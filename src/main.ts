import { FileSystemAdapter, Notice, Plugin } from 'obsidian';
import { registerCommands } from './commands';
import { LocallySaveSettingTab, settingsFrom } from './settings';
import type { PluginSettings } from './settings';
import { runSync as runSyncEngine } from './sync/runner';
import type { SyncHost, SyncOutcome, SyncProgress, SyncRunOptions } from './sync/runner';
import { STATE_FILE_NAME, loadState } from './sync/state';
import { statusBarText } from './sync/summary';
import { applyBundleAction, exportBundleAction, syncNow } from './ui/actions';
import { registerBundleDropTarget } from './ui/drop-watch';
import { registerProtocolHandler } from './ui/protocol';
import { SyncStatusBar } from './ui/progress';
import { pickIcon } from './ui/ribbon';
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
	/**
	 * 左侧栏的三个图标：同步、导出包、应用包。
	 * 都先建好、再按设置切显隐 —— 改开关立刻生效，不用重载插件。
	 */
	private ribbonSyncEl: HTMLElement | null = null;
	private ribbonExportEl: HTMLElement | null = null;
	private ribbonApplyEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.statusBar = new SyncStatusBar(this.addStatusBarItem());

		// 左侧栏三个入口。图标名用运行时清单挑（类型上 IconName 就是 string，
		// 写错了只会静默显示成空白方块，见 ui/ribbon.ts）
		this.ribbonSyncEl = this.addRibbonIcon(
			pickIcon(['refresh-cw', 'hard-drive', 'save']),
			'Locally Save：立即同步到本地副本',
			() => { void syncNow(this); },
		);
		this.ribbonExportEl = this.addRibbonIcon(
			pickIcon(['package', 'archive', 'download']),
			'Locally Save：导出同步包',
			() => { exportBundleAction(this); },
		);
		this.ribbonApplyEl = this.addRibbonIcon(
			pickIcon(['package-open', 'import', 'upload']),
			'Locally Save：打开同步包并应用',
			() => { applyBundleAction(this); },
		);
		this.refreshEntryPoints();
		// 把"上次同步"从状态文件里读回来 —— 不然每次重启状态栏都变回"尚未同步"
		await this.restoreLastSync();

		registerCommands(this);
		// 把 .lsave 拖到窗口上就直接打开应用对话框（只拦 .lsave，别的拖放不受影响）
		registerBundleDropTarget(this);
		// 用 Obsidian 直接打开包：obsidian://locally-save?vault=…&bundle=…
		// （配合设置里那个"关联 .lsave"，双击文件就能应用。参数名**不能叫 path**，
		//   那会让 Obsidian 去找"哪个 vault 包含这个路径"、直接报 vault 找不到）
		registerProtocolHandler(this);
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

	/**
	 * 启动时把上次同步的结果读回来显示。
	 *
	 * 那份记录存在状态文件里（`sync-state.json` 的 `lastSync`），不随重启丢 ——
	 * 以前只存在内存里，于是每次重启状态栏都显示"尚未同步"，看着像记录丢了。
	 */
	private async restoreLastSync(): Promise<void> {
		try {
			const state = await loadState(this.stateFile());
			if (state.lastSync) this.statusBar.setSummary(statusBarText(state.lastSync));
		} catch (error) {
			// 读不到不影响用：状态栏继续显示"尚未同步"，下次同步会写新的
			this.log.debug('读回上次同步记录失败', error);
		}
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

		// 保存后同步：0 ＝ 不同步（一个下拉管这件事，不再有单独的开关）
		const saveDelay = this.settings.syncAfterSaveDelay;
		if (
			this.pendingSaveSync
			&& saveDelay > 0
			&& Date.now() - this.saveDirtyAt >= saveDelay * 1000
		) {
			this.pendingSaveSync = false;
			void syncNow(this, {}, '保存后同步');
		}
	}

	/** 按设置显示 / 隐藏三个左侧栏图标与状态栏那一格 */
	private refreshEntryPoints(): void {
		this.ribbonSyncEl?.toggleClass('locally-save-hidden', this.settings.ribbonSyncIcon === false);
		this.ribbonExportEl?.toggleClass('locally-save-hidden', this.settings.ribbonExportIcon === false);
		this.ribbonApplyEl?.toggleClass('locally-save-hidden', this.settings.ribbonApplyIcon === false);
		this.statusBar?.setVisible(this.settings.showStatusBar);
	}
}
