import {
	DEFAULT_SETTINGS,
	SIZE_WARN_OPTIONS,
	coerceAnchorFingerprint,
	coerceBoolean,
	coerceNumberChoice,
	coerceText,
} from '../model';
import { anchorOptions, listFullAnchorsSync, LATEST_STATE } from '../../bundle/anchor';
import { bundleBaseDir } from '../../bundle/paths';
import { loadStateSync } from '../../sync/state';
import type LocallySavePlugin from '../../main';
import type { FieldSection } from './types';

/**
 * 「高级」一页：**日常用不到的东西全收在这儿**。
 *
 * 用户提过"包设置太繁琐"：主页面只留同步 / 文件夹 / 导出管理，
 * 进包规则、更新包起点终点、校验、拖放、自动应用、git 细节都移到这。
 * 这些设置本身都还有用（不是删掉），只是不该挡在第一次用的人面前。
 */
export const ADVANCED_SECTION: FieldSection = {
	type: 'page',
	heading: '高级',
	desc: '不常用的设置：进包规则、更新包端点、校验、自动应用与 Git 细节。',
	groups: [
		{
			heading: '包内容',
			fields: [
				{
					key: 'excludePatterns',
					name: '不进包的文件',
					desc: '一行一条，写法与 .gitignore 相同（目录/、*.tmp、a/**/*.md）。默认已排除配置目录、回收目录和系统临时文件。',
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
			heading: '更新包起点 / 终点',
			// 本地有几份完整备份，就有几个"状态" —— 选项在渲染那一刻扫包目录算出来
			fields: [
				{
					key: 'changesFromState',
					name: '从哪个状态开始',
					desc: '默认是本机当前的基准。仅在对方仍使用更旧的一份时才需要修改。',
					control: { type: 'dropdown', options: plugin => stateChoices(plugin, 'from') },
					coerce: value => coerceAnchorFingerprint(value),
				},
				{
					key: 'changesToState',
					name: '到哪个状态为止',
					desc: '默认「最新」（当前仓库）。选择另一份完整备份时，将导出这两份之间的差分更新包。',
					control: { type: 'dropdown', options: plugin => stateChoices(plugin, 'to') },
					coerce: value => coerceAnchorFingerprint(value),
				},
				{
					key: 'bundleSizeWarnLimit',
					name: '变大了提醒立新基准',
					desc: '更新包超过该大小时，提醒导出新的完整备份并更换基准。',
					control: { type: 'dropdown', options: SIZE_WARN_OPTIONS },
					coerce: value => coerceNumberChoice(
						value,
						Object.keys(SIZE_WARN_OPTIONS).map(Number),
						DEFAULT_SETTINGS.bundleSizeWarnLimit,
					),
				},
			],
		},
		{
			heading: '应用与校验',
			fields: [
				{
					key: 'autoApplyIncoming',
					name: '自动应用收到的更新包',
					desc: '未启用 Git 时，只自动应用不会删除文件、也不会覆盖本地改动的更新包；启用 Git 后由「方向」决定。',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.autoApplyIncoming),
				},
				{
					key: 'autoApplyIncomingBoth',
					name: '双向时收到包直接应用（不确认）',
					desc: '启用 Git 且方向为双向时，收到同步包不再确认，直接按对方的状态覆盖本机；会覆盖或删除本地文件（移入回收目录）。供无人值守场景使用，默认关闭。',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.autoApplyIncomingBoth),
				},
				{
					key: 'dropBundleToApply',
					name: '拖入 .lsave 即打开应用对话框',
					desc: '把 .lsave 拖到窗口上即打开应用对话框；拖动图片和附件不受影响。',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.dropBundleToApply),
				},
				{
					key: 'bundleVerify',
					name: '应用前校验完整性',
					desc: '先读取整个包并计算校验和，确认传输没有损坏文件。大包会多花几秒。',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.bundleVerify),
				},
			],
		},
		{
			heading: 'Git 细节',
			fields: [
				{
					key: 'gitBranch',
					name: '分支',
					desc: '搬包用的分支。',
					control: { type: 'text', placeholder: 'main' },
					coerce: value => coerceText(value, DEFAULT_SETTINGS.gitBranch).trim() || DEFAULT_SETTINGS.gitBranch,
				},
				{
					key: 'gitPath',
					name: 'git 路径',
					desc: '留空表示从 PATH 中查找；找不到时填写 git.exe 的完整路径。',
					control: { type: 'text', placeholder: 'C:\\Program Files\\Git\\cmd\\git.exe' },
					coerce: value => coerceText(value, DEFAULT_SETTINGS.gitPath),
				},
			],
		},
	],
};

/**
 * 「从哪个状态 / 到哪个状态」的选项：**只有完整备份**，外加"默认"那一项。
 * 设置面板是同步渲染的，所以用同步那套读法（只读包头部，很便宜）。
 */
function stateChoices(plugin: LocallySavePlugin, end: 'from' | 'to'): Record<string, string> {
	const fallback = end === 'from'
		? { [LATEST_STATE]: '自动：本机现在的基准' }
		: { [LATEST_STATE]: '最新（当前仓库）' };
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
			options[wanted] = `基准 ${wanted}（这个目录里找不到这一份完整备份）`;
		}
		return options;
	} catch {
		return fallback;
	}
}
