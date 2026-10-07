import { Notice } from 'obsidian';
import { exportBundle, planBundleExport, plannedExportModes } from '../bundle/export';
import type { BundleExportPreview, ExportOptions, ExportOutcome } from '../bundle/export';
import { pickIncoming, sweepIncoming } from '../bundle/incoming';
import type { IncomingSweep } from '../bundle/incoming';
import { describeExportRange, describeLastActivity } from '../bundle/log';
import { listBundles } from '../bundle/manage';
import { bundleBaseDir } from '../bundle/paths';
import type { BundleMode } from '../bundle/paths';
import type { ApplyOptions } from '../bundle/apply';
import type LocallySavePlugin from '../main';
import { DEFAULT_MTIME_TOLERANCE_MS, sameRecord } from '../sync/diff';
import { scanTree } from '../sync/disk';
import { loadState } from '../sync/state';
import type { PluginState } from '../sync/state';
import { anchorFingerprintOf } from '../settings/model';
import type { Inventory } from '../sync/types';
import { VAULT_TRASH_DIR, excludePatterns } from '../sync/vault';
import { ApplyBundleModal, ExportBundleModal } from './bundle-modal';
import { ExportPreviewModal } from './export-preview-modal';
import { BundleManagerModal } from './manage-modal';
import { BundleLogModal } from './log-modal';

/**
 * 命令背后的动作：统一处理"总开关、串行、报错、通知、状态栏"，
 * 命令注册那边只留一行接线（见 commands/index.ts）。
 *
 * 0.8.0 起这里只有**同步包**一条通道：留包（导出）与应用（导入）。
 * 那个"同步到本地文件夹副本"的动作连同它的引擎（`sync/runner.ts`）一起删掉了 ——
 * 共用目录那种用法交给 Remotely Save 这类走云的插件，这里只做不联网的单文件搬运。
 */

/** 串行锁的标记在插件上（`plugin.bundleBusy`）：定时留包的节拍也要看它 */
function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 没填包目录时，界面上所有要写包 / 找包的动作都用这一句提示 */
export function bundleDirHint(): string {
	return '还没设置「同步包文件夹」：设置 → Locally Save → 同步包';
}

/**
 * 立即留包：按两个「自动留包」开关留一次。
 *
 * 手动命令、左侧栏图标、启动 / 定时 / 保存后三种自动触发**都走这里** ——
 * 以前这套挂在"同步到副本"成功之后（`syncNow`），于是没填目标文件夹就一步也跑不了；
 * 现在留包自己就是一条完整的动作，跟别的通道没关系。
 *
 * `quiet`：自动触发传 true —— "没有变化、没生成包"这种**正常结果**只写状态栏与日志，
 * 不弹通知（不然每 5 分钟的定时留包都在眼前闪一条）。真写出了包、或者失败了，照样弹。
 */
export async function exportBundlesNow(
	plugin: LocallySavePlugin,
	label = '留包',
	options: { quiet?: boolean } = {},
): Promise<void> {
	if (!plugin.isActive()) return;
	if (plugin.bundleBusy) {
		new Notice('上一次留包还没跑完');
		return;
	}
	plugin.bundleBusy = true;
	try {
		await runExport(plugin, label, options.quiet === true);
	} finally {
		plugin.bundleBusy = false;
		// 记下"刚跑过"：定时留包的节拍靠它判断到没到点（手工留包也算数）
		plugin.lastBundleAt = Date.now();
		plugin.reportProgress(null);
	}
}

