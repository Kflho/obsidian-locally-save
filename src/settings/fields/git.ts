import {
	DEFAULT_SETTINGS,
	DIRECTION_OPTIONS,
	coerceBoolean,
	coerceDirection,
	coerceText,
} from '../model';
import {
	checkGitConnectivity,
	checkGitEnvironment,
	connectGitRemote,
	describeGitConnection,
	downloadNow,
	openShelfFolder,
	syncGitNow,
	uploadNow,
} from '../../ui/git';
import { SshKeyModal } from '../../ui/ssh-modal';
import { syncNow } from '../../ui/actions';
import { openPeerStatus } from '../../ui/status';
import type { FieldSection } from './types';

/**
 * 「Git 远程」一页：把同步包文件夹接到一个 git 仓库。
 *
 * 这一页的说明写短：原理、为什么要私有仓库、完整备份为什么不推，都在 README / 看说明里
 * （用户提过"界面解释太啰嗦"）。这里只留"填什么、点哪个"。
 */
export const GIT_SECTION: FieldSection = {
	type: 'page',
	heading: 'Git 远程',
	desc: '把同步包文件夹接入 Git 仓库，通过推送和拉取传输同步包。完整备份较大，不通过 Git 传输。',
	groups: [
		{
			heading: '连接',
			fields: [
				{
					key: 'gitEnabled',
					name: '启用 Git 传输',
					desc: '开启后自动提交并推送新的同步包，并定时拉取其他电脑的包；关闭后不发起网络请求。',
					control: { type: 'toggle' },
					// 打开 / 关掉之后，「当前状态」那一行要跟着变（旧版 DOM 靠它整块重画）
					rerenderOnChange: true,
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.gitEnabled),
				},
				{
					key: 'gitRemote',
					name: '远程地址',
					desc: 'HTTPS 或 SSH 地址。请使用私有仓库，因为更新包中包含笔记内容。',
					control: { type: 'text', placeholder: 'git@github.com:you/lsave-bundles.git' },
					coerce: value => coerceText(value, DEFAULT_SETTINGS.gitRemote),
				},
				{
					key: 'syncDirection',
					name: '同步方向',
					desc: '本电脑负责发送、接收，还是两者都做。',
					control: { type: 'dropdown', options: DIRECTION_OPTIONS },
					coerce: value => coerceDirection(value),
				},
			],
		},
		{
			heading: '连接状态',
			// 按钮**不再按条件变灰**：变灰只会让人问"为什么点不了"。点了就立即说清差什么、下一步做什么。
			fields: [],
			actions: [
				{
					name: '连接状态',
					desc: plugin => describeGitConnection(plugin),
					button: '查看详情',
					run: plugin => { void checkGitEnvironment(plugin); },
				},
				{
					name: '连接远程仓库',
					desc: '把同步包文件夹初始化为 Git 仓库并连接远程地址；信息不完整时提示缺少什么。',
					button: '连接…',
					cta: true,
					run: plugin => { void connectGitRemote(plugin); },
				},
				{
					name: '检查连接',
					desc: '检查 Git、远程地址与 SSH 凭据是否可用。此操作会联网。',
					button: '检查',
					run: plugin => { void checkGitConnectivity(plugin); },
				},
				{
					name: 'SSH 密钥',
					desc: '生成或复制公钥、添加密钥，并测试 SSH 登录。',
					button: '设置 SSH 密钥…',
					run: plugin => { new SshKeyModal(plugin.app, plugin.settings.gitRemote).open(); },
				},
			],
		},
		{
			heading: '同步动作',
			fields: [],
			actions: [
				{
					name: '立即同步',
					desc: '导出同步包，与远程仓库推送和拉取，并应用收到的包；不必等待下一个定时周期。',
					button: '同步',
					cta: true,
					run: plugin => { void syncNow(plugin); },
				},
				{
					name: '各台电脑同步状态',
					desc: '查看每台电脑的内容编号、版本号与最后上报时间。',
					button: '查看…',
					run: plugin => {
						void openPeerStatus(plugin, () => { void syncGitNow(plugin, { manual: true }); });
					},
				},
				{
					name: '推送本电脑的改动',
					desc: '把本电脑改动导出为更新包并推送；其他电脑应用后与本电脑一致。',
					button: '推送',
					run: plugin => { void uploadNow(plugin); },
				},
				{
					name: '拉取其他电脑的改动',
					desc: '拉取其他电脑最新的包并对齐；本电脑改动先移到回收站。',
					button: '拉取',
					run: plugin => { void downloadNow(plugin); },
				},
			],
		},
		{
			heading: '其他',
			fields: [],
			actions: [
				{
					name: '打开同步包文件夹',
					desc: '同步包所在的文件夹，同时也是 Git 工作区。',
					button: '打开',
					run: plugin => openShelfFolder(plugin),
				},
			],
		},
	],
};
