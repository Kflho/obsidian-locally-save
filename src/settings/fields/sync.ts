import {
	BUNDLE_EXTENSION,
	CONFLICT_OPTIONS,
	DEFAULT_SETTINGS,
	DIRECTION_OPTIONS,
	coerceBoolean,
	coerceChoice,
	coerceConflict,
	coerceDirection,
	coerceText,
} from '../model';
import type { FieldSection } from './types';

/**
 * 「本地同步」一页：副本放哪儿、怎么比、删了怎么办。
 *
 * 这一页是整个插件的核心设置，所以每个说明都写清"后果"，
 * 别让用户稀里糊涂就开了删除传播。
 */
export const SYNC_SECTION: FieldSection = {
	type: 'page',
	heading: '本地同步',
	desc: '把仓库同步到本地的一个文件夹副本：目标在哪儿、怎么比、删了怎么办',
	groups: [
		{
			heading: '同步目标',
			fields: [
				{
					key: 'targetDir',
					name: '目标文件夹',
					desc: '副本放在哪个文件夹（填绝对路径，例如 D:\\备份\\我的笔记；也可以直接指向移动硬盘或网盘的同步目录）。文件夹不存在时会自动创建',
					control: { type: 'text', placeholder: 'D:\\备份\\我的笔记' },
					coerce: value => coerceText(value, DEFAULT_SETTINGS.targetDir),
				},
				{
					key: 'syncDirection',
					name: '同步方向',
					desc: '双向＝两边改动互相补；仅上传＝本地删改会覆盖副本，副本的改动不回流；仅下载＝反方向',
					control: { type: 'dropdown', options: DIRECTION_OPTIONS },
					coerce: value => coerceDirection(value),
				},
				{
					key: 'excludePatterns',
					name: '不同步的文件',
					desc: '一行一条，写法同 .gitignore：结尾带 / 表示整个文件夹，不带 / 就匹配任意层级的同名文件，支持 * 与 ?。默认排除配置目录（各台机器的插件与快捷键往往不同）',
					control: {
						type: 'textarea',
						placeholder: '一行一条，例如：\n.obsidian/\n*.tmp',
						rows: 6,
					},
					coerce: value => coerceText(value, DEFAULT_SETTINGS.excludePatterns),
				},
			],
		},
		{
			heading: '删除与冲突',
			fields: [
				{
					key: 'propagateDeletions',
					name: '同步删除',
					desc: '本地删掉的文件，副本里也删掉；副本里删掉的，本地也删。关掉的话删除不会传播——被删的文件会从另一边重新长回来（只在两边都没再动过它的情况下才判定为删除，没同步过的新文件永远不会被删）',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.propagateDeletions),
					rerenderOnChange: true,
				},
				{
					key: 'deletedToTrash',
					name: '删除前先备份',
					desc: '删掉的文件不直接消失，而是挪进回收目录：副本那边的在「目标文件夹/.lsave/trash」，本地这边的在「仓库/.trash/locally-save」，按时间分堆',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.deletedToTrash),
					disabled: settings => !settings.propagateDeletions,
				},
				{
					key: 'conflictStrategy',
					name: '两边都改了怎么办',
					desc: '判定依据是"跟上次同步后的样子比，哪边动过"。两边都动过才算冲突：留两份是最稳的，改得新的那份占原名，另一份存成「xxx (冲突副本 时间戳)」',
					control: { type: 'dropdown', options: CONFLICT_OPTIONS },
					coerce: value => coerceConflict(value),
				},
			],
		},
	],
};

/** 「同步包」一页：把一个副本装进单个文件，用 U 盘 / 网盘搬来搬去 */
export const BUNDLE_SECTION: FieldSection = {
	type: 'page',
	heading: '同步包',
	desc: `把仓库（或只把改动）导出成单个 ${BUNDLE_EXTENSION} 文件，拷到另一台机器上打开即可应用`,
	groups: [
		{
			heading: '导出',
			fields: [
				{
					key: 'bundleDir',
					name: '同步包文件夹',
					desc: `导出的 ${BUNDLE_EXTENSION} 文件放哪儿（填绝对路径）。留空则每次导出时手动填路径`,
					control: { type: 'text', placeholder: 'D:\\传输' },
					coerce: value => coerceText(value, DEFAULT_SETTINGS.bundleDir),
				},
				{
					key: 'bundleMode',
					name: '导出内容',
					desc: '完整副本＝整个仓库，体积大但到哪台机器都能整份恢复；仅改动＝只装自上次导出后变过的文件，体积小，适合天天来回搬',
					control: {
						type: 'dropdown',
						options: {
							full: '完整副本（整个仓库）',
							changes: '仅改动（自上次导出后变过的文件）',
						},
					},
					coerce: value => coerceChoice(value, ['full', 'changes'] as const, DEFAULT_SETTINGS.bundleMode),
				},
				{
					key: 'rememberFingerprints',
					name: '记住内容指纹',
					desc: '给文件算 sha256 并记下来（按大小与修改时间缓存，改过的才算）。作用是：世代对不上时能靠"内容"而不是"时间"判断本地有没有改过，合并更准。第一次导出会多花一两秒读一遍全库',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.rememberFingerprints),
				},
			],
		},
		{
			heading: '应用',
			fields: [
				{
					key: 'bundleDeleteMissing',
					name: '应用时删除多余文件',
					desc: '只对「完整副本」生效：本地有、包里没有、且比包更早的文件会被删掉（在导出那台机器上删过的文件，这边跟着删）。比包新的文件不动——那多半是这边刚写的',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.bundleDeleteMissing),
				},
				{
					key: 'bundleVerify',
					name: '应用前校验完整性',
					desc: '把整个包读一遍算校验和，确认传输（U 盘、网盘）没把文件弄坏。包很大时这一步会多花几秒',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.bundleVerify),
				},
			],
		},
	],
};