/** 真的跑一轮；同一时间只允许一轮（上面的锁） */
async function runExport(plugin: LocallySavePlugin, label: string, quiet: boolean): Promise<void> {
	const { autoExportChanges, autoExportFull } = plugin.settings;
	if (!autoExportChanges && !autoExportFull) {
		new Notice('「留更新包」与「留完整包」都没开：先在设置 → Locally Save → 同步包里选一种', 9000);
		return;
	}
	const base = bundleBaseDir(plugin.settings);
	if (!base) {
		new Notice(bundleDirHint(), 9000);
		return;
	}

	try {
		const result = await writePlannedBundles(plugin, base);
		const text = result.notes.length > 0 ? result.notes.join('、') : '什么都没有生成';
		// 自动触发 + 没有变化：正常结果，不打扰（状态栏与日志照写）
		if (result.noChanges && quiet) {
			await refreshStatusBar(plugin);
			plugin.log.debug(`${label}：${text}`);
			return;
		}
		// 「该立新完整包了」这句提醒：顺手留包（自动触发）时**只写状态栏与日志、不弹通知** ——
		// 提醒不是"出事了"，没必要在用户眼前闪一条；手动留包时连着结果一起说。
		// 状态栏那句是常驻的（最近一次留包干了什么），两种触发都写进去，抬眼就能看到。
		const said = !quiet && result.advice ? `${text}、${result.advice}` : text;
		new Notice(result.wrote ? `${label}完成：${said}` : `${label}：${said}`, 6000);
		await refreshStatusBar(plugin, result.advice);
		plugin.log.debug(`${label}：${text}${result.advice ? `；${result.advice}` : ''}`);
	} catch (error) {
		new Notice(`${label}失败：${describe(error)}`, 9000);
		plugin.log.error(`${label}失败`, error);
	}
}

/**
 * 按开关留一轮包：**先完整副本、后更新包**（`plannedExportModes` 一处说了算）。
 *
 * 三处刻意省：
 * - 整库**只扫一次**，两个包共用同一份清单；
 * - 自上次留包以来没有任何变化时**一个包都不写** —— 完整包一写就是整库重写；
 * - 完整包刚留过的话，更新包按它算必然是空的，那就不写空包，只说明一句。
 *
 * `advice` 单独拎出来（不塞进 `notes`）：调用方要按"手动 / 自动触发"决定它去哪儿 ——
 * 自动触发只写状态栏与日志，不弹通知（见 `runExport`）。
 */
async function writePlannedBundles(
	plugin: LocallySavePlugin,
	base: string,
): Promise<{ notes: string[]; advice: string | null; wrote: boolean; noChanges: boolean }> {
	const inventory = await scanVault(plugin);
	const state = await loadState(plugin.stateFile());
	if (!hasChanges(state, inventory)) {
		return {
			notes: ['自上次留包以来没有变化，没有生成包（要强行导一份完整副本：用「导出同步包…」）'],
			advice: null,
			wrote: false,
			noChanges: true,
		};
	}

	const { autoExportChanges, autoExportFull } = plugin.settings;
	const notes: string[] = [];
	/** 这一轮已经导出来的包：导完整包时别把它们当成"被取代的旧包"清掉 */
	const written: string[] = [];
	/** 这一轮留过完整包：紧随其后的更新包必然是空的 */
	let fullWritten = false;
	let wrote = false;
	/** 「该立新完整包了」（引擎按这份包自起点以来要搬的字节数算好，没到阈值时是 null） */
	let advice: string | null = null;

	for (const mode of plannedExportModes({ changes: autoExportChanges, full: autoExportFull })) {
		const result = await writeBundleFile(plugin, base, mode, inventory, written);
		if (result.kind === 'written') {
			wrote = true;
			if (mode === 'full') fullWritten = true;
			if (result.outcome.advice) advice = result.outcome.advice;
			notes.push(mode === 'full'
				? `已留完整副本（${result.outcome.entryCount} 个文件）`
				: `已留更新包（${result.outcome.entryCount} 个文件`
					+ `${result.outcome.deletedCount > 0 ? `、删除 ${result.outcome.deletedCount}` : ''}）`
					+ describeExportRange(result.outcome));
			continue;
		}
		// 空的更新包：完整包刚留过时它必然空，别写；其余情况如实说一句"没有变化"
		if (result.kind === 'empty' && mode === 'changes') {
			notes.push(fullWritten && !result.reason?.includes('已经导过')
				? '更新包是空的（刚留的完整副本已含全部内容），没生成'
				: (result.reason ?? '没有变化，更新包没生成'));
			continue;
		}
		if (result.kind === 'failed') {
			notes.push(mode === 'full' ? `完整包没导成（${result.error}）` : `更新包没导成（${result.error}）`);
		}
	}
	return { notes, advice, wrote, noChanges: false };
}

