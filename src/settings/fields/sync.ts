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
import type { PluginSettings } from '../model';
import { bundleBaseDir } from '../../bundle/paths';
import { ApplyBundleModal, ExportBundleModal } from '../../ui/bundle-modal';
import { BundleHelpModal } from '../../ui/help-modal';
import type { FieldSection } from './types';

/**
 * 「本地同步」一页：副本放哪儿、怎么比、删了怎么办，以及怎么把改动装进一个文件搬走。
 *
 * 同步包不单独分页：它本来就是"本地同步的搬运方式"——包里的内容就是同步的产物，
 * 放在一起用户才看得明白两者的关系（2026-10 从独立一页并进来的）。
 */
export const SYNC_SECTION: FieldSection = {
	type: 'page',
	heading: '本地同步',
	desc: '把仓库同步到本地的一个文件夹副本，并把改动装进单个文件来回搬',
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
		{
			heading: '同步包：自动留包',
			fields: [
				{
					key: 'autoExportChanges',
					name: '同步后自动留更新包',
					desc: '每次同步成功后，把自上次**完整副本**以来的累积改动导成一个包放进「同步包文件夹/changes」'
						+ '（没有变化就不导）。用的是同步刚扫完的结果，几乎不额外花时间；'
						+ '包会随改动累积变大，定期导一次完整副本即可清零。**第一次要先导一次完整副本**，更新包要有基准',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.autoExportChanges),
				},
				{
					key: 'autoExportFull',
					name: '同步后自动留完整包',
					desc: '每次同步成功后，把整个仓库导成一个包放进「同步包文件夹/full」。'
						+ '注意：完整包每次都要把整个仓库重写一遍，几百 MB 的库会明显变慢；'
						+ '只在"随时要给别人一份完整副本"时才打开',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.autoExportFull),
				},
				{
					key: 'bundleDir',
					name: '同步包文件夹',
					desc: `留空＝放在**目标文件夹**的 .lsave/bundles 下（这个目录不参与同步，包不会被当成副本内容传回仓库）。`
						+ `填了就用你指定的路径。完整包与更新包分别放在它的 full 与 changes 子目录里。`
						+ `输入框里的灰字就是"留空时会用的路径"`,
					control: {
						type: 'text',
						// 按惯例把"默认值"显示成灰底提示，而不是预先填进输入框 ——
						// 预先填进去的话，用户一删就变成"没填路径"，还得自己猜默认是哪儿
						placeholder: settings => {
							const base = bundleBaseDir(settings, settings.targetDir);
							return base || '先填上面的「目标文件夹」，或在这里直接指定';
						},
					},
					coerce: value => coerceText(value, DEFAULT_SETTINGS.bundleDir),
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
			heading: '同步包：手动导出',
			// 这一组没有设置项：导哪种包是"这一次要怎么导"的选择，
			// 放在对话框里两个独立开关上（不是互斥的下拉框）
			fields: [],
			actions: [
				{
					name: '导出到文件',
					desc: '把仓库打包成 .lsave 文件，拷到别的机器上用下面的按钮应用。'
						+ '对话框里**完整副本与更新包是两个独立开关**，可以都要（都勾时先导更新包、再导完整包）',
					button: '导出同步包…',
					cta: true,
					run: plugin => { new ExportBundleModal(plugin.app, plugin).open(); },
					disabled: settings => !hasBundleTarget(settings),
				},
			],
		},
		{
			heading: '同步包：应用',
			fields: [
				{
					key: 'dropBundleToApply',
					name: '拖入 .lsave 即打开应用对话框',
					desc: '把 .lsave 文件直接拖到 Obsidian 窗口上，自动打开这个对话框并填好路径（等同于在这里粘路径）。'
						+ '只拦 .lsave，往笔记里拖图片、拖别的文件一概不受影响；关掉的话拖进来会交给 Obsidian 自己处理',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.dropBundleToApply),
				},
				{
					key: 'bundleVerify',
					name: '应用前校验完整性',
					desc: '把整个包读一遍算校验和，确认传输（U 盘、网盘）没把文件弄坏。包很大时这一步会多花几秒',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.bundleVerify),
				},
			],
			actions: [
				{
					name: '应用一个包',
					desc: '选中 .lsave 文件后会**先算一遍再给你看**（同步程度、会改动哪些、会不会删东西）。'
						+ '**应用方式在对话框里当场选**：所有都保留 / 清老的 / 强制应用 —— '
						+ '后两种只对完整副本开放，而且真要删东西时会再确认一次。这一步只读，不碰你的文件',
					button: '打开同步包并应用…',
					cta: true,
					run: plugin => { new ApplyBundleModal(plugin.app, plugin).open(); },
					disabled: settings => !hasBundleTarget(settings),
				},
				{
					name: '不知道怎么用？',
					desc: '跨机器搬运的完整流程、两种包该用哪个、会不会弄丢东西',
					button: '看说明',
					run: plugin => { new BundleHelpModal(plugin.app).open(); },
				},
			],
		},
	],
};

/** 两个目录都空着时没地方放包、也没地方找包 —— 按钮就该是灰的 */
function hasBundleTarget(settings: PluginSettings): boolean {
	return settings.targetDir.trim() !== '' || settings.bundleDir.trim() !== '';
}
