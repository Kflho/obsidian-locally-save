import { Notice } from 'obsidian';
import { exportBundle } from '../bundle/export';
import type LocallySavePlugin from '../main';
import type { SyncOutcome, SyncRunOptions } from '../sync/runner';
import { formatTime } from '../utils/format';
import { ApplyBundleModal, ExportBundleModal } from './bundle-modal';
import { SyncPreviewModal, summarizeOutcome } from './sync-modal';

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
		const text = summarizeOutcome(outcome);
		new Notice(`${label}完成：${text}`, 6000);

		const bundleNote = await autoExportBundle(plugin, outcome);
		if (plugin.settings.showLastSyncInStatusBar) {
			plugin.statusBar.setSummary(`上次同步 ${formatTime(Date.now())}${bundleNote}`);
		}
		plugin.log.debug(`${label}：${text}`);
	} catch (error) {
		new Notice(`${label}失败：${describe(error)}`, 9000);
		plugin.log.error(`${label}失败`, error);
	}
}

/**
 * 同步成功后顺手留一个改动包（设置里打开才生效）。
 *
 * 两个地方刻意省：
 * - 复用同步刚扫完的仓库清单，**不再遍历一遍全库**；
 * - 只装改动（强制 changes 模式）—— 完整副本几百 MB，每次同步都写一遍不划算，
 *   那个走命令手动导。
 *
 * 返回一句给状态栏用的后缀（没留包就返回空串）。
 */
async function autoExportBundle(plugin: LocallySavePlugin, outcome: SyncOutcome): Promise<string> {
	if (!plugin.settings.autoExportBundle) return '';
	const outDir = plugin.settings.bundleDir.trim();
	if (!outDir) return '';
	// 没有改动：没有可搬的东西，也就没必要写文件
	if (outcome.changed === 0) return '';

	try {
		const result = await exportBundle({
			settings: { ...plugin.settings, bundleMode: 'changes' },
			log: plugin.log,
			vaultRoot: plugin.vaultRoot(),
			vaultName: plugin.vaultName(),
			stateFile: plugin.stateFile(),
			outDir,
			configDir: plugin.configDir(),
			inventory: outcome.localInventory,
		});
		if (!result.file) return '';
		plugin.log.debug(`已顺手留下改动包：${result.file}`);
		return ' · 已留包';
	} catch (error) {
		// 留包失败不该让"同步成功"这件事看起来失败了
		new Notice(`同步完成，但改动包导出失败：${describe(error)}`, 9000);
		plugin.log.error('改动包导出失败', error);
		return '';
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
