import { FileSystemAdapter, Notice, Plugin } from 'obsidian';
import { registerCommands } from './commands';
import { LocallySaveSettingTab, settingsFrom } from './settings';
import type { PluginSettings } from './settings';
import { STATE_FILE_NAME, loadStateSync } from './sync/state';
import type { PluginState } from './sync/state';
import { bundleBaseDir } from './bundle/paths';
import { needsPeerRefresh, readPeers } from './git/peers';
import { applyBundleAction, checkIncomingBundles, exportBundleAction, exportBundlesNow, isReceiveOnly, syncNow } from './ui/actions';
import { maybeGitSync, syncGitNow } from './ui/git';
import { registerBundleDropTarget } from './ui/drop-watch';
import { registerProtocolHandler } from './ui/protocol';
import { SyncStatusBar } from './ui/progress';
import { pickIcon } from './ui/ribbon';
import { openPeerStatus, refreshStatusBar } from './ui/status';
import { createLogger } from './utils/log';
import { DebugLog, setDebugSink } from './debugLog';
import { toNative } from './utils/paths';

/** 自动留包的检查节拍：每 30 秒看一次"到点了吗" */
const TICK_MS = 30_000;

/**
 * 对表文件（"对方到哪一步了"）的快节拍：**只在两边还没对齐时**每 10 秒拉一次。
 *
 * 为什么单独一条：应用完 / 导出完，对面只改了 `.lsave-peers/<它的 copyId>.json`，
 * 要等它下一次拉取才看得到 —— 30 秒那个节拍管的是留包和收包，拿它盯对表太慢，
 * 用户看到的就是"一边一致、一边待上报，怎么刷新都不变"。
 */
const PEER_TICK_MS = 10_000;

