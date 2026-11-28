import { Notice } from 'obsidian';
import { debugEvent } from '../debugLog';
import { exportBundle, planBundleExport, plannedExportModes } from '../bundle/export';
import type { BundleExportPreview, ExportOptions, ExportOutcome } from '../bundle/export';
import { pickIncoming, sweepIncoming, unappliedIncoming } from '../bundle/incoming';
import type { IncomingCandidate, IncomingPolicy, IncomingSweep } from '../bundle/incoming';
import { describeExportRange } from '../bundle/log';
import { describeGcRun, planBundleGc, runBundleGc } from '../bundle/gc';
import { listBundles } from '../bundle/manage';
import { bundleBaseDir } from '../bundle/paths';
import type { BundleMode } from '../bundle/paths';
import type { ApplyOptions, ApplyPlan } from '../bundle/apply';
import { isShelf } from '../git/shelf';
import { readPeers } from '../git/peers';
import type LocallySavePlugin from '../main';
import { DEFAULT_MTIME_TOLERANCE_MS, sameRecord } from '../sync/diff';
import { scanTree } from '../sync/disk';
import { loadState } from '../sync/state';
import type { PluginState } from '../sync/state';
import { computeStateId } from '../sync/state-id';
import { anchorFingerprintOf } from '../settings/model';
import type { PluginSettings, SyncDirection } from '../settings/model';
import type { Inventory } from '../sync/types';
import { VAULT_TRASH_DIR, excludePatterns } from '../sync/vault';
import { ApplyBundleModal, ExportBundleModal } from './bundle-modal';
import { ExportPreviewModal } from './export-preview-modal';
import { BundleManagerModal } from './manage-modal';
import { BundleLogModal } from './log-modal';
import { syncGitNow, peerBaselineHint } from './git';
import { runRebaselineDiffs, ensureLocalBaselineBundle } from './rebaseline';
import { peerStatusText, refreshStatusBar } from './status';
import { ConfirmModal } from './confirm-modal';

/**
 * 命令背后的动作：统一处理"总开关、串行、报错、通知、状态栏"，
 * 命令注册那边只留一行接线（见 commands/index.ts）。
 *
 * 0.8.0 起这里只有**同步包**一条通道：导出（导出）与应用（导入）。
 * 那个"同步到本地文件夹副本"的动作连同它的引擎（`sync/runner.ts`）一起删掉了 ——
 * 共用目录那种用法交给 Remotely Save 这类走云的插件，这里只做不联网的单文件搬运。
 */

/** 串行锁的标记在插件上（`plugin.bundleBusy`）：定时导出的节拍也要看它 */
function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 没填包目录时，界面上所有要写包 / 找包的动作都用这一句提示 */
export function bundleDirHint(): string {
	return '还没设置「同步包文件夹」：设置 → Locally Save → 同步包';
}

/**
 * **「仅拉」＝只收不发**（`direction: download`）：自动导出、「立即同步」、回传都不写包。
 *
 * 为什么连"完整备份"也不导：这台机器的职责是跟着对面走，写一份包出来只会在远程仓库上多一份
 * 没人要的东西（而且完整备份很大）。要导就手动点「导出同步包…」——那是用户的明确动作。
 */
export function isReceiveOnly(settings: PluginSettings): boolean {
	return settings.gitEnabled && settings.syncDirection === 'download';
}

/**
 * 「Git 同步失败」那一句：带上落后几个提交。
 *
 * 只说"失败"时用户不知道差多少：落后 1 个和落后 20 个要处理的事不一样
 * （2026-11-23 现场：落后 20 个提交、三个多小时没拉成功，界面上只有一句失败）。
 * `behind` 是 `state.git.behind`，同步失败时也照样记下来了。
 */
export function syncFailureText(behind: number): string {
	return behind > 0 ? `Git 同步失败（落后 ${behind} 个提交）` : 'Git 同步失败';
}

/**
 * 「立即同步」在「仅拉」方向上的那条总结（纯函数，测试直接跑）。
 *
 * **拉取失败不能说成「没有新包」**：仅拉这台不导出，远程仓库里有没有新东西全靠这一趟拉取；
 * 拉取失败时远程仓库里当然什么都没有，报「没有新包」会让人以为对面根本没发东西
 * （2026-11-23 现场：网络超时的那一拍，界面写的就是「没有新包」）。
 */
export function receiveOnlySummary(input: {
	label: string;
	acted: boolean;
	pullOk: boolean;
	pullError?: string | null;
	waiting: number;
	peer?: string | null;
}): string {
	if (!input.pullOk) {
		const why = input.pullError ? `：${brief(input.pullError)}` : '';
		const waiting = input.waiting > 0 ? ` · 本地还有 ${input.waiting} 个包没应用` : '';
		return `${input.label}：拉取失败${why}${waiting}`;
	}
	const parts = [`${input.acted ? '已应用其他电脑的包' : '没有新包'}（仅拉：不导出）`];
	if (input.waiting > 0) parts.push(`还有 ${input.waiting} 个包没应用`);
	if (input.peer) parts.push(input.peer);
	return `${input.label}：${parts.join(' · ')}`;
}

/** 一轮导出的结果：给「立即同步」拼一句总结用（不弹通知那条路也拿得到） */
export interface ExportRunResult {
	text: string;
	wrote: boolean;
	advice: string | null;
	noChanges: boolean;
	/** 这一轮写了完整备份（它**不提交到 Git**，要给用户一句"手动复制给其他电脑"） */
	fullWritten: boolean;
}

/** 「立即同步」正在跑：它要串起"导出 → 推送和拉取 → 接收"三步，中间别让第二次点击插进来 */
let syncing = false;

/**
 * 立即导出：按两个「自动导出」开关留一次。
 *
 * 自动触发（启动 / 定时 / 保存后）**都走这里** —— 导出自己就是一条完整的动作，跟别的通道没关系。
 *
 * `quiet`：自动触发传 true —— "没有变化、没生成包"这种**正常结果**只写状态栏与日志，
 * 不弹通知（不然每 5 分钟的定时导出都在眼前闪一条）。真写出了包、或者失败了，照样弹。
 * `silent`：「立即同步」用 —— 它自己拼一句总结，不要让这里先弹一条。
 * `defaultWhenOff`：两个自动导出开关都没开时也给个默认（有基准导更新包、没基准导完整备份）。
 */
