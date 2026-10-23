import fs from 'node:fs';
import path from 'node:path';
import { Notice } from 'obsidian';
import { isApplying, executeBundlePlan, planBundleApply } from '../bundle/apply';
import type { ApplyOptions } from '../bundle/apply';
import { baselineOfBundle } from '../bundle/baseline';
import { listFullAnchorsSync } from '../bundle/anchor';
import { exportBundle } from '../bundle/export';
import { bundleTrashRoot, listBundles } from '../bundle/manage';
import { bundleBaseDir } from '../bundle/paths';
import { readPeers, writePeer, describePeerDetail, needsPeerRefresh } from '../git/peers';
import { runGit } from '../git/run';
import { isShelf, prepareShelf } from '../git/shelf';
import type { ShelfOptions } from '../git/shelf';
import { readShelfStatus, refreshShelf, shelfIsDirty, syncShelf } from '../git/sync';
import type { GitSyncReport } from '../git/sync';
import type LocallySavePlugin from '../main';
import { DIRECTION_OPTIONS } from '../settings/model';
import { loadState, loadStateSync, saveState } from '../sync/state';
import type { GitSyncRecord, PluginState } from '../sync/state';
import { ConfirmModal } from './confirm-modal';
import { GitStatusModal } from './git-modal';
import { openFolderInExplorer } from './reveal';
import { peerStatusText, refreshStatusBar } from './status';

/**
 * 「Git 远程」那一套动作：接入、同步、检查环境、打开货架。
 *
 * 边界（方案里定死的，改之前先读 `docs/git远程货架-实施计划.md`）：
 * - **git 只搬包**：工作区就是同步包文件夹，仓库里只有 `.lsave`；
 * - **不自动 init / 不自动改远程**：那两件事只在「接入」动作里做，别的路径只读不写；
 * - **完整包不推**：`.git/info/exclude` 里常驻 `/full/`（见 `git/shelf.ts`）；
 * - 拉取到的包不在这里应用 —— 交给 `main.tick()` 后面那条 `checkIncomingBundles`，
 *   安全边界（只自动应用不会动本地东西的更新包）仍然只有一份。
 */

/** 同步的入口参数：手动那一路要说话，自动那一路安静（真出事再说） */
export interface GitSyncOptions {
	/** 自动触发（定时 / 留包后）：正常结果不弹通知 */
	quiet?: boolean;
	/** 用户点的：无论结果都回一句 */
	manual?: boolean;
}

/** 从设置拼出引擎要的货架参数；没填全就返回 null */
function shelfOptions(plugin: LocallySavePlugin): ShelfOptions | null {
	const base = bundleBaseDir(plugin.settings);
	const remote = plugin.settings.gitRemote.trim();
	if (base === '' || remote === '') return null;
	const gitPath = plugin.settings.gitPath.trim();
	return {
		dir: base,
		remote,
		branch: plugin.settings.gitBranch.trim() || 'main',
		trashDir: bundleTrashRoot(base) || null,
		...(gitPath !== '' ? { gitPath } : {}),
		// 网络命令给足时间：GitHub 慢慢推一个几 MB 的包也可能几十秒
		networkTimeoutMs: 90_000,
	};
}

/**
 * 和远程对一遍（提交 → 拉 → 推）。
 *
 * 同一时间只允许一次：留包 / 收包 / 应用进行中也会让路 —— 同步会动包文件夹里的文件，
 * 应用正读着某个包时把它挪走就麻烦了。
 */
