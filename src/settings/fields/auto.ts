import { DEFAULT_SETTINGS, SAVE_DELAY_OPTIONS, SYNC_INTERVAL_OPTIONS, coerceBoolean, coerceNumberChoice } from '../model';
import type { FieldSection } from './types';

/**
 * 「自动导出」一页：什么时候自己动手、留哪种。
 *
 * 默认全是关的 —— 导出会往磁盘写文件，得让用户明确打开。
 * 两个「留哪种包」开关都在这一页，跟触发时机关在一起；
 * 「立即同步」不看这两个开关（它自己按"有基准导更新包、没基准导完整备份"来）。
 */
export const AUTO_SECTION: FieldSection = {
	type: 'page',
	heading: '自动导出同步包',
	desc: '自动导出同步包的时机与类型，默认全部关闭。',
	groups: [
		{
			heading: '触发时机',
			fields: [
				{
					key: 'syncOnStartup',
					name: '启动后导出一次',
					desc: 'Obsidian 启动并加载工作区后自动导出一份同步包。',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.syncOnStartup),
				},
				{
					key: 'autoSyncInterval',
					name: '定时同步（导出与 Git）',
					desc: '定时导出一份同步包（需要开启「导出更新包」），并与 Git 远程推送、拉取一次；选择 0 时只手动触发。',
					control: { type: 'dropdown', options: SYNC_INTERVAL_OPTIONS },
					coerce: value => coerceNumberChoice(
						value,
						Object.keys(SYNC_INTERVAL_OPTIONS).map(Number),
						DEFAULT_SETTINGS.autoSyncInterval,
					),
				},
				{
					key: 'syncAfterSaveDelay',
					name: '保存后导出',
					desc: '笔记保存后延迟一段时间再导出。编辑时保存频繁，延迟可减少写入次数。',
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
			heading: '导出的同步包类型',
			// 两个开关各自独立：都要就都开（顺序仍是先完整、后更新）
			fields: [
				{
					key: 'autoExportChanges',
					name: '导出更新包',
					desc: '只导出自上次完整备份以来改动的文件。首次使用需要先导出一份完整备份。',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.autoExportChanges),
				},
				{
					key: 'autoExportFull',
					name: '导出完整备份',
					desc: '重新写入整个仓库，大仓库会明显变慢。完整备份同时作为之后更新包的起点与还原点。',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.autoExportFull),
				},
			],
		},
	],
};
