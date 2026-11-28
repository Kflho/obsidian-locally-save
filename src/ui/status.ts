import { Modal, Setting } from 'obsidian';
import { describeLastActivity } from '../bundle/log';
import { bundleBaseDir } from '../bundle/paths';
import { describePeersDetailed, describePeersShort, readPeers } from '../git/peers';
import type { PeerState } from '../git/peers';
import type LocallySavePlugin from '../main';
import { loadState } from '../sync/state';
import type { PluginState } from '../sync/state';
import { setupModal } from './modal-layout';

/**
 * 状态栏那一句：尽量短，但把两件事分开说清楚：
 *
 * 1. git 推送和拉取本身：`已推送` / `已拉取` / `已完成推送和拉取` / `远程已是最新` / `同步失败`；
 * 2. 各台电脑的内容状态：`其他电脑：一致` / `其他电脑：1 台不同步` / `其他电脑：1 台待上报`。
 */

/** 一次状态栏刷新要的两层信息（结果 + 悬停详情） */
export interface PeerStatusText {
	short: string | null;
	details: string[];
}

/** 把“每台机器上报的状态”翻成状态栏那一截（纯函数，测试直接跑） */
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
				? '已完成推送与拉取'
				: git.pushed
					? '已推送'
					: git.pulled > 0
						? '已拉取'
						: '远程已是最新';
			text = `${action} ${when}`;
			if (git.ahead > 0) text += ` · ${git.ahead} 项未推送`;
			if (git.behind > 0) text += ` · 待拉取 ${git.behind}`;
		}
	} else {
		text = describeLastActivity(state);
	}
	return peer ? `${text} · ${peer}` : text;
}

/** 重新读状态文件 / 其他电脑状态、刷新状态栏（悬停里保留每台机器的详情） */
export async function refreshStatusBar(plugin: LocallySavePlugin): Promise<void> {
	try {
		const state = await loadState(plugin.stateFile());
		const base = bundleBaseDir(plugin.settings);
		const withGit = plugin.settings.gitEnabled && base !== '';
		const peers = withGit ? readPeers(base, state.copyId) : [];
		const peer = withGit ? peerStatusText(peers, state) : null;
		plugin.statusBar.setSummary(statusSummary(state, peer?.short ?? null));
		const mine = [
			`本电脑：第 ${state.generation} 版 · 编号 ${shortId(state.stateId?.id)}`,
			`完整备份：${state.bundle?.fullGeneration ? `第 ${state.bundle.fullGeneration} 版` : '未记录'}`
				+ ` · 编号 ${shortId(state.bundle?.fullHash)}`,
			...(state.applyDrift
				? [`内容与第 ${state.applyDrift.generation ?? '?'} 版不一致：实际编号 ${shortId(state.applyDrift.actual)}`]
				: []),
			state.git
				? `上次同步：${state.git.ok ? '成功' : '失败'} ${hhmm(state.git.at)}`
				: '尚未与 Git 远程同步',
		];
		plugin.statusBar.setDetail([...mine, ...(peer?.details ?? [])].join('\n'));
	} catch (error) {
		// 读不到不影响用：状态栏继续显示上一次的
		plugin.log.debug('刷新状态栏失败', error);
	}
}

interface PeerModalData {
	generation: number | null;
	fullGeneration: number | null;
	stateId: string | null;
	fullHash: string | null;
	syncLine: string;
	notice: string;
	peers: PeerState[];
	mine: string | null;
}

/**
 * 「各电脑同步状态」窗口：顶部三项事实，下面一张表。
 *
 * 表格只留电脑、版本、内容编号、状态、最后上报；完整编号与远端详情放 title，
 * 正文不再堆“本电脑（vault）的内容编号是……”这类长句。
 */
class PeerStatusModal extends Modal {
	constructor(
		app: LocallySavePlugin['app'],
		private readonly data: PeerModalData,
		private readonly onSync?: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		setupModal(this);
		contentEl.createEl('h2', { text: '各电脑同步状态' });

		const strip = contentEl.createDiv({ cls: 'locally-save-facts-strip' });
		this.fact(strip, '本电脑版本', this.data.generation === null ? '未记录' : `第 ${this.data.generation} 版`);
		this.fact(strip, '当前完整备份', this.data.fullGeneration === null ? '未记录' : `第 ${this.data.fullGeneration} 版`);
		this.fact(strip, '内容编号', shortId(this.data.stateId));

		contentEl.createEl('p', { cls: 'locally-save-hint', text: this.data.syncLine });
		if (this.data.notice) contentEl.createEl('p', { cls: 'locally-save-hint', text: this.data.notice });

		if (this.data.peers.length > 0) {
			this.renderTable(contentEl);
		} else if (!this.data.notice) {
			contentEl.createEl('p', {
				cls: 'locally-save-hint',
				text: '还没有其他电脑上报状态。其他电脑完成同步并上报后，表格中会出现对应记录。',
			});
		}

		new Setting(contentEl)
			.addButton(button => button
				.setButtonText('现在同步一次')
				.setCta()
				.setDisabled(!this.onSync)
				.onClick(() => {
					this.close();
					this.onSync?.();
				}))
			.addButton(button => button
				.setButtonText('关闭')
				.onClick(() => this.close()));
	}

