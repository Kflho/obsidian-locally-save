import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from '../sync/disk';
import type { PluginState } from '../sync/state';

/**
 * 货架里的**每台机器的小状态**（对表用，不是包）。
 *
 * 为什么要有：包是单向广播 —— 对方不应用，我这边永远不知道它到了哪一步。
 * git 货架既然是共享的，每台机器往 `.lsave-peers/<copyId>.json` 写一小份自己的状态
 * （状态编号、站在哪份完整副本上、最后导出 / 应用了哪个包），同步时跟着提交；
 * 拉一下就能回答三个问题：
 * - **两边内容一样了吗**（`stateId` 相同就是一样）；
 * - **我的包对方应用了没有**（它应用完会把 `lastApply` 写上去、`stateId` 变成我的目标）；
 * - **谁还没重导**（站在哪一份完整副本上）。
 *
 * 它只是**状态**，不是第二条通道：不参与基准 / 冲突 / 删除那一套，
 * 也不带任何文件内容（`stateId` 已经能说明内容一不一样）。
 */

/** 货架里放机器状态的目录 */
export const PEER_DIR = '.lsave-peers';

export const PEER_FORMAT = 'locally-save-peer';
export const PEER_VERSION = 1;

/** 一台机器的一笔状态（写在货架里，别人拉得到） */
export interface PeerState {
	format: typeof PEER_FORMAT;
	version: number;
	copyId: string;
	/** 仓库名（两台机器都可能叫 obsidian，光靠它分不清） */
	vault: string;
	/** 主机名（0.15.3 起；旧状态文件没有就是空串）—— 多台机器时用来认出"是哪台" */
	host: string;
	lineage: string;
	/** 这台机器现在的内容指纹（`sync/state-id.ts`）；还没算过就是 null */
	stateId: string | null;
	generation: number;
	/** 它站在哪一份完整副本上 */
	baselineHash: string | null;
	baselineGeneration: number | null;
	/** 最后一次导出 / 应用（状态栏与"对方应用了没"靠它） */
	lastExport: { bundleId: string; file?: string; target: number; at: number } | null;
	lastApply: { bundleId: string; file?: string; target: number; at: number } | null;
	/** 它这边还有多少改动没发出去（`pendingReturn`） */
	pending: number;
	/**
	 * **最近一次收包失败的原因**（0.15.9 起；没有就不写这个字段）。
	 *
	 * 为什么放进对表文件：收包失败只留在本机 `sync-state.json` / `debug.log`，
	 * 对面想排查只能等这边的人手动发日志（283 就卡在这里）。peer 文件本来就跟着货架同步，
	 * 顺手带上"哪个包、什么原因"，对面拉一次就能看到，不用再要日志。
	 */
	lastError?: { file?: string; bundleId: string; message: string; at: number };
	/**
	 * **内容与"它以为的那个状态"不一致**（＝ `state.applyDrift`）。
	 *
	 * 有这一项时，上面那个 `generation` / `stateId` 只是"记录里的号"，**内容并不等于那一代**
	 * （典型：完整副本镜像有删不掉的目录）。不写出来的话，对面只能看到"它说自己在第 392 代"，
	 * 于是按 392 去推理 —— 本次 112/392 的排查就是这么被带偏的。
	 */
	contentDrift?: { expected: string; actual: string; generation?: number | null; at: number };
	/** 这份状态是什么时候写的 */
	at: number;
}

/** 某台机器的状态文件路径（货架根目录下） */
export function peerFile(baseDir: string, copyId: string): string {
	return path.join(baseDir, PEER_DIR, `${copyId}.json`);
}