export async function exportBundlesNow(
	plugin: LocallySavePlugin,
	label = '导出',
	options: { quiet?: boolean; silent?: boolean; defaultWhenOff?: boolean; retried?: boolean } = {},
): Promise<ExportRunResult | null> {
	if (!plugin.isActive()) return null;
	/**
	 * **「仅拉」在这个交汇点上再拦一道**（不是只靠调用方各自记得）：
	 * 这个方向一个包都不写 —— 启动 / 定时 / 保存后 / 「立即同步」/ 回传都不写，
	 * 手动「导出同步包…」是用户的明确动作，走的是另一条路（`exportBundleAction`）。
	 *
	 * 为什么要拦在这里：以前只在 `main.tickExport` 与 `syncNow` 里判，任何新入口
	 * （命令、别的面板按钮）忘了判就会在"只收不发"的机器上写出一份包，
	 * 下一轮 Git 同步一并把它推上去 —— 用户报过"回退了某一份完整备份之后，
	 * 只同步没想导出，包却被上传了"。
	 */
	if (isReceiveOnly(plugin.settings)) {
		plugin.log.debug(`${label}：仅拉方向，不写包`);
		return { text: '仅拉：不导出同步包', wrote: false, advice: null, noChanges: true, fullWritten: false };
	}
	if (plugin.bundleBusy) {
		if (!options.silent) new Notice('上一次导出尚未完成');
		return null;
	}
	/**
	 * **正在和远程同步就别开始写包**（0.18.3）。
	 *
	 * 同步会在包目录里 `git add -A` 并提交，而 `writeBundle` 是直接写最终路径的 ——
	 * 正好撞上就会把**写到一半的包**提交上去，对面拉下来是个坏包。
	 * 反过来的方向已经挡着（`syncGitNow` 遇到 `bundleBusy` 会让路），这里把另一个方向补齐；
	 * 手动导出那条路由弹窗自己挡（`ExportBundleModal`），自动触发这一条等一下再来。
	 */
	if (plugin.gitBusy) {
		plugin.log.debug(`${label}：正在和远程同步，稍后再导出`);
		if (options.retried !== true && typeof window !== 'undefined') {
			window.setTimeout(() => {
				void exportBundlesNow(plugin, label, { ...options, retried: true });
			}, 5_000);
		}
		return null;
	}
	plugin.bundleBusy = true;
	try {
		return await runExport(plugin, label, options.quiet === true, options);
	} finally {
		plugin.bundleBusy = false;
		// 记下"刚跑过"：定时导出的节拍靠它判断到没到点（手工导出也算数）
		plugin.lastBundleAt = Date.now();
		plugin.reportProgress(null);
	}
}

/**
 * 这次发号的**下限**：远程仓库上已经能看到的最高代。
 *
 * 两台机器各自导出时，如果都只看自己的 `maxGeneration`，就会各发一个第 N 版
 * （内容还不一样）—— 用 git 交换过 peer 状态 / 包之后，重新发号时取"已知最大 + 1"，
 * 后导的那一份就排到下一个号上。
 *
 * 只读：peer 状态 + 现有包头部；不联网。`syncNow` 会在导出前先 git 同步一次，
 * 所以这里看到的是对方刚推上来的号。
 */
async function generationFloor(plugin: LocallySavePlugin, base: string): Promise<number> {
	let floor = 0;
	try {
		const state = await loadState(plugin.stateFile());
		for (const peer of readPeers(base, state.copyId)) {
			floor = Math.max(
				floor,
				peer.generation,
				peer.lastExport?.target ?? 0,
				peer.lastApply?.target ?? 0,
				peer.baselineGeneration ?? 0,
			);
		}
		for (const item of await listBundles(base)) {
			const header = item.header;
			if (!header) continue;
			floor = Math.max(floor, header.targetGeneration ?? 0, header.baseGeneration ?? 0);
		}
	} catch (error) {
		plugin.log.debug('读发号下限失败（按本电脑高水位发）', error);
	}
	return floor;
}

/** 导出通知只留一句：留了哪种、要不要手动搬完整备份。细节看更新记录 */
function shortNotice(label: string, wrote: boolean, noChanges: boolean, fullWritten: boolean): string {
	if (!wrote) return `${label}：${noChanges ? '没有变化' : '没有生成包'}`;
	return fullWritten
		? `${label}：已导出完整备份（需手动复制给其他电脑）`
		: `${label}：已导出更新包`;
}

/** 真的跑一轮；同一时间只允许一轮（上面的锁） */
async function runExport(
	plugin: LocallySavePlugin,
	label: string,
	quiet: boolean,
	options: { silent?: boolean; defaultWhenOff?: boolean; generationFloor?: number } = {},
): Promise<ExportRunResult | null> {
	const { autoExportChanges, autoExportFull } = plugin.settings;
	if (!autoExportChanges && !autoExportFull && options.defaultWhenOff !== true) {
		if (!options.silent) new Notice('「导出更新包」「导出完整备份」均未开启：请在 设置 → 自动导出同步包 中开启一项', 6000);
		return null;
	}
	const base = bundleBaseDir(plugin.settings);
	if (!base) {
		if (!options.silent) new Notice(bundleDirHint(), 9000);
		return null;
	}

	try {
		// 发号前先看远程仓库上已知的最高代（别的机器的 peer 状态 + 现有包）——
		// 两台机器各导一份时，后导的那一份不会再用对方的号
		const floor = options.generationFloor ?? await generationFloor(plugin, base);
		const result = await writePlannedBundles(plugin, base, { ...options, generationFloor: floor });
		const text = result.notes.length > 0 ? result.notes.join('、') : '没有生成包';
		// 自动触发 + 没有变化：正常结果，不打扰（状态栏与日志照写）
		if (result.noChanges && quiet) {
			await refreshStatusBar(plugin);
			plugin.log.debug(`${label}：${text}`);
			return { text, wrote: false, advice: null, noChanges: true, fullWritten: false };
		}
		// 「该立新完整备份了」这句提醒：自动导出时**只写状态栏与日志、不弹通知** ——
		// 提醒不是"出事了"，没必要在用户眼前闪一条；手动导出时连着结果一起说。
		const said = !quiet && result.advice ? `${text}、${result.advice}` : text;
		// 通知只说结果（一句）；文件名、路径、版本这些细节在更新记录 / 日志里
		/**
		 * **自动触发（quiet）只在"真需要你动手"时弹**（0.16.14）：
		 * 完整备份不提交到 Git，得自己复制给对方 —— 这一句必须说；更新包写完会自己推上去，
		 * 属例行结果，只写状态栏与日志（用户报的"右上角不断显示信息"：
		 * 每 5 分钟一条"定时同步：已导出更新包"，其实没人需要看）。
		 */
		if (!options.silent && (!quiet || result.fullWritten)) {
			new Notice(shortNotice(label, result.wrote, result.noChanges, result.fullWritten), 5000);
		}
		await refreshStatusBar(plugin);
		plugin.log.debug(`${label}：${text}${result.advice ? `；${result.advice}` : ''}`);
		return { text: said, wrote: result.wrote, advice: result.advice, noChanges: result.noChanges, fullWritten: result.fullWritten };
	} catch (error) {
		const message = describe(error);
		if (!options.silent) new Notice(`${label}失败。原因：${message}。`, 9000);
		plugin.log.error(`${label}失败`, error);
		return null;
	}
}

