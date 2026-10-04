import { Notice } from 'obsidian';
import type NewPlugin from '../main';
import { MainModal } from '../ui/main-modal';

/**
 * 命令注册。
 *
 * **命令 ID 一旦发布就是稳定接口**，改名会让用户的快捷键失效 —— 别改。
 * 一条命令一个函数，实现放各自模块里，这里只做接线。
 */
export function registerCommands(plugin: NewPlugin): void {
	plugin.addCommand({
		id: 'open-main-modal',
		name: '打开示例窗口',
		callback: () => {
			if (!plugin.isActive()) return;
			plugin.log.debug('命令：打开示例窗口');
			new MainModal(plugin.app, plugin).open();
		},
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
