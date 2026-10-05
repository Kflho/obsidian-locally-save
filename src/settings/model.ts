import { BUNDLE_ROOT_DIR, BUNDLE_SUBDIR } from '../bundle/paths';
import { DEFAULT_EXCLUDES } from '../sync/exclude';
import { toNative } from '../utils/paths';

/**
 * 插件设置的**数据模型**：字段定义、默认值、取值收敛。
 *
 * 面板怎么渲染不在这里（见 `fields/` 与 `tab.ts`）；这里只回答
 * "有哪些设置、默认是多少、脏数据怎么收敛"。
 *
 * 0.8.0 砍掉「同步到本地副本」通道、0.11.0 把应用收成"严格同步"之后，设置只剩两件事：
 * **包放在哪 / 什么时候自动留包**。
 */

/** 日志级别：控制台里输出多少（见 src/utils/log.ts） */
export const LOG_LEVELS = ['silent', 'error', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** 日志级别的「取值 → 显示文案」，下拉控件与默认值校验共用 */
export const LOG_LEVEL_OPTIONS: Record<LogLevel, string> = {
	silent: '不输出',
	error: '只记错误',
	debug: '全部输出（排查问题时用）',
};

/** 自动留包间隔（分钟）：键是存进 data.json 的值，值是面板上的文案 */
export const SYNC_INTERVAL_OPTIONS: Record<string, string> = {
	'0': '不留包',
	'5': '每 5 分钟',
	'15': '每 15 分钟',
	'30': '每 30 分钟',
	'60': '每 1 小时',
	'180': '每 3 小时',
};

/**
 * 保存之后隔多久留一次包：**0 ＝ 不留**。
 *
 * 以前是"开关 + 间隔"两项，改成一个下拉：开关关掉时那个间隔项就藏在面板里，
 * 等于一个设置还得配一个依赖它的设置，用户看着就是"设置怎么这么多"。
 */
export const SAVE_DELAY_OPTIONS: Record<string, string> = {
	'0': '不留包',
	'10': '停顿 10 秒后留包',
	'30': '停顿 30 秒后留包',
	'60': '停顿 1 分钟后留包',
	'300': '停顿 5 分钟后留包',
};

export const BUNDLE_MODE_OPTIONS: Record<string, string> = {
	full: '完整副本（整个仓库）',
	changes: '仅改动（自上次导出后变过的文件）',
};

/** 同步包文件的后缀由格式模块定义，这里只用于界面提示 */
export const BUNDLE_EXTENSION = '.lsave';

export interface PluginSettings {
	// ------------------------------------------------------------ 通用
	/** 总开关：关掉后插件自己注册的入口不工作（设置面板本身仍然可用） */
	enabled: boolean;
	/** 控制台输出级别 */
	logLevel: LogLevel;

	// ------------------------------------------------------------ 包的内容
	/** 不进包的文件：一行一条（写法同 .gitignore，见 src/sync/exclude.ts） */
	excludePatterns: string;

	// 0.11.0 删掉了「应用同步包时的默认处理」那一组三项（`propagateDeletions` /
	// `deletedToTrash` / `conflictStrategy`）：应用只剩一种语义 ——
	// **严格同步**（应用完仓库 == 包），没有可配的地方。合并那条路（`ApplyStrictness.normal`）
	// 只剩引擎与测试在用，它的默认值写在 `bundle/apply.ts` 里。

	// ------------------------------------------------------------ 自动留包
	// 这三个只管**时机**，留不留、留哪种看下面的 autoExport* 两个开关。
	// 两个开关都关着时，触发了也什么都不做（只记一条日志）—— 不弹错。
	/** Obsidian 启动后自动留一次包 */
	syncOnStartup: boolean;
	/** 定时留包间隔（分钟），0 = 关 */
	autoSyncInterval: number;
	/** 保存笔记后隔多久留一次包（秒）；**0 ＝ 不留** */
	syncAfterSaveDelay: number;

	// ------------------------------------------------------------ 同步包
	/** 同步包放哪儿（绝对路径）；**必填**：留空时导出与应用都不可用，只提示去填 */
	bundleDir: string;
	/** 应用前校验包的完整性（读一遍全包算校验和，大包会慢一点） */
	bundleVerify: boolean;
	/** 把 .lsave 拖到 Obsidian 窗口上时，自动打开"应用同步包"对话框 */
	dropBundleToApply: boolean;
	/**
	 * 发现"给我的新更新包"时自动应用 —— 但**只在完全不会动到本地已有东西时**。
	 *
	 * 完整包永远不自动应用（它可能删掉本机独有的文件）；要删文件 / 覆盖本地改动 /
	 * 会产生冲突副本时，也只提示一句，让人自己打开看。理由是那条老规矩：
	 * 删除是唯一不可逆的动作，宁可留着。
	 */
	autoApplyIncoming: boolean;
	/** 留包时导一个更新包（只装自上一个基准点以来的新改动；几乎不额外花时间） */
	autoExportChanges: boolean;
	/** 留包时导一份完整包（每次都重写整个仓库，慢，默认关） */
	autoExportFull: boolean;
	/**
	 * 更新包**从哪个状态**开始：留空 ＝ 我最新那份完整副本（默认）；否则是**基准指纹**
	 * （16 位十六进制，见 `bundle/baseline.ts`）。
	 *
	 * 为什么存指纹而不是世代号：世代号说的是"内容走到第几版"，
	 * 两边的"第 32 代"完全可能是**两份不同的完整副本**。用户实测踩过：按"第 32 代"
	 * 选起点，对方回「基准对不上」—— 选中的那份根本不是对方手里那份。
	 * 指纹是内容的直接证据，也是对方「更新记录」顶上那行「基准：… · 指纹 xxxx」里的值。
	 */
	changesFromState: string;
	/**
	 * 更新包**到哪个状态**为止：留空 ＝ 最新（当前仓库，现在这一刻）；否则是某一份完整副本的
	 * **基准指纹** —— 导一份"从起点到那一刻"的**差量包**（内容取自那份包的负载）。
	 */
	changesToState: string;

	// ------------------------------------------------------------ 界面
	/** 左侧栏：立即留包（按两个「自动留包」开关留一次） */
	ribbonSyncIcon: boolean;
	/** 左侧栏：导出同步包 */
	ribbonExportIcon: boolean;
	/** 左侧栏：打开同步包并应用 */
	ribbonApplyIcon: boolean;
	/** 在右下角状态栏显示状态（含上次留包的时间与结果、进行中的进度） */
	showStatusBar: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	enabled: true,
	logLevel: 'error',

	excludePatterns: DEFAULT_EXCLUDES,

	syncOnStartup: false,
	autoSyncInterval: 0,
	// 0 ＝ 不同步：会往磁盘写文件的事，默认都得用户自己点头
	syncAfterSaveDelay: 0,

	bundleDir: '',
	bundleVerify: true,
	dropBundleToApply: true,
	// 会往磁盘写文件的事，默认都得用户自己点头
	autoApplyIncoming: false,
	// 会往磁盘写文件的事，默认都得用户自己点头
	autoExportChanges: false,
	autoExportFull: false,
	// 留空 ＝ 从"我站的这个基准点"到"最新（当前仓库）"
	changesFromState: '',
	changesToState: '',

	ribbonSyncIcon: true,
	ribbonExportIcon: true,
	ribbonApplyIcon: true,
	showStatusBar: true,
};

// ------------------------------------------------------------------ 取值收敛
// data.json 可能是旧版本写的、也可能被手工改坏。设置面板读 / 写与插件启动
// 读盘都走这几个函数，保证拿到的永远是合法值。

export function coerceBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

/** 只接受白名单里的取值，其余一律回落（下拉框用） */
export function coerceChoice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** 下拉框存的是数字时用它（控件给回来的一定是字符串） */
export function coerceNumberChoice(value: unknown, allowed: readonly number[], fallback: number): number {
	const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
	return allowed.includes(parsed) ? parsed : fallback;
}

export function coerceText(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : fallback;
}

export function coerceLogLevel(value: unknown): LogLevel {
	return coerceChoice(value, LOG_LEVELS, DEFAULT_SETTINGS.logLevel);
}

export function coerceBundleMode(value: unknown): 'full' | 'changes' {
	return coerceChoice(value, ['full', 'changes'] as const, 'full');
}

/**
 * 「从哪个状态 / 到哪个状态」的取值：留空 ＝ 最新，其余必须是**基准指纹**
 * （16 位十六进制，大小写都收，统一成小写）。
 *
 * 为什么不是世代号：世代号说不出"我们是从哪一份完整副本分出来的"，两边的"第 32 代"可能是两份不同的完整副本
 * （用户实测踩过：按代选起点 → 对面报「基准对不上」）。指纹才是"这是哪一份东西"的判据。
 *
 * 这里只做形状检查：万一那一份完整副本已经不在目录里了，导出时会明确报错并列出
 * "现在有哪些状态" —— 不会悄悄换一份。
 */
export function coerceAnchorFingerprint(value: unknown): string {
	const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
	return /^[0-9a-f]{16}$/.test(text) ? text : '';
}

/** 「从 / 到」设置项 → 引擎参数：null ＝ 最新 */
export function anchorFingerprintOf(value: string): string | null {
	const coerced = coerceAnchorFingerprint(value);
	return coerced === '' ? null : coerced;
}

/**
 * 把 `loadData()` 拿到的原始数据收敛成一份完整的设置。
 *
 * 比 `Object.assign({}, DEFAULT_SETTINGS, data)` 稳：那种写法会把脏值原样留下
 * （`logLevel: "xyz"` 就一直躺在 data.json 里），这里每个字段都过一遍收敛规则，
 * 缺字段补默认值、坏字段回落到默认值。
 */
export function settingsFrom(data: unknown): PluginSettings {
	const raw = (data ?? {}) as Record<string, unknown>;
	/**
	 * 「保存后同步」的迁移：老 data.json 里是**开关 + 间隔**两项，现在合成一个下拉（0 ＝ 不同步）。
	 * 关着的时候必须落到 0 —— 不这么写的话，用户原本没开自动同步，升级后会因为
	 * 存着的那个 30 秒而突然开始往磁盘写（这类"静悄悄改了行为"是最不能接受的）。
	 */
	const saveDelay = raw.syncAfterSave === false ? 0 : raw.syncAfterSaveDelay;
	/**
	 * 迁移：0.8.0 砍掉了「同步到本地副本」通道，`targetDir` 与 `syncDirection` 随之消失。
	 *
	 * 老用户的包默认就放在 `<目标文件夹>/.lsave/bundles` —— 把「同步包文件夹」
	 * 迁移成这个路径：包还在原处，用户不必重新找一遍。自己填过包目录的照旧不动。
	 * 两个老字段留在旧 `data.json` 里不读即可（`settingsFrom` 不会把它们带进内存）。
	 */
	const legacyTarget = coerceText(raw.targetDir).trim();
	const rawBundleDir = coerceText(raw.bundleDir, DEFAULT_SETTINGS.bundleDir);
	const bundleDir = rawBundleDir.trim() === '' && legacyTarget !== ''
		? toNative(legacyTarget, `${BUNDLE_ROOT_DIR}/${BUNDLE_SUBDIR}`)
		: rawBundleDir;
	return {
		enabled: coerceBoolean(raw.enabled, DEFAULT_SETTINGS.enabled),
		logLevel: coerceLogLevel(raw.logLevel),

		excludePatterns: coerceText(raw.excludePatterns, DEFAULT_SETTINGS.excludePatterns),

		syncOnStartup: coerceBoolean(raw.syncOnStartup, DEFAULT_SETTINGS.syncOnStartup),
		autoSyncInterval: coerceNumberChoice(
			raw.autoSyncInterval,
			Object.keys(SYNC_INTERVAL_OPTIONS).map(Number),
			DEFAULT_SETTINGS.autoSyncInterval,
		),
		syncAfterSaveDelay: coerceNumberChoice(
			saveDelay,
			Object.keys(SAVE_DELAY_OPTIONS).map(Number),
			DEFAULT_SETTINGS.syncAfterSaveDelay,
		),

		bundleDir,
		bundleVerify: coerceBoolean(raw.bundleVerify, DEFAULT_SETTINGS.bundleVerify),
		dropBundleToApply: coerceBoolean(raw.dropBundleToApply, DEFAULT_SETTINGS.dropBundleToApply),
		autoApplyIncoming: coerceBoolean(raw.autoApplyIncoming, DEFAULT_SETTINGS.autoApplyIncoming),
		autoExportChanges: coerceBoolean(raw.autoExportChanges, DEFAULT_SETTINGS.autoExportChanges),
		autoExportFull: coerceBoolean(raw.autoExportFull, DEFAULT_SETTINGS.autoExportFull),
		changesFromState: coerceAnchorFingerprint(raw.changesFromState),
		changesToState: coerceAnchorFingerprint(raw.changesToState),

		// ribbonIcon 是 0.1.0 里的旧名字（那时只有一个图标）：老 data.json 也认
		ribbonSyncIcon: coerceBoolean(raw.ribbonSyncIcon ?? raw.ribbonIcon, DEFAULT_SETTINGS.ribbonSyncIcon),
		ribbonExportIcon: coerceBoolean(raw.ribbonExportIcon, DEFAULT_SETTINGS.ribbonExportIcon),
		ribbonApplyIcon: coerceBoolean(raw.ribbonApplyIcon, DEFAULT_SETTINGS.ribbonApplyIcon),
		showStatusBar: coerceBoolean(raw.showStatusBar, DEFAULT_SETTINGS.showStatusBar),
	};
}
