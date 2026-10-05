import { Notice } from 'obsidian';
import type LocallySavePlugin from '../main';
import {
	applyBundleAction,
	bundleLogAction,
	exportBundleAction,
	exportBundlesNow,
	manageBundlesAction,
	previewBundleExport,
} from '../ui/actions';

/**
 * 命令注册。
 *
 * **命令 ID 一旦发布就是稳定接口**，改名会让用户的快捷键失效 —— 别改。
 * 所以 0.8.0 砍掉「同步到本地副本」通道时：
 * - `sync-now` / `sync-preview` 这两个 ID **留着，改指留包**（立即留一次 / 先预览会装什么），
 *   快捷键照旧能用，做的正好是最接近的那件事；
 * - `upload-to-copy` / `download-from-copy` 也留一版，只弹一句指路通知 ——
 *   直接删掉的话，用户的快捷键会静默失效，他只会觉得"插件坏了"。
 */
export function registerCommands(plugin: LocallySavePlugin): void {
	plugin.addCommand({
		id: 'sync-now',
		name: '立即留包',
		callback: () => { void exportBundlesNow(plugin); },
	});

	plugin.addCommand({
		id: 'sync-preview',
		name: '预览：这次会留什么包',
		callback: () => { void previewBundleExport(plugin); },
	});

	// 下面两条是被砍掉的副本通道留下的 ID：留着弹指路通知，下一版再删
	plugin.addCommand({
		id: 'upload-to-copy',
		name: '上传到本地副本（通道已移除）',
		callback: () => {
			new Notice(
				'「同步到本地副本」通道已移除：把改动带走请用「导出同步包…」（导一个更新包拷到另一台机器）',
				9000,
			);
		},
	});

	plugin.addCommand({
		id: 'download-from-copy',
		name: '从本地副本拉取（通道已移除）',
		callback: () => {
			new Notice(
				'「同步到本地副本」通道已移除：从别处拿内容请用「打开同步包并应用…」（选一个 .lsave 应用）',
				9000,
			);
		},
	});

	plugin.addCommand({
		id: 'export-bundle',
		name: '导出同步包…',
		callback: () => { exportBundleAction(plugin); },
	});

	plugin.addCommand({
		id: 'apply-bundle',
		name: '打开同步包并应用…',
		callback: () => { applyBundleAction(plugin); },
	});

	plugin.addCommand({
		id: 'manage-bundles',
		name: '管理同步包…',
		callback: () => { manageBundlesAction(plugin); },
	});

	plugin.addCommand({
		id: 'bundle-log',
		name: '同步包更新记录…',
		callback: () => { bundleLogAction(plugin); },
	});

	// 这条不受总开关限制 —— 它就是用来把插件重新打开的
	plugin.addCommand({
		id: 'toggle-enabled',
		name: '启用 / 停用插件',
		callback: async () => {
			const enabled = !plugin.settings.enabled;
			plugin.settings.enabled = enabled;
			await plugin.saveSettings();
			new Notice(enabled ? '插件已启用' : '插件已停用');
		},
	});
}
