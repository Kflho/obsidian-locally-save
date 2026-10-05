import {
	CONFLICT_OPTIONS,
	DEFAULT_SETTINGS,
	SIZE_LIMIT_OPTIONS,
	coerceBoolean,
	coerceChoice,
	coerceConflict,
	coerceAnchorFingerprint,
	coerceText,
} from '../model';
import type { PluginSettings } from '../model';
import { anchorOptions, listFullAnchorsSync, LATEST_STATE } from '../../bundle/anchor';
import { bundleBaseDir } from '../../bundle/paths';
import { loadStateSync } from '../../sync/state';
import { ApplyBundleModal, ExportBundleModal } from '../../ui/bundle-modal';
import { BundleHelpModal } from '../../ui/help-modal';
import { BundleManagerModal } from '../../ui/manage-modal';
import { associationSupported } from '../../ui/associate';
import { AssociateModal } from '../../ui/associate-modal';
import type LocallySavePlugin from '../../main';
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
					desc: '包放在哪个文件夹（绝对路径）。完整包与更新包分别进它的 full 与 changes 子目录。必填',
					control: { type: 'text', placeholder: 'D:\\备份\\同步包' },
					coerce: value => coerceText(value, DEFAULT_SETTINGS.bundleDir),
				},
				{
					key: 'excludePatterns',
					name: '不进包的文件',
					desc: '一行一条，写法同 .gitignore（`目录/`、`*.tmp`、`a/**/*.md`）。默认已排除配置目录、回收目录与系统垃圾文件',
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
					desc: '留包时导一个更新包（自上次完整副本以来累积的改动）。第一次要先导一次完整副本',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.autoExportChanges),
				},
				{
					key: 'autoExportFull',
					name: '留完整包',
					desc: '留包时导一份完整副本（整个仓库重写一遍，大库会明显变慢）。它是还原点，也是更新包的基准',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.autoExportFull),
				},
				{
					key: 'bundleSizeWarnLimit',
					name: '更新包超过多大就提醒换基准',
					desc: '更新包是累积的、越攒越大；到线弹窗问要不要重导一份完整副本当新基准',
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
			heading: '更新包从哪个状态到哪个状态',
			// 本地有几份完整包，就有几个"状态"，再加上「最新」这一项 ——
			// 选项是在渲染那一刻扫包目录算出来的（见 bundle/anchor.ts）
			fields: [
				{
					key: 'changesFromState',
					name: '从哪个状态开始',
					desc: '更新包接着哪一份完整副本往后算。默认「最新那份完整副本」；'
						+ '对方还停在更老的一份上时，照它「更新记录」里的基准指纹选（世代号说不出是哪一份完整副本）',
					control: { type: 'dropdown', options: plugin => stateChoices(plugin, 'from') },
					coerce: value => coerceAnchorFingerprint(value),
				},
				{
					key: 'changesToState',
					name: '到哪个状态为止',
					desc: '默认「最新（当前仓库）」；选一份完整副本则导到那一刻为止（内容取自那份包，不是你现在的仓库）',
					control: { type: 'dropdown', options: plugin => stateChoices(plugin, 'to') },
					coerce: value => coerceAnchorFingerprint(value),
				},
			],
		},
		{
			heading: '应用同步包时的默认处理',
			fields: [
				{
					key: 'conflictStrategy',
					name: '两边都改了怎么办',
					desc: '「应用方式」选「按设置」时按这条办。默认留两份：新的占原名，旧的那份进回收目录的「冲突」文件夹',
					control: { type: 'dropdown', options: CONFLICT_OPTIONS },
					coerce: value => coerceConflict(value),
				},
				{
					key: 'propagateDeletions',
					name: '包里删掉的文件，这边也删',
					desc: '关掉的话，包里点名要删的一律留着（本地改过的一律不删，不受这一项影响）',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.propagateDeletions),
				},
				{
					key: 'deletedToTrash',
					name: '删除前先备份',
					desc: '删掉的文件挪进回收目录（`仓库/.trash/locally-save/`），还能捞回来。'
						+ '强制两档（以包为准 / 完全镜像）一定备份，不看这一项',
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
					desc: '把仓库打包成 .lsave 文件，拷到别的机器上应用。完整副本与更新包是两个独立开关，可以都要',
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
					desc: '列出包文件夹里的所有包：应用 / 打开文件夹 / 复制路径 / 挪进回收站 / 彻底删除',
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
					desc: '每 30 秒看一眼包文件夹：只在**不会动到本地已有东西**时才自己应用；'
						+ '完整包、要删东西的、两边都改过的一律只提示一句',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.autoApplyIncoming),
				},
				{
					key: 'dropBundleToApply',
					name: '拖入 .lsave 即打开应用对话框',
					desc: '把 .lsave 拖到 Obsidian 窗口上就打开应用对话框。只拦 .lsave，别的文件一概不受影响',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.dropBundleToApply),
				},
				{
					key: 'bundleVerify',
					name: '应用前校验完整性',
					desc: '把整个包读一遍算校验和，确认传输没把文件弄坏（大包会多花几秒）',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.bundleVerify),
				},
			],
			actions: [
				{
					name: '应用一个包',
					desc: '选中包后先算一遍再给你看（同步程度、会改动哪些）；确认了才动文件',
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
					desc: '双击 .lsave 用 Obsidian 打开并弹出应用对话框（往当前用户注册表写一条关联，不需要管理员权限）',
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

/**
 * 「从哪个状态 / 到哪个状态」的选项：**本地有几份完整包就有几个状态**，外加「最新」。
 *
 * 设置面板是同步渲染的，所以这里用的是同步那套读法（`listFullAnchorsSync` /
 * `loadStateSync`）—— 只看包目录与状态文件，量都很小。
 * 读不出来（没填包目录、状态文件还没建）也要给出一张表：至少留着「最新」那一项，
 * 否则下拉框会空着，用户以为这个设置坏了。
 */
function stateChoices(plugin: LocallySavePlugin, end: 'from' | 'to'): Record<string, string> {
	const fallback = end === 'from'
		? { [LATEST_STATE]: '最新那份完整副本' }
		: { [LATEST_STATE]: '最新（当前仓库，现在这一刻）' };
	/** 现在存着的值（一个基准指纹）：那一份要是找不到了，也得把它列出来（否则下拉框会显示成别的项） */
	const current = end === 'from' ? plugin.settings.changesFromState : plugin.settings.changesToState;
	try {
		const base = bundleBaseDir(plugin.settings);
		const state = loadStateSync(plugin.stateFile());
		const anchors = listFullAnchorsSync(base, state.lineage);
		const options = anchorOptions(anchors, end, {
			generation: state.bundle?.fullGeneration ?? null,
			hash: state.bundle?.fullHash ?? null,
			file: state.bundle?.fullFile ?? null,
		});
		const wanted = coerceAnchorFingerprint(current);
		if (wanted !== '' && !(wanted in options)) {
			options[wanted] = `基准 ${wanted}（这个目录里找不到那一份完整副本）`;
		}
		return options;
	} catch {
		return fallback;
	}
}