/** 从本机状态拼出要写出去的那份（只放"对表"需要的，不放大块内容） */
export function buildPeer(state: PluginState): PeerState {
	const log = Array.isArray(state.bundleLog) ? state.bundleLog : [];
	const lastExport = [...log].reverse().find(entry => entry.direction === 'export');
	const lastApply = [...log].reverse().find(entry => entry.direction === 'apply');
	const incoming = Array.isArray(state.incoming) ? state.incoming : [];
	// 只认**最后一笔**：后来应用成功过，就不该再挂着旧的失败原因
	const lastIncoming = incoming[incoming.length - 1];
	const lastFailure = lastIncoming?.note === 'failed' ? lastIncoming : undefined;
	return {
		format: PEER_FORMAT,
		version: PEER_VERSION,
		copyId: state.copyId,
		vault: '',
		host: os.hostname(),
		lineage: state.lineage,
		stateId: state.stateId?.id ?? null,
		generation: state.generation,
		baselineHash: state.bundle?.fullHash ?? null,
		baselineGeneration: state.bundle?.fullGeneration ?? null,
		lastExport: lastExport
			? {
				bundleId: lastExport.bundleId,
				...(lastExport.file ? { file: lastExport.file } : {}),
				target: lastExport.target,
				at: lastExport.at,
			}
			: null,
		lastApply: lastApply
			? {
				bundleId: lastApply.bundleId,
				...(lastApply.file ? { file: lastApply.file } : {}),
				target: lastApply.target,
				at: lastApply.at,
			}
			: null,
		pending: (state.pendingReturn?.changes ?? 0) + (state.pendingReturn?.deletes ?? 0),
		...(state.applyDrift ? { contentDrift: state.applyDrift } : {}),
		...(lastFailure
			? {
				lastError: {
					bundleId: lastFailure.id,
					...(lastFailure.file ? { file: lastFailure.file } : {}),
					message: (lastFailure.error ?? '').slice(0, 300),
					at: lastFailure.at,
				},
			}
			: {}),
		at: Date.now(),
	};
}

