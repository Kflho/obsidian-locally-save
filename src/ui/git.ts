import fs from 'node:fs';
import path from 'node:path';
import { Notice } from 'obsidian';
import { debugEvent } from '../debugLog';
import { isApplying, executeBundlePlan, planBundleApply } from '../bundle/apply';
import type { ApplyOptions } from '../bundle/apply';
import { baselineOfBundle } from '../bundle/baseline';
import { listFullAnchorsSync } from '../bundle/anchor';
import { exportBundle } from '../bundle/export';
import { bundleTrashRoot, listBundles } from '../bundle/manage';
import { bundleBaseDir } from '../bundle/paths';
import { readPeers, writePeer, describePeerDetail, needsPeerRefresh } from '../git/peers';
import { readRemovals } from '../git/removals';
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
 * 「Git 远程」那一套动作：接入、同步、检查环境、打开远程仓库。
 *
 * 边界（方案里定死的，改之前先读 `bin/reference_docs/technical_solution_docs/git远程远程仓库-实施计划.md`）：
 * - **git 只搬包**：工作区就是同步包文件夹，仓库里只有 `.lsave`；
 * - **不自动 init / 不自动改远程**：那两件事只在「接入」动作里做，别的路径只读不写；
 * - **完整备份不推**：`.git/info/exclude` 里常驻 `/full/`（见 `git/shelf.ts`）；
 * - 拉取到的包不在这里应用 —— 交给 `main.tick()` 后面那条 `checkIncomingBundles`，
 *   安全边界（只自动应用不会动本地东西的更新包）仍然只有一份。
 */

/** 同步的入口参数：手动那一路演一句过程，其余安静（真出事再说） */
export interface GitSyncOptions {
	/** 自动 / 一并推送（导出、应用之后）：正常结果不弹通知，**也不写状态栏**（发起方自己有文案） */
	quiet?: boolean;
	/** 用户点的：开头一句「正在同步…」，结束时给结果 + 其他电脑状态 */
	manual?: boolean;
	/**
	 * **后台的例行对表**（每 30 秒那一拍）：连状态栏都不写。
	 *
	 * 这些同步只是"看看对面有没有新包"，几秒就完；结果本来就会落在状态栏那一句总结里
	 * （`已推送 12:31 · 对方：一致`），不必再演一遍过程。
	 */
	background?: boolean;
}

/** 从设置拼出引擎要的远程仓库参数；没填全就返回 null */
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
		// 远程仓库只用于搬运、不留历史：每次同步生成一个提交（引擎只对独立仓库生效）
		singleCommit: true,
		// 网络命令给足时间：GitHub 慢慢推一个几 MB 的包也可能几十秒
		networkTimeoutMs: 90_000,
	};
}

/**
 * 和远程对一遍（提交 → 拉 → 推）。
 *
 * 同一时间只允许一次：导出 / 接收 / 应用进行中也会让路 —— 同步会动同步包文件夹里的文件，
 * 应用正读着某个包时把它移走就麻烦了。
 */