/** 静默对表的最小间隔：不管状态栏写什么，至少这么久拉一次（对方改了才收得到信号） */
const PEER_SYNC_MS = 30_000;

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
	/** 插件目录 debug.log：失败异常写这里，MCP / sync-state 都能读 */
	debugLog!: DebugLog;
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
	/** 上一次定时同步（留包）跑完的时间（定时同步靠它判断到没到点） */
	lastBundleAt = 0;
	/**
	 * 正在和 git 远程同步。
	 *
	 * 与留包 / 收包互斥：同步会往包文件夹里写文件、也会读它，
	 * 与应用（`apply.ts` 的 `applying`）也不许同时开跑 —— 那条由 `ui/git.ts` 自己查。
	 */
	gitBusy = false;
	/** 上一次 git 同步的时间（拉取的节拍靠它；启动时是 0，所以第一拍就会拉） */
	lastGitAt = 0;
	/** 连续失败次数与退避截止时间：连不上时别每 30 秒弹一次 */
	gitFailures = 0;
	gitBackoffUntil = 0;
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

		this.debugLog = new DebugLog({
			writer: {
				exists: (path) => this.app.vault.adapter.exists(path),
				read: (path) => this.app.vault.adapter.read(path),
				write: (path, text) => this.app.vault.adapter.write(path, text),
			},
			path: `${this.app.vault.configDir}/plugins/${this.manifest.id}/debug.log`,
			enabled: () => this.settings.debugLog !== false,
		});
		setDebugSink((event, data, error) => { void this.debugLog.log(event, data, error); });
		// 第一笔就落盘：用户看到「没有 debug.log」时，能立刻区分"插件没加载"和"没出过错"
		void this.debugLog.log('plugin.loaded', {
			version: this.manifest.version,
			enabled: this.settings.enabled,
			debugLog: this.settings.debugLog !== false,
			configDir: this.app.vault.configDir,
		});
		this.registerDomEvent(window, 'error', (event) => {
			void this.debugLog.log('window.error', {
				message: event.message,
				filename: event.filename,
				lineno: event.lineno,
			}, event.error);
		});
		this.registerDomEvent(window, 'unhandledrejection', (event) => {
			void this.debugLog.log('unhandled.rejection', {}, event.reason);
		});

		this.statusBar = new SyncStatusBar(this.addStatusBarItem(), () => {
			void openPeerStatus(this, () => { void syncGitNow(this, { manual: true }); });
		});

		// 左侧栏三个入口。图标名用运行时清单挑（类型上 IconName 就是 string，
		// 写错了只会静默显示成空白方块，见 ui/ribbon.ts）
		this.ribbonSyncEl = this.addRibbonIcon(
			pickIcon(['package-plus', 'archive', 'save']),
			'Locally Save：立即同步',
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
		// 把"上次留包 / 上次应用"从状态文件里读回来 —— 不然每次重启状态栏都变回"尚未留包"
		await this.restoreLastActivity();

		registerCommands(this);
		void this.debugLog.log('commands.registered', {});
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
		/**
		 * **对表文件的快节拍**（用户提的："一边显示一致一边显示待上报，还是没有即时获取同步信息"）。
		 *
		 * 30 秒那个节拍管留包 / 收包，太重；这里只做一件事：状态"待上报 / 不同步 / 它还没报"
		 * 时每 `PEER_TICK_MS` 拉一次对表文件，拿到对面新状态就停（`needsPeerRefresh` 自己会收敛）。
		 */
		this.registerInterval(window.setInterval(() => { void this.peerTick(); }, PEER_TICK_MS));
		this.registerEvent(this.app.vault.on('modify', () => {
			this.saveDirtyAt = Date.now();
			this.pendingSave = true;
		}));

		// 「仅拉」只收不发：启动 / 定时 / 保存后都不写包（见 `isReceiveOnly`）
		if (this.settings.syncOnStartup && !isReceiveOnly(this.settings)) {
			this.app.workspace.onLayoutReady(() => { void exportBundlesNow(this, '启动留包', { quiet: true }); });
		}
		// git：启动后对一遍（关着 / 还没接上时 maybeGitSync 自己会安静跳过，不会自动 init）
		if (this.settings.gitEnabled) {
			this.app.workspace.onLayoutReady(() => { void maybeGitSync(this); });
		}
		this.log.debug(`已加载 v${this.manifest.version}`);
	}

	onunload(): void {
		setDebugSink(null);
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
		// 状态栏那一句（上次留包 / git / 对方状态）在一个地方拼，见 ui/status.ts
		await refreshStatusBar(this);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.refreshEntryPoints();
	}

	// ------------------------------------------------------------ 内部
	/**
	 * 定时同步 / 自动应用的节拍：每 30 秒看一次"到点了吗、有没有新包"。
	 *
	 * 一拍里两件事，**先看别人发来的包**（它要写仓库），再决定要不要留包：
	 * - 收包那条路由 `autoApplyIncoming` 管，只有"完全不会动到本地已有东西"的更新包才会自己应用；
	 * - 定时同步由 `autoSyncInterval` 管：到点先 git 推拉，再（如果开了自动留包）留包；
	 * - 刚应用过东西的这一拍**不再留包**（那等于立刻生成回礼包，两边容易来回搬运）。
	 */
	private tick(): void {
		if (!this.settings.enabled) return;
		if (this.bundleBusy || this.incomingBusy || this.gitBusy) return;
		void this.runTick();
	}

	/**
	 * **对表文件的快节拍**（每 10 秒，见 `PEER_TICK_MS`）：只在两边还没对齐时拉一次。
	 *
	 * 为什么要有它：应用完 / 导出完，对面只改了 `.lsave-peers/<它的 copyId>.json`，
	 * 本机要等下一次拉取才看得到。30 秒那个节拍管的是留包与收包，拿它盯对表太慢 ——
	 * 用户看到的就是"一边一致、一边待上报，刷新也不变"。
	 *
	 * 不干活的情形一律安静返回：没启用 / 没接 git / 正忙 / 没有对方 / 状态还没算过。
	 */
	private async peerTick(): Promise<void> {
		if (!this.settings.enabled || !this.settings.gitEnabled) return;
		if (this.gitBusy || this.bundleBusy || this.incomingBusy) return;
		const base = bundleBaseDir(this.settings);
		if (base === '') return;
		let state: PluginState;
		try {
			state = loadStateSync(this.stateFile());
		} catch {
			return;
		}
		const mine = state.stateId?.id ?? null;
		if (!mine) return;
		const peers = readPeers(base, state.copyId);
		if (peers.length === 0) return;
		/**
		 * 两种情况都拉一次：
		 * - 对表文件明说"待上报 / 不同步"（`needsPeerRefresh`）→ 立刻拉，最多每 10 秒一次；
		 * - 或者已经 30 秒没和远程说过话 → 也拉一次。只靠前一条不够：本机现在看到的是对方
		 *   **旧文件**、结论可能还是"一致"，对方改了东西这边根本收不到信号（用户报的
		 *   "一边一致、一边待上报，刷新也不变"）。30 秒一次的静默 fetch 就是这条信号。
		 */
		const stale = needsPeerRefresh(
			peers, mine, state.stateId?.at ?? 0, this.lastGitAt, Date.now(), PEER_TICK_MS / 2,
		);
		if (!stale && Date.now() - this.lastGitAt < PEER_SYNC_MS) return;
		this.log.debug(stale ? '对表文件还是旧的：主动拉一次' : '静默对表：拉一次');
		await syncGitNow(this, { quiet: true });
	}

	/** 一拍的实际内容（异步）：**先和远程对一遍**，再收包，最后才考虑留包 */
	private async runTick(): Promise<void> {
		// 先 git：拉下来的包，紧接着的收包就能看见（不用等下一拍）
		await maybeGitSync(this);
		if (this.bundleBusy || this.incomingBusy) return;
		const acted = await checkIncomingBundles(this);
		if (acted) {
			/**
			 * 刚应用完：**立刻把"我已经落到这一代"写进货架并推上去**。
			 * 不推的话要等下一拍（30 秒）才有人写 peer 文件 —— 这半分钟里对面拉到的
			 * 还是应用前的状态，状态栏会写"对方：不同步"（用户报的就是应用完之后仍报不同步）。
			 * 这一拍仍然**不留包**：刚应用完就留包等于马上回礼，两边容易来回搬运。
			 */
			await maybeGitSync(this);
			return;
		}
		if (this.bundleBusy || this.incomingBusy) return;
		this.tickExport();
	}

	/** 留包那一半：定时同步到点了、或者保存后静置够久了，就留一轮 */
	private tickExport(): void {
		// 「仅拉」＝只收不发：这个方向下一个包都不写（手动「导出同步包…」除外）
		if (isReceiveOnly(this.settings)) return;
		if (!this.settings.autoExportChanges && !this.settings.autoExportFull) return;

		const minutes = this.settings.autoSyncInterval;
		if (minutes > 0 && Date.now() - this.lastBundleAt >= minutes * 60_000) {
			void exportBundlesNow(this, '定时同步', { quiet: true });
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
