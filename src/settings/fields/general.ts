import { DEFAULT_SETTINGS, LOG_LEVELS, LOG_LEVEL_OPTIONS, coerceBoolean, coerceChoice, coerceText } from '../model';
import type { FieldSection } from './types';

/**
 * 「通用」一页：基本开关、日志级别、启动提示。
 *
 * 演示了字段表的三种控件（开关 / 下拉 / 输入框）与两种联动
 * （`visible` 看别的开关、`rerenderOnChange` 让旧版 DOM 跟着重画）。
 */
export const GENERAL_SECTION: FieldSection = {
	type: 'page',
	heading: '通用',
	desc: '插件的基本开关、控制台日志与启动提示',
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
		{
			heading: '启动提示',
			fields: [
				{
					key: 'startupNotice',
					name: '加载时弹出提示',
					desc: '插件每次加载完成时在右上角弹一条通知',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.startupNotice),
					// 关掉它以后「提示文案」要跟着消失，旧版 DOM 需要整块重画
					rerenderOnChange: true,
				},
				{
					key: 'greeting',
					name: '提示文案',
					desc: '上面那条通知的内容，版本号会自动附在后面',
					control: { type: 'text', placeholder: DEFAULT_SETTINGS.greeting },
					coerce: value => coerceText(value, DEFAULT_SETTINGS.greeting),
					visible: settings => settings.startupNotice,
				},
			],
		},
	],
};
