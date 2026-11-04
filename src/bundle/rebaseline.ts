import path from 'node:path';
import type { PluginState } from '../sync/state';
import type { PeerState } from '../git/peers';
import type { FileRecord, Inventory } from '../sync/types';
import { DEFAULT_MTIME_TOLERANCE_MS } from '../sync/diff';
import { BUNDLE_EXT, readBundleInfoSync } from './format';
import { baselineOfBundle, listingHashOfFiles } from './baseline';
import { bundleDirForMode } from './paths';
import { listFullAnchorsSync, pickAnchor } from './anchor';
import type { BundleAnchor } from './anchor';
import { listFilesSync } from '../sync/disk';
import { exportBundle } from './export';
import type { ExportOptions } from './export';

/**
 * **换基准的差量包**：把「别的电脑站的旧完整副本 → 我现在站的这份完整副本」写成一份小包。
 *
 * 为什么需要：完整副本按决定**不进 git**（几百 MB），而更新包是"自某一份完整副本算起的累积差量"。
 * 我一换基准（导了一份新的完整副本），别的电脑下一次收到的更新包就是"从一份它没有的完整副本算起"，
 * `checkAncestor` 判它基准对不上 → 两边卡死。补法是导一份**差量包**（端点是两份完整副本，
 * 只装两者之间的差异，通常几 MB）：它收下、应用完就换到新基准上（`apply.ts` 的
 * `landedOnBaseline` 只认清单与指纹，**它手里不需要有新的完整副本**）。
 *
 * 这一份专门回答三个问题（**只读**，先算后做）：
 * 1. 我现在站的是哪一份（`state.bundle.fullHash`）；
 * 2. 每台电脑用哪一份（货架 `.lsave-peers/*.json` 里它自己报的 `baselineHash`）；
 * 3. 这两点之间做不做得出差量包 —— 它的起点那份完整副本得**还在本机**（差量包的负载取自终点那份，
 *    起点的清单要靠它算）。
 *
 * 与 `exportRebaselineDiff` 的关系：那个是"导出完整副本时顺手导一份"（只知道"导出前我站的旧基准"），
 * 这里是"按每台电脑各自报的基准逐个导"（多台机器停在不同旧基准上时各要一份）。
 */

/**
 * 一份差量包**最大**做多大就不做了（字节）。
 *
 * 依据：GitHub 对单个文件卡 100 MB，超了 push 直接失败；而包一旦落进 `changes/` 就会被
 * `git add` 收进去，**之后每一轮同步都会带着它失败** —— 那等于把整条货架搞停。
 * 所以宁可先算一下要搬多少，超了就不写包、如实告诉用户改走"完整副本整个拷过去"。
 */
export const REBASELINE_MAX_BYTES = 80 * 1024 * 1024;

/** 货架里一台电脑的基准情况（`readPeers` 出来的那几项，界面直接用） */
export interface RebaselinePeer {
	copyId: string;
	host: string;
	vault: string;
	generation: number;
	baselineHash: string | null;
	baselineGeneration: number | null;
	/** 它还有几个改动没发出来（`pendingReturn`）：停在旧基准上又有改动时更要紧 */
	pending: number;
	at: number;
}

export function peerOfState(peer: PeerState): RebaselinePeer {
	return {
		copyId: peer.copyId,
		host: peer.host,
		vault: peer.vault,
		generation: peer.generation,
		baselineHash: peer.baselineHash,
		baselineGeneration: peer.baselineGeneration,
		pending: peer.pending,
		at: peer.at,
	};
}

/**
 * 一台电脑当前处在哪一档：
 * - `ready`：能导 —— 它站的旧完整副本在本机，终点是我站的这份；
 * - `exists`：`changes/` 里已经有一份同样的差量包了（不会重复生成）；
 * - `same`：它已经站到我这份上了（不用做什么）；
 * - `ahead`：它站的比我这份新（该收它的差量包，不是发）；
 * - `diverged`：同一代、但不是同一份（两条线各立过基准，差量包不能拿它当起点）；
 * - `missing`：本机没有它站的那份完整副本（做不出来，只能把整份拷过去）；
 * - `no-baseline`：它还没站上任何完整副本（第一次用，先应用一份完整副本）；
 * - `foreign`：不同一分支（另一条独立的线）；
 * - `too-big`：做出来的差量包太大，推不进货架；
 * - `no-target`：我站的这份完整副本不在本机磁盘上（应用差量包之后就是这样），做不出到它的包。
 */