export async function syncGitNow(
	plugin: LocallySavePlugin,
	options: GitSyncOptions = {},
): Promise<boolean> {
	if (!plugin.settings.enabled) return false;
	if (!plugin.settings.gitEnabled) {
		if (options.manual) new Notice('「启用 Git 传输」尚未开启：设置 → Git 远程');
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
		if (options.manual) new Notice('上一次 Git 同步尚未完成');
		return false;
	}
	if (plugin.bundleBusy || plugin.incomingBusy || isApplying()) {
		if (options.manual) new Notice('正在导出、接收或应用，请等本轮完成后再同步');
		return false;
	}
	// **不自动 init**：写 `.git` 是「接入」那个动作的事；这里只跟已经接上的远程仓库说话
	if (!(await isShelf(shelf.dir, { gitPath: shelf.gitPath }))) {
		if (options.manual) new Notice('同步包文件夹尚未连接 Git：设置 → Git 远程 →「接入这个远程…」', 9000);
		return false;
	}

	plugin.gitBusy = true;
	/**
	 * **只有用户点的同步才演过程**：开头一句「正在同步…」，结束后回到结果。
	 *
	 * 原来按五个步骤刷「同步 2/5 · 连接远程…」；导出 / 应用之后一并推送的那一下
	 * 也走这条路，右下角就一直在跳状态（用户报的"连跳很多状态"）。
	 * 现在：quiet（发起方自己有文案）与后台对表都不写，结果就一条 ——
	 * 完成后的动作 + 对方的内容状态（`refreshStatusBar` 那一句）。
	 */
	const narrate = options.manual === true;
	if (narrate) plugin.statusBar.showActivity('正在同步…');
	try {
		// 先把自己的状态写进远程仓库（别人拉下来就知道我在哪一步），再提交 / 拉 / 推
		const state = await loadState(plugin.stateFile());
		// 状态文件还没建时，`loadState` 每次都会给一个新的 copyId —— 先落盘，别让状态文件在远程仓库上"换名字"
		if (!fs.existsSync(plugin.stateFile())) await saveState(plugin.stateFile(), state);
		const peer = await writePeer(shelf.dir, state, plugin.vaultName());
		if (peer.error) plugin.log.debug(`写本电脑状态失败：${peer.error}`);

		const report = await syncShelf(shelf);
		plugin.lastGitAt = Date.now();
		plugin.gitFailures = 0;
		plugin.gitBackoffUntil = 0;
		await rememberGit(plugin, {
			at: Date.now(),
			ok: true,
			pushed: report.pushed,
			pulled: report.pulled.length,
			deleted: report.deleted.length,
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
		} else if (report.pulled.length > 0 || report.deleted.length > 0) {
			/**
			 * **拉下来的包不在这里报数**（0.16.14）：拉下来只说明"远程仓库上多了个文件"，
			 * 真正要用户知道的是"它被应用了没有、动了什么" —— 那由接收那条路说
			 * （`reportIncomingSweep`：只有删 / 覆盖 / 保底回退才弹）。两句一起弹，
			 * 用户看到的就是"同步成功 + 收到 1 个包 + 已应用 3 个文件"三连，
			 * 每 5 分钟一轮（用户报的"右上角不断显示信息"）。
			 *
			 * **仅推例外**：那个方向根本不看接收文件夹（`wantsIncoming` 为 false），
			 * 这些包没有人会替你应用 —— 得说一句，不然它们会一直躺在远程仓库上。
			 */
			plugin.log.debug(`从 Git 远程收到 ${report.pulled.length} 个包，移走 ${report.deleted.length} 个`);
			// 排障要能回答「到底拉下来 / 撤下哪几个」：只有文件名时，分不清是对方的包还是自己的
			if (report.pulled.length > 0) {
				debugEvent('git.pulled', {
					files: report.pulled,
					direction: plugin.settings.syncDirection,
				});
			}
			if (plugin.settings.syncDirection === 'upload' && report.pulled.length > 0) {
				new Notice(`已从 Git 远程接收 ${report.pulled.length} 个同步包（仅推：不会自动应用）`, 9000);
			}
			/**
			 * **撤下要说一句**：那是删掉本机已有的文件（约定第 10 条：删了本机文件才弹）。
			 * 只说撤下几个，不说去处：单提交模式会先移进回收站，子目录形态是直接删
			 * （git 合流删的，插件没经手）；硬编码一处就等于对另一种形态说谎。
			 */
			if (report.deleted.length > 0) {
				debugEvent('git.deleted', {
					files: report.deleted,
					direction: plugin.settings.syncDirection,
				});
				new Notice(`远程撤下了 ${report.deleted.length} 个同步包。`, 9000);
			}
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
			deleted: 0,
			ahead: status?.ahead ?? 0,
			behind: status?.behind ?? 0,
			error: message,
		});
		await refreshStatusBar(plugin);
		plugin.log.error('git 同步失败', error);
		if (options.manual) {
			// 落后几个提交一并说出来：只报"失败"时用户不知道两边差了多少
			const behind = status?.behind ?? 0;
			new Notice(
				`Git 同步失败${behind > 0 ? `（落后 ${behind} 个提交）` : ''}。原因：${brief(message)}。`,
				8000,
			);
		}
		return false;
	} finally {
		plugin.gitBusy = false;
		// 只有演过「正在同步…」才需要回车；quiet / 后台没写过，别去动发起方的文案
		if (narrate) plugin.statusBar.showActivity(null);
	}
}

