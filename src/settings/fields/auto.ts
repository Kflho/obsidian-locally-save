import { DEFAULT_SETTINGS, SAVE_DELAY_OPTIONS, SYNC_INTERVAL_OPTIONS, coerceBoolean, coerceNumberChoice } from '../model';
import type { FieldSection } from './types';

/**
 * 「自动留包」一页：什么时候自己动手。
 *
 * 默认全是关的 —— 留包会往磁盘写文件，得让用户明确打开。
 * 这一页只管**时机**：留完整包还是更新包，看「同步包」页里那两个开关 ——
 * 两个都没开时，这里触发了也什么都不做（只记一条日志），不弹错。
 */
export const AUTO_SECTION: FieldSection = {
	type: 'page',
	heading: '自动留包',
	desc: '什么时候自动留一次包（默认都要手动打开；留哪种包在「同步包」那一页选）',
	groups: [
		{
			heading: '触发时机',
			fields: [
				{
					key: 'syncOnStartup',
					name: '启动后留包一次',
					desc: 'Obsidian 启动并加载完工作区后自动留一次包',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.syncOnStartup),
				},
				{
					key: 'autoSyncInterval',
					name: '定时留包',
					desc: '每隔一段时间自动留一次（Obsidian 关闭后自然就停了）',
					control: { type: 'dropdown', options: SYNC_INTERVAL_OPTIONS },
					coerce: value => coerceNumberChoice(
						value,
						Object.keys(SYNC_INTERVAL_OPTIONS).map(Number),
						DEFAULT_SETTINGS.autoSyncInterval,
					),
				},
				{
					key: 'syncAfterSaveDelay',
					name: '保存后留包',
					desc: '笔记保存后，停顿一会儿再自动留一次。注意：编辑时会频繁触发保存，'
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
