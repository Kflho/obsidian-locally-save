import { Notice } from 'obsidian';
import { exportBundle } from '../bundle/export';
import type { ExportOutcome } from '../bundle/export';
import { bundleBaseDir } from '../bundle/paths';
import type LocallySavePlugin from '../main';
import type { SyncOutcome, SyncRunOptions } from '../sync/runner';
import { describeRecord, recordFromOutcome, statusBarText } from '../sync/summary';
import { ApplyBundleModal, ExportBundleModal } from './bundle-modal';
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
 * 同步成功后自动留包：改动包与完整包**各自独立**，两个都开就都留。
 *
 * 三处刻意省：
 * - 复用同步刚扫完的仓库清单，**不再遍历一遍全库**；
 * - 没有改动就直接跳过，不写空包；
 * - **先改动包、后完整包** —— 完整包会把"上次导出的样子"更新成当前仓库，
 *   顺序反过来先导完整包的话，改动包就没东西可装了。
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
	if (autoExportChanges) {
		const changes = await writeBundleFile(plugin, outcome, base, 'changes', written);
		if (changes) {
			notes.push('已留改动包');
			// 攒大了就弹窗问"要不要换基准"（用户点过跳过后，提醒线会抬高一倍原上限）
			await offerBaselineReset(plugin, changes);
		}
	}
	if (autoExportFull
		&& await writeBundleFile(plugin, outcome, base, 'full', written)) notes.push('已留完整包');
	return notes.length > 0 ? ` · ${notes.join('、')}` : '';
}

/** 导一个包出去；写了文件就把结果返回（没改动时返回 null） */
async function writeBundleFile(
	plugin: LocallySavePlugin,
	outcome: SyncOutcome,
	base: string,
	mode: 'full' | 'changes',
	written: string[],
): Promise<ExportOutcome | null> {
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
		if (!result.file) return null;
		written.push(result.file);
		plugin.log.debug(`${label}已留下：${result.file}`);
		return result;
	} catch (error) {
		// 留包失败不该让"同步成功"这件事看起来失败了
		new Notice(`同步完成，但${label}导出失败：${describe(error)}`, 9000);
		plugin.log.error(`${label}导出失败`, error);
		return null;
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