/**
 * 自动那条路（每 30 秒的节拍调）。
 *
 * 什么时候真的干活：
 * - 到了统一同步间隔（`autoSyncInterval`，0 ＝ 不自动拉）；
 * - 或者远程仓库里**有还没提交的包**（刚留过包 → 30 秒内推上去，不等拉取间隔）；
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
	 * 状态变了（刚应用 / 刚导出）就把"我现在在哪一步"写回远程仓库 —— 不等拉取间隔。
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
	// 自动节拍：安静 + **不演状态栏**（用户报的"右下角一直显示同步远程"）
	return syncGitNow(plugin, { quiet: true, background: true });
}

/**
 * **对方仍使用别的基准时，导出前提醒一句**（0.15.9）。
 *
 * 导出默认从"本机当前使用的那份完整备份"算起；对方若仍在使用更老（或另一份）完整备份上，
 * 这份包它无法应用。这里直接说清"从哪一份开始才能应用"、以及本机有没有那份副本。
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
			return `${who} 以完整备份为准 ${short}：导出前把「更新包起点」选成它，其他电脑才能应用`;
		}
		return `${who} 以完整备份为准 ${short}，本电脑没有它的完整备份：请其他电脑发一份完整备份，或把本电脑的完整备份发给其他电脑。`;
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
	if (base === '') return '尚未填写「同步包文件夹」。请在「同步包」页填写一个仓库之外的目录。';
	const remote = plugin.settings.gitRemote.trim();
	if (remote === '') return '尚未填写「远程地址」。请填写一个私有仓库的 HTTPS 或 SSH 地址。';
	const layout = detectGitLayoutSync(base);
	if (!layout) {
		return '尚未接入。请点击下方「接入这个远程…」将同步包文件夹初始化为 Git 仓库；'
			+ '或者把它放进一个已有仓库的子目录（比如 kf-personal-data），插件会跟着那个仓库同步。';
	}
	const current = readOriginUrl(layout.repo);
	if (!current) {
		return layout.hosted
			? `同步包文件夹在仓库 ${layout.repo} 里，但那个仓库没有远程地址。先在仓库里配好 origin。`
			: '尚未接入。请点击下方「接入这个远程…」补上远程地址。';
	}
	if (current !== remote) {
		return `Git 远程为 ${redactRemote(current)}，与设置中的地址不同。请先改回，或重新接入。`;
	}
	const where = layout.hosted ? `${redactRemote(remote)}（子目录 ${layout.rel}）` : redactRemote(remote);

	let state: PluginState | null = null;
	try {
		state = loadStateSync(plugin.stateFile());
	} catch {
		state = null;
	}
	const git = state?.git;
	if (!git) return `已连接 ${where}，尚未同步（请点击「现在同步一次」）。`;
	if (!git.ok) {
		return `已连接 ${where}，上次同步失败。原因：${git.error ?? '详情见日志'}（请点击「检查」排查）。`;
	}
	const parts = [`已连接 ${where}，并在 ${hhmm(git.at)} 完成一次推送与拉取`];
	if (git.pulled > 0) parts.push(`收到 ${git.pulled} 个同步包`);
	if (git.deleted > 0) parts.push(`撤下 ${git.deleted} 个同步包`);
	if (git.ahead > 0) parts.push(`还有 ${git.ahead} 项未推送`);
	if (git.behind > 0) parts.push(`还有 ${git.behind} 个提交待拉取`);
	return `${parts.join('；')}。`;
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
		lines.push('尚未填写「同步包文件夹」：请在「同步包」页填写一个仓库之外的目录');
		new GitStatusModal(plugin.app, lines).open();
		return;
	}
	if (remote === '') {
		lines.push('尚未填写「远程地址」：请填写一个私有仓库的 HTTPS 或 SSH 地址');
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
		lines.push('Git：未找到。请安装 Git（Windows 上为 Git for Windows），或在本页填写 git.exe 的路径。');
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
		lines.push('接入状态：已是 Git 仓库（「接入这个远程…」会补上远程与排除规则）');
	} else if (top.code === 0) {
		lines.push(`接入状态：在仓库 ${top.stdout.trim()} 里的子目录（提交只涉及这一段，推的是那个仓库当前的分支）`);
	} else {
		lines.push('接入状态：尚未接入（点击「接入这个远程…」；也可以将它放入已有仓库的子目录）');
	}

	// 真正联网的一步：ls-remote 会走 SSH / 凭据，把"连不上 / 没权限"立即暴露出来
	const ls = await run(['ls-remote', '--heads', remote, branch], 60_000)
		.catch(error => ({ code: -1, stdout: '', stderr: describe(error), timedOut: false }));
	if (ls.timedOut) {
		lines.push('连通性：超时。网络或凭据阻塞；SSH 可能在等待口令或确认主机内容编号。');
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

/** 远程仓库 `.git/config` 里 `origin` 的地址（读不到返回 null） */
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
 * 往上找第一个带 `.git` 的目录：就是它 → 独立远程仓库；在它上面 → 别人仓库的子目录。
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
 * 首次接入：把同步包文件夹初始化成 git 仓库、接上远程（只做这一次）。
 *
 * 之后所有同步都走 `syncGitNow` —— 用户不点这个按钮，插件不会自己往文件夹里写 `.git`。
 */
