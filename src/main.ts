import { FileSystemAdapter, Notice, Plugin } from 'obsidian';
import { registerCommands } from './commands';
import { LocallySaveSettingTab, settingsFrom } from './settings';
import type { PluginSettings } from './settings';
import { runSync as runSyncEngine } from './sync/runner';
import type { SyncHost, SyncOutcome, SyncProgress, SyncRunOptions } from './sync/runner';
import { STATE_FILE_NAME } from './sync/state';
import { syncNow } from './ui/actions';
import { SyncStatusBar } from './ui/progress';
import { createLogger } from './utils/log';
import { toNative } from './utils/paths';

/** 自动同步的检查节拍：每 30 秒看一次"到点了吗" */
const TICK_MS = 30_000;

/**
 * 插件入口：只管生命周期与装配。
 *
 * 同步引擎通过 `SyncHost` 接口拿它需要的东西（仓库路径、状态文件、进度回调），
 * 所以引擎本身不 import obsidian，能在测试里拿临时目录直接跑。
 */
export default class LocallySavePlugin extends Plugin implements SyncHost {
	settings!: PluginSettings;
	/** 跟着设置走的日志器（见 utils/log.ts） */
	readonly log = createLogger(() => this.settings.logLevel);
	/** 状态栏那一格（进度与上次结果） */
	statusBar!: SyncStatusBar;

	/** 正在跑的同步：同一时间只允许一轮，避免两边互相打架 */
	private syncing: Promise<SyncOutcome> | null = null;
	/** 上一次同步完成的时间（定时同步靠它判断到没到点） */
	private lastSyncAt = 0;
	/** 保存事件攒到的"脏"时间：停下来多久之后才真的同步 */
	private saveDirtyAt = 0;
	private pendingSaveSync = false;
	private ribbonEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.statusBar = new SyncStatusBar(this.addStatusBarItem());
		this.ribbonEl = this.addRibbonIcon('hard-drive', '立即同步到本地副本', () => { void syncNow(this); });
		this.refreshEntryPoints();

		registerCommands(this);
		this.addSettingTab(new LocallySaveSettingTab(this.app, this));

		// 一个固定节拍管两种自动同步（定时 / 保存后），
		// 这样改设置立刻生效，不用重建定时器（重建最容易漏清旧的）
		this.registerInterval(window.setInterval(() => this.tick(), TICK_MS));
		this.registerEvent(this.app.vault.on('modify', () => {
			this.saveDirtyAt = Date.now();
			this.pendingSaveSync = true;
		}));

		if (this.settings.syncOnStartup) {
			this.app.workspace.onLayoutReady(() => { void syncNow(this, {}, '启动同步'); });
		}
		if (this.settings.startupNotice) {
			new Notice(`${this.settings.greeting}（${this.manifest.name} v${this.manifest.version}）`);
		}
		this.log.debug(`已加载 v${this.manifest.version}`);
	}

	onunload(): void {
		this.log.debug('已卸载');
	}

	// ------------------------------------------------------------ SyncHost
	/** 仓库根目录的绝对路径。vault API 出不了库，所以同步目标只能用文件系统访问 */
	vaultRoot(): string {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error('Locally Save 只支持桌面端：同步到仓库之外的文件夹需要文件系统访问');
		}
		return adapter.getBasePath();
	}

	/** 状态文件放在插件目录里（跟 data.json 做邻居） */
	stateFile(): string {
		const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		return toNative(this.vaultRoot(), `${dir}/${STATE_FILE_NAME}`);
	}

	vaultName(): string {
		return this.app.vault.getName();
	}

	/** 配置目录名：用户可能改过，不能假设就是 `.obsidian` */
	configDir(): string {
		return this.app.vault.configDir;
	}

	reportProgress(progress: SyncProgress | null): void {
		this.statusBar.showProgress(progress);
	}

	// ------------------------------------------------------------ 对外
	/** 总开关：关掉后入口不干活，但会说明原因 —— 静默失效会让人以为插件坏了 */
	isActive(): boolean {
		if (this.settings.enabled) return true;
		new Notice('插件已停用：在设置里重新启用');
		return false;
	}

	/** 跑一轮同步；已经有一轮在跑时返回 null */
	runSync(options: SyncRunOptions = {}): Promise<SyncOutcome | null> {
		if (this.syncing) {
			new Notice('上一次同步还没跑完');
			return Promise.resolve(null);
		}
		const task = runSyncEngine(this, options).finally(() => {
			this.syncing = null;
			this.lastSyncAt = Date.now();
			// 同步可能被中断在任意一步，收工时把进度清掉
			this.reportProgress(null);
		});
		this.syncing = task;
		return task;
	}

	async loadSettings(): Promise<void> {
		// 走 settingsFrom 而不是 Object.assign：data.json 里的脏值 / 缺失字段在这里一次性收敛
		this.settings = settingsFrom(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.refreshEntryPoints();
	}

	// ------------------------------------------------------------ 内部
	/** 自动同步的节拍：定时到点了、或者保存后静置够久了，就跑一轮 */
	private tick(): void {
		if (!this.settings.enabled) return;
		if (this.syncing) return;

		const minutes = this.settings.autoSyncInterval;
		if (minutes > 0 && Date.now() - this.lastSyncAt >= minutes * 60_000) {
			void syncNow(this, {}, '定时同步');
			return;
		}

		if (
			this.pendingSaveSync
			&& this.settings.syncAfterSave
			&& Date.now() - this.saveDirtyAt >= this.settings.syncAfterSaveDelay * 1000
		) {
			this.pendingSaveSync = false;
			void syncNow(this, {}, '保存后同步');
		}
	}

	/** 按设置显示 / 隐藏左侧栏图标与状态栏那一格 */
	private refreshEntryPoints(): void {
		this.ribbonEl?.toggleClass('locally-save-hidden', this.settings.ribbonIcon === false);
		this.statusBar?.setVisible(this.settings.showStatusBar);
	}
}