/**
 * 状态栏 / 同步总结里那句"对方：…"：读本地远程仓库的 peer 状态文件，不联网。
 *
 * 只认状态栏同一个判据（`peerStatusText`），别在这里另写一套 —— 两处说法不一致时，
 * 用户会以为"通知说同步了、右下角说没同步"是插件坏了。
 */
async function peerShortFor(plugin: LocallySavePlugin, base: string): Promise<string | null> {
	if (!plugin.settings.gitEnabled) return null;
	try {
		const state = await loadState(plugin.stateFile());
		return peerStatusText(readPeers(base, state.copyId), state).short;
	} catch {
		return null;
	}
}

/**
 * 远程仓库上还有几个"看过、但没应用成"的包（`needs-review` / `failed`）。
 *
 * 只给「立即同步」的总结用：那句总结如果说成"没有新改动"，用户会以为两边已经一致 ——
 * 而实际上可能正躺着一份包等他处理（读不到就当 0，不该因为一个统计把同步说成失败）。
 */
async function unappliedCount(plugin: LocallySavePlugin, base: string): Promise<number> {
	try {
		const state = await loadState(plugin.stateFile());
		return unappliedIncoming(await listBundles(base), state).length;
	} catch {
		return 0;
	}
}

/**
 * **立即同步**（主入口）：导出包 → 和 git 远程推送和拉取 → 应用拉下来的安全更新。
 *
 * 这是用户面前那一个按钮（左侧栏第一个图标、`sync-now` 命令、Git 页的「立即同步」）。
 * 三步串起来的原因：用户想的是"把两边的改动对上"，而不是"先留个包、再去另一处点同步"。
 * 默认导出什么：自动导出开关开了就按它；都没开时有基准导更新包、没基准导完整备份 ——
 * 否则第一次用"立即同步"会什么都不发。
 *
 * 有一步失败不影响后面的（导出失败还照样推送和拉取，推送和拉取失败也把已导出的包留下），
 * 最后**只弹一句**总结，细节在状态栏 / 日志里。
 */
export async function syncNow(plugin: LocallySavePlugin, label = '立即同步'): Promise<void> {
	debugEvent('sync.start', { label });
	if (!plugin.isActive()) {
		debugEvent('sync.skip', { reason: 'inactive' });
		return;
	}
	const base = bundleBaseDir(plugin.settings);
	if (base === '') {
		debugEvent('sync.skip', { reason: 'no-bundle-dir' });
		new Notice(bundleDirHint(), 9000);
		return;
	}
	if (syncing || plugin.bundleBusy || plugin.gitBusy) {
		debugEvent('sync.skip', {
			reason: 'busy',
			syncing,
			bundleBusy: plugin.bundleBusy,
			gitBusy: plugin.gitBusy,
		});
		new Notice('上一次同步或导出尚未完成');
		return;
	}

	syncing = true;
	try {
		const gitPath = plugin.settings.gitPath.trim();
		const connected = plugin.settings.gitEnabled
			&& await isShelf(base, gitPath !== '' ? { gitPath } : {});

		/**
		 * **先交换一次，再发号**：对方可能刚推了一个第 N 版包，我这边如果只看自己的高水位，
		 * 就会再发一个同版本包。先 git 同步（只拉/推，不应用），`generationFloor` 才看得到对方的号。
		 * 这次失败不挡导出：离线时照常导出，后面那次同步再试。
		 */
		let pullOk = true;
		if (connected) {
			plugin.statusBar.showActivity(`${label}：拉取其他电脑状态…`);
			pullOk = await syncGitNow(plugin, { quiet: true });
		}

		/**
		 * **「仅拉」只收不发**：不导出、也不推自己的包 —— 拉下来的包直接应用。
		 * 应用完把本机状态写进远程仓库（`syncGitNow` 会顺带写 peer）—— 只写那一小份状态，不是包。
		 */
		if (isReceiveOnly(plugin.settings)) {
			plugin.statusBar.showActivity(`${label}：应用…`);
			const acted = await checkIncomingBundles(plugin, { manual: true });
			// 应用完立刻把新状态推上去（`syncGitNow` 会先写 peer，再提交推送）：
			// 对面下一次拉取就能看到"我已经应用了"，而不是等下一次节拍
			if (acted) await syncGitNow(plugin, { quiet: true });
			await refreshStatusBar(plugin);
			const waiting = await unappliedCount(plugin, base);
			const peer = await peerShortFor(plugin, base);
			new Notice(
				receiveOnlySummary({
					label,
					acted,
					pullOk,
					pullError: pullOk ? null : ((await loadState(plugin.stateFile())).git?.error ?? null),
					waiting,
					peer,
				}),
				6000,
			);
			return;
		}

		plugin.statusBar.showActivity(`${label}：导出同步包…`);
		const exported = await exportBundlesNow(plugin, label, {
			quiet: true,
			silent: true,
			defaultWhenOff: true,
		});
		const parts: string[] = [];
		if (!exported) parts.push('导出失败');
		else if (exported.noChanges) parts.push('没有改动');
		else if (exported.fullWritten) parts.push('已导完整备份');
		else parts.push('已导更新包');

		if (!plugin.settings.gitEnabled) {
			parts.push('Git 传输未启用');
			new Notice(`${label}：${parts.join(' · ')}`, 5000);
			await refreshStatusBar(plugin);
			return;
		}

		if (!connected) {
			parts.push('Git 远程尚未接入');
			new Notice(`${label}：${parts.join(' · ')}`, 6000);
			await refreshStatusBar(plugin);
			return;
		}

		plugin.statusBar.showActivity(`${label}：推送与拉取…`);
		if (!(await syncGitNow(plugin, { quiet: true }))) {
			// 只说"失败"没说差多少：落后几个提交在状态文件里已经算出来了，带上它
			parts.push(syncFailureText((await loadState(plugin.stateFile())).git?.behind ?? 0));
			new Notice(`${label}：${parts.join(' · ')}`, 7000);
			await refreshStatusBar(plugin);
			return;
		}

		// 拉下来的包交给接收那条路。**手动点了同步**：上次被拦下的包也再试一次，
		// 不然它会在 `state.incoming` 里躺到永远，两边代数一直差着（用户报的 108 / 109）
		plugin.statusBar.showActivity(`${label}：应用…`);
		const acted = await checkIncomingBundles(plugin, { manual: true });
		/**
		 * 结果按"用户实际关心什么"分三层：
		 * - 我这边有没有导出 / 推上去；
		 * - 有没有收到并应用对面的包；
		 * - **内容层面各台机器对不对得上**（`对方：…`，可能与"推送和拉取成功"不同）。
		 *
		 * 不再用一句"已同步"把这三层糊在一起：推上去只说明远程有我的包，
		 * 对方没拉、没应用之前，内容仍然是"待上报"。
		 */
		if (acted) {
			parts.push('已应用其他电脑的包');
			// 应用完立刻推一次：新的内容校验值 / 基准要让对面下一次拉取就看得到，
			// 别等下一次 30 秒节拍（不然对面会在这一小段时间里报"不同步"）
			await syncGitNow(plugin, { quiet: true });
		} else if (exported?.wrote && !exported.fullWritten) {
			parts.push(plugin.settings.syncDirection === 'upload' ? '已推送，等待其他电脑拉取' : '已推送');
		} else if (exported?.fullWritten) {
			// 完整备份在 .git/info/exclude 里，不随 git 走 —— 别写成"已推送"
			parts.push('完整备份不通过 Git 传输，需手动复制给其他电脑');
		} else if (exported?.noChanges) {
			parts.push('没有新改动');
		} else {
			parts.push('已完成推送与拉取');
		}
		/**
		 * **别让"没有新改动"读成"两边已经一样了"**：远程仓库上可能还躺着一份没应用成的包
		 * （完整备份、或者是让用户自己看的那种）。明明两边代数差着一截，点同步却只说"已经最新"，
		 * 用户只会当成插件坏了（报过的现场：一台 108、一台 109）。
		 */
		const waiting = await unappliedCount(plugin, base);
		if (waiting > 0) parts.push(`还有 ${waiting} 个包没应用（用「打开同步包并应用…」查看）`);
		const peer = await peerShortFor(plugin, base);
		if (peer) parts.push(peer);
		await refreshStatusBar(plugin);
		new Notice(`${label}：${parts.join(' · ')}`, 6000);
	} finally {
		syncing = false;
		plugin.lastBundleAt = Date.now();
		plugin.reportProgress(null);
		plugin.statusBar.showActivity(null);
	}
}

