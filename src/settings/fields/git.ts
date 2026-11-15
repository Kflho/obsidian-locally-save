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
	desc: '把同步包文件夹接入 Git 仓库，通过推送和拉取搬运同步包。完整备份体积较大，不通过 Git 传输。',
	groups: [
		{
			heading: '连接',
			fields: [
				{
					key: 'gitEnabled',
					name: '启用 git 传输',
					desc: '开启后自动提交并推送新包，并定时拉取对方的包；关闭时不发起任何网络请求。',
					control: { type: 'toggle' },
					// 打开 / 关掉之后，「当前状态」那一行要跟着变（旧版 DOM 靠它整块重画）
					rerenderOnChange: true,
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.gitEnabled),
				},
				{
					key: 'gitRemote',
					name: '远程地址',
					desc: 'HTTPS 或 SSH 地址。请用私有仓库：更新包里是笔记内容。',
					control: { type: 'text', placeholder: 'git@github.com:you/lsave-bundles.git' },
					coerce: value => coerceText(value, DEFAULT_SETTINGS.gitRemote),
				},
				{
					key: 'syncDirection',
					name: '方向',
					desc: '决定这台电脑负责哪一半：只发送、只接收，还是收发都做。',
					control: { type: 'dropdown', options: DIRECTION_OPTIONS },
					coerce: value => coerceDirection(value),
				},
			],
		},
		{
			heading: '状态与接入',
			// 按钮**不再按条件变灰**：变灰只会让人问"为什么点不了"。点了就当场说清差什么、下一步做什么。
			fields: [],
			actions: [
				{
					name: '当前状态',
					desc: plugin => describeGitConnection(plugin),
					button: '看详情',
					run: plugin => { void checkGitEnvironment(plugin); },
				},
				{
					name: '接入这个远程',
					desc: '把同步包文件夹初始化为 Git 仓库并连接远程；信息不完整时会提示缺少什么。',
					button: '接入…',
					cta: true,
					run: plugin => { void connectGitRemote(plugin); },
				},
				{
					name: '测试连通性',
					desc: '检查 Git、远程地址和 SSH 凭据是否可用。该操作会联网。',
					button: '测试',
					run: plugin => { void checkGitConnectivity(plugin); },
				},
				{
					name: 'SSH 接入',
					desc: '生成或复制公钥、添加密钥，并测试 SSH 登录。',
					button: 'SSH 设置…',
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
					desc: '导出同步包、与远程推送与拉取，并应用收到的包。无需等待下一个定时周期。',
					button: '同步',
					cta: true,
					run: plugin => { void syncNow(plugin); },
				},
				{
					name: '各台电脑同步状态',
					desc: '每台电脑的内容校验值、版本号和最后上报时间。',
					button: '查看…',
					run: plugin => {
						void openPeerStatus(plugin, () => { void syncGitNow(plugin, { manual: true }); });
					},
				},
				{
					name: '让对面和我一致',
					desc: '把本机改动导出为更新包并推送，对方应用后与本机一致。',
					button: '推上去',
					run: plugin => { void uploadNow(plugin); },
				},
				{
					name: '让我和对面一致',
					desc: '拉取对方最新的包并对齐。本机改动会先移入回收目录。',
					button: '拉下来',
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