export async function syncGitNow(
	plugin: LocallySavePlugin,
	options: GitSyncOptions = {},
): Promise<boolean> {
	if (!plugin.settings.enabled) return false;
	if (!plugin.settings.gitEnabled) {
		if (options.manual) new Notice('还没打开「启用 git 传输」：设置 → Git 远程');
		return false;
	}
	const shelf = shelfOptions(plugin);
	if (!shelf) {
		if (options.manual) {
			new Notice('还没填全：设置 → Git 远程 →「同步包文件夹」和「远程地址」', 9000);
		}
		return false;
	}
	if (plugin.gitBusy) {
		if (options.manual) new Notice('上一次 git 同步还没跑完');
		return false;
	}
	if (plugin.bundleBusy || plugin.incomingBusy || isApplying()) {
		if (options.manual) new Notice('正在留包、收包或应用，等这一轮跑完再同步');
		return false;
	}
	// **不自动 init**：写 `.git` 是「接入」那个动作的事；这里只跟已经接上的货架说话
	if (!(await isShelf(shelf.dir, { gitPath: shelf.gitPath }))) {
		if (options.manual) new Notice('这个文件夹还没接上 git：设置 → Git 远程 →「接入这个远程…」', 9000);
		return false;
	}

	plugin.gitBusy = true;
	plugin.statusBar.showActivity('同步中…');
	try {
		// 先把自己的状态写进货架（别人拉下来就知道我在哪一步），再提交 / 拉 / 推
		const state = await loadState(plugin.stateFile());
		// 状态文件还没建时，`loadState` 每次都会给一个新的 copyId —— 先落盘，别让状态文件在货架上"换名字"
		if (!fs.existsSync(plugin.stateFile())) await saveState(plugin.stateFile(), state);
		const peer = await writePeer(shelf.dir, state, plugin.vaultName());
		if (peer.error) plugin.log.debug(`写本机状态失败：${peer.error}`);

		const report = await syncShelf({
			...shelf,
			onStage: stage => plugin.statusBar.showActivity(`同步中：${stage}`),
		});
		plugin.lastGitAt = Date.now();
		plugin.gitFailures = 0;
		plugin.gitBackoffUntil = 0;
		await rememberGit(plugin, {
			at: Date.now(),
			ok: true,
			pushed: report.pushed,
			pulled: report.pulled.length,
			ahead: report.ahead,
			behind: report.behind,
		});
		await refreshStatusBar(plugin);
		if (options.manual) {
			const latest = await loadState(plugin.stateFile());
			const peer = plugin.settings.gitEnabled
				? peerStatusText(readPeers(shelf.dir, latest.copyId), latest).short
				: null;
			new Notice(describeReport(report, peer), 9000);
		} else if (report.pulled.length > 0) {
			new Notice(`从 git 远程收到 ${report.pulled.length} 个包`, 9000);
		}
		return true;
	} catch (error) {
		const message = describe(error);
		plugin.gitFailures++;
		// 连不上 / 凭据不对时别每 30 秒弹一次：2 分钟起步，最多 10 分钟
		plugin.gitBackoffUntil = Date.now() + Math.min(2 * 60_000 * 2 ** Math.min(plugin.gitFailures - 1, 3), 10 * 60_000);
		// 失败时也把"本地领先几个"记下来：状态栏要能说"几个包还没推上去"（本地命令，不联网）
		const status = await readShelfStatus(shelf).catch(() => null);
		await rememberGit(plugin, {
			at: Date.now(),
			ok: false,
			pushed: false,
			pulled: 0,
			ahead: status?.ahead ?? 0,
			behind: status?.behind ?? 0,
			error: message,
		});
		await refreshStatusBar(plugin);
		plugin.log.error('git 同步失败', error);
		if (options.manual) new Notice(`git 同步失败：${brief(message)}`, 8000);
		return false;
	} finally {
		plugin.gitBusy = false;
		plugin.statusBar.showActivity(null);
	}
}

/**
 * 自动那条路（每 30 秒的节拍调）。
 *
 * 什么时候真的干活：
 * - 到了统一同步间隔（`autoSyncInterval`，0 ＝ 不自动拉）；
 * - 或者货架里**有还没提交的包**（刚留过包 → 30 秒内推上去，不等拉取间隔）；
 * - 或者上一次没推上去（`state.git.ahead > 0`）。
 * 没接上（还不是 git 仓库）就安静地跳过 —— **不自动 init**。
 */