/**
 *
 * 三处刻意省：
 * - 整库**只扫一次**，两个包共用同一份清单；
 * - 自上次导出以来没有任何变化时**一个包都不写** —— 完整备份一写就是整库重写；
 * - 完整备份刚留过的话，更新包按它算必然是空的，那就不写空包，只说明一句。
 *
 * `advice` 单独拎出来（不放进 `notes`）：调用方要按"手动 / 自动触发"决定它去哪儿 ——
 * 自动触发只写状态栏与日志，不弹通知（见 `runExport`）。
 */
async function writePlannedBundles(
	plugin: LocallySavePlugin,
	base: string,
	options: { defaultWhenOff?: boolean; generationFloor?: number } = {},
): Promise<{ notes: string[]; advice: string | null; wrote: boolean; noChanges: boolean; fullWritten: boolean }> {
	const inventory = await scanVault(plugin);
	const state = await loadState(plugin.stateFile());
	const generationFloor = options.generationFloor ?? 0;
	if (!(await hasContentChanges(plugin, state, inventory))) {
		return {
			notes: ['自上次导出以来没有变化，没有生成包（要导完整备份，用「导出同步包…」）'],
			advice: null,
			wrote: false,
			noChanges: true,
			fullWritten: false,
		};
	}

	const { autoExportChanges, autoExportFull } = plugin.settings;
	const hasBaseline = Boolean(state.bundle?.fullHash);
	const configured = plannedExportModes({ changes: autoExportChanges, full: autoExportFull });
	/**
	 * 这一轮导哪几种：
	 * - 两个自动导出开关开了哪个就按哪个（与老行为一致）；
	 * - **「立即同步」第一次没有基准**：不管自动开关开的是哪个，都先导完整备份 ——
	 *   只开「导出更新包」时更新包没有起点，算不出来；否则第一次点同步会什么都不发；
	 * - 自动触发没有基准、只开了「导出更新包」：照旧交给引擎说清"先导完整备份"，
	 *   不硬写一份空更新包。
	 */
	const modes = options.defaultWhenOff === true && !hasBaseline
		? ['full' as const]
		: configured.length > 0
			? configured
			: (options.defaultWhenOff === true
				? (hasBaseline ? ['changes' as const] : ['full' as const])
				: []);
	if (modes.length === 0) {
		return {
			notes: ['「导出更新包」与「导出完整备份」都没开，没有生成包'],
			advice: null,
			wrote: false,
			noChanges: true,
			fullWritten: false,
		};
	}
	const notes: string[] = [];
	/** 这一轮已经导出来的包：导完整备份时别把它们当成"被取代的旧包"清掉 */
	const written: string[] = [];
	/** 这一轮留过完整备份：紧随其后的更新包必然是空的 */
	let fullWritten = false;
	let wrote = false;
	/** 「该立新完整备份了」（引擎按这份包自起点以来要搬的字节数算好，没到阈值时是 null） */
	let advice: string | null = null;

	for (const mode of modes) {
		const result = await writeBundleFile(plugin, base, mode, inventory, written, generationFloor);
		if (result.kind === 'written') {
			wrote = true;
			if (mode === 'full') {
				fullWritten = true;
				/**
				 * 完整备份不提交到 Git —— 导完同时给**还仍使用旧的完整备份**的那几台各导一份差分更新包
				 * （谁的起点在本机、谁和我同一分支都算在计划里）。
				 *
				 * 阈值别放宽：**一台都没上报过就什么都不做**（那种情况本来就把完整备份整份复制过去），
				 * 一份谁都用不上的包只会白占远程仓库。
				 */
				const detail = await runRebaselineDiffs(plugin, base);
				if (detail) notes.push(detail);
			}
			if (result.outcome.advice) advice = result.outcome.advice;
			notes.push(mode === 'full'
				? `已导出完整备份（${result.outcome.entryCount} 个文件）`
				: `已导出更新包（${result.outcome.entryCount} 个文件`
					+ `${result.outcome.deletedCount > 0 ? `、删除 ${result.outcome.deletedCount}` : ''}`
					+ `${result.outcome.moveCount > 0 ? `、移动 ${result.outcome.moveCount} 处` : ''}）`
					+ describeExportRange(result.outcome));
			if (result.outcome.retired.length > 0) {
				notes.push(`${result.outcome.retired.length} 个更新包的完整备份已无电脑使用，已移到回收站`);
			}
			continue;
		}
		// 空的更新包：完整备份刚留过时它必然空，别写；其余情况如实说一句"没有变化"
		if (result.kind === 'empty' && mode === 'changes') {
			notes.push(fullWritten && !result.reason?.includes('已经导过')
				? '更新包是空的（刚留的完整备份已含全部内容），没生成'
				: (result.reason ?? '没有变化，更新包没生成'));
			continue;
		}
		if (result.kind === 'failed') {
			notes.push(mode === 'full' ? `完整备份没导成（${result.error}）` : `更新包没导成（${result.error}）`);
		}
	}
	return { notes, advice, wrote, noChanges: false, fullWritten };
}

