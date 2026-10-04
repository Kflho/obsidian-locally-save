import { DEFAULT_SETTINGS, coerceBoolean } from '../model';
import type { FieldSection } from './types';

/**
 * 「界面与交互」一页：插件把入口放在哪儿。
 *
 * 左侧栏三个图标对应三件事：同步、导出包、应用包 ——
 * 三个都是"先建好、按开关切显隐"（见 main.ts 的 refreshEntryPoints），
 * 所以改开关立刻生效，不用重载插件。
 */
export const INTERFACE_SECTION: FieldSection = {
	type: 'page',
	heading: '界面与交互',
	desc: '插件把入口放在哪儿、显示什么',
	groups: [
		{
			heading: '左侧栏图标',
			fields: [
				{
					key: 'ribbonSyncIcon',
					name: '同步到本地副本',
					desc: '在左侧栏放一个图标，点一下立即同步（等同于命令「立即同步」）',
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
					name: '显示同步状态',
					desc: '在右下角状态栏显示上次同步的时间与结果；同步进行中显示进度（移动端没有状态栏，这一项不生效）',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.showStatusBar),
				},
			],
		},
	],
};
