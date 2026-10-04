import { Modal } from 'obsidian';
import type { App } from 'obsidian';
import type NewPlugin from '../main';
import { LOG_LEVEL_OPTIONS } from '../settings';

/**
 * 示例窗口：展示插件的版本与当前设置。
 *
 * 这里只是模板留下的占位界面 —— 定了插件功能以后，
 * 换成真正要展示的内容即可（`ui/` 下的每个窗口一个文件）。
 */
export class MainModal extends Modal {
	private plugin: NewPlugin;

	constructor(app: App, plugin: NewPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		const { contentEl, plugin } = this;
		const settings = plugin.settings;

		contentEl.empty();
		contentEl.createEl('h2', { text: plugin.manifest.name });
		contentEl.createEl('p', { text: `版本 ${plugin.manifest.version}` });

		// 把当前设置列一遍：占位内容，顺便当作"设置真的生效了"的自检
		const list = contentEl.createEl('ul');
		const rows: [string, string][] = [
			['状态', settings.enabled ? '已启用' : '已停用'],
			['日志级别', LOG_LEVEL_OPTIONS[settings.logLevel]],
			['左侧栏图标', settings.ribbonIcon ? '显示' : '隐藏'],
			['状态栏状态', settings.showStatusBar ? '显示' : '隐藏'],
		];
		for (const [name, value] of rows) {
			list.createEl('li', { text: `${name}：${value}` });
		}

		contentEl.createEl('p', {
			text: '这是空白模板留下的示例窗口，功能定了以后替换 UI/main-modal.ts。',
			cls: 'new-plugin-modal-hint',
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
