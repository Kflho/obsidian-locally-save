import { DEFAULT_SETTINGS, SAVE_DELAY_OPTIONS, SYNC_INTERVAL_OPTIONS, coerceBoolean, coerceNumberChoice } from '../model';
import type { FieldSection } from './types';

/**
 * 「自动同步」一页：什么时候自己动。
 *
 * 默认全是关的 —— 自动同步会写磁盘，得让用户明确打开。
 * 「保存后同步」是**一个下拉**（0 ＝ 不同步）：以前是"开关 + 间隔"两项，
 * 关掉开关时那个间隔项还藏在面板里，看着就是设置太多。
 */
export const AUTO_SECTION: FieldSection = {
	type: 'page',
	heading: '自动同步',
	desc: '什么时候自动跑一次同步（默认都要手动打开）',
	groups: [
		{
			heading: '触发时机',
			fields: [
				{
					key: 'syncOnStartup',
					name: '启动后同步一次',
					desc: 'Obsidian 启动并加载完工作区后自动同步一次',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.syncOnStartup),
				},
				{
					key: 'autoSyncInterval',
					name: '定时同步',
					desc: '每隔一段时间自动同步一次（Obsidian 关闭后自然就停了）',
					control: { type: 'dropdown', options: SYNC_INTERVAL_OPTIONS },
					coerce: value => coerceNumberChoice(
						value,
						Object.keys(SYNC_INTERVAL_OPTIONS).map(Number),
						DEFAULT_SETTINGS.autoSyncInterval,
					),
				},
				{
					key: 'syncAfterSaveDelay',
					name: '保存后同步',
					desc: '笔记保存后，停顿一会儿再自动同步一次。注意：编辑时会频繁触发保存，'
						+ '所以这一项会带来持续的磁盘写入 —— 停顿就是给连续打字留的缓冲',
					control: { type: 'dropdown', options: SAVE_DELAY_OPTIONS },
					coerce: value => coerceNumberChoice(
						value,
						Object.keys(SAVE_DELAY_OPTIONS).map(Number),
						DEFAULT_SETTINGS.syncAfterSaveDelay,
					),
				},
			],
		},
	],
};