export type RebaselineStatus =
	| 'ready'
	| 'exists'
	| 'same'
	| 'ahead'
	| 'diverged'
	| 'missing'
	| 'no-baseline'
	| 'foreign'
	| 'too-big'
	| 'no-target';

export interface RebaselineDiffTask {
	peer: RebaselinePeer;
	status: RebaselineStatus;
	/** 它站的那份完整副本（在本机找得到时才有） */
	source: BundleAnchor | null;
	/** 已经存在的那一份差量包的文件名 */
	existing: string | null;
	/** 这一份大概要搬多少字节（只装两边不一样的那些文件） */
	estimateBytes: number;
}

export interface RebaselineDiffPlan {
	/** 我现在站的完整副本；null ＝ 还没站上任何一份 */
	mine: { generation: number; hash: string; name: string | null } | null;
	tasks: RebaselineDiffTask[];
	/** 有几个任务真能导 */
	ready: number;
	/** 一份都算不出来时的原因（能算就不用它） */
	problem: string | null;
}

/** 差量包已经有的那几份（认「起点代 + 终点代 + 终点状态编号」，与 `findExistingCheckpoint` 同口径） */
interface CheckpointRef {
	name: string;
	base: number | null;
	target: number;
	stateId: string | null;
}

function listCheckpointRefs(baseDir: string): CheckpointRef[] {
	if (!baseDir) return [];
	const dir = bundleDirForMode(baseDir, 'changes');
	const out: CheckpointRef[] = [];
	for (const item of listFilesSync(dir)) {
		if (!item.name.toLowerCase().endsWith(BUNDLE_EXT)) continue;
		try {
			const header = readBundleInfoSync(path.join(dir, item.name)).header;
			if (header.mode !== 'changes' || header.targetFullBundle !== true) continue;
			out.push({
				name: item.name,
				base: header.baseGeneration ?? null,
				target: header.targetGeneration,
				stateId: header.stateId?.id ?? null,
			});
		} catch {
			// 读不出头部：不是我们的包，跳过
		}
	}
	return out;
}

/** 两份完整副本的清单差多少字节（差量包的负载取自终点那份，所以按终点的文件大小估） */
function estimateDiffBytes(from: Record<string, FileRecord>, to: Record<string, FileRecord>): number {
	let bytes = 0;
	for (const [file, record] of Object.entries(to)) {
		const before = from[file];
		if (before && before.size === record.size && Math.abs(before.mtime - record.mtime) <= DEFAULT_MTIME_TOLERANCE_MS) {
			continue;
		}
		bytes += record.size;
	}
	return bytes;
}

export function peerLabel(peer: RebaselinePeer): string {
	return peer.host !== '' ? peer.host : (peer.vault !== '' ? peer.vault : peer.copyId.slice(0, 8));
}

/**
 * 算清楚「每台电脑还差哪一份差量包」（**只读**：扫包目录 + 读状态，不写一个字节）。
 *
 * `maxBytes` 默认 `REBASELINE_MAX_BYTES`（测试会传一个小值来守住"太大就不生成"这条）。
 */
export function planRebaselineDiffs(
	baseDir: string,
	state: PluginState,
	peers: PeerState[],
	options: { maxBytes?: number } = {},
): RebaselineDiffPlan {
	const maxBytes = options.maxBytes ?? REBASELINE_MAX_BYTES;
	const mineHash = state.bundle?.fullHash ?? null;
	const mineGeneration = state.bundle?.fullGeneration ?? state.generation;
	if (!mineHash) {
		return {
			mine: null,
			tasks: [],
			ready: 0,
			problem: '本机还没有基准：先导一份完整副本（或应用对方发来的那份），差量包才有终点',
		};
	}

	const anchors = listFullAnchorsSync(baseDir, state.lineage);
	const mineAnchor = pickAnchor(anchors, mineHash);
	const mine = {
		generation: mineGeneration,
		hash: mineHash,
		name: state.bundle?.fullFile ?? mineAnchor?.name ?? null,
	};
	const checkpoints = listCheckpointRefs(baseDir);
	const tasks: RebaselineDiffTask[] = peers.map(peer => {
		const view = peerOfState(peer);
		const make = (status: RebaselineStatus, extra: Partial<RebaselineDiffTask> = {}): RebaselineDiffTask => ({
			peer: view,
			status,
			source: null,
			existing: null,
			estimateBytes: 0,
			...extra,
		});
		if (peer.lineage !== '' && peer.lineage !== state.lineage) return make('foreign');
		if (!peer.baselineHash) return make('no-baseline');
		if (peer.baselineHash === mineHash) return make('same');
		const source = pickAnchor(anchors, peer.baselineHash);
		if (!source) return make('missing');
		// 它站的比我这份新：该收它的差量包，方向反了
		if (source.generation > mineGeneration) return make('ahead', { source });
		// 同一代、两份不同的完整副本：差量包会把它整片换成我这份，等于拿一条线覆盖另一条
		if (source.generation === mineGeneration) return make('diverged', { source });
		if (!mineAnchor) {
			// 终点那份完整包不在本机（应用差量包变成某个基准之后就是这样：`fullFile` 留空）
			return make('no-target', { source });
		}
		const existing = checkpoints.find(item =>
			item.base === source.generation
			&& item.target === mineGeneration
			&& item.stateId === (mineAnchor.stateId?.id ?? null)) ?? null;
		if (existing) return make('exists', { source, existing: existing.name });
		const estimateBytes = estimateDiffBytes(source.files, mineAnchor.files);
		if (estimateBytes > maxBytes) return make('too-big', { source, estimateBytes });
		return make('ready', { source, estimateBytes });
	});
	return {
		mine,
		tasks,
		ready: tasks.filter(task => task.status === 'ready').length,
		problem: null,
	};
}

