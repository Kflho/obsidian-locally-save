/**
 * 设置模块的出口。
 *
 * 目录结构：
 * - `model.ts`  数据模型：字段定义、默认值、取值收敛
 * - `types.ts`  字段表的类型
 * - `fields/`   字段表（面板的单一数据源：名字、说明、控件、收敛、显隐）
 * - `tab.ts`    设置面板：声明式定义与旧版手写 DOM 都由字段表生成
 */
export {
	DEFAULT_SETTINGS,
	LOG_LEVELS,
	LOG_LEVEL_OPTIONS,
	coerceBoolean,
	coerceChoice,
	coerceLogLevel,
	coerceText,
	settingsFrom,
} from './model';
export type { LogLevel, PluginSettings } from './model';
export { LocallySaveSettingTab } from './tab';
export { ALL_FIELDS, FIELD_INDEX, SETTINGS_SECTIONS } from './fields';
export type { ControlSpec, FieldGroup, FieldSection, FieldSpec } from './fields';