export async function connectGitRemote(plugin: LocallySavePlugin): Promise<void> {
	if (!plugin.settings.gitEnabled) {
		new Notice('请先开启「启用 Git 传输」');
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
		new Notice(`接入失败。原因：${brief(message)}。`, 8000);
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
				? '已接入 Git：此后导出会自动提交并推送'
				: hosted
					? '同步包文件夹已在远程仓库中：不新建仓库，使用该仓库当前分支（仅提交这一段）'
					: '已经接入过，这一轮也同步完了',
			8000,
		);
	}
}

/**
 * 「让对面和我一致」：把我这边的改动导成更新包、推上去。
 *
 * **只推不收**（方向那项也是这么写的）：对面拉下来、应用之后才会变成我这样。
 * 不在这里替用户决定"要不要一并接收对方的包" —— 那是 `both` 与「让我和对面一致」的事。
 */
export async function uploadNow(plugin: LocallySavePlugin): Promise<void> {
	if (!plugin.settings.enabled) return;
	if (!plugin.settings.gitEnabled) {
		new Notice('请先开启「启用 Git 传输」：设置 → Git 远程');
		return;
	}
	const shelf = shelfOptions(plugin);
	if (!shelf) {
		new Notice('先把「同步包文件夹」和「远程地址」填上', 9000);
		return;
	}
	if (!(await isShelf(shelf.dir, { gitPath: shelf.gitPath }))) {
		new Notice('同步包文件夹尚未连接 Git：请先点击「接入这个远程…」', 9000);
		return;
	}

	let exported: string | null = null;
	try {
		// 不管自动导出开没开：用户明确点了"推"，有改动就导一份（引擎在没变化时返回 file: null）
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
		new Notice(`导出失败。原因：${brief(describe(error))}。`, 8000);
		return;
	}

	// 只留一句总结：`syncGitNow` 手动模式自己也会弹一条，两条叠在一起用户要读两遍
	const synced = await syncGitNow(plugin, { quiet: true });
	if (!synced) {
		new Notice('推送或拉取失败：详情见状态栏或日志；已导出的包会在下次同步时重试', 9000);
		return;
	}
	new Notice(exported ? '已推送，等其他电脑拉取并应用' : '没有新改动，远程已是最新', 6000);
}

/**
 * 「让我和对面一致」：拉下来，然后用对方最新的更新包**严格对齐**到它那一份状态。
 *
 * 对齐全走引擎的严格镜像：本机改过的、多出来的文件先移到回收目录（备份），
 * 目标状态 ＝ 本机的基准 ＋ 包里的条目 − 包点名的删除 —— 正好是对方那一点，做完内容校验值一致。
 * 会覆盖本机内容，所以先弹一句确认。
 */
