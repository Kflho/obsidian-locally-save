import { Notice } from 'obsidian';
import type LocallySavePlugin from '../main';
import type { SyncRunOptions } from '../sync/runner';
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
		if (plugin.settings.showLastSyncInStatusBar) {
			plugin.statusBar.setSummary(`上次同步 ${formatTime(Date.now())}`);
		}
		plugin.log.debug(`${label}：${text}`);
	} catch (error) {
		new Notice(`${label}失败：${describe(error)}`, 9000);
		plugin.log.error(`${label}失败`, error);
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