/** 扫一遍仓库（用户的排除规则与运行时才知道的配置目录都在这里生效） */
async function scanVault(plugin: LocallySavePlugin): Promise<Inventory> {
	const exclude = excludePatterns(plugin.settings.excludePatterns, plugin.configDir());
	return scanTree(plugin.vaultRoot(), { exclude, skipTopLevelDirs: [VAULT_TRASH_DIR] });
}

/**
 * 仓库自上次导出以来有变化吗（没有就不写任何包）。
 *
 * **判据是内容内容校验值，不是 mtime**：只 touch / 网盘重写会把大小和修改时间改掉，
 * 内容一个字没变；拿 mtime 判会白写一份「更新包」，对面收到又提示确认，来回滚。
 * 老状态文件没有 stateId 时才退回 mtime 判据。
 */
async function hasContentChanges(plugin: LocallySavePlugin, state: PluginState, inventory: Inventory): Promise<boolean> {
	if (state.stateId) {
		const current = await computeStateId({
			vaultRoot: plugin.vaultRoot(),
			state,
			files: inventory.files,
			dirs: inventory.dirs,
		});
		return current.id !== state.stateId.id;
	}
	return hasChanges(state, inventory);
}

/** 老状态文件没有 stateId 时的保底：大小 + mtime，2 秒容差；空文件夹也算 */
function hasChanges(state: PluginState, inventory: Inventory): boolean {
	const before = state.bundle?.files ?? {};
	if (inventory.files.size !== Object.keys(before).length) return true;
	for (const [file, record] of inventory.files) {
		const at = before[file];
		if (!at || !sameRecord(record, at, DEFAULT_MTIME_TOLERANCE_MS)) return true;
	}
	const dirs = new Set(state.bundle?.dirs ?? []);
	if (inventory.dirs.size !== dirs.size) return true;
	for (const dir of inventory.dirs) {
		if (!dirs.has(dir)) return true;
	}
	return false;
}

/** 导出的结果：写了 / 空包 / 失败三种分开报，界面上才说得清"更新包为什么没生成" */
type BundleWriteResult =
	| { kind: 'written'; outcome: ExportOutcome }
	/** 没写：`reason` 是引擎给的原因（没有变化 / 这一份差分更新包已经导过了…） */
	| { kind: 'empty'; reason?: string }
	| { kind: 'failed'; error: string };

/** 导一个包出去 */
async function writeBundleFile(
	plugin: LocallySavePlugin,
	base: string,
	mode: BundleMode,
	inventory: Inventory,
	written: string[],
	generationFloor: number,
): Promise<BundleWriteResult> {
	const label = mode === 'full' ? '完整备份' : '更新包';
	try {
		const result = await exportBundle({
			...exportOptions(plugin, base, mode, inventory),
			keepPaths: [...written],
			generationFloor,
			onProgress: (done, total, path) => plugin.reportProgress({ done, total, path, label: '导出中' }),
		});
		if (!result.file) return { kind: 'empty', ...(result.reason ? { reason: result.reason } : {}) };
		written.push(result.file);
		plugin.log.debug(`${label}已留下：${result.file}`);
		return { kind: 'written', outcome: result };
	} catch (error) {
		// 一个包失败不该让另一个已经写成的包也变成"失败"：
		// 单独弹一条说清原因，结果那句里也带上（不然"导出完成："后面会是空的）
		const message = describe(error);
		new Notice(`${label}导出失败。原因：${message}。`, 9000);
		plugin.log.error(`${label}导出失败`, error);
		return { kind: 'failed', error: message };
	}
}

/** 导出参数：导出与预览共用，别各拼一份 */
function exportOptions(
	plugin: LocallySavePlugin,
	base: string,
	mode: BundleMode,
	inventory?: Inventory,
): ExportOptions {
	return {
		settings: plugin.settings,
		log: plugin.log,
		vaultRoot: plugin.vaultRoot(),
		vaultName: plugin.vaultName(),
		stateFile: plugin.stateFile(),
		mode,
		outDir: base,
		configDir: plugin.configDir(),
		// 「从哪个状态到哪个状态」：设置里那两个下拉（留空 ＝ 最新）。导出时按它算。
		// 值是**基准校验值**（不是版本号）：版本号只说"内容走到第几版"，认不出"这是哪一份完整备份"
		baseFingerprint: anchorFingerprintOf(plugin.settings.changesFromState),
		toFingerprint: anchorFingerprintOf(plugin.settings.changesToState),
		...(inventory ? { inventory } : {}),
	};
}

/**
 * 应用一个包要的参数（对话框与自动应用共用一处拼装） */
