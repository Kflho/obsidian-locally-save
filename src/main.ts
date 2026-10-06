import { FileSystemAdapter, Notice, Plugin } from 'obsidian';
import { registerCommands } from './commands';
import { LocallySaveSettingTab, settingsFrom } from './settings';
import type { PluginSettings } from './settings';
import { describeLastActivity } from './bundle/log';
import { STATE_FILE_NAME, loadState } from './sync/state';
import { applyBundleAction, checkIncomingBundles, exportBundleAction, exportBundlesNow } from './ui/actions';
import { registerBundleDropTarget } from './ui/drop-watch';
import { registerProtocolHandler } from './ui/protocol';
import { SyncStatusBar } from './ui/progress';
import { pickIcon } from './ui/ribbon';
import { createLogger } from './utils/log';
import { toNative } from './utils/paths';

/** 自动留包的检查节拍：每 30 秒看一次"到点了吗" */
const TICK_MS = 30_000;

/**
 * 插件入口：只管生命周期与装配。
 *
 * 0.8.0 砍掉「同步到本地副本」通道之后，插件只剩**同步包**一条线：
 * 留包（导出：完整副本 / 更新包）与应用（导入）。仓库存放之外的读写都走
 * `bundle/`，这里只提供它们要的东西（仓库路径、状态文件、配置目录、进度回调）。
 */
export default class LocallySavePlugin extends Plugin {
	settings!: PluginSettings;
	/** 跟着设置走的日志器（见 utils/log.ts） */
	readonly log = createLogger(() => this.settings.logLevel);
	/** 状态栏那一格（进度与上次留包的结果） */
	statusBar!: SyncStatusBar;