/** 扫一遍仓库（用户的排除规则与运行时才知道的配置目录都在这里生效） */
async function scanVault(plugin: LocallySavePlugin): Promise<Inventory> {
	const exclude = excludePatterns(plugin.settings.excludePatterns, plugin.configDir());
	return scanTree(plugin.vaultRoot(), { exclude, skipTopLevelDirs: [VAULT_TRASH_DIR] });
}

/**
 * 仓库自上次留包以来有变化吗（没有就不写任何包）。
 *
 * 判据与导出挑成员用的是同一条（大小 + 修改时间，2 秒容差），
 * 但**空文件夹也要算**：包里带着空文件夹的清单，漏了它对面永远缺那一个。
 */
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

/** 留包的结果：写了 / 空包 / 失败三种分开报，界面上才说得清"更新包为什么没生成" */
type BundleWriteResult =
	| { kind: 'written'; outcome: ExportOutcome }
	/** 没写：`reason` 是引擎给的原因（没有变化 / 这一份差量包已经导过了…） */
	| { kind: 'empty'; reason?: string }
	| { kind: 'failed'; error: string };

/** 导一个包出去 */
async function writeBundleFile(
	plugin: LocallySavePlugin,
	base: string,
	mode: BundleMode,
	inventory: Inventory,
	written: string[],
): Promise<BundleWriteResult> {
	const label = mode === 'full' ? '完整包' : '更新包';
	try {
		const result = await exportBundle({
			...exportOptions(plugin, base, mode, inventory),
			keepPaths: [...written],
			onProgress: (done, total, path) => plugin.reportProgress({ done, total, path, label: '导出中' }),
		});
		if (!result.file) return { kind: 'empty', ...(result.reason ? { reason: result.reason } : {}) };
		written.push(result.file);
		plugin.log.debug(`${label}已留下：${result.file}`);
		return { kind: 'written', outcome: result };
	} catch (error) {
		// 一个包失败不该让另一个已经写成的包也变成"失败"：
		// 单独弹一条说清原因，结果那句里也带上（不然"留包完成："后面会是空的）
		const message = describe(error);
		new Notice(`${label}导出失败：${message}`, 9000);
		plugin.log.error(`${label}导出失败`, error);
		return { kind: 'failed', error: message };
	}
}

/** 导出参数：留包与预览共用，别各拼一份 */
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
		// 值是**基准指纹**（不是世代号）：世代号只说"内容走到第几版"，认不出"这是哪一份完整副本"
		baseFingerprint: anchorFingerprintOf(plugin.settings.changesFromState),
		toFingerprint: anchorFingerprintOf(plugin.settings.changesToState),
		...(inventory ? { inventory } : {}),
	};
}

/**
 * 状态栏那句"上次留包 / 上次应用"：真相在更新记录里，这里只是把它读回来。
 *
 * `advice`（「该立新完整包了」）跟在后头：状态栏是常驻的那一格，
 * 顺手留包（自动触发）不弹通知，这句提醒就靠它让用户看得见。
 */
async function refreshStatusBar(plugin: LocallySavePlugin, advice?: string | null): Promise<void> {
	try {
		const summary = describeLastActivity(await loadState(plugin.stateFile()));
		plugin.statusBar.setSummary(advice ? `${summary} · ${advice}` : summary);
	} catch (error) {
		plugin.log.debug('刷新状态栏失败', error);
	}
}

/** 应用一个包要的参数（对话框与自动应用共用一处拼装） */
function applyOptionsFor(plugin: LocallySavePlugin, file: string): ApplyOptions {
	return {
		settings: plugin.settings,
		log: plugin.log,
		vaultRoot: plugin.vaultRoot(),
		stateFile: plugin.stateFile(),
		file,
		configDir: plugin.configDir(),
	};
}

/**
 * 看一眼同步包文件夹里有没有"给我的新包"，该自己应用的就应用（`autoApplyIncoming` 开着时）。
 *
 * 由 `main.tick()` 每 30 秒调一次。安全边界全在 `bundle/incoming.ts` 里：
 * **只有完全不会动到本地已有东西的更新包**才会自己应用，其余一律只提示一句；
 * 而且必须**从本机站的那份完整副本算起**（不是那份起点的包收不下，搁着等它到）。
 * 这里只负责通知、状态栏与"这一拍干了活没有"。
 *
 * 返回 true ＝ 这一拍动过东西（调用方据此跳过同拍的留包：刚应用完不该立刻回礼）。
 */