function applyOptionsFor(plugin: LocallySavePlugin, file: string): ApplyOptions {
	return {
		settings: plugin.settings,
		log: plugin.log,
		vaultRoot: plugin.vaultRoot(),
		stateFile: plugin.stateFile(),
		file,
		configDir: plugin.configDir(),
		bundleDir: bundleBaseDir(plugin.settings),
		// 「仅拉」没有要回传的那一半：报告里记 0，别记一笔永远发不出去的欠账
		receiveOnly: isReceiveOnly(plugin.settings),
		// 自动接收也要有进度（不然大包应用时界面像卡住）
		onProgress: (done, total, path) => plugin.reportProgress({ done, total, path, label: '应用中' }),
	};
}

/**
 * 把"刚合并完的状态"导成更新包（欠账回传，git 方向 `both` 用）。
 *
 * 为什么不能走 `exportBundlesNow`：那条路第一步就是"自上次导出以来有没有变化"，
 * 应用刚落完盘、状态刚写成合并后的样子 —— 它会判成"没变化"直接返回。
 * 这里直接调引擎：它按"自基准以来变过的文件"挑，合并进来的对方改动也在里面。
 * 失败只记日志：这一轮已经应用成功了，回传下次同步还能补。
 */
async function exportMergedState(plugin: LocallySavePlugin, base: string): Promise<void> {
	try {
		const result = await exportBundle({
			settings: plugin.settings,
			log: plugin.log,
			vaultRoot: plugin.vaultRoot(),
			vaultName: plugin.vaultName(),
			stateFile: plugin.stateFile(),
			mode: 'changes',
			outDir: base,
			configDir: plugin.configDir(),
			logNote: '回传：把刚合并完的状态发回去',
		});
		if (result.file) plugin.log.debug(`已导出合并后的状态：${result.file}`);
	} catch (error) {
		plugin.log.debug('导出合并后的状态失败（下一轮同步还能补）', error);
	}
}

/**
 * **「方向」决定接收怎么做**（0.15 起；改之前先读 `bundle/incoming.ts` 的 `IncomingPolicy`）：
 * - `download`（仅拉）：完整备份也收，会删 / 覆盖的也照做 —— 目标是对面那一点
 *   （`mirror` ＋ `alignToPeer`），本机被覆盖 / 删掉的东西进回收目录；这台机器**不写包**；
 * - `both`（双向）：默认收到先弹一句确认（写清会写 / 删 / 覆盖几个），确认后才应用；
 *   用户显式打开 `autoApplyIncomingBoth` 时跳过确认，直接按仅拉的镜像策略应用（无人值守）；
 *   应用完由下面那段"回传"把本机改动导出回去；
 * - `upload`（仅推）：根本不该走到这里（只发不收，见下面的 `wantsIncoming`）。
 */
function incomingPolicy(plugin: LocallySavePlugin, direction: SyncDirection): IncomingPolicy {
	if (direction === 'download') {
		return {
			force: true,
			allowFull: true,
			apply: { strictness: 'mirror', alignToPeer: true },
		};
	}
	if (direction === 'both') {
		if (plugin.settings.autoApplyIncomingBoth) {
			/**
			 * **无人值守的「双向」：三方合并 + 两边都改时"留两份"**（0.16.13，场景 3 实测后改的）。
			 *
			 * 0.16.12 用的是 `local-wins`，本机这一半保住了，但**对方那一半会静默消失**：
			 * 场景 3 里对方加了行、我们这边应用时被判成"已经一致（already）"，他们的行根本没写入，
			 * 而他们的包也已经发过了 —— 谁都没报错，两边却各只有自己那一行。
			 *
			 * 现在改成 `keep-both`：mtime 新的占原名、旧的那份存成**冲突副本**。
			 * 两份内容都还在（一份在原路径、一份在同目录的冲突副本里），谁都不会被静默丢掉；
			 * 用户看到冲突副本就知道该合哪一份。
			 */
			return {
				force: true,
				allowFull: true,
				apply: { strictness: 'normal', conflictStrategy: 'keep-both' },
			};
		}
		// 免确认但**不镜像**的合并开关已经撤掉：它只是绕过确认框，和"先应用、再导出回传"
		// 是同一件事，而且计划真要覆盖本地改动时仍会被 `isDestructivePlan` 拦下。
		return { confirm: (candidate, plan) => confirmIncomingApply(plugin, candidate, plan) };
	}
	return {};
}

/**
 * **整理更新包**：每一拍（30 秒）在 git 推送和拉取之前看一眼 `changes/`，把
 * "起点已经没人用"和"同组里还有更新的一份"移到回收站（0.18.2）。
 *
 * 为什么放在自动节拍上而不是只在导出时清：**最后一台机器跟上来的时候，没有任何人导出**。
 * 那种情况下老包会永远躺在远程仓库上（用户看到的"仓库越攒越乱"）。放在推送和拉取**之前**，
 * 清出来的删除就在同一拍被提交、推走，别的终端拉一次也跟着没掉。
 *
 * 边界：没开 git / 没有别的电脑上报 / 正忙 —— 一律不跑（`planBundleGc` 里那三道闸）。
 * 例行清理不弹通知（规矩见 `约定-传输与界面.md` 第 0 节）：状态栏一句 + 日志。
 */
export async function checkBundleGc(plugin: LocallySavePlugin): Promise<boolean> {
	if (!plugin.settings.enabled || !plugin.settings.gitEnabled) return false;
	if (plugin.bundleBusy || plugin.incomingBusy || plugin.gitBusy) return false;
	const base = bundleBaseDir(plugin.settings);
	if (!base) return false;
	try {
		const state = await loadState(plugin.stateFile());
		const plan = await planBundleGc(base, state, readPeers(base, state.copyId));
		if (plan.drop.length === 0) return false;
		const outcome = await runBundleGc(base, plan);
		const sentence = describeGcRun(plan, outcome.moved);
		if (sentence !== '') {
			plugin.log.debug(sentence);
			plugin.statusBar.flash(sentence);
		}
		return outcome.moved.length > 0;
	} catch (error) {
		// 整理失败不该影响同步本身
		plugin.log.debug('整理更新包时出错（不影响这一拍）', error);
		return false;
	}
}

/**
 * 「双向」接收前的确认窗：只说这一包会动什么，确认了才应用。
 *
 * 取消也记一笔（`dismissed`）—— 用户刚做过选择，同一个包不再弹第二次；
 * 想反悔还能从「打开同步包并应用…」手动来。
 *
 * **窗口不在前台时不弹、直接 `defer`**（0.15.9）：REST / 后台节拍触发时没人能点确认框，
 * 弹出来只会让一个 Promise 一直等待 —— `syncNow` 的锁一直占着，后面的同步就"204 没反应"。
 * 记 `needs-review`，用户回 Obsidian 手动同步时再问。
 */
