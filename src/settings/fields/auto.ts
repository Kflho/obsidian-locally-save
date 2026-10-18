import { DEFAULT_SETTINGS, SAVE_DELAY_OPTIONS, SYNC_INTERVAL_OPTIONS, coerceBoolean, coerceNumberChoice } from '../model';
import type { FieldSection } from './types';

/**
 * 「自动留包」一页：什么时候自己动手、留哪种。
 *
 * 默认全是关的 —— 留包会往磁盘写文件，得让用户明确打开。
 * 两个「留哪种包」开关都在这一页，跟触发时机关在一起；
 * 「立即同步」不看这两个开关（它自己按"有基准导更新包、没基准导完整包"来）。
 */
export const AUTO_SECTION: FieldSection = {
	type: 'page',
	heading: '自动留包',
	desc: '自动留包的时机与类型，默认全关。',
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
					desc: '每隔一段时间自动留一次；Obsidian 关闭后停止。',
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
					desc: '笔记保存后停顿一会儿再留包。编辑时保存很频繁，停顿能少写几次盘。',
					control: { type: 'dropdown', options: SAVE_DELAY_OPTIONS },
					coerce: value => coerceNumberChoice(
						value,
						Object.keys(SAVE_DELAY_OPTIONS).map(Number),
						DEFAULT_SETTINGS.syncAfterSaveDelay,
					),
				},
			],
		},
		{
			heading: '留哪种包',
			// 两个开关各自独立：都要就都开（顺序仍是先完整、后更新）
			fields: [
				{
					key: 'autoExportChanges',
					name: '留更新包',
					desc: '只装自起点那份完整副本以来变过的文件。第一次要先导一份完整副本。',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.autoExportChanges),
				},
				{
					key: 'autoExportFull',
					name: '留完整包',
					desc: '整个仓库重写一遍，大库会明显变慢。它同时是基准点和还原点。',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.autoExportFull),
				},
			],
		},
	],
};