export async function checkIncomingBundles(plugin: LocallySavePlugin): Promise<boolean> {
	if (!plugin.settings.enabled || !plugin.settings.autoApplyIncoming) return false;
	if (plugin.bundleBusy || plugin.incomingBusy) return false;
	const base = bundleBaseDir(plugin.settings);
	if (!base) return false;

	plugin.incomingBusy = true;
	try {
		const state = await loadState(plugin.stateFile());
		const candidates = pickIncoming(await listBundles(base), state);
		if (candidates.length === 0) return false;

		const sweep = await sweepIncoming(
			file => applyOptionsFor(plugin, file),
			plugin.stateFile(),
			candidates,
		);
		await reportIncomingSweep(plugin, sweep);
		return sweep.applied.length > 0;
	} catch (error) {
		plugin.log.error('检查收到的包失败', error);
		return false;
	} finally {
		plugin.incomingBusy = false;
	}
}

/**
 * 收下了但还接不上的那几份：**同一个包只提示一次**（内存里记着）。
 *
 * 为什么不落盘：它们随时可能因为"缺的那一份起点到了"就能应用 —— 落盘记成"处理过了"
 * 就再也自动接不上了（得用户手动去点）。而每 30 秒重提示一遍又太吵，
 * 所以只在内存里记一笔：重启后再提示一次，可以接受。
 */
const waitingNotified = new Set<string>();

/** 把一次自动接包的结果说给用户听（各说各的，不糊成一句） */
async function reportIncomingSweep(plugin: LocallySavePlugin, sweep: IncomingSweep): Promise<void> {
	for (const item of sweep.applied) {
		const parts = [`写入 ${item.written}`];
		if (item.deleted > 0) parts.push(`删除 ${item.deleted}`);
		const tail = item.stateIdCompare === 'match'
			? '两边内容已经一致'
			: item.pending > 0
				? `你这边还有 ${item.pending} 个改动没发出去（下次留包会一起带上）`
				: '跟对方的编号还差一点，下次留包会补上';
		new Notice(`已自动应用 ${item.file}：${parts.join('、')}；${tail}`, 12000);
	}
	if (sweep.applied.length > 0) await refreshStatusBar(plugin);

	for (const item of sweep.review) {
		if (item.kind === 'failed') {
			new Notice(`自动应用 ${item.file} 失败：${item.why}`, 9000);
			continue;
		}
		// 不自动动手，但也别沉默：告诉用户"包到了、为什么没自动应用、去哪儿处理"
		new Notice(
			item.full
				? `收到完整副本 ${item.file}：${item.why} —— 没有自动应用；用「打开同步包并应用…」看看再决定`
				: `收到更新包 ${item.file}，但它${item.why} —— 没有自动应用；用「打开同步包并应用…」看看再决定`,
			15000,
		);
	}

	const fresh = sweep.waiting.filter(name => !waitingNotified.has(name));
	for (const name of fresh) waitingNotified.add(name);
	if (fresh.length > 0) {
		new Notice(
			`收到 ${fresh.length} 个更新包，但它们不是从你站的那份完整副本算起的 —— `
			+ '先让对方把他用的那份完整副本（或者从你这份起点的更新包）发过来，到齐了会自动应用',
			15000,
		);
	}
}

/**
 * 预览：这次留包会装哪些文件（只算不写，看完再决定）。
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
		new ExportPreviewModal(plugin.app, plugin, previews, () => { void exportBundlesNow(plugin); }).open();
	} catch (error) {
		new Notice(`预览失败：${describe(error)}`, 9000);
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

/** 管理同步包：列出、打开所在文件夹、复制路径、删除（挪进回收站）、清空回收站 */
export function manageBundlesAction(plugin: LocallySavePlugin): void {
	if (!plugin.isActive()) return;
	new BundleManagerModal(plugin.app, plugin).open();
}

/** 同步包更新记录：像 git log 那样，看"从哪份完整副本开始、中间收发过什么" */
export function bundleLogAction(plugin: LocallySavePlugin): void {
	if (!plugin.isActive()) return;
	new BundleLogModal(plugin.app, plugin).open();
}