export async function downloadNow(plugin: LocallySavePlugin): Promise<void> {
	if (!plugin.settings.enabled) return;
	if (!plugin.settings.gitEnabled) {
		new Notice('请先开启「启用 Git 传输」：设置 → Git 远程');
		return;
	}
	const shelf = shelfOptions(plugin);
	if (!shelf) {
		new Notice('先把「同步包文件夹」和「远程地址」填上', 9000);
		return;
	}
	if (!(await isShelf(shelf.dir, { gitPath: shelf.gitPath }))) {
		new Notice('同步包文件夹尚未连接 Git：请先点击「接入这个远程…」', 9000);
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
	} catch {
		new Notice('读不到本电脑状态', 6000);
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
		new Notice('没有其他电脑的更新包可对齐', 6000);
		return;
	}

	new ConfirmModal(plugin.app, {
		title: '推送本电脑的改动',
		lines: [
			`会用其他电脑的更新包「${target.name}」把本电脑改成其他电脑那一份状态。`,
			'本电脑改动或新增的文件会先移入回收目录，可从回收目录恢复。',
			'做完两台电脑的内容编号应当一致；本电脑的新改动之后靠「拉取其他电脑的改动」推回去。',
		],
		confirmText: '以其他电脑为准',
		onConfirm: () => { void applyAlign(plugin, target.file); },
	}).open();
}

/**
 * **刷新包：把远程仓库对齐到远程**（用户点的动作）。
 *
 * 用户现场："包弄乱了我会删，这时候要从远程重新拉最新的……现在删了他就不会拉了，
 * 一直拉不下来。" 自动同步碰上"本地有提交 + 远程也有提交"必须停下（不能替用户 rebase 仓库），
 * 于是给一个明确的出口：丢掉远程仓库那一段的本地提交/改动，整段对齐远程，再把新包捡起来。
 */
export async function refreshBundlesAction(plugin: LocallySavePlugin): Promise<void> {
	if (!plugin.settings.enabled) return;
	if (!plugin.settings.gitEnabled) {
		new Notice('请先开启「启用 Git 传输」：设置 → Git 远程');
		return;
	}
	const shelf = shelfOptions(plugin);
	if (!shelf) {
		new Notice('先把「同步包文件夹」和「远程地址」填上', 9000);
		return;
	}
	if (!(await isShelf(shelf.dir, { gitPath: shelf.gitPath }))) {
		new Notice('同步包文件夹尚未连接 Git：请先点击「接入这个远程…」', 9000);
		return;
	}
	if (plugin.gitBusy || plugin.bundleBusy || plugin.incomingBusy || isApplying()) {
		new Notice('正在同步 / 应用，等这一步做完再刷新', 6000);
		return;
	}
	/**
	 * **防呆：刷新会把"还没推上去的东西"一起丢掉**（0.18.2，用户报的现场：
	 * 删掉一份包之后立刻点「刷新包」，那份包又被 `reset --hard origin` 拉回来了）。
	 *
	 * 删除在本地是一笔**还没提交/推送的改动**，刷新是"整段对齐远程"——两者一撞，
	 * 用户看到的就是"删了又回来"。所以先算清楚会丢什么，让他明确点一次。
	 */
	{
		const status = await readShelfStatus(shelf).catch(() => null);
		const pending = readRemovals(shelf.dir).size;
		const ahead = status?.ahead ?? 0;
		if (ahead > 0 || pending > 0) {
			const lines = [
				'刷新是「整段对齐远程」：本地还没推送的东西会被丢掉，远程还留着的包会重新拉取。',
			];
			if (pending > 0) {
				lines.push(`有 ${pending} 处删除尚未推送：刷新后那些包会重新出现。`);
			}
			if (ahead > 0) lines.push(`本地还有 ${ahead} 次提交未推送（可能包含刚导出的包或刚删除的包）。`);
			lines.push('确定要丢吗？只想把删除推走，先点一次「立即同步」。');
			const ok = await new Promise<boolean>(resolve => {
				const modal = new ConfirmModal(plugin.app, {
					title: '刷新将丢弃本地未推送的改动',
					lines,
					confirmText: '仍然刷新',
					onResolve: value => { resolve(value); void modal; },
				});
				modal.open();
			});
			if (!ok) return;
		}
	}
	plugin.gitBusy = true;
	try {
		plugin.reportProgress({ done: 0, total: 0, path: '', label: '刷新中' });
		const report = await refreshShelf({
			...shelf,
			onStage: (stage, step) => plugin.reportProgress({
				done: 0,
				total: 0,
				path: '',
				label: step ? `${step.index}/${step.total} ${stage}` : stage,
			}),
		});
		plugin.reportProgress(null);
		plugin.log.debug(
			`从远程刷新：丢弃本地 ${report.dropped} 笔提交，收到 ${report.pulled.length} 个同步包（HEAD ${report.head ?? '?'}）`,
		);
		new Notice(
			`已与远程仓库对齐，丢弃本地 ${report.dropped} 次提交。`
				+ `，新到 ${report.pulled.length} 个包`,
			8000,
		);
		await refreshStatusBar(plugin);
		// 新到的包可能就是要应用的那一份：按当前方向再走一遍接收
		if (report.pulled.length > 0) await syncGitNow(plugin, { quiet: true });
	} catch (error) {
		plugin.reportProgress(null);
		const message = error instanceof Error ? error.message : String(error);
		new Notice(`刷新失败。原因：${message}。`, 9000);
		plugin.log.error('刷新远程仓库失败', error);
	} finally {
		plugin.gitBusy = false;
	}
}

