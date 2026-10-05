import {
	CONFLICT_OPTIONS,
	DEFAULT_SETTINGS,
	SIZE_LIMIT_OPTIONS,
	coerceBoolean,
	coerceChoice,
	coerceConflict,
	coerceText,
} from '../model';
import type { PluginSettings } from '../model';
import { bundleBaseDir } from '../../bundle/paths';
import { ApplyBundleModal, ExportBundleModal } from '../../ui/bundle-modal';
import { BundleHelpModal } from '../../ui/help-modal';
import { BundleManagerModal } from '../../ui/manage-modal';
import { associationSupported } from '../../ui/associate';
import { AssociateModal } from '../../ui/associate-modal';
import type { FieldSection } from './types';

/**
 * 「同步包」一页：包放哪儿、什么时候自动留、应用时默认怎么处理。
 *
 * 0.8.0 起这是插件**唯一**的一条通道：**完整副本（基准 + 还原点）+ 更新包（天天搬）**。
 * 原来那一组"同步到本地文件夹副本"的设置（目标文件夹 / 同步方向 / 删除传播）
 * 随那条通道一起删掉了 —— 共用目录那种用法交给 Remotely Save 这类走云的插件，
 * 这里只做"不联网的单文件搬运"。
 */
export const SYNC_SECTION: FieldSection = {
	type: 'page',
	heading: '同步包',
	desc: '把仓库打包成单个 .lsave 文件来回搬：先立一份完整副本当基准，之后只导累积的更新包',
	groups: [
		{
			heading: '包放在哪',
			fields: [
				{
					key: 'bundleDir',
					name: '同步包文件夹',
					desc: '包放在哪个文件夹（填绝对路径，例如 D:\\备份\\同步包）。完整包与更新包分别放在它的 '
						+ 'full 与 changes 子目录里。**必填**：留空时导出与应用都不可用 —— '
						+ '包是这个插件唯一的搬运格式，放哪儿得你说了算，插件不该替你藏一个默认值',
					control: { type: 'text', placeholder: 'D:\\备份\\同步包' },
					coerce: value => coerceText(value, DEFAULT_SETTINGS.bundleDir),
				},
				{
					key: 'excludePatterns',
					name: '不进包的文件',
					desc: '一行一条，写法同 .gitignore：结尾带 / 表示整个文件夹，不带 / 就匹配任意层级的同名文件，'
						+ '支持 * 与 ?。默认排除配置目录（各台机器的插件与快捷键往往不同）、回收目录与系统垃圾文件',
					control: {
						type: 'textarea',
						placeholder: '一行一条，例如：\n附件/临时/\n*.tmp',
						rows: 6,
					},
					coerce: value => coerceText(value, DEFAULT_SETTINGS.excludePatterns),
				},
			],
		},
		{
			heading: '自动留包',
			// 什么时候触发在「自动留包」那一页（启动 / 定时 / 保存后）；
			// 这里只管留哪种包 —— 两个开关各自独立
			fields: [
				{
					key: 'autoExportChanges',
					name: '留更新包',
					desc: '自上次**完整副本**以来累积的全部改动（含一份删除清单）导成一个包放进「同步包文件夹/changes」。'
						+ '对方永远只需要应用**最新那一个**，跳过中间几个也不会少内容。'
						+ '**第一次要先导一次完整副本** —— 更新包要有基准。'
						+ '两个开关都开着时：完整包先留、更新包按它算必然是空的，于是不会留空包',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.autoExportChanges),
				},
				{
					key: 'autoExportFull',
					name: '留完整包',
					desc: '每次留包都把整个仓库重写一遍放进「同步包文件夹/full」，几百 MB 的库会明显变慢。'
						+ '它是**还原点**，也是更新包的基准 —— 只在"随时要给别人一份完整副本"时才打开',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.autoExportFull),
				},
				{
					key: 'bundleSizeWarnLimit',
					name: '更新包超过多大就提醒换基准',
					desc: '更新包是**累积**的，越攒越大；大到快赶上完整副本时，它最大的好处（传得小）就没了。'
						+ '到点会弹窗：建议先把手上这个更新包传过去应用，再重导一份完整副本当新基准'
						+ '（换完基准，更新包从零重新累积）。',
					control: { type: 'dropdown', options: SIZE_LIMIT_OPTIONS },
					coerce: value => coerceChoice(
						value,
						Object.keys(SIZE_LIMIT_OPTIONS),
						DEFAULT_SETTINGS.bundleSizeWarnLimit,
					),
				},
			],
		},
		{
			heading: '应用同步包时的默认处理',
			fields: [
				{
					key: 'conflictStrategy',
					name: '两边都改了怎么办',
					desc: '「应用方式」选「按设置」时按这一条办。判定依据是"跟上次应用后的样子比，包和我这边各自动过没有"：'
						+ '两边都动过才算冲突 —— 留两份最稳（改得新的那份占原名，另一份存进回收目录的「冲突」文件夹，不留在原地）。'
						+ '打开包时可以这一次性地覆盖它（「两边都留 / 以我为准 / 以包为准」）',
					control: { type: 'dropdown', options: CONFLICT_OPTIONS },
					coerce: value => coerceConflict(value),
				},
				{
					key: 'propagateDeletions',
					name: '包里删掉的文件，这边也删',
					desc: '关掉的话，包里点名要删的一律留着。删除必须过基准检查，没有例外：'
						+ '本地改过的、或者还在别的中间版本上的，都不删 —— 宁可留着',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.propagateDeletions),
				},
				{
					key: 'deletedToTrash',
					name: '删除前先备份',
					desc: '删掉的文件不直接消失，而是挪进「仓库/.trash/locally-save/时间戳/」，想反悔可以手动捞回来。'
						+ '强制两档（以包为准 / 完全镜像）**一定会备份**，不看这一项 —— '
						+ '关掉回收再加强制，等于不可恢复的批量删除，不给这个组合留口子',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.deletedToTrash),
				},
			],
		},
		{
			heading: '手动导出',
			// 这一组没有设置项：导哪种包是"这一次要怎么导"的选择，
			// 放在对话框里两个独立开关上（不是互斥的下拉框）
			fields: [],
			actions: [
				{
					name: '导出到文件',
					desc: '把仓库打包成 .lsave 文件，拷到别的机器上用下面的按钮应用。'
						+ '对话框里**完整副本与更新包是两个独立开关**，可以都要（都勾时先导完整副本、再导更新包；'
						+ '完整副本刚把整个仓库装走，这时的更新包必然是空的，所以不会生成它）',
					button: '导出同步包…',
					cta: true,
					run: plugin => { new ExportBundleModal(plugin.app, plugin).open(); },
					disabled: settings => !hasBundleDir(settings),
				},
			],
		},
		{
			heading: '管理',
			// 包攒多了要清、要看看某个包到底在哪个目录：这些都是"管已有的包"，不是设置项
			fields: [],
			actions: [
				{
					name: '管理已有的包',
					desc: '列出同步包文件夹里的所有包（完整还是更新、多大、什么时候导的），'
						+ '选中一行可以**应用… / 打开所在文件夹 / 复制路径 / 挪进回收站 / 彻底删除**。'
						+ '「挪进回收站」只是挪走（跟 bundles 平级的 .lsave/bundles-trash/时间戳/，还能捞回来）；'
						+ '「彻底删除」是真删，单个包就能删，不必为它清空整个回收站',
					button: '管理同步包…',
					run: plugin => { new BundleManagerModal(plugin.app, plugin).open(); },
				},
			],
		},
		{
			heading: '应用同步包',
			fields: [
				{
					key: 'autoApplyIncoming',
					name: '自动应用收到的更新包',
					desc: '有人把包放进「同步包文件夹」之后，不用再手点那一下：每 30 秒看一眼，发现**没处理过**的包就处理 ——'
						+ '每次只看**最新那一个**（更新包是累积的、完整包是完整清单，更新的包已经包含旧的，'
						+ '比它旧的还没处理的会记成"被取代了"）。'
						+ '更新包**只在完全不会动到本地已有的东西时**才自己应用（不删文件、不覆盖你改过的内容、不产生冲突副本）；'
						+ '要删东西、或者两边都改过时，只提示一句让你自己打开看。'
						+ '**完整副本从来不自动应用**（它可能删掉你本机独有的文件），也只提示一句。'
						+ '我自己的导出、以及已经处理过的包都会跳过',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.autoApplyIncoming),
				},
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
					desc: '选中 .lsave 文件后会**先算一遍再给你看**（同步程度、会改动哪些、会不会删东西）；'
						+ '冲突与删除默认跟随设置，也可以在对话框里临时覆盖。这一步只读，不碰你的文件',
					button: '打开同步包并应用…',
					cta: true,
					run: plugin => { new ApplyBundleModal(plugin.app, plugin).open(); },
					disabled: settings => !hasBundleDir(settings),
				},
			],
		},
		{
			heading: '用 Obsidian 直接打开',
			// 这一组也没有设置项：都是"点一下做一件事"的按钮
			fields: [],
			actions: [
				{
					name: '把 .lsave 关联到 Obsidian',
					desc: '双击 .lsave 就用 Obsidian 打开并弹出应用对话框。'
						+ '做法是往当前用户注册表写一条关联（**不需要管理员权限**，只动 HKCU）。'
						+ '注意：单纯"用 Obsidian 打开"是通不了的 —— 必须让它调起 obsidian:// 链接'
						+ '（而且链接里要写明 vault，插件才收得到）',
					button: '设置关联',
					run: plugin => { new AssociateModal(plugin.app, plugin.app.vault.getName()).open(); },
					disabled: () => !associationSupported(),
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

/** 没填「同步包文件夹」＝没地方放包、也没地方找包 —— 导出 / 应用按钮就该是灰的 */
function hasBundleDir(settings: PluginSettings): boolean {
	return bundleBaseDir(settings) !== '';
}
