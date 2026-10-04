/**
 * 插件设置的**数据模型**：字段定义、默认值、取值收敛。
 *
 * 面板怎么渲染不在这里（见 `fields/` 与 `tab.ts`）；这里只回答
 * "有哪些设置、默认是多少、脏数据怎么收敛"。
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

export interface PluginSettings {
	/** 总开关：关掉后插件自己注册的入口不工作（设置面板本身仍然可用） */
	enabled: boolean;
	/** 控制台输出级别 */
	logLevel: LogLevel;
	/** 插件加载时弹一条通知 */
	startupNotice: boolean;
	/** 上面那条通知的文案 */
	greeting: string;
	/** 在左侧栏放一个插件图标 */
	ribbonIcon: boolean;
	/** 在右下角状态栏显示插件状态 */
	showStatusBar: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	enabled: true,
	logLevel: 'error',
	startupNotice: true,
	greeting: '插件已加载',
	ribbonIcon: true,
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

export function coerceText(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : fallback;
}

export function coerceLogLevel(value: unknown): LogLevel {
	return coerceChoice(value, LOG_LEVELS, DEFAULT_SETTINGS.logLevel);
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
	return {
		enabled: coerceBoolean(raw.enabled, DEFAULT_SETTINGS.enabled),
		logLevel: coerceLogLevel(raw.logLevel),
		startupNotice: coerceBoolean(raw.startupNotice, DEFAULT_SETTINGS.startupNotice),
		greeting: coerceText(raw.greeting, DEFAULT_SETTINGS.greeting),
		ribbonIcon: coerceBoolean(raw.ribbonIcon, DEFAULT_SETTINGS.ribbonIcon),
		showStatusBar: coerceBoolean(raw.showStatusBar, DEFAULT_SETTINGS.showStatusBar),
	};
}
