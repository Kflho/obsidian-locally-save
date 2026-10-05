import { DEFAULT_SETTINGS, LOG_LEVELS, LOG_LEVEL_OPTIONS, coerceBoolean, coerceChoice } from '../model';
import type { FieldSection } from './types';

/**
 * 「通用」一页：基本开关与日志级别。
 *
 * 这里只剩两项 —— 曾经的"加载时弹提示 + 提示文案"是一对没有信息量的装饰
 * （弹出来的就是插件名与版本号），删掉之后启动也安静了。
 */
export const GENERAL_SECTION: FieldSection = {
	type: 'page',
	heading: '通用',
	desc: '插件的基本开关与控制台日志',
	groups: [
		{
			heading: '基本',
			fields: [
				{
					key: 'enabled',
					name: '启用插件',
					desc: '关掉后插件注册的命令与界面入口都不再工作（设置面板仍然可以打开，方便再打开它）',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.enabled),
				},
				{
					key: 'logLevel',
					name: '日志级别',
					desc: '控制台（Ctrl+Shift+I）里输出多少信息。排查问题时选「全部输出」，平时用默认的「只记错误」就够了',
					control: { type: 'dropdown', options: LOG_LEVEL_OPTIONS },
					coerce: value => coerceChoice(value, LOG_LEVELS, DEFAULT_SETTINGS.logLevel),
				},
			],
		},
	],
};