export interface RebaselineDiffRun {
	exported: {
		host: string;
		file: string;
		fromGeneration: number | null;
		toGeneration: number;
		entries: number;
		payloadBytes: number;
	}[];
	skipped: { host: string; why: string }[];
	failed: { host: string; error: string }[];
}

/**
 * 按计划把差量包导出来（**只导 `ready` 的那几条**）。
 *
 * 一条失败不影响其余：每台电脑的起点可能不同（有的在本机、有的不在），各自独立。
 * **本机什么都不推进**（`exportBundle` 的差量包那一趟是 `frozen`）：世代、基准、状态编号都不动 ——
 * 差量包代表的是"终点那一刻"，不是我的仓库。
 */
export async function exportRebaselineDiffs(
	options: ExportOptions,
	plan: RebaselineDiffPlan,
): Promise<RebaselineDiffRun> {
	const run: RebaselineDiffRun = { exported: [], skipped: [], failed: [] };
	if (!plan.mine) return run;
	for (const task of plan.tasks) {
		const host = peerLabel(task.peer);
		if (task.status === 'exists') {
			run.skipped.push({ host, why: `已经有一份同样的差量包（${task.existing}）` });
			continue;
		}
		if (task.status !== 'ready' || !task.source) continue;
		try {
			const outcome = await exportBundle({
				...options,
				mode: 'changes',
				// 两端都钉死：起点是它站的那份完整副本，终点是我站的那份（内容是终点那份包的负载）
				baseFingerprint: task.source.hash,
				toFingerprint: plan.mine.hash,
				logNote: `差量包：第 ${task.source.generation} 代 → 第 ${plan.mine.generation} 代`
					+ `（${host} 还停在第 ${task.source.generation} 代）`,
			});
			if (!outcome.file) {
				run.skipped.push({ host, why: outcome.reason ?? '没有生成（差量包是空的）' });
				continue;
			}
			run.exported.push({
				host,
				file: outcome.file,
				fromGeneration: task.source.generation,
				toGeneration: plan.mine.generation,
				entries: outcome.entryCount,
				payloadBytes: outcome.payloadBytes,
			});
		} catch (error) {
			run.failed.push({ host, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return run;
}

/**
 * 计划里"为什么做不了"的一句话（每台一行，界面直接显示）。
 *
 * 只写**当前状态 + 要用户做什么**（见 `约定-传输与界面.md` 第 0 节）：
 * 数字与指纹是给人对号的，别把原理写进弹窗。
 */
export function describeRebaselineTask(task: RebaselineDiffTask, mineGeneration: number | null): string {
	const host = peerLabel(task.peer);
	const at = task.peer.baselineGeneration !== null
		? `第 ${task.peer.baselineGeneration} 代`
		: (task.peer.baselineHash ?? '未记');
	const where = `停在 ${at}`;
	switch (task.status) {
		case 'ready':
			return `${host}：${where} → 会导一份第 ${task.peer.baselineGeneration ?? '?'} → ${mineGeneration ?? '?'} 代的差量包（约 ${mb(task.estimateBytes)}）`;
		case 'exists':
			return `${host}：${where}，差量包已经有了（${task.existing}），不会再导一份`;
		case 'same':
			return `${host}：已经和本机是同一份基准`;
		case 'ahead':
			return `${host}：它的基准是第 ${task.source?.generation ?? '?'} 代，比本机这份新 — 该收它导的差量包`;
		case 'diverged':
			return `${host}：和我同一代（第 ${task.peer.baselineGeneration ?? '?'} 代）但不是同一份完整副本 — 差量包会把它整片换掉，别这么做`;
		case 'missing':
			return `${host}：${where}，那份完整副本不在本机 — 做不出差量包，把新的完整副本整份拷给它`;
		case 'no-baseline':
			return `${host}：还没有基准 — 先让它应用一份完整副本`;
		case 'foreign':
			return `${host}：另一条线（分支不同），差量包不通用`;
		case 'too-big':
			return `${host}：${where}，差量包约 ${mb(task.estimateBytes)}，超过单个包上限 — 把完整副本整份拷过去`;
		case 'no-target':
			return `${host}：${where}，但本机没有这个基准的包文件 — 先把它拷进来`;
	}
}

function mb(bytes: number): string {
	if (bytes <= 0) return '0 MB';
	const value = bytes / (1024 * 1024);
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} MB`;
}

/**
 * **我停在某个基准上，但本机没有它的包文件** —— 该不该补一份（0.18.1）。
 *
 * 什么时候会这样：应用了一份**差量包**（或者"接上后续基准"那一趟）—— 基准前进到了
 * 另一份完整副本，可我手里只有那份更新包，`state.bundle.fullFile` 只能是空的
 * （`apply.ts` 里那段：拿更新包的文件名冒充基准包会让"恢复本机误改"去找错东西）。
 *
 * 后果（不是致命的，但都能踩到）：`findBaselineBundle` 按名字找不到 → 「恢复本机误改」/
 * 「强制回退到基准再应用」只能报"把那份包放回来"；给第三台机器导差量包时，
 * 终点那份完整副本不在本机也做不出来。补一份就全好了，而且**两边各持一份同一份基准**，
 * 谁缺了都能从对方那儿再要一次。
 *
 * **必须核对指纹**再补：`fullHash` 是清单（路径 ＋ 大小 ＋ 修改时间）算出来的，
 * 拿现在的仓库算一遍如果和它不等，说明磁盘上这份**并不是**大家站的那一点
 * （典型：另一个文件系统的 mtime 精度/截断），补出来的完整副本会是**另一个基准** ——
 * 那种情况宁可不补，如实说出来，也别让两边悄悄分了岔。
 */
export interface BaselineCopyPlan {
	/** 要不要补 */
	needed: boolean;
	/** 不用补的原因（`needed=false` 时给人看） */
	reason: string | null;
	generation: number | null;
	hash: string | null;
	/** 现在这份仓库算出来的指纹 */
	actual: string | null;
	/** `actual === hash`：磁盘上确实就是大家站的那一点 */
	matches: boolean;
	/** 对不上的路径（大小 / 修改时间，最多 20 条，界面只说数量） */
	drift: string[];
	driftCount: number;
}

/** 补一份完整副本之前先算清楚（**只读**：只看状态与传进来的清单） */
export function planBaselineCopy(state: PluginState, inventory: Inventory): BaselineCopyPlan {
	const hash = state.bundle?.fullHash ?? null;
	const base = {
		needed: false,
		reason: null as string | null,
		generation: state.bundle?.fullGeneration ?? null,
		hash,
		actual: null as string | null,
		matches: false,
		drift: [] as string[],
		driftCount: 0,
	};
	if (!hash) return { ...base, reason: '本机还没有基准' };
	const fullFile = state.bundle?.fullFile ?? null;
	if (fullFile) return { ...base, reason: `本机已经有它的包文件（${fullFile}）` };

	const actual = listingHashOfFiles(inventory.files);
	const matters = state.bundle?.fullFiles ?? {};
	const drift: string[] = [];
	for (const [file, record] of inventory.files) {
		const at = matters[file];
		if (!at || at.size !== record.size || Math.round(at.mtime) !== Math.round(record.mtime)) {
			drift.push(file);
		}
	}
	for (const file of Object.keys(matters)) {
		if (!inventory.files.has(file)) drift.push(file);
	}
	return {
		needed: true,
		reason: null,
		generation: base.generation,
		hash,
		actual,
		matches: actual === hash,
		drift: drift.slice(0, 20),
		driftCount: drift.length,
	};
}