	/**
	 * 正在留包：定时触发看到它就让路。
	 *
	 * 真正的串行锁在 `ui/actions.ts` 的 `exportBundlesNow`（那里是所有留包入口的交汇点）；
	 * 这个标记是给 `tick()` 用的 —— 不然一轮跑了 10 分钟时，每 30 秒的节拍都会去敲一次门。
	 */
	bundleBusy = false;
	/**
	 * 正在检查 / 应用"别人发来的包"（`autoApplyIncoming` 那条路）。
	 *
	 * 与 `bundleBusy` 分开记：两件事都会写文件（一个写包目录、一个写仓库），
	 * 一拍之内不许同时开跑 —— 留包要扫仓库，正好扫到"应用到一半"的仓库就麻烦了。
	 */
	incomingBusy = false;
	/** 上一次留包跑完的时间（定时留包靠它判断到没到点） */
	lastBundleAt = 0;
	/** 保存事件攒到的"脏"时间：停下来多久之后才真的留包 */
	private saveDirtyAt = 0;
	private pendingSave = false;
	/**
	 * 左侧栏的三个图标：留包、导出包、应用包。
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
			pickIcon(['package-plus', 'archive', 'save']),
			'Locally Save：立即留包',
			() => { void exportBundlesNow(this); },
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
		// 把"上次留包 / 上次应用"从状态文件里读回来 —— 不然每次重启状态栏都变回"尚未留包"
		await this.restoreLastActivity();

		registerCommands(this);
		// 把 .lsave 拖到窗口上就直接打开应用对话框（只拦 .lsave，别的拖放不受影响）
		registerBundleDropTarget(this);
		// 用 Obsidian 直接打开包：obsidian://locally-save?vault=…&bundle=…
		// （配合设置里那个"关联 .lsave"，双击文件就能应用。参数名**不能叫 path**，
		//   那会让 Obsidian 去找"哪个 vault 包含这个路径"、直接报 vault 找不到）
		registerProtocolHandler(this);
		this.addSettingTab(new LocallySaveSettingTab(this.app, this));

		// 一个固定节拍管两种自动留包（定时 / 保存后），
		// 这样改设置立刻生效，不用重建定时器（重建最容易漏清旧的）
		this.registerInterval(window.setInterval(() => this.tick(), TICK_MS));
		this.registerEvent(this.app.vault.on('modify', () => {
			this.saveDirtyAt = Date.now();
			this.pendingSave = true;
		}));

		if (this.settings.syncOnStartup) {
			this.app.workspace.onLayoutReady(() => { void exportBundlesNow(this, '启动留包', { quiet: true }); });
		}
		this.log.debug(`已加载 v${this.manifest.version}`);
	}

	onunload(): void {
		this.log.debug('已卸载');
	}

	// ------------------------------------------------------------ 给 bundle/ 与界面用的东西
	/** 仓库根目录的绝对路径。vault API 出不了库，所以读写包只能用文件系统访问 */
	vaultRoot(): string {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error('Locally Save 只支持桌面端：读写仓库之外的文件需要文件系统访问');
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

	reportProgress(progress: { done: number; total: number; path: string; label?: string } | null): void {
		this.statusBar.showProgress(progress);
	}

	// ------------------------------------------------------------ 对外
	/** 总开关：关掉后入口不干活，但会说明原因 —— 静默失效会让人以为插件坏了 */
	isActive(): boolean {
		if (this.settings.enabled) return true;
		new Notice('插件已停用：在设置里重新启用');
		return false;
	}

	async loadSettings(): Promise<void> {
		// 走 settingsFrom 而不是 Object.assign：data.json 里的脏值 / 缺失字段在这里一次性收敛
		this.settings = settingsFrom(await this.loadData());
	}

	/**
	 * 启动时把"上次留包 / 上次应用"读回来显示。
	 *
	 * 那句话的真相在状态文件的**更新记录**里（`bundleLog` 的最后一条），
	 * 不随重启丢 —— 0.8.0 之前它来自"上次同步到副本"的记录，那条通道已经砍掉了。
	 */
	private async restoreLastActivity(): Promise<void> {
		try {
			const state = await loadState(this.stateFile());
			this.statusBar.setSummary(describeLastActivity(state));
		} catch (error) {
			// 读不到不影响用：状态栏继续显示"尚未留包"，下次留包会写新的
			this.log.debug('读回上次留包记录失败', error);
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.refreshEntryPoints();
	}

	// ------------------------------------------------------------ 内部
	/**
	 * 自动留包 / 自动应用的节拍：每 30 秒看一次"到点了吗、有没有新包"。
	 *
	 * 一拍里两件事，**先看别人发来的包**（它要写仓库），再决定要不要留包：
	 * - 收包那条路由 `autoApplyIncoming` 管，只有"完全不会动到本地已有东西"的更新包才会自己应用；
	 * - 留包那条路由两个「自动留包」开关管，都关着时什么都不做；
	 * - 刚应用过东西的这一拍**不再留包**（那等于立刻生成回礼包，两边容易来回搬运）。
	 */
	private tick(): void {
		if (!this.settings.enabled) return;
		if (this.bundleBusy || this.incomingBusy) return;
		void this.runTick();
	}

	/** 一拍的实际内容（异步）：先收包，再留包 */
	private async runTick(): Promise<void> {
		const acted = await checkIncomingBundles(this);
		if (acted || this.bundleBusy || this.incomingBusy) return;
		this.tickExport();
	}

	/** 留包那一半：定时到点了、或者保存后静置够久了，就留一轮 */
	private tickExport(): void {
		if (!this.settings.autoExportChanges && !this.settings.autoExportFull) return;

		const minutes = this.settings.autoSyncInterval;
		if (minutes > 0 && Date.now() - this.lastBundleAt >= minutes * 60_000) {
			void exportBundlesNow(this, '定时留包', { quiet: true });
			return;
		}

		// 保存后留包：0 ＝ 不留（一个下拉管这件事，不再有单独的开关）
		const saveDelay = this.settings.syncAfterSaveDelay;
		if (
			this.pendingSave
			&& saveDelay > 0
			&& Date.now() - this.saveDirtyAt >= saveDelay * 1000
		) {
			this.pendingSave = false;
			void exportBundlesNow(this, '保存后留包', { quiet: true });
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