export async function maybeGitSync(plugin: LocallySavePlugin): Promise<boolean> {
	if (!plugin.settings.enabled || !plugin.settings.gitEnabled) return false;
	if (plugin.gitBusy || plugin.bundleBusy || plugin.incomingBusy || isApplying()) return false;
	if (Date.now() < plugin.gitBackoffUntil) return false;

	const shelf = shelfOptions(plugin);
	if (!shelf) return false;
	if (!(await isShelf(shelf.dir, { gitPath: shelf.gitPath }))) return false;

	const due = plugin.settings.autoSyncInterval > 0
		&& Date.now() - plugin.lastGitAt >= plugin.settings.autoSyncInterval * 60_000;
	const state = await loadState(plugin.stateFile());
	const last = state.git;
	const pendingPush = (last?.ahead ?? 0) > 0;
	/**
	 * 状态变了（刚应用 / 刚导出）就把"我现在在哪一步"写回货架 —— 不等拉取间隔。
	 * 这一步不联网；写出来之后 `shelfIsDirty` 会让下面的同步把它提交推送上去，
	 * 对面下一次拉取就能看到"我已经应用完了"。
	 */
	const peer = await writePeer(shelf.dir, state, plugin.vaultName());
	/**
	 * **对面应用完但没产生新包时**，它只更新了 `.lsave-peers/<它的 copyId>.json`。
	 * 这边如果干等 `autoSyncInterval`（默认 5 分钟），状态栏会一直写"对方：待上报"，
	 * 用户只能自己再点一次同步。这里在"有 peer 报告比我旧"时每 30 秒主动拉一次，
	 * 拉到它的新状态就自动变成一致 / 不同步，不用人手点。
	 */
	const mine = state.stateId?.id ?? null;
	// `autoSyncInterval = 0` 是用户明确关掉自动拉取 —— 回执刷新也不越过它
	const refreshDue = plugin.settings.autoSyncInterval > 0 && mine
		? needsPeerRefresh(
			readPeers(shelf.dir, state.copyId),
			mine,
			state.stateId?.at ?? 0,
			plugin.lastGitAt,
			Date.now(),
		)
		: false;
	if (!due && !pendingPush && !peer.written && !refreshDue && !(await shelfIsDirty(shelf))) return false;
	return syncGitNow(plugin, { quiet: true });
}

/**
 * **对方站在别的基准上时，导出前提醒一句**（0.15.9）。
 *
 * 导出默认从"我站的那份完整副本"算起；对方若还站在更老（或另一份）完整副本上，
 * 这份包它接不上。这里直接说清"从哪一份开始它才接得上"、以及本机有没有那份副本。
 *
 * 只读 peer 文件；包目录没填 / 状态读不出 / peers 读不出都返回 null ——
 * 提示是加分项，不能反过来把导出拦住。
 */
export function peerBaselineHint(plugin: LocallySavePlugin): string | null {
	const base = bundleBaseDir(plugin.settings);
	if (base === '') return null;
	let state: PluginState;
	try {
		state = loadStateSync(plugin.stateFile());
	} catch {
		return null;
	}
	const mine = state.bundle?.fullHash ?? null;
	if (!mine) return null;
	let peers;
	try {
		peers = readPeers(base, state.copyId);
	} catch {
		return null;
	}
	const others = peers.filter(peer => peer.baselineHash !== null && peer.baselineHash !== mine);
	if (others.length === 0) return null;
	const anchors = listFullAnchorsSync(base, state.lineage);
	const lines = others.map(peer => {
		const who = peer.host || peer.copyId.slice(0, 8);
		const short = (peer.baselineHash ?? '').slice(0, 8);
		if (anchors.some(anchor => anchor.hash === peer.baselineHash)) {
			return `${who} 站在基准 ${short}：导出前把「更新包：从哪个状态开始」选成它，对方才接得上`;
		}
		return `${who} 站在基准 ${short}，本机没有它的完整副本：让它发一份完整副本过来，或把本机这份基准发给它`;
	});
	return lines.join('；');
}

/**
 * 设置页「连接状态」那一行：**一眼看出能不能用、下一步做什么**。
 *
 * 同步读（不跑 git、不联网）：`.git` 在不在、`origin` 地址、状态文件里最近一次同步结果。
 * 真正"git 装没装 / 远程通不通"在「测试连通性」里跑（那一步会联网）。
 */