function confirmIncomingApply(
	plugin: LocallySavePlugin,
	candidate: IncomingCandidate,
	plan: ApplyPlan,
): Promise<boolean | 'defer'> {
	// 用「窗口有没有焦点」判定，不用 `visibilityState`：实测（kahotat 机器）
	// visibilityState 会一直是 hidden，窗口拉到前台也不变 —— 那样确认框永远弹不出来。
	const doc = typeof document !== 'undefined' ? document : null;
	const hasFocus = doc && typeof doc.hasFocus === 'function' ? doc.hasFocus() : true;
	if (doc && !hasFocus) {
		debugEvent('incoming.confirm.deferred', {
			visibilityState: doc.visibilityState,
			hidden: doc.hidden,
			hasFocus,
		});
		return Promise.resolve('defer');
	}
	debugEvent('incoming.confirm.open', {
		visibilityState: doc?.visibilityState ?? null,
		hidden: doc?.hidden ?? null,
		hasFocus,
	});
	const counts = { write: 0, rename: 0, conflict: 0, delete: 0, restore: 0 };
	for (const action of plan.actions) counts[action.kind] += 1;
	const parts: string[] = [];
	if (counts.write > 0) parts.push(`写入 ${counts.write} 个文件`);
	if (counts.rename > 0) parts.push(`改名 ${counts.rename} 处`);
	if (counts.delete > 0) parts.push(`删除 ${counts.delete} 个`);
	if (counts.restore > 0) parts.push(`恢复 ${counts.restore} 个误改的文件`);
	if (counts.conflict > 0) parts.push(`${counts.conflict} 处两台电脑都改动过`);
	if (plan.foldersToRemove.length > 0) parts.push(`删 ${plan.foldersToRemove.length} 个空文件夹`);
	const summary = parts.length > 0 ? parts.join('、') : '只有目录调整';
	return new Promise<boolean | 'defer'>(resolve => {
		new ConfirmModal(plugin.app, {
			title: '收到其他电脑的更新包',
			lines: [
				`「${candidate.bundle.name}」会：${summary}。`,
				'本地被覆盖或删除的文件会先移入回收目录，可从回收目录恢复。',
				'应用完会把本电脑的改动导成更新包，其他电脑拉到后两台电脑内容一致。',
			],
			confirmText: '应用',
			onResolve: resolve,
		}).open();
	});
}

/**
 * 看一眼同步包文件夹里有没有"给我的新包"，按方向处理。
 *
 * 由 `main.tick()` 每 30 秒调一次，安全策略与基准判定在 `bundle/incoming.ts` 里；
 * 这里只负责"方向 → 策略"、通知、状态栏与"这一拍干了活没有"。
 *
 * `manual`：用户自己点的「立即同步」。与自动节拍的区别**只有两处**，都在安全边界之内：
 * - 上次停在 `needs-review` / `failed` 的包**重新挑出来**（用户明确要同步，就该再试一次）；
 * - "起点不一致、先搁着"的那句提示**再说一遍**（自动节拍只提示一次，免得刷屏）。
 * 应用的安全边界一个字没松：默认策略照样不碰会删东西的包；「双向」默认照样要确认
 * （只有显式打开 `autoApplyIncomingBoth` 才跳过，那是给无人值守的明确选择）。
 *
 * 返回 true ＝ 这一拍动过东西（调用方据此跳过同拍的导出：刚应用完不该立刻回传）。
 */
export async function checkIncomingBundles(
	plugin: LocallySavePlugin,
	options: { manual?: boolean } = {},
): Promise<boolean> {
	const manual = options.manual === true;
	const direction: SyncDirection | null = plugin.settings.gitEnabled
		? plugin.settings.syncDirection
		: null;
	/**
	 * 什么时候看"收到的包"：
	 * - git 开着时**由方向定**：仅推不看（只发不收）；仅拉 / 双向都看；
	 * - 没开 git 时退回 `autoApplyIncoming` 那个开关（包目录共享那条路照样能用）。
	 */
	const wantsIncoming = direction === null
		? plugin.settings.autoApplyIncoming
		: direction !== 'upload';
	if (!plugin.settings.enabled || !wantsIncoming) return false;
	if (plugin.bundleBusy || plugin.incomingBusy) return false;
	const base = bundleBaseDir(plugin.settings);
	if (!base) return false;

	plugin.incomingBusy = true;
	try {
		const state = await loadState(plugin.stateFile());
		const candidates = pickIncoming(await listBundles(base), state, { retryBlocked: manual });
		if (candidates.length === 0) return false;

		const sweep = await sweepIncoming(
			file => applyOptionsFor(plugin, file),
			plugin.stateFile(),
			candidates,
			direction === null ? {} : incomingPolicy(plugin, direction),
		);
		await reportIncomingSweep(plugin, sweep, { manual });
		/**
		 * **回传**：刚把对方的改动合进来，我这边多出来的那一半得发回去，对面才能一致。
		 *
		 * **只在 `both` 方向做**：`upload` 只推、`download` 只拉（不写包），都不该自动发；
		 * 导出的是"从基准到我现在的状态"的累积更新包，对面以同一份基准为准就能收。
		 * 不能等"自上次导出以来有变化"那条判据 —— 应用已经把状态记录更新成合并后的样子了，
		 * 那条判据会判成"没变化"，于是永远不回传（这正是"单向传输"的老毛病）。
		 */
		if (
			sweep.applied.length > 0
			&& direction === 'both'
			// 应用完就已经跟对方一致（绝大多数）→ 不用回传；只有还差一点时才补一份
			&& sweep.applied.some(item => item.stateIdCompare !== 'match')
		) {
			await exportMergedState(plugin, base);
		}
		/**
		 * **应用完之后本机还没有这个基准的包文件**（应用差分更新包就是这种）→ 立刻留一份完整备份
		 * （0.18.1，用户拍板："接受后也要导出一个完整备份，保证两边完整备份相同，然后才继续更新"）。
		 *
		 * 放在这条路上，是因为它同时覆盖**点一次「立即同步」**和**每 30 秒的自动节拍** ——
		 * 用户不用再记一步。补之前会核对校验值（`planBaselineCopy`），不一致就不补、只如实说。
		 * 完整备份不提交到 Git，但它占了本机几百 MB，所以照规矩说一句。
		 */
		if (sweep.applied.length > 0) {
			const baseline = await ensureLocalBaselineBundle(plugin, base);
			if (baseline) new Notice(baseline, 15000);
		}
		return sweep.applied.length > 0;
	} catch (error) {
		plugin.log.error('检查收到的包失败', error);
		return false;
	} finally {
		plugin.incomingBusy = false;
		plugin.reportProgress(null);
	}
}

