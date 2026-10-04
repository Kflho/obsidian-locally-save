import { Notice, Plugin } from 'obsidian';
import { registerCommands } from './commands';
import { NewPluginSettingTab, settingsFrom } from './settings';
import type { PluginSettings } from './settings';
import { MainModal } from './ui/main-modal';
import { createLogger } from './utils/log';

/**
 * 插件入口：只管生命周期与装配。
 *
 * 功能实现都在各自模块里（命令见 `commands/`，界面见 `ui/`，设置见 `settings/`）；
 * 这里只做四件事：读设置、建界面入口、注册命令与设置面板、按设置刷新入口。
 *
 * 这套结构继承自 js_02（note-tidy）：入口保持精简，功能一律下沉到模块。
 */
export default class NewPlugin extends Plugin {
	settings!: PluginSettings;
	/** 跟着设置走的日志器（见 utils/log.ts） */
	readonly log = createLogger(() => this.settings.logLevel);

	/** 左侧栏图标与状态栏文字：**先建好、再按开关切显隐**，改开关就立刻生效，不用重载插件 */
	private ribbonEl: HTMLElement | null = null;
	private statusBarEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.ribbonEl = this.addRibbonIcon('dice', '打开示例窗口', () => {
			if (this.isActive()) new MainModal(this.app, this).open();
		});
		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass('new-plugin-status');
		this.refreshEntryPoints();

		registerCommands(this);
		this.addSettingTab(new NewPluginSettingTab(this.app, this));

		if (this.settings.startupNotice) {
			new Notice(`${this.settings.greeting}（${this.manifest.name} v${this.manifest.version}）`);
		}
		this.log.debug(`已加载 v${this.manifest.version}`);
	}

	onunload(): void {
		this.log.debug('已卸载');
	}

	/**
	 * 总开关（设置里的「启用插件」）。
	 * 关掉后入口不干活，但会说明原因 —— 直接静默失效会让人以为插件坏了。
	 */
	isActive(): boolean {
		if (this.settings.enabled) return true;
		new Notice('插件已停用：在设置里重新启用');
		return false;
	}

	async loadSettings(): Promise<void> {
		// 走 settingsFrom 而不是 Object.assign：data.json 里的脏值 / 缺失字段在这里一次性收敛
		this.settings = settingsFrom(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// 设置面板里可能刚改了图标 / 状态栏开关：立刻按新设置刷一次
		this.refreshEntryPoints();
	}

	/** 按设置显示 / 隐藏两个入口，并刷新状态栏文字 */
	private refreshEntryPoints(): void {
		this.ribbonEl?.toggleClass('new-plugin-hidden', this.settings.ribbonIcon === false);
		this.statusBarEl?.toggleClass('new-plugin-hidden', this.settings.showStatusBar === false);
		this.statusBarEl?.setText(`${this.manifest.name}：${this.settings.enabled ? '已启用' : '已停用'}`);
	}
}
