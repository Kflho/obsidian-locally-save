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
 * 「Git 远程」一页：把包文件夹接到一个 git 仓库。
 *
 * 这一页的说明写短：原理、为什么要私有仓库、完整包为什么不推，都在 README / 看说明里
 * （用户提过"界面解释太啰嗦"）。这里只留"填什么、点哪个"。
 */
export const GIT_SECTION: FieldSection = {
	type: 'page',
	heading: 'Git 远程',
	desc: '把包文件夹接到一个 git 仓库：一台机器推上去，另一台拉下来。完整包太大，不推，仍用 U 盘搬',
	groups: [
		{
			heading: '连接',
			fields: [
				{
					key: 'gitEnabled',
					name: '启用 git 传输',
					desc: '打开后，留包会自动提交并推上去，定时拉下别人的包；关着时一个网络请求都不发',
					control: { type: 'toggle' },
					// 打开 / 关掉之后，「当前状态」那一行要跟着变（旧版 DOM 靠它整块重画）
					rerenderOnChange: true,
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.gitEnabled),
				},
				{
					key: 'gitRemote',
					name: '远程地址',
					desc: 'HTTPS 或 SSH 都行。仓库请用私有的 —— 更新包里是笔记内容',
					control: { type: 'text', placeholder: 'git@github.com:you/lsave-bundles.git' },
					coerce: value => coerceText(value, DEFAULT_SETTINGS.gitRemote),
				},
				{
					key: 'syncDirection',
					name: '方向',
					desc: '双向＝收发都做（收到先弹窗确认，应用后把本机改动回传）；仅推＝只发不收；'
						+ '仅拉＝只收不发（收到直接应用，本机改动进回收目录，也不导出包）',
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
					desc: '第一次用点它：把包文件夹变成 git 仓库、接上远程（没填全时会提示差什么）',
					button: '接入…',
					cta: true,
					run: plugin => { void connectGitRemote(plugin); },
				},
				{
					name: '测试连通性',
					desc: '查 git 版本、远程能不能连上、SSH / 凭据行不行（会联网，比"接入"先跑一遍更省事）',
					button: '测试',
					run: plugin => { void checkGitConnectivity(plugin); },
				},
				{
					name: 'SSH 接入',
					desc: '生成 / 复制公钥、用 GitHub CLI 添加、测 SSH 登录（远程是 SSH 地址时用）',
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
					desc: '导出一份包（有基准导更新包、没基准导完整包）+ 和远程推拉 + 应用拉下来的安全更新。不用等节拍',
					button: '同步',
					cta: true,
					run: plugin => { void syncNow(plugin); },
				},
				{
					name: '各台电脑同步状态',
					desc: '列出每台机器上报的状态编号 / 第几代 / 最后上报时间，标出一致、不同步、待上报',
					button: '查看…',
					run: plugin => {
						void openPeerStatus(plugin, () => { void syncGitNow(plugin, { manual: true }); });
					},
				},
				{
					name: '让对面和我一致',
					desc: '把本机改动导成更新包推上去；对面拉下来应用之后就变成我这样',
					button: '推上去',
					run: plugin => { void uploadNow(plugin); },
				},
				{
					name: '让我和对面一致',
					desc: '把对方最新的包拉下来、严格对齐过去（本机改动先进回收目录）；做完两边状态编号一致',
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
					name: '打开货架文件夹',
					desc: '包文件夹本身（也是 git 工作区）',
					button: '打开',
					run: plugin => openShelfFolder(plugin),
				},
			],
		},
	],
};