export function describeGitConnection(plugin: LocallySavePlugin): string {
	if (!plugin.settings.gitEnabled) {
		return 'git 传输关着。打开上面的开关，再填地址。';
	}
	const base = bundleBaseDir(plugin.settings);
	if (base === '') return '还没填「同步包文件夹」。去「同步包」那一页填一个仓库之外的目录。';
	const remote = plugin.settings.gitRemote.trim();
	if (remote === '') return '还没填「远程地址」。填一个私有仓库的 HTTPS 或 SSH 地址。';
	const layout = detectGitLayoutSync(base);
	if (!layout) {
		return '还没接入。点下面「接入这个远程…」把同步包文件夹变成 git 仓库；'
			+ '或者把它放进一个已有仓库的子目录（比如 kf-personal-data），插件会跟着那个仓库同步。';
	}
	const current = readOriginUrl(layout.repo);
	if (!current) {
		return layout.hosted
			? `这个文件夹在仓库 ${layout.repo} 里，但那个仓库没有远程地址。先在仓库里配好 origin。`
			: '还没接入。点下面「接入这个远程…」补上远程地址。';
	}
	if (current !== remote) {
		return `git 远程是 ${redactRemote(current)}，和设置里的地址不同。先改回来，或重新接入。`;
	}
	const where = layout.hosted ? `${redactRemote(remote)}（子目录 ${layout.rel}）` : redactRemote(remote);

	let state: PluginState | null = null;
	try {
		state = loadStateSync(plugin.stateFile());
	} catch {
		state = null;
	}
	const git = state?.git;
	if (!git) return `已接上 ${where} · 还没同步过（点「现在同步一次」）`;
	if (!git.ok) {
		return `已接上 ${where} · 上次同步失败：${git.error ?? '看日志'}（点「测试连通性」查）`;
	}
	const bits = [`已接上 ${where}`, `${hhmm(git.at)} 推拉过`];
	if (git.pulled > 0) bits.push(`收到 ${git.pulled} 个包`);
	if (git.ahead > 0) bits.push(`${git.ahead} 个没推上去`);
	if (git.behind > 0) bits.push(`落后 ${git.behind} 个提交`);
	return bits.join(' · ');
}

/**
 * 「测试连通性」：git 装没装、远程连不连得上、SSH / 凭据行不行。
 *
 * **不依赖本地仓库**（还没接入也能测）：直接用设置里的地址跑 `git ls-remote`。
 * 只读，不改任何东西；失败时说下一步（SSH 接入 / 先终端 pull 一次）。
 */
export async function checkGitConnectivity(plugin: LocallySavePlugin): Promise<void> {
	const base = bundleBaseDir(plugin.settings);
	const remote = plugin.settings.gitRemote.trim();
	const branch = plugin.settings.gitBranch.trim() || 'main';
	const gitPath = plugin.settings.gitPath.trim();
	const lines: string[] = [];

	if (base === '') {
		lines.push('还没填「同步包文件夹」：去「同步包」那一页填一个仓库之外的目录');
		new GitStatusModal(plugin.app, lines).open();
		return;
	}
	if (remote === '') {
		lines.push('还没填「远程地址」：填一个私有仓库的 HTTPS 或 SSH 地址');
		new GitStatusModal(plugin.app, lines).open();
		return;
	}

	const run = (args: string[], timeoutMs = 15_000) => runGit(args, {
		cwd: base,
		...(gitPath !== '' ? { gitPath } : {}),
		timeoutMs,
	});
	const version = await run(['--version'])
		.catch(error => ({ code: -1, stdout: '', stderr: describe(error), timedOut: false }));
	if (version.code !== 0) {
		lines.push('git：没找到。装一个 Git（Windows 上是 Git for Windows），或在这一页填 git.exe 的路径。');
		new GitStatusModal(plugin.app, lines).open();
		return;
	}
	lines.push(`git：${version.stdout.trim()}`);
	lines.push(`同步包文件夹：${base}`);
	lines.push(`远程：${redactRemote(remote)}（分支 ${branch}）`);

	if (!fs.existsSync(base)) {
		lines.push('同步包文件夹还不存在。先在「导出同步包…」里导一次（或手动建这个目录），再测试。');
		new GitStatusModal(plugin.app, lines).open();
		return;
	}

	const top = await run(['rev-parse', '--show-toplevel'])
		.catch(() => ({ code: -1, stdout: '', stderr: '', timedOut: false }));
	if (top.code === 0 && samePathText(top.stdout.trim(), base)) {
		lines.push('接入状态：已经是 git 仓库（「接入这个远程…」会补上远程与排除规则）');
	} else if (top.code === 0) {
		lines.push(`接入状态：在仓库 ${top.stdout.trim()} 里的子目录（提交只涉及这一段，推的是那个仓库当前的分支）`);
	} else {
		lines.push('接入状态：还没接入（点「接入这个远程…」；也可以把它放进一个已有仓库的子目录）');
	}

	// 真正联网的一步：ls-remote 会走 SSH / 凭据，把"连不上 / 没权限"当场暴露出来
	const ls = await run(['ls-remote', '--heads', remote, branch], 60_000)
		.catch(error => ({ code: -1, stdout: '', stderr: describe(error), timedOut: false }));
	if (ls.timedOut) {
		lines.push('连通性：超时。网络或凭据卡住了；SSH 可能停在问口令或确认主机指纹。');
	} else if (ls.code === 0) {
		lines.push(ls.stdout.trim() !== ''
			? `连通性：正常，远程有分支 ${branch}`
			: `连通性：正常，远程还没有分支 ${branch}（第一次推的时候会建）`);
	} else {
		lines.push(`连通性：失败。${lastLines(ls.stderr || ls.stdout)}`);
		lines.push('下一步：SSH 地址点「SSH 接入…」生成、添加公钥；HTTPS 地址先在终端里成功 pull 一次，'
			+ '让系统记住凭据。插件不存 token。');
	}

	new GitStatusModal(plugin.app, lines, () => { void syncGitNow(plugin, { manual: true }); }).open();
}