	private fact(parent: HTMLElement, label: string, value: string): void {
		const item = parent.createDiv({ cls: 'locally-save-fact' });
		item.createDiv({ cls: 'locally-save-fact-label', text: label });
		item.createDiv({ cls: 'locally-save-fact-value', text: value });
	}

	private renderTable(parent: HTMLElement): void {
		const table = parent.createEl('table', { cls: 'locally-save-peer-table' });
		const head = table.createEl('thead').createEl('tr');
		for (const title of ['电脑', '版本', '内容编号', '状态', '最后上报']) {
			head.createEl('th', { text: title });
		}
		const body = table.createEl('tbody');
		for (const peer of this.data.peers) {
			const row = body.createEl('tr');
			const name = row.createEl('td', { cls: 'locally-save-peer-name' });
			name.setText(peer.host || peer.vault || '未知电脑');
			name.setAttribute('title', `${peer.host || '未知电脑'} · ${peer.vault}\n${peer.copyId}`);
			row.createEl('td', { text: `第 ${peer.generation} 版` });
			const id = row.createEl('td', { cls: 'is-code', text: shortId(peer.stateId) });
			id.setAttribute('title', peer.stateId ?? '尚未计算内容编号');
			const [label, tone] = peerLabel(peer, this.data.mine);
			const status = row.createEl('td');
			status.createSpan({ cls: `locally-save-peer-status is-${tone}`, text: label });
			row.createEl('td', { cls: 'is-num', text: dateTime(peer.at) });
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** 窗口里那份数据；读不到就只显示错误与“现在同步一次” */
async function peerModalData(plugin: LocallySavePlugin): Promise<PeerModalData> {
	try {
		const state = await loadState(plugin.stateFile());
		const data: PeerModalData = {
			generation: state.generation,
			fullGeneration: state.bundle?.fullGeneration ?? null,
			stateId: state.stateId?.id ?? null,
			fullHash: state.bundle?.fullHash ?? null,
			syncLine: '尚未与 Git 远程同步。',
			notice: '',
			peers: [],
			mine: state.stateId?.id ?? null,
		};
		if (state.git) {
			const parts = [`上次同步：${state.git.ok ? '成功' : '失败'} ${hhmm(state.git.at)}`];
			if (!state.git.ok) parts.push('请检查网络与远程地址');
			if (state.git.pushed) parts.push('已推送');
			if (state.git.pulled > 0) parts.push(`收到 ${state.git.pulled} 个同步包`);
			if (state.git.deleted > 0) parts.push(`移走 ${state.git.deleted} 个同步包`);
			if (state.git.ahead > 0) parts.push(`${state.git.ahead} 项未推送`);
			if (state.git.behind > 0) parts.push(`待拉取 ${state.git.behind}`);
			data.syncLine = parts.join(' · ');
		}
		if (!plugin.settings.gitEnabled) {
			data.notice = 'Git 传输未启用：这里只显示本电脑状态。';
			return data;
		}
		const base = bundleBaseDir(plugin.settings);
		if (base === '') {
			data.notice = '尚未填写「同步包文件夹」。请在 设置 → 同步包 中填写。';
			return data;
		}
		data.peers = readPeers(base, state.copyId);
		return data;
	} catch (error) {
		return {
			generation: null, fullGeneration: null, stateId: null, fullHash: null,
			syncLine: '', notice: `无法读取同步状态。原因：${describe(error)}。`,
			peers: [], mine: null,
		};
	}
}

function peerLabel(peer: PeerState, mine: string | null): [string, string] {
	if (peer.lastError) return ['上次接收失败', 'error'];
	if (peer.contentDrift) return ['内容与记录不符', 'error'];
	if (peer.stateId && mine && peer.stateId === mine) return ['一致', 'same'];
	if (peer.pending > 0) return [`待上报 ${peer.pending}`, 'pending'];
	if (peer.stateId && mine && peer.stateId !== mine) return ['内容不同', 'diff'];
	return ['已上报', 'muted'];
}

function shortId(value: string | null | undefined): string {
	return value ? value.slice(0, 8) : '未计算';
}

function dateTime(ms: number): string {
	const date = new Date(ms);
	const pad = (n: number): string => String(n).padStart(2, '0');
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 状态栏要短：只写「HH:mm」 */
function hhmm(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number): string => String(n).padStart(2, '0');
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export async function openPeerStatus(
	plugin: LocallySavePlugin,
	onSync?: () => void,
): Promise<void> {
	new PeerStatusModal(plugin.app, await peerModalData(plugin), onSync).open();
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
