import { Notice } from 'obsidian';
import type LocallySavePlugin from '../main';
import { applyBundleAction, exportBundleAction, previewSync, syncNow } from '../ui/actions';

/**
 * 命令注册。
 *
 * **命令 ID 一旦发布就是稳定接口**，改名会让用户的快捷键失效 —— 别改。
 * 一条命令一个动作，实现放 `ui/actions.ts`，这里只做接线。
 */
export function registerCommands(plugin: LocallySavePlugin): void {
	plugin.addCommand({
		id: 'sync-now',
		name: '立即同步',
		callback: () => { void syncNow(plugin); },
	});

	plugin.addCommand({
		id: 'sync-preview',
		name: '预览同步（不执行）',
		callback: () => { void previewSync(plugin); },
	});

	plugin.addCommand({
		id: 'upload-to-copy',
		name: '仅上传到本地副本',
		callback: () => { void syncNow(plugin, { direction: 'upload' }, '上传'); },
	});

	plugin.addCommand({
		id: 'download-from-copy',
		name: '仅从本地副本拉取',
		callback: () => { void syncNow(plugin, { direction: 'download' }, '拉取'); },
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