/** 把本机状态写进货架（`vault` 由调用方填）；返回"这次真写了吗"与失败原因 */
export async function writePeer(
	baseDir: string,
	state: PluginState,
	vault: string,
): Promise<{ written: boolean; error: string | null }> {
	try {
		const peer = { ...buildPeer(state), vault };
		const target = peerFile(baseDir, state.copyId);
		/**
		 * **内容没变就不写**：`at`（写这份状态的时间）一改，`git add` 就会造一笔空提交 ——
		 * 每 5 分钟拉一次就是每 5 分钟一笔"只是时间变了"的提交，仓库很快就没法看。
		 * 所以比较时把 `at` 去掉：只有状态编号 / 基准 / 最后导出应用这些**有意义的东西**变了才写。
		 */
		try {
			const existing = JSON.parse(fs.readFileSync(target, 'utf8')) as PeerState;
			if (JSON.stringify({ ...existing, at: 0 }) === JSON.stringify({ ...peer, at: 0 })) {
				return { written: false, error: null };
			}
		} catch {
			// 没有 / 读不出：照写
		}
		await writeJsonAtomic(target, peer);
		return { written: true, error: null };
	} catch (error) {
		return { written: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * 读货架上所有**别人**的状态（自己的跳过；读不出的也跳过 —— 可能是旧版本写的半截文件）。
 *
 * 只看 `*.json`，按文件名的 copyId 认人；不信任文件内容里的 copyId 之外的东西，
 * 一律过一遍形状检查。
 */
export function readPeers(baseDir: string, selfCopyId: string): PeerState[] {
	const dir = path.join(baseDir, PEER_DIR);
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const out: PeerState[] = [];
	for (const name of names) {
		if (!name.toLowerCase().endsWith('.json')) continue;
		const copyId = name.slice(0, -'.json'.length);
		if (copyId === selfCopyId) continue;
		try {
			const raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Partial<PeerState>;
			const peer = normalizePeer(raw);
			if (peer) out.push(peer);
		} catch {
			// 半截文件 / 不是我们的：跳过
		}
	}
	return out.sort((a, b) => b.at - a.at);
}

/** 状态文件内容的形状检查（手改坏 / 旧版本都当"没这回事"） */
function normalizePeer(raw: Partial<PeerState> | null): PeerState | null {
	if (!raw || raw.format !== PEER_FORMAT || typeof raw.copyId !== 'string' || raw.copyId === '') return null;
	const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
	const entry = (value: Partial<PeerState['lastExport']> | null | undefined) => {
		if (!value || typeof value.bundleId !== 'string') return null;
		return {
			bundleId: value.bundleId,
			...(typeof value.file === 'string' && value.file !== '' ? { file: value.file } : {}),
			target: count(value.target),
			at: count(value.at),
		};
	};
	const lastError = ((): PeerState['lastError'] | undefined => {
		const value = (raw as { lastError?: unknown }).lastError;
		if (!value || typeof value !== 'object') return undefined;
		const item = value as Record<string, unknown>;
		if (typeof item.message !== 'string' || item.message === '') return undefined;
		return {
			bundleId: typeof item.bundleId === 'string' ? item.bundleId : '',
			...(typeof item.file === 'string' && item.file !== '' ? { file: item.file } : {}),
			message: item.message.slice(0, 300),
			at: typeof item.at === 'number' && Number.isFinite(item.at) ? item.at : 0,
		};
	})();
	return {
		format: PEER_FORMAT,
		version: count(raw.version) || 1,
		copyId: raw.copyId,
		vault: typeof raw.vault === 'string' ? raw.vault : '',
		host: typeof raw.host === 'string' ? raw.host : '',
		lineage: typeof raw.lineage === 'string' ? raw.lineage : '',
		stateId: typeof raw.stateId === 'string' && raw.stateId !== '' ? raw.stateId : null,
		generation: count(raw.generation),
		baselineHash: typeof raw.baselineHash === 'string' && raw.baselineHash !== '' ? raw.baselineHash : null,
		baselineGeneration: typeof raw.baselineGeneration === 'number' ? raw.baselineGeneration : null,
		lastExport: entry(raw.lastExport),
		lastApply: entry(raw.lastApply),
		pending: count(raw.pending),
		...(lastError ? { lastError } : {}),
		at: count(raw.at),
	};
}

/**
 * 一台机器和我这边的内容对得上吗：
 * - `same`：状态编号相同 —— 内容一致；
 * - `different`：它上报的状态比我新（或同一时间），编号却不同 —— 真没同步；
 * - `stale`：它上次上报**早于**我最近一次应用/导出 —— 我这边刚动过，它还没报新状态，
 *   不能断言"不同步"（用户看到的就是应用完右下角立刻写"对方未同步"）；
 * - `unknown`：它还没算过状态编号，或我这边还没有。
 */
export type PeerMatch = 'same' | 'different' | 'stale' | 'unknown';

/** 我这边动过之后，对方至少隔这么久没上报才算"还没报新状态"（避开同一次同步的先后顺序） */
const STALE_GRACE_MS = 60_000;

export function peerMatch(
	peer: PeerState,
	myStateId: string | null,
	/** 我这边的状态编号是什么时候算的（`state.stateId.at`） */
	myUpdatedAt = 0,
): PeerMatch {
	if (!myStateId || !peer.stateId) return 'unknown';
	if (peer.stateId === myStateId) return 'same';
	if (myUpdatedAt > 0 && peer.at > 0 && peer.at < myUpdatedAt - STALE_GRACE_MS) return 'stale';
	return 'different';
}

/** peer 报告比自己旧时，主动拉取的最小间隔（用户不用再点一次同步） */
export const PEER_REFRESH_MS = 30_000;

/**
 * 要不要主动拉一次 peer 报告。
 *
 * 触发："**待上报**"或"**不同步**"都拉一次 —— 对面应用完只改了
 * `.lsave-peers/<它的 copyId>.json`（没有产生新包），不主动拉就永远停在旧状态，
 * 用户只能再点一次同步。拉下来可能拿到它的新状态（一致），也可能确认内容真不同；
 * `unknown`（对方还没算过状态）不在这里反复联网。
 */
export function needsPeerRefresh(
	peers: PeerState[],
	myStateId: string | null,
	myUpdatedAt = 0,
	lastSyncAt = 0,
	now = Date.now(),
	interval = PEER_REFRESH_MS,
): boolean {
	if (!myStateId || now - lastSyncAt < interval) return false;
	return peers.some(peer => {
		const match = peerMatch(peer, myStateId, myUpdatedAt);
		return match === 'stale' || match === 'different';
	});
}

/**
 * 状态栏那一小截。
 *
 * **不要再把所有不同情况压成一句"对方：不同步"**：多台机器时用户要知道是哪一台、
 * 是内容不同还是只是它还没上报。例：
 * `对方：2 台一致` / `对方：1 台不同步 · 1 台待上报` / `对方：还没上报`。
 */
export function describePeersShort(
	peers: PeerState[],
	myStateId: string | null,
	myUpdatedAt = 0,
): string | null {
	if (peers.length === 0) return '对方：还没上报';
	// 本机还没算过状态编号：不是"对方没上报"，是没法比
	if (!myStateId) return '对方：本机还没算过状态';
	const counts: Record<PeerMatch, number> = { same: 0, different: 0, stale: 0, unknown: 0 };
	for (const peer of peers) counts[peerMatch(peer, myStateId, myUpdatedAt)]++;
	// 只有一台时不必写"1 台"：状态栏那一格能省一个字是一个字
	if (peers.length === 1) {
		if (counts.same === 1) return '对方：一致';
		if (counts.different === 1) return '对方：不同步';
		if (counts.stale === 1) return '对方：待上报';
		return '对方：没上报';
	}
	if (counts.same === peers.length) return `对方：${peers.length} 台一致`;
	const bits: string[] = [];
	if (counts.same > 0) bits.push(`${counts.same} 台一致`);
	if (counts.different > 0) bits.push(`${counts.different} 台不同步`);
	if (counts.stale > 0) bits.push(`${counts.stale} 台待上报`);
	if (counts.unknown > 0) bits.push(`${counts.unknown} 台没上报`);
	return `对方：${bits.join(' · ')}`;
}

/**
 * 一台机器的完整一行（「检查环境」/「各台电脑同步状态」/ 状态栏悬停提示共用）。
 *
 * 写清 **谁、一致不一致、两边的状态编号、最后上报时间**：用户要判断"是哪一台、
 * 它是不是只是还没同步"，只给一句"未同步"不够。
 */
export function describePeerDetail(
	peer: PeerState,
	myStateId: string | null,
	myUpdatedAt = 0,
): string {
	const match = peerMatch(peer, myStateId, myUpdatedAt);
	const mark = !myStateId
		? '? 无法比较（本机还没算过状态）'
		: match === 'same'
			? '✓ 一致'
			: match === 'stale'
				? '? 还没报新状态'
				: match === 'unknown'
					? '? 还没上报状态编号'
					: '✗ 不同步';
	// 多台机器时最容易混：仓库都叫 obsidian。**主机名 + copyId 前 8 位**才认得出是哪台
	const label = [peer.vault, peer.host, shortId(peer.copyId)].filter(item => item !== '');
	const who = `另一台（${label.join(' · ')}）`;
	const parts = [`${who}：${mark}`];
	if (myStateId && peer.stateId) parts.push(`它 ${peer.stateId} / 我 ${myStateId}`);
	else parts.push(`它 ${peer.stateId ?? '还没算过'}`);
	parts.push(`第 ${peer.generation} 代`);
	parts.push(`基准 ${peer.baselineGeneration ?? '?'} 代 ${peer.baselineHash ?? '未记'}`);
	parts.push(`最后上报 ${peer.at > 0 ? hhmm(peer.at) : '没记时间'}`);
	if (peer.lastExport) parts.push(`最后导出 ${peer.lastExport.file ?? shortId(peer.lastExport.bundleId)}`);
	if (peer.lastApply) parts.push(`最后应用 ${peer.lastApply.file ?? shortId(peer.lastApply.bundleId)}`);
	if (peer.lastError) {
		const message = peer.lastError.message.length > 40
			? `${peer.lastError.message.slice(0, 40)}…`
			: peer.lastError.message;
		parts.push(`它上次收包失败：${message}`);
	}
	if (peer.pending > 0) parts.push(`还有 ${peer.pending} 个改动没发出去`);
	return parts.join(' · ');
}

/** 状态栏悬停 / 弹窗里用：把每台机器的详情摊开 */
export function describePeersDetailed(
	peers: PeerState[],
	myStateId: string | null,
	myUpdatedAt = 0,
): string[] {
	if (peers.length === 0) return ['还没有别的机器上报过状态：对方同步一次之后才会出现。'];
	return peers.map(peer => describePeerDetail(peer, myStateId, myUpdatedAt));
}

/** 界面里只露前 8 位（copyId / bundleId 太长会把一行撑满） */
function shortId(id: string): string {
	return id.length > 8 ? id.slice(0, 8) : id;
}

/** 时间戳 → `HH:mm`（状态栏 / 弹窗同一套写法） */
function hhmm(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number): string => String(n).padStart(2, '0');
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
