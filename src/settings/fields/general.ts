import { DEFAULT_SETTINGS, LOG_LEVELS, LOG_LEVEL_OPTIONS, coerceBoolean, coerceChoice } from '../model';
import type { FieldSection } from './types';

/**
 * 「通用」一页：插件自身的开关与入口。
 *
 * 三组都是"跟包没关系"的设置：总开关、日志，以及左侧栏图标与状态栏的显隐。
 * 曾经把后两组单独拆成一页「界面与交互」，可两页都只有两三项、说明还都以
 * "插件…"开头，看起来就像同一件事被劈成了两半 —— 合回一页。
 *
 * 左侧栏三个图标都是"先建好、按开关切显隐"（见 main.ts 的 refreshEntryPoints），
 * 所以改开关立刻生效，不用重载插件。
 */
export const GENERAL_SECTION: FieldSection = {
	type: 'page',
	heading: '通用',
	desc: '插件自身的开关与入口：总开关、日志、左侧栏图标、状态栏',
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
			heading: '左侧栏图标',
			fields: [
				{
					key: 'ribbonSyncIcon',
					name: '立即留包',
					desc: '在左侧栏放一个图标，点一下按「自动留包」的开关立即留一次包（等同于命令「立即留包」）',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.ribbonSyncIcon),
				},
				{
					key: 'ribbonExportIcon',
					name: '导出同步包',
					desc: '在左侧栏放一个图标，点一下打开「导出同步包」对话框（把仓库或改动打包成一个文件）',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.ribbonExportIcon),
				},
				{
					key: 'ribbonApplyIcon',
					name: '打开同步包并应用',
					desc: '在左侧栏放一个图标，点一下打开「应用同步包」对话框（先看报告，确认后再应用）',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.ribbonApplyIcon),
				},
			],
		},
		{
			heading: '状态栏',
			fields: [
				{
					key: 'showStatusBar',
					name: '显示同步包状态',
					desc: '在右下角状态栏显示上次留包的时间与结果；导出 / 应用进行中显示进度（移动端没有状态栏，这一项不生效）',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.showStatusBar),
				},
			],
		},
	],
};
