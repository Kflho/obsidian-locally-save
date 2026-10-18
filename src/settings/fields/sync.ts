import { DEFAULT_SETTINGS, coerceText } from '../model';
import type { PluginSettings } from '../model';
import { bundleBaseDir } from '../../bundle/paths';
import { ApplyBundleModal, ExportBundleModal } from '../../ui/bundle-modal';
import { BundleHelpModal } from '../../ui/help-modal';
import { BundleManagerModal } from '../../ui/manage-modal';
import { associationSupported } from '../../ui/associate';
import { AssociateModal } from '../../ui/associate-modal';
import { syncNow } from '../../ui/actions';
import type { FieldSection } from './types';

/**
 * 「同步包」一页：**只留日常要用的**。
 *
 * 包放哪儿、点一下同步、手动导出 / 管理 / 应用。
 * 进包规则、更新包起点终点、校验、拖放这些不常用的，全挪到「高级」页 ——
 * 用户提过"包设置太繁琐"，主页面不该摆一排下拉框。
 *
 * 0.8.0 起这是插件唯一的内容通道：完整副本（基准 + 还原点）+ 更新包（日常）。
 * 0.11.0 把「应用方式」收成严格同步，界面上已经没有可选项。
 */
export const SYNC_SECTION: FieldSection = {
	type: 'page',
	heading: '同步包',
	desc: '留包 / 应用同步包。日常直接点左侧栏的「立即同步」就行，这一页只管东西放在哪',
	groups: [
		{
			heading: '包放在哪',
			fields: [
				{
					key: 'bundleDir',
					name: '同步包文件夹',
					desc: '包放在哪个文件夹（绝对路径，库外面）。完整包进它的 full 子目录，更新包进 changes。必填',
					control: { type: 'text', placeholder: 'D:\\备份\\同步包' },
					coerce: value => coerceText(value, DEFAULT_SETTINGS.bundleDir),
				},
			],
		},
		{
			heading: '同步',
			fields: [],
			actions: [
				{
					name: '立即同步',
					desc: '导出包 + 和远程推拉 + 应用拉下来的安全更新。和左侧栏第一个图标是同一件事',
					button: '同步',
					cta: true,
					run: plugin => { void syncNow(plugin); },
					disabled: settings => !hasBundleDir(settings),
				},
			],
		},
		{
			heading: '手动导出',
			// 导哪种包是"这一次要怎么导"的选择，放在对话框里两个独立开关上（不是互斥的下拉框）
			fields: [],
			actions: [
				{
					name: '导出到文件',
					desc: '把仓库打包成 .lsave，拷到别的机器上应用。完整副本与更新包是两个独立开关，可以都要',
					button: '导出同步包…',
					run: plugin => { new ExportBundleModal(plugin.app, plugin).open(); },
					disabled: settings => !hasBundleDir(settings),
				},
			],
		},
		{
			heading: '管理',
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
			fields: [],
			actions: [
				{
					name: '应用一个包',
					desc: '选中包后先算一遍再给你看（同步程度、会改动哪些）；确认了才动文件',
					button: '打开同步包并应用…',
					run: plugin => { new ApplyBundleModal(plugin.app, plugin).open(); },
					disabled: settings => !hasBundleDir(settings),
				},
			],
		},
		{
			heading: '用 Obsidian 直接打开',
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
