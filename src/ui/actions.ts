import { Notice } from 'obsidian';
import { exportBundle, plannedExportModes } from '../bundle/export';
import type { ExportOutcome } from '../bundle/export';
import { bundleBaseDir } from '../bundle/paths';
import type LocallySavePlugin from '../main';
import type { SyncOutcome, SyncRunOptions } from '../sync/runner';
import { describeRecord, recordFromOutcome, statusBarText } from '../sync/summary';
import { ApplyBundleModal, ExportBundleModal } from './bundle-modal';
import { BundleManagerModal } from './manage-modal';
import { offerBaselineReset } from './reset-baseline-modal';
import { SyncPreviewModal } from './sync-modal';

/**
 * 命令背后的动作：统一处理"总开关、串行、报错、通知、状态栏"，
 * 命令注册那边只留一行接线（见 commands/index.ts）。
 */

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 立即同步。串行由插件负责：上一次没跑完时会直接返回 null */
export async function syncNow(plugin: LocallySavePlugin, options: SyncRunOptions = {}, label = '同步'): Promise<void> {
	if (!plugin.isActive()) return;
	try {
		const outcome = await plugin.runSync(options);
		if (!outcome) return;
		const record = recordFromOutcome(outcome);
		new Notice(`${label}完成：${describeRecord(record)}`, 6000);

		const bundleNote = await autoExportBundles(plugin, outcome);
		if (plugin.settings.showLastSyncInStatusBar) {
			plugin.statusBar.setSummary(`${statusBarText(record)}${bundleNote}`);
		}
		plugin.log.debug(`${label}：${describeRecord(record)}`);
	} catch (error) {
		new Notice(`${label}失败：${describe(error)}`, 9000);
		plugin.log.error(`${label}失败`, error);
	}
}

/**
 * 同步成功后自动留包：改动包与完整包**各自独立**，两个开关都开时按顺序来，
 * 但**只留该留的** —— 完整包刚留过的话，改动包必然是空的，那就不留（见下）。
 *
 * 顺序是**先完整包、后改动包**（`plannedExportModes`，跟导出弹窗同一条规矩）：
 * 完整包一写完，"自上次完整副本以来的改动"就归零了 —— 紧接着算出来的改动包**必然是空的**。
 * 空的就不写：接收方应用一个空包什么也不会发生，还让人以为漏了什么；只在状态栏说明一句。
 * 反过来先写改动包的话，完整包会把它当成"被它取代的旧包"清掉，
 * 用户看到的是"我那个包没了，然后又生出来一个一模一样的"（报过的）。
 *
 * 三处刻意省：
 * - 复用同步刚扫完的仓库清单，**不再遍历一遍全库**；
 * - 没有改动就直接跳过，不写空包；
 * - 改动包算出来是空的（完整包刚留过）也不写文件。
 *
 * 返回一句给状态栏用的后缀（没留包就返回空串）。
 */
async function autoExportBundles(plugin: LocallySavePlugin, outcome: SyncOutcome): Promise<string> {
	const { autoExportChanges, autoExportFull } = plugin.settings;
	if (!autoExportChanges && !autoExportFull) return '';
	// 没有改动：没有可搬的东西，也就没必要写文件
	if (outcome.changed === 0) return '';

	const base = bundleBaseDir(plugin.settings, plugin.settings.targetDir);
	if (!base) return '';

	const notes: string[] = [];
	/** 这一轮已经导出来的包：导完整包时别把它们当成"被取代的旧包"清掉 */
	const written: string[] = [];
	/** 这一轮留过完整包：紧随其后的改动包必然是空的 */
	let fullWritten = false;

	for (const mode of plannedExportModes({ changes: autoExportChanges, full: autoExportFull })) {
		const result = await writeBundleFile(plugin, outcome, base, mode, written);
		if (result.kind === 'written') {
			if (mode === 'full') fullWritten = true;
			notes.push(mode === 'full' ? '已留完整包' : '已留改动包');
			// 攒大了就弹窗问"要不要换基准"（用户点过跳过后，提醒线会抬高一倍原上限）
			if (mode === 'changes') await offerBaselineReset(plugin, result.outcome);
			continue;
		}
		// 空包只在"刚留过完整包"时才值得说 —— 别的空（同步本身没改动）上面已经提前返回了
		if (result.kind === 'empty' && mode === 'changes' && fullWritten) {
			notes.push('改动包是空的（刚留的完整包已含全部内容），没生成');
		}
	}
	return notes.length > 0 ? ` · ${notes.join('、')}` : '';
}

/** 留包的结果：写了 / 空包 / 失败三种分开报，界面上才说得清"改动包为什么没生成" */
type BundleWriteResult =
	| { kind: 'written'; outcome: ExportOutcome }
	| { kind: 'empty' }
	| { kind: 'failed' };

/** 导一个包出去 */
async function writeBundleFile(
	plugin: LocallySavePlugin,
	outcome: SyncOutcome,
	base: string,
	mode: 'full' | 'changes',
	written: string[],
): Promise<BundleWriteResult> {
	const label = mode === 'full' ? '完整包' : '改动包';
	try {
		const result = await exportBundle({
			settings: plugin.settings,
			log: plugin.log,
			vaultRoot: plugin.vaultRoot(),
			vaultName: plugin.vaultName(),
			stateFile: plugin.stateFile(),
			mode,
			outDir: base,
			configDir: plugin.configDir(),
			inventory: outcome.localInventory,
			keepPaths: [...written],
		});
		if (!result.file) return { kind: 'empty' };
		written.push(result.file);
		plugin.log.debug(`${label}已留下：${result.file}`);
		return { kind: 'written', outcome: result };
	} catch (error) {
		// 留包失败不该让"同步成功"这件事看起来失败了
		new Notice(`同步完成，但${label}导出失败：${describe(error)}`, 9000);
		plugin.log.error(`${label}导出失败`, error);
		return { kind: 'failed' };
	}
}

/** 预览：只算不干，看完再决定 */
export async function previewSync(plugin: LocallySavePlugin): Promise<void> {
	if (!plugin.isActive()) return;
	try {
		const outcome = await plugin.runSync({ dryRun: true });
		if (!outcome) return;
		new SyncPreviewModal(plugin.app, plugin, outcome, () => { void syncNow(plugin); }).open();
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