/** 货架 `.git/config` 里 `origin` 的地址（读不到返回 null） */
function readOriginUrl(repo: string): string | null {
	try {
		const text = fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8');
		const match = /\[remote "origin"\][^[]*?url\s*=\s*(.+)/.exec(text);
		return match?.[1]?.trim() ?? null;
	} catch {
		return null;
	}
}

/**
 * 同步读一眼这个文件夹在 git 里的身份（设置页是同步渲染的，等不了 `readShelfLayout`）。
 *
 * 往上找第一个带 `.git` 的目录：就是它 → 独立货架；在它上面 → 别人仓库的子目录。
 */
function detectGitLayoutSync(base: string): { repo: string; rel: string; hosted: boolean } | null {
	const target = path.resolve(base);
	let dir = target;
	for (;;) {
		if (fs.existsSync(path.join(dir, '.git'))) {
			const rel = path.relative(dir, target).split(path.sep).join('/');
			return { repo: dir, rel, hosted: rel !== '' };
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** 显示远程地址前把凭据抹掉（有人会把 token 拼进 URL；别让它出现在界面 / 日志里） */
function redactRemote(remote: string): string {
	return remote.replace(/^(https?:\/\/)[^/@]+@/i, '$1***@');
}

/** 路径比较（Windows 大小写不敏感） */
function samePathText(a: string, b: string): boolean {
	const normalized = (value: string): string => {
		const resolved = path.resolve(value);
		return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
	};
	return a !== '' && normalized(a) === normalized(b);
}

/** 错误信息只取最后两行（git 前面常有一堆 To/From） */
function lastLines(text: string): string {
	return text.trim().split(/\r?\n/).filter(line => line.trim() !== '').slice(-2).join(' ');
}

/** 状态栏 / 设置页要的「HH:mm」 */
function hhmm(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number): string => String(n).padStart(2, '0');
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 首次接入：把包文件夹初始化成 git 仓库、接上远程（只做这一次）。
 *
 * 之后所有同步都走 `syncGitNow` —— 用户不点这个按钮，插件不会自己往文件夹里写 `.git`。
 */
export async function connectGitRemote(plugin: LocallySavePlugin): Promise<void> {
	if (!plugin.settings.gitEnabled) {
		new Notice('先打开「启用 git 传输」');
		return;
	}
	const shelf = shelfOptions(plugin);
	if (!shelf) {
		new Notice('先把「同步包文件夹」和「远程地址」填上', 9000);
		return;
	}
	if (plugin.gitBusy) {
		new Notice('正在同步：等它跑完再接入');
		return;
	}

	plugin.gitBusy = true;
	let created = false;
	let hosted = false;
	try {
		const prepared = await prepareShelf(shelf);
		created = prepared.created;
		hosted = prepared.hosted;
		plugin.gitFailures = 0;
		plugin.gitBackoffUntil = 0;
	} catch (error) {
		const message = describe(error);
		new Notice(`接入失败：${brief(message)}`, 8000);
		plugin.log.error('接入 git 远程失败', error);
		return;
	} finally {
		plugin.gitBusy = false;
	}

	plugin.log.debug(created ? '同步包文件夹已初始化' : '同步包文件夹已经在用');
	const synced = await syncGitNow(plugin, { manual: true });
	if (synced) {
		new Notice(
			created
				? '已接入 git：之后留包会自动提交并推送'
				: hosted
					? '这个文件夹已经在仓库里：不新建仓库，跟着那个仓库当前的分支走（提交只涉及这一段）'
					: '已经接入过，这一轮也同步完了',
			8000,
		);
	}
}

/**
 * 「让对面和我一致」：把我这边的改动导成更新包、推上去。
 *
 * **只推不收**（方向那项也是这么写的）：对面拉下来、应用之后才会变成我这样。
 * 不在这里替用户决定"要不要顺手收对方的包" —— 那是 `both` 与「让我和对面一致」的事。
 */
export async function uploadNow(plugin: LocallySavePlugin): Promise<void> {
	if (!plugin.settings.enabled) return;
	if (!plugin.settings.gitEnabled) {
		new Notice('先打开「启用 git 传输」：设置 → Git 远程');
		return;
	}
	const shelf = shelfOptions(plugin);
	if (!shelf) {
		new Notice('先把「同步包文件夹」和「远程地址」填上', 9000);
		return;
	}
	if (!(await isShelf(shelf.dir, { gitPath: shelf.gitPath }))) {
		new Notice('这个文件夹还没接上 git：先点「接入这个远程…」', 9000);
		return;
	}

	let exported: string | null = null;
	try {
		// 不管自动留包开没开：用户明确点了"推"，有改动就导一份（引擎在没变化时返回 file: null）
		const result = await exportBundle({
			settings: plugin.settings,
			log: plugin.log,
			vaultRoot: plugin.vaultRoot(),
			vaultName: plugin.vaultName(),
			stateFile: plugin.stateFile(),
			mode: 'changes',
			outDir: shelf.dir,
			configDir: plugin.configDir(),
		});
		exported = result.file;
	} catch (error) {
		new Notice(`导出失败：${brief(describe(error))}`, 8000);
		return;
	}

	// 只留一句总结：`syncGitNow` 手动模式自己也会弹一条，两条叠在一起用户要读两遍
	const synced = await syncGitNow(plugin, { quiet: true });
	if (!synced) {
		new Notice('推拉失败：看状态栏或日志。已经导出的包会在下次同步时再推', 9000);
		return;
	}
	new Notice(exported ? '已推送，等对方拉取并应用' : '没有新改动，远程已是最新', 6000);
}

/**
 * 「让我和对面一致」：拉下来，然后用对方最新的更新包**严格对齐**到它那一份状态。
 *
 * 对齐全走引擎的严格镜像：本机改过的、多出来的文件先挪进回收目录（备份），
 * 目标状态 ＝ 我站的基准 ＋ 包里的条目 − 包点名的删除 —— 正好是对方那一点，做完状态编号一致。
 * 会覆盖本机内容，所以先弹一句确认。
 */
export async function downloadNow(plugin: LocallySavePlugin): Promise<void> {
	if (!plugin.settings.enabled) return;
	if (!plugin.settings.gitEnabled) {
		new Notice('先打开「启用 git 传输」：设置 → Git 远程');
		return;
	}
	const shelf = shelfOptions(plugin);
	if (!shelf) {
		new Notice('先把「同步包文件夹」和「远程地址」填上', 9000);
		return;
	}
	if (!(await isShelf(shelf.dir, { gitPath: shelf.gitPath }))) {
		new Notice('这个文件夹还没接上 git：先点「接入这个远程…」', 9000);
		return;
	}

	// 先拉一遍（不然对面刚推的包还不在本地）
	if (!(await syncGitNow(plugin, { quiet: true }))) {
		new Notice('同步没成功：先看状态栏或日志，再点一次', 9000);
		return;
	}

	let state: PluginState;
	try {
		state = await loadState(plugin.stateFile());
	} catch (error) {
		new Notice('读不到本机状态', 6000);
		return;
	}
	const baseline = state.bundle?.fullHash ?? null;
	const candidates = (await listBundles(shelf.dir))
		.filter(item => item.header?.mode === 'changes'
			&& item.header.source?.copyId !== state.copyId
			&& baselineOfBundle(item.header) === baseline)
		.sort((a, b) => (b.header?.targetGeneration ?? 0) - (a.header?.targetGeneration ?? 0));
	const target = candidates[0];
	if (!target) {
		new Notice('没有对方的更新包可对齐', 6000);
		return;
	}

	new ConfirmModal(plugin.app, {
		title: '让我和对面一致',
		lines: [
			`会用对方的更新包「${target.name}」把本机改成对面那一份状态。`,
			'本机改过或多出来的文件会先挪进回收目录（.trash/locally-save），能捞回来。',
			'做完两边状态编号应当一致；你的新改动之后靠「让对面和我一致」推回去。',
		],
		confirmText: '以对面为准',
		onConfirm: () => { void applyAlign(plugin, target.file); },
	}).open();
}

/**
 * **刷新包：把货架对齐到远程**（用户点的动作）。
 *
 * 用户现场："包弄乱了我会删，这时候要从远程重新拉最新的……现在删了他就不会拉了，
 * 一直拉不下来。" 自动同步碰上"本地有提交 + 远程也有提交"必须停下（不能替用户 rebase 仓库），
 * 于是给一个明确的出口：丢掉货架那一段的本地提交/改动，整段对齐远程，再把新包捡起来。
 */
export async function refreshBundlesAction(plugin: LocallySavePlugin): Promise<void> {
	if (!plugin.settings.enabled) return;
	if (!plugin.settings.gitEnabled) {
		new Notice('先打开「启用 git 传输」：设置 → Git 远程');
		return;
	}
	const shelf = shelfOptions(plugin);
	if (!shelf) {
		new Notice('先把「同步包文件夹」和「远程地址」填上', 9000);
		return;
	}
	if (!(await isShelf(shelf.dir, { gitPath: shelf.gitPath }))) {
		new Notice('这个文件夹还没接上 git：先点「接入这个远程…」', 9000);
		return;
	}
	if (plugin.gitBusy || plugin.bundleBusy || plugin.incomingBusy || isApplying()) {
		new Notice('正在同步 / 应用，等这一步做完再刷新', 6000);
		return;
	}
	plugin.gitBusy = true;
	try {
		plugin.reportProgress({ done: 0, total: 0, path: '', label: '刷新中' });
		const report = await refreshShelf({
			...shelf,
			onStage: stage => plugin.reportProgress({ done: 0, total: 0, path: '', label: stage }),
		});
		plugin.reportProgress(null);
		plugin.log.debug(
			`刷新包：丢掉本地 ${report.dropped} 笔提交，新到 ${report.pulled.length} 个包（HEAD ${report.head ?? '?'}）`,
		);
		new Notice(
			`货架已对齐远程 · 丢掉本地 ${report.dropped} 笔货架提交`
				+ `，新到 ${report.pulled.length} 个包`,
			8000,
		);
		await refreshStatusBar(plugin);
		// 新到的包可能就是要应用的那一份：按当前方向再走一遍收包
		if (report.pulled.length > 0) await syncGitNow(plugin, { quiet: true });
	} catch (error) {
		plugin.reportProgress(null);
		const message = error instanceof Error ? error.message : String(error);
		new Notice(`刷新失败：${message}`, 9000);
		plugin.log.error('刷新货架失败', error);
	} finally {
		plugin.gitBusy = false;
	}
}

/** 真正按对方对齐（见 `downloadNow` 的说明）；strictness 用界面上那唯一一种：mirror */
async function applyAlign(plugin: LocallySavePlugin, file: string): Promise<void> {
	const options: ApplyOptions = {
		settings: plugin.settings,
		log: plugin.log,
		vaultRoot: plugin.vaultRoot(),
		stateFile: plugin.stateFile(),
		file,
		configDir: plugin.configDir(),
		bundleDir: bundleBaseDir(plugin.settings),
		strictness: 'mirror',
		// 目标 ＝ 对方那一点（基准 ＋ 条目 − 删除），不是"我的内容 ＋ 对方的改动"
		alignToPeer: true,
	};
	try {
		const plan = await planBundleApply(options);
		const result = await executeBundlePlan(plan, options);
		// 状态变了：赶紧把"我现在的状态"写进货架，别让对面看到旧的那份
		const state = await loadState(plugin.stateFile());
		const peer = await writePeer(bundleBaseDir(plugin.settings), state, plugin.vaultName());
		if (peer.error) plugin.log.debug(`写本机状态失败：${peer.error}`);
		await syncGitNow(plugin, { quiet: true });
		new Notice(
			result.stateIdCompare === 'match'
				? '已和对面一致'
				: '应用完了，编号还差一点（看更新记录）',
			6000,
		);
	} catch (error) {
		new Notice(`应用失败：${brief(describe(error))}`, 8000);
		plugin.log.error('按对方对齐失败', error);
	}
}

/** 「检查环境」：只看本地，不联网、不改任何东西（结果在一个小窗口里） */
export async function checkGitEnvironment(plugin: LocallySavePlugin): Promise<void> {
	const shelf = shelfOptions(plugin);
	const cwd = shelf?.dir ?? plugin.vaultRoot();
	const gitPath = plugin.settings.gitPath.trim();
	const version = await runGit(['--version'], {
		cwd,
		...(gitPath !== '' ? { gitPath } : {}),
	}).catch(error => ({ code: -1, stdout: '', stderr: describe(error), timedOut: false }));

	const lines: string[] = [];
	lines.push(version.code === 0
		? `git：${version.stdout.trim()}`
		: 'git：没找到。装一个 Git（Windows 上是 Git for Windows），或在这一页填 git.exe 的路径。');

	if (!shelf) {
		lines.push('还没填全：「同步包文件夹」与「远程地址」');
	} else {
		const status = await readShelfStatus(shelf);
		if (!status.isRepo) {
			lines.push(`同步包文件夹：${shelf.dir}`);
			lines.push('还不是 git 仓库。点「接入这个远程…」');
		} else {
			lines.push(`同步包文件夹：${shelf.dir}`);
			lines.push(`远程：${status.remote ?? '没设'}（分支 ${status.branch}）`);
			lines.push(`本地：${status.head ? status.head.slice(0, 7) : '还没有提交'}`
				+ ` · ${status.dirty ? '有包还没提交' : '干净'}`);
			lines.push(`与远程：领先 ${status.ahead}、落后 ${status.behind}`);
			lines.push(`方向：${DIRECTION_OPTIONS[plugin.settings.syncDirection]}`);
			// 对表：对方现在在哪一步（货架里的 `.lsave-peers/*.json`）
			try {
				const state = await loadState(plugin.stateFile());
				lines.push(`我这台：状态 ${state.stateId?.id ?? '还没算过'} · 第 ${state.generation} 代`
					+ ` · 基准 ${state.bundle?.fullGeneration ?? '?'} 代 ${state.bundle?.fullHash ?? '未记'}`);
				const peers = readPeers(shelf.dir, state.copyId);
				if (peers.length === 0) {
					lines.push('另一台：还没上报状态（它同步过一次之后才有）');
				} else {
					for (const peer of peers) {
						lines.push(describePeerDetail(peer, state.stateId?.id ?? null, state.stateId?.at ?? 0));
					}
				}
			} catch (error) {
				lines.push(`另一台：读不到（${describe(error)}）`);
			}
		}
	}

	new GitStatusModal(plugin.app, lines, () => { void syncGitNow(plugin, { manual: true }); }).open();
}

/** 在系统文件管理器里打开货架（包文件夹不存在时说明一句） */
export function openShelfFolder(plugin: LocallySavePlugin): void {
	const base = bundleBaseDir(plugin.settings);
	if (base === '') {
		new Notice('还没设置「同步包文件夹」：设置 → Locally Save → 同步包');
		return;
	}
	if (!fs.existsSync(base)) {
		new Notice(`这个文件夹还不存在：${base}（先在「导出同步包…」里导一次）`, 9000);
		return;
	}
	openFolderInExplorer(base, plugin.app as unknown as { openWithDefaultApp?: (path: string) => void });
}

/** 把结果写进状态文件（状态栏下次启动还能看到） */
async function rememberGit(plugin: LocallySavePlugin, record: GitSyncRecord): Promise<void> {
	try {
		const state = await loadState(plugin.stateFile());
		state.git = record;
		await saveState(plugin.stateFile(), state);
	} catch (error) {
		// 记不下只是"下次启动少一句"，不该把已经成功的同步说成失败
		plugin.log.debug('记 git 同步结果失败', error);
	}
}

/**
 * 手动推拉那一句：**git 这一层**干了什么 + **内容这一层**各台机器对不对得上。
 *
 * 不再只写"同步完成"：推上去不等于对方应用了，更不等于两边内容一样；
 * `peer` 那半句来自 `.lsave-peers`（状态栏同一套判据），会明确说"一致 / 待上报 / 不同步"。
 */
function describeReport(report: GitSyncReport, peer?: string | null): string {
	const parts: string[] = [];
	if (report.pulled.length > 0) parts.push(`收到 ${report.pulled.length} 个包`);
	const action = report.pushed
		? (report.pulled.length > 0 ? '已推拉' : '已推送')
		: (report.pulled.length > 0 ? '已拉取' : '远程已是最新');
	parts.push(action);
	if (report.committed && !report.pushed) parts.push('本地已提交、还没推');
	if (report.ahead > 0) parts.push(`${report.ahead} 个没推`);
	if (report.behind > 0) parts.push(`落后 ${report.behind}`);
	if (peer) parts.push(peer);
	return `git 同步完成：${parts.join(' · ')}`;
}

function brief(text: string, max = 70): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
