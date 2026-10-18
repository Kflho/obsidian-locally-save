import { describeLastActivity } from '../bundle/log';
import { bundleBaseDir } from '../bundle/paths';
import { describePeersDetailed, describePeersShort, readPeers } from '../git/peers';
import type { PeerState } from '../git/peers';
import type LocallySavePlugin from '../main';
import { loadState } from '../sync/state';
import type { PluginState } from '../sync/state';
import { GitStatusModal } from './git-modal';

/**
 * 状态栏那一句：**尽量短**，但要把两件事分开说清楚 ——
 *
 * 1. **git 推拉本身**：`已推送` / `已拉取` / `已推拉` / `远程已是最新` / `同步失败`
 *    （旧文案写"已同步"，等于把"推上去了"说成"两边内容一样了"，用户会误解）；
 * 2. **各台电脑的内容状态**：`对方：一致` / `对方：1 台不同步` / `对方：1 台待上报`
 *    （多台时逐台计数；只给一句"不同步"看不出是哪台、也看不出是不是它还没上报）。
 *
 * 没启用 git 的机器仍然写"上次留包…"（它没有"远程同步"这回事）。
 */

/** 一次状态栏刷新要的两层信息（结果 + 悬停详情） */
export interface PeerStatusText {
	short: string | null;
	details: string[];
}

/** 把"每台机器上报的状态"翻成状态栏那一截（纯函数，测试直接跑） */
export function peerStatusText(peers: PeerState[], state: PluginState): PeerStatusText {
	const mine = state.stateId?.id ?? null;
	const at = state.stateId?.at ?? 0;
	return {
		short: describePeersShort(peers, mine, at),
		details: describePeersDetailed(peers, mine, at),
	};
}

export function statusSummary(state: PluginState, peer?: string | null): string {
	let text: string;
	const git = state.git;
	if (git) {
		const when = hhmm(git.at);
		if (!git.ok) {
			text = `同步失败 ${when}`;
		} else {
			const action = git.pushed && git.pulled > 0
				? '已推拉'
				: git.pushed
					? '已推送'
					: git.pulled > 0
						? '已拉取'
						: '远程已是最新';
			text = `${action} ${when}`;
			if (git.ahead > 0) text += ` · ${git.ahead} 个没推`;
			if (git.behind > 0) text += ` · 落后 ${git.behind}`;
		}
	} else {
		text = describeLastActivity(state);
	}
	return peer ? `${text} · ${peer}` : text;
}

/** 重新读状态文件 / 对方状态、刷新状态栏（悬停里有每台机器的详情） */
export async function refreshStatusBar(plugin: LocallySavePlugin): Promise<void> {
	try {
		const state = await loadState(plugin.stateFile());
		const base = bundleBaseDir(plugin.settings);
		const withGit = plugin.settings.gitEnabled && base !== '';
		const peers = withGit ? readPeers(base, state.copyId) : [];
		const peer = withGit ? peerStatusText(peers, state) : null;
		plugin.statusBar.setSummary(statusSummary(state, peer?.short ?? null));
		const mine = [
			`我这台（${plugin.vaultName()}）：状态 ${state.stateId?.id ?? '还没算过'} · 第 ${state.generation} 代`,
			`基准：第 ${state.bundle?.fullGeneration ?? '?'} 代 · ${state.bundle?.fullHash ?? '未记'}`,
			state.git
				? `上次推拉：${state.git.ok ? '成功' : '失败'} ${hhmm(state.git.at)}`
				: '还没和 git 远程同步过',
		];
		plugin.statusBar.setDetail([...mine, ...(peer?.details ?? [])].join('\n'));
	} catch (error) {
		// 读不到不影响用：状态栏继续显示上一次的
		plugin.log.debug('刷新状态栏失败', error);
	}
}

/**
 * 「各台电脑同步状态」窗口：本机一行 + 每台机器一行。
 *
 * 从状态栏点一下、命令面板、设置页的 Git 远程都能打开；`onSync` 是窗口里那个
 * "现在同步一次"按钮（由调用方传，避免 `ui/status.ts` 反过来 import `ui/git.ts` 成环）。
 */
export async function openPeerStatus(
	plugin: LocallySavePlugin,
	onSync?: () => void,
): Promise<void> {
	const lines: string[] = [];
	try {
		const state = await loadState(plugin.stateFile());
		lines.push(`我这台（${plugin.vaultName()}）：状态 ${state.stateId?.id ?? '还没算过'} · 第 ${state.generation} 代`);
		lines.push(`基准：第 ${state.bundle?.fullGeneration ?? '?'} 代 · ${state.bundle?.fullHash ?? '未记'}`);
		if (state.git) {
			const detail = [
				`${state.git.ok ? '成功' : '失败'} ${hhmm(state.git.at)}`,
				state.git.pushed ? '推过' : '没推',
				state.git.pulled > 0 ? `收到 ${state.git.pulled} 个包` : '没收到包',
				state.git.ahead > 0 ? `领先 ${state.git.ahead}` : '',
				state.git.behind > 0 ? `落后 ${state.git.behind}` : '',
			].filter(item => item !== '');
			lines.push(`上次推拉：${detail.join(' · ')}`);
		} else {
			lines.push('上次推拉：还没和 git 远程同步过');
		}

		if (!plugin.settings.gitEnabled) {
			lines.push('git 传输关着：没有"远程同步"这回事；这里只看本机留包状态');
		} else {
			const base = bundleBaseDir(plugin.settings);
			if (base === '') {
				lines.push('还没填「同步包文件夹」：去设置 → 同步包填一个仓库之外的目录');
			} else {
				const peers = readPeers(base, state.copyId);
				lines.push('');
				lines.push(peers.length === 0
					? '还没有别的机器上报过状态：对方同步一次之后，这里会出现它。'
					: '各台机器（按最后上报排序）：');
				for (const line of describePeersDetailed(peers, state.stateId?.id ?? null, state.stateId?.at ?? 0)) {
					lines.push(line);
				}
			}
		}
	} catch (error) {
		lines.push(`读不到同步状态：${error instanceof Error ? error.message : String(error)}`);
	}
	new GitStatusModal(plugin.app, lines, onSync, '各台电脑同步状态').open();
}

/** 状态栏要短：只写「HH:mm」 */
function hhmm(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number): string => String(n).padStart(2, '0');
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
