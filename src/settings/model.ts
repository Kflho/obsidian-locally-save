import { BUNDLE_ROOT_DIR, BUNDLE_SUBDIR } from '../bundle/paths';
import { DEFAULT_EXCLUDES } from '../sync/exclude';
import type { ConflictStrategy } from '../sync/types';
import { toNative } from '../utils/paths';

/**
 * 插件设置的**数据模型**：字段定义、默认值、取值收敛。
 *
 * 面板怎么渲染不在这里（见 `fields/` 与 `tab.ts`）；这里只回答
 * "有哪些设置、默认是多少、脏数据怎么收敛"。
 *
 * 0.8.0 砍掉「同步到本地副本」通道之后，设置只剩三件事：
 * **包放在哪 / 什么时候自动留包 / 应用包时默认怎么处理**。
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

export const CONFLICT_OPTIONS: Record<ConflictStrategy, string> = {
	'keep-both': '两份都留（新的占原名，旧的存成冲突副本）',
	'local-wins': '以我为准（我这边的改动留下）',
	'remote-wins': '以包为准（用包里那一版）',
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

/** 更新包攒到多大就提醒换基准（`bundle/size-warn.ts` 会解析这个字符串） */
export const SIZE_LIMIT_OPTIONS: Record<string, string> = {
	'': '200 MB（默认）',
	'100MB': '100 MB',
	'500MB': '500 MB',
	'1GB': '1 GB',
	'0': '不提醒',
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

	// ------------------------------------------------------------ 应用同步包时的默认处理
	// 这三项只在「应用方式＝按设置」（ApplyStrictness.normal）时生效；
	// 对话框里选「以包为准 / 完全镜像」会各按各的规矩来，不看这里。
	/** 包里点名要删的文件，这边也跟着删吗（关掉的话它们会留着） */
	propagateDeletions: boolean;
	/** 删掉的文件先挪进回收目录而不是直接删 */
	deletedToTrash: boolean;
	/** 两边都改了怎么办 */
	conflictStrategy: ConflictStrategy;

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
	/** 留包时导一个更新包（自上次完整包以来累积的改动；几乎不额外花时间） */
	autoExportChanges: boolean;
	/** 留包时导一份完整包（每次都重写整个仓库，慢，默认关） */
	autoExportFull: boolean;
	/**
	 * 更新包攒到多大就提醒"该换基准了"（写法见 `bundle/size-warn.ts`）。
	 *
	 * 更新包是累积的、越攒越大；大到接近完整副本时，它唯一的好处（传得小）就没了。
	 * 到点会弹窗问：要不要重导一份完整副本当新基准（更新包从零重新累积）。
	 * 取值来自 `SIZE_LIMIT_OPTIONS`：留空 ＝ 默认 200MB，`0` ＝ 不提醒。
	 */
	bundleSizeWarnLimit: string;

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

	propagateDeletions: true,
	deletedToTrash: true,
	conflictStrategy: 'keep-both',
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
	bundleSizeWarnLimit: '',

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

export function coerceConflict(value: unknown): ConflictStrategy {
	return coerceChoice(value, ['keep-both', 'local-wins', 'remote-wins'] as const, DEFAULT_SETTINGS.conflictStrategy);
}

export function coerceBundleMode(value: unknown): 'full' | 'changes' {
	return coerceChoice(value, ['full', 'changes'] as const, 'full');
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

		propagateDeletions: coerceBoolean(raw.propagateDeletions, DEFAULT_SETTINGS.propagateDeletions),
		deletedToTrash: coerceBoolean(raw.deletedToTrash, DEFAULT_SETTINGS.deletedToTrash),
		conflictStrategy: coerceConflict(raw.conflictStrategy),
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
		bundleSizeWarnLimit: coerceChoice(
			raw.bundleSizeWarnLimit,
			Object.keys(SIZE_LIMIT_OPTIONS),
			DEFAULT_SETTINGS.bundleSizeWarnLimit,
		),

		// ribbonIcon 是 0.1.0 里的旧名字（那时只有一个图标）：老 data.json 也认
		ribbonSyncIcon: coerceBoolean(raw.ribbonSyncIcon ?? raw.ribbonIcon, DEFAULT_SETTINGS.ribbonSyncIcon),
		ribbonExportIcon: coerceBoolean(raw.ribbonExportIcon, DEFAULT_SETTINGS.ribbonExportIcon),
		ribbonApplyIcon: coerceBoolean(raw.ribbonApplyIcon, DEFAULT_SETTINGS.ribbonApplyIcon),
		showStatusBar: coerceBoolean(raw.showStatusBar, DEFAULT_SETTINGS.showStatusBar),
	};
}