/**
 * 收下了但还无法应用的那几份：**同一个包只提示一次**（内存里记着）。
 *
 * 为什么不落盘：它们随时可能因为"缺的那一份起点到了"就能应用 —— 落盘记成"处理过了"
 * 就再也自动无法应用了（得用户手动去点）。而每 30 秒重提示一遍又太吵，
 * 所以只在内存里记一笔：重启后再提示一次，可以接受。
 */
const waitingNotified = new Set<string>();

/** 把一次自动接包的结果说给用户听（各说各的，不糊成一句） */
async function reportIncomingSweep(
	plugin: LocallySavePlugin,
	sweep: IncomingSweep,
	options: { manual?: boolean } = {},
): Promise<void> {
	let written = 0;
	let deleted = 0;
	let restored = 0;
	let recovered = 0;
	let pending = 0;
	let mismatch = false;
	for (const item of sweep.applied) {
		written += item.written;
		deleted += item.deleted;
		restored += item.restored;
		if (item.recovered) recovered += 1;
		if (item.stateIdCompare !== 'match') mismatch = true;
		pending = Math.max(pending, item.pending);
		plugin.log.debug(
			`已自动应用其他电脑更新：写入 ${item.written} 个文件，删除 ${item.deleted} 个，恢复误改文件 ${item.restored} 个`,
		);
	}
	if (sweep.applied.length > 0) {
		const parts = [`写入 ${written} 个文件`];
		if (deleted > 0) parts.push(`删除 ${deleted} 个`);
		if (restored > 0) parts.push(`恢复误改 ${restored} 个`);
		if (recovered > 0) parts.push(`${recovered} 份先回退到完整备份`);
		const tail = mismatch ? (pending > 0 ? `。本电脑还有 ${pending} 个待发` : '。两台电脑内容尚未完全一致') : '';
		/**
		 * 自动接收不弹通知，只在状态栏顶一句；只有动了用户已有的东西才弹出。
		 * 一次扫到多份包时合并成一条，不按包刷屏。
		 */
		plugin.statusBar.flash(`已应用其他电脑更新：${parts.join('，')}${tail}。`);
		if (deleted > 0 || restored > 0 || recovered > 0) {
			new Notice(`已自动应用其他电脑更新：${parts.join('，')}${tail}。`, 7000);
		}
		await refreshStatusBar(plugin);
	}

	if (sweep.review.length > 0) {
		const failed = sweep.review.filter(item => item.kind === 'failed').length;
		const fulls = sweep.review.filter(item => item.kind !== 'failed' && item.full).length;
		const updates = sweep.review.length - failed - fulls;
		const segments: string[] = [];
		if (fulls > 0) segments.push(`收到完整备份（${fulls} 份），需要手动应用`);
		if (updates > 0) segments.push(`收到更新包（${updates} 个），但未自动应用`);
		if (failed > 0) segments.push(`自动应用失败（${failed} 份）`);
		const first = brief(sweep.review[0]?.why ?? '未知原因');
		new Notice(`${segments.join('；')}。首个原因：${first}。详见日志。`, 9000);
	}

	// 手动的「立即同步」**不按"只说一次"压着**：用户就是来问"到底还差什么"的，
	// 每点一次都说一遍才对（自动节拍才需要防刷屏）。
	const fresh = options.manual === true
		? sweep.waiting
		: sweep.waiting.filter(name => !waitingNotified.has(name));
	for (const name of fresh) waitingNotified.add(name);
	if (fresh.length > 0) {
		new Notice(`收到 ${fresh.length} 个更新包，但起点与本电脑当前使用的完整备份不一致。请其他电脑以本电脑的请其他电脑按本电脑当前使用的完整备份重新导出。重新导出。`, 8000);
	}
}

/** 通知里只留一句：长原因截断（完整原因在日志 / 报告窗口里） */
function brief(text: string, max = 70): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 预览：这次导出会装哪些文件（只算不写，看完再决定）。
 *
 * 给几份预览按开关走：两个都开就都给（**先完整、后更新**，与真正的顺序一致）；
 * 都关着时给一份更新包预览 —— 那时用户还没选留哪种，先让他看清改动有多少。
 */
export async function previewBundleExport(plugin: LocallySavePlugin): Promise<void> {
	if (!plugin.isActive()) return;
	const base = bundleBaseDir(plugin.settings);
	if (!base) {
		new Notice(bundleDirHint(), 9000);
		return;
	}
	try {
		const { autoExportChanges, autoExportFull } = plugin.settings;
		const inventory = await scanVault(plugin);
		const modes = plannedExportModes({
			changes: autoExportChanges || !autoExportFull,
			full: autoExportFull,
		});
		const previews: BundleExportPreview[] = [];
		for (const mode of modes) {
			previews.push(await planBundleExport(exportOptions(plugin, base, mode, inventory)));
		}
		new ExportPreviewModal(plugin.app, plugin, previews, () => { void exportBundlesNow(plugin); }, peerBaselineHint(plugin)).open();
	} catch (error) {
		new Notice(`预览失败。原因：${describe(error)}。`, 9000);
		plugin.log.error('预览失败', error);
	}
}

export function exportBundleAction(plugin: LocallySavePlugin): void {
	if (!plugin.isActive()) return;
	new ExportBundleModal(plugin.app, plugin).open();
}

export function applyBundleAction(plugin: LocallySavePlugin): void {
	if (!plugin.isActive()) return;
	new ApplyBundleModal(plugin.app, plugin).open();
}

/** 管理同步包：列出、打开所在文件夹、复制路径、删除（移到回收站）、清空回收站 */
export function manageBundlesAction(plugin: LocallySavePlugin): void {
	if (!plugin.isActive()) return;
	new BundleManagerModal(plugin.app, plugin).open();
}

/** 同步包更新记录：像 git log 那样，看"从哪份完整备份开始、中间收发过什么" */
export function bundleLogAction(plugin: LocallySavePlugin): void {
	if (!plugin.isActive()) return;
	new BundleLogModal(plugin.app, plugin).open();
}
