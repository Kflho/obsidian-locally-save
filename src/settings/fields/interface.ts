import { DEFAULT_SETTINGS, coerceBoolean } from '../model';
import type { FieldSection } from './types';

/**
 * 「界面与交互」一页：插件把入口放在哪儿。
 *
 * 两个入口都是"先建好、按开关切换显隐"（见 main.ts 的 refreshEntryPoints），
 * 所以改开关立刻生效，不用重载插件。
 */
export const INTERFACE_SECTION: FieldSection = {
	type: 'page',
	heading: '界面与交互',
	desc: '插件把入口放在哪儿、显示什么',
	groups: [
		{
			heading: '入口',
			fields: [
				{
					key: 'ribbonIcon',
					name: '左侧栏图标',
					desc: '在左侧栏放一个插件图标，点一下打开示例窗口',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.ribbonIcon),
				},
				{
					key: 'showStatusBar',
					name: '状态栏状态',
					desc: '在右下角状态栏显示插件当前是启用还是停用（移动端没有状态栏，这一项不生效）',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.showStatusBar),
				},
			],
		},
	],
};
