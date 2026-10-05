import { DEFAULT_EXCLUDES } from '../sync/exclude';
import type { ConflictStrategy, SyncDirection } from '../sync/types';

/**
 * 插件设置的**数据模型**：字段定义、默认值、取值收敛。
 *
 * 面板怎么渲染不在这里（见 `fields/` 与 `tab.ts`）；这里只回答
 * "有哪些设置、默认是多少、脏数据怎么收敛"。
 *
 * 设置项的组织参照了 Remotely Save 的思路（目标 / 方向 / 删除 / 冲突 / 排除 / 自动同步），
 * 但把「远程」换成了「本地文件夹」，并多了「同步包」一组。
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

export const DIRECTION_OPTIONS: Record<SyncDirection, string> = {
	both: '双向同步（本地改动推上去，副本改动拉回来）',
	upload: '仅上传（本地 → 副本，副本只作备份）',
	download: '仅下载（副本 → 本地，本地改动不推）',
};

export const CONFLICT_OPTIONS: Record<ConflictStrategy, string> = {
	'keep-both': '两份都留（新的占原名，旧的存成冲突副本）',
	'local-wins': '以本地为准',
	'remote-wins': '以副本为准',
};

/** 自动同步间隔（分钟）：键是存进 data.json 的值，值是面板上的文案 */
export const SYNC_INTERVAL_OPTIONS: Record<string, string> = {
	'0': '不自动同步',
	'5': '每 5 分钟',
	'15': '每 15 分钟',
	'30': '每 30 分钟',
	'60': '每 1 小时',
	'180': '每 3 小时',
};

/**
 * 保存之后隔多久同步一次：**0 ＝ 不同步**。
 *
 * 以前是"开关 + 间隔"两项，改成一个下拉：开关关掉时那个间隔项就藏在面板里，
 * 等于一个设置还得配一个依赖它的设置，用户看着就是"设置怎么这么多"。
 */
export const SAVE_DELAY_OPTIONS: Record<string, string> = {
	'0': '不同步',
	'10': '停顿 10 秒后同步',
	'30': '停顿 30 秒后同步',
	'60': '停顿 1 分钟后同步',
	'300': '停顿 5 分钟后同步',
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

	// ------------------------------------------------------------ 同步目标
	/** 同步到的本地文件夹（绝对路径），副本就放在这里 */
	targetDir: string;
	/** 同步方向 */
	syncDirection: SyncDirection;
	/** 删除要不要跟着传播（关掉的话，删掉的文件会被从另一边拉回来） */
	propagateDeletions: boolean;
	/** 删除的文件先挪进回收目录而不是直接删 */
	deletedToTrash: boolean;
	/** 两边都改了怎么办 */
	conflictStrategy: ConflictStrategy;
	/** 排除规则，一行一条（写法同 .gitignore，见 src/sync/exclude.ts） */
	excludePatterns: string;

	// ------------------------------------------------------------ 自动同步
	/** Obsidian 启动后自动同步一次 */
	syncOnStartup: boolean;
	/** 定时同步间隔（分钟），0 = 关 */
	autoSyncInterval: number;
	/** 保存笔记后隔多久同步一次（秒）；**0 ＝ 不同步** */
	syncAfterSaveDelay: number;

	// ------------------------------------------------------------ 同步包
	/** 同步包放哪儿；**留空＝放在同步目标文件夹的 `.lsave/bundles` 下** */
	bundleDir: string;
	/** 应用前校验包的完整性（读一遍全包算校验和，大包会慢一点） */
	bundleVerify: boolean;
	/** 把 .lsave 拖到 Obsidian 窗口上时，自动打开"应用同步包"对话框 */
	dropBundleToApply: boolean;
	/** 每次同步成功后，把这一次的改动导成一个包（几乎不额外花时间） */
	autoExportChanges: boolean;
	/** 每次同步成功后，导一份完整包（每次都重写整个仓库，慢，默认关） */
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
	/** 左侧栏：立即同步到本地副本 */
	ribbonSyncIcon: boolean;
	/** 左侧栏：导出同步包 */
	ribbonExportIcon: boolean;
	/** 左侧栏：打开同步包并应用 */
	ribbonApplyIcon: boolean;
	/** 在右下角状态栏显示状态（含上次同步的时间与结果、进行中的进度） */
	showStatusBar: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	enabled: true,
	logLevel: 'error',

	targetDir: '',
	syncDirection: 'both',
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

export function coerceDirection(value: unknown): SyncDirection {
	return coerceChoice(value, ['both', 'upload', 'download'] as const, DEFAULT_SETTINGS.syncDirection);
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
	return {
		enabled: coerceBoolean(raw.enabled, DEFAULT_SETTINGS.enabled),
		logLevel: coerceLogLevel(raw.logLevel),

		targetDir: coerceText(raw.targetDir, DEFAULT_SETTINGS.targetDir),
		syncDirection: coerceDirection(raw.syncDirection),
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

		bundleDir: coerceText(raw.bundleDir, DEFAULT_SETTINGS.bundleDir),
		bundleVerify: coerceBoolean(raw.bundleVerify, DEFAULT_SETTINGS.bundleVerify),
		dropBundleToApply: coerceBoolean(raw.dropBundleToApply, DEFAULT_SETTINGS.dropBundleToApply),
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
