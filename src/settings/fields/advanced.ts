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
 * 进包规则、更新包起点终点、校验、拖放、自动应用、git 细节都挪到这。
 * 这些设置本身都还有用（不是删掉），只是不该挡在第一次用的人面前。
 */
export const ADVANCED_SECTION: FieldSection = {
	type: 'page',
	heading: '高级',
	desc: '不常用的设置：进包规则、更新包端点、校验、自动应用和 git 细节。',
	groups: [
		{
			heading: '包内容',
			fields: [
				{
					key: 'excludePatterns',
					name: '不进包的文件',
					desc: '一行一条，写法同 .gitignore（目录/、*.tmp、a/**/*.md）。默认已排除配置目录、回收目录和系统垃圾文件。',
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
			// 本地有几份完整包，就有几个"状态" —— 选项在渲染那一刻扫包目录算出来
			fields: [
				{
					key: 'changesFromState',
					name: '从哪个状态开始',
					desc: '默认是你站的那份完整副本。只有对方还停在更老的一份上时才需要改。',
					control: { type: 'dropdown', options: plugin => stateChoices(plugin, 'from') },
					coerce: value => coerceAnchorFingerprint(value),
				},
				{
					key: 'changesToState',
					name: '到哪个状态为止',
					desc: '默认「最新」（当前仓库）。选另一份完整副本会导出这两份之间的差量包。',
					control: { type: 'dropdown', options: plugin => stateChoices(plugin, 'to') },
					coerce: value => coerceAnchorFingerprint(value),
				},
				{
					key: 'bundleSizeWarnLimit',
					name: '攒大了提醒立新基准',
					desc: '更新包超过这个大小时，提醒你导一份新的完整副本换基准。',
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
					desc: '没开 git 时，只自动应用不会删文件、也不会覆盖本地改动的更新包。开了 git 由「方向」决定。',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.autoApplyIncoming),
				},
				{
					key: 'autoApplyIncomingBoth',
					name: '双向时收到包直接应用（不确认）',
					desc: '开了 git 且方向为双向时，收到包不再弹确认，按「仅拉」的镜像策略应用；会覆盖/删除本地文件（进回收目录）。给无人值守 / REST / MCP 用，默认关。',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.autoApplyIncomingBoth),
				},
				{
					key: 'dropBundleToApply',
					name: '拖入 .lsave 即打开应用对话框',
					desc: '把 .lsave 拖到窗口上就打开应用对话框；拖图片和附件不受影响。',
					control: { type: 'toggle' },
					coerce: value => coerceBoolean(value, DEFAULT_SETTINGS.dropBundleToApply),
				},
				{
					key: 'bundleVerify',
					name: '应用前校验完整性',
					desc: '先读一遍整个包算校验和，确认传输没弄坏文件。大包会慢几秒。',
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
					desc: '留空＝从 PATH 里找。找不到时填 git.exe 的完整路径。',
					control: { type: 'text', placeholder: 'C:\\Program Files\\Git\\cmd\\git.exe' },
					coerce: value => coerceText(value, DEFAULT_SETTINGS.gitPath),
				},
			],
		},
	],
};

/**
 * 「从哪个状态 / 到哪个状态」的选项：**只有完整副本**，外加"默认"那一项。
 * 设置面板是同步渲染的，所以用同步那套读法（只读包头部，很便宜）。
 */
function stateChoices(plugin: LocallySavePlugin, end: 'from' | 'to'): Record<string, string> {
	const fallback = end === 'from'
		? { [LATEST_STATE]: '自动：我站的那份完整副本' }
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
			options[wanted] = `基准 ${wanted}（这个目录里找不到这一份完整副本）`;
		}
		return options;
	} catch {
		return fallback;
	}
}