/** 真正按其他电脑对齐（见 `downloadNow` 的说明）；strictness 用界面上那唯一一种：mirror */
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
		// 状态变了：赶紧把"我现在的状态"写进远程仓库，别让对面看到旧的那份
		const state = await loadState(plugin.stateFile());
		const peer = await writePeer(bundleBaseDir(plugin.settings), state, plugin.vaultName());
		if (peer.error) plugin.log.debug(`写本电脑状态失败：${peer.error}`);
		await syncGitNow(plugin, { quiet: true });
		new Notice(
			result.stateIdCompare === 'match'
				? '已与其他电脑一致'
				: '应用完成，但内容编号尚未完全一致（详情见更新记录）',
			6000,
		);
	} catch (error) {
		new Notice(`应用失败。原因：${brief(describe(error))}。`, 8000);
		plugin.log.error('按其他电脑对齐失败', error);
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
		: 'Git：未找到。请安装 Git（Windows 上为 Git for Windows），或在本页填写 git.exe 的路径。');

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
			// 对表：对方现在在哪一步（远程仓库里的 `.lsave-peers/*.json`）
			try {
				const state = await loadState(plugin.stateFile());
				lines.push(`本电脑的内容编号是 ${state.stateId?.id ?? '尚未计算'}，当前是第 ${state.generation} 版。`
					+ ` · 完整备份 ${state.bundle?.fullGeneration ?? '?'} 版 ${state.bundle?.fullHash ?? '未记'}`);
				const peers = readPeers(shelf.dir, state.copyId);
				if (peers.length === 0) {
					lines.push('另一台尚未上报状态（它完成一次同步后才会出现）。');
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

/** 在系统文件管理器里打开远程仓库（同步包文件夹不存在时说明一句） */
export function openShelfFolder(plugin: LocallySavePlugin): void {
	const base = bundleBaseDir(plugin.settings);
	if (base === '') {
		new Notice('还没设置「同步包文件夹」：设置 → Locally Save → 同步包');
		return;
	}
	if (!fs.existsSync(base)) {
		new Notice(`同步包文件夹还不存在：${base}（请先在「导出同步包…」里导出一次）`, 9000);
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
 * 手动推送和拉取那一句：**git 这一层**干了什么 + **内容这一层**各台机器对不对得上。
 *
 * 不再只写"同步完成"：推上去不等于对方应用了，更不等于两边内容一样；
 * `peer` 那半句来自 `.lsave-peers`（状态栏同一套判据），会明确说"一致 / 待上报 / 不同步"。
 */
function describeReport(report: GitSyncReport, peer?: string | null): string {
	const parts: string[] = [];
	if (report.pulled.length > 0) parts.push(`收到 ${report.pulled.length} 个包`);
	if (report.deleted.length > 0) parts.push(`撤下 ${report.deleted.length} 个包`);
	const incoming = report.pulled.length > 0 || report.deleted.length > 0;
	const action = report.pushed
		? (incoming ? '已完成推送和拉取' : '已推送')
		: (incoming ? '已拉取' : '远程已是最新');
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
