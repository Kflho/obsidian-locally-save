import path from 'node:path';
import { BUNDLE_EXT, readBundleInfo } from './format';
import type { BundleHeader } from './format';
import { baselineOfBundle } from './baseline';
import { listFiles } from '../sync/disk';
import { bundleDirForMode } from './paths';
import { trashBundles } from './manage';
import type { TrashOutcome } from './manage';
import type { PluginState } from '../sync/state';
import type { PeerState } from '../git/peers';

/**
 * **更新包的自动管理**（0.18.2）。用户的原话：
 * "所有终端都在新的完整备份后，老包到新包的更新包就应该从所有终端和 git 中清掉，保持整洁……
 *  只保留需要的更新包，无意义的更新包自动删，防止仓库繁杂。"
 *
 * 一条判据：**还有没有机器能用得上它**。更新包/差分更新包只在"接收方的基准正好是它的起点"时
 * 才应用得上（`checkAncestor` 那条硬规矩），所以：
 *
 * | 情况 | 判定 |
 * |---|---|
 * | 它的起点是本机的基准，或者远程仓库上还有电脑报着这个起点 | **有用**（留着） |
 * | 起点已经没人用（本机换了基准、别的机器也都跟上去了） | **没用** → 移到回收站 |
 * | 同一份起点 ＋ 同一形态 ＋ 同一台机器导的，还有更新的那一份 | **多余** → 移到回收站 |
 * | 回退环（目标版本号 ≤ 起点号） | **留着**：这条线上唯一一份"往回走"的说明 |
 * | 目标版本比我这一代还新 | **留着**：可能是更新的内容，宁可多留 |
 * | 别的分支 / 读不出头部 | **留着**：判不了就绝不猜 |
 *
 * 三道安全闸（都是"宁可留着"的方向）：
 * 1. **远程仓库上没有任何电脑上报过** → 整条不跑（单机 / 没开 git，分不清谁在用）；
 * 2. **只说得出"再也不可能被应用"** → 一律移到**回收站**（`trashBundles` + 记号），
 *    不真删；真删只有「彻底删除」「清空回收站」两条用户点的路；
 * 3. 清出来的删除照 `git/removals.ts` 的记号提交并推走 → **别的终端和远程一起没掉**
 *    （那边 `salvageDroppedBundles` 会把它也备份进本机回收站再删）。
 *
 * 什么时候跑：`main.runTick` 每一拍在 git 推送和拉取**之前**看一遍（30 秒一次，读几个包头部，
 * 不扫仓库）。所以"最后一台机器跟上来"之后最多 30 秒，那份老包就从所有地方消失。
 * 导出时同时清（`removeSupersededChanges`）那条路照旧保留：它多一道"内容被新包完全覆盖"的判据。
 */

export interface GcDrop {
	file: string;
	name: string;
	size: number;
	/** `base-unused`：起点没人用了；`superseded-sibling`：同组里还有更新的那一份 */
	why: 'base-unused' | 'superseded-sibling';
	baseGeneration: number | null;
	targetGeneration: number;
}

export interface GcPlan {
	drop: GcDrop[];
	kept: { name: string; why: string }[];
	/** `drop` 一共占多少字节（界面报"腾出 X MB"） */
	bytes: number;
	/** 现在判断不了时的一句话（null ＝ 判断过了） */
	blocked: string | null;
}

/** 一组"同一份起点 ＋ 同一形态"的包（只对**我导的**做"只留最新"） */
interface Row {
	file: string;
	name: string;
	size: number;
	header: BundleHeader;
	base: string | null;
	baseGeneration: number | null;
	targetGeneration: number;
	created: number;
	checkpoint: boolean;
}

function peerLabel(peer: PeerState): string {
	if (peer.host !== '') return peer.host;
	return peer.vault !== '' ? peer.vault : peer.copyId.slice(0, 8);
}

export async function planBundleGc(
	baseDir: string,
	state: PluginState,
	peers: PeerState[],
): Promise<GcPlan> {
	const plan: GcPlan = { drop: [], kept: [], bytes: 0, blocked: null };
	const mine = state.bundle?.fullHash ?? null;
	if (!baseDir) {
		plan.blocked = '还没确定同步包文件夹';
		return plan;
	}
	if (!mine) {
		plan.blocked = '本机还没有基准：先导一份完整备份，才分得清哪些包还有人用';
		return plan;
	}
	if (peers.length === 0) {
		plan.blocked = '远程仓库上还没有别的电脑上报过状态：分不清哪些包还有人用（先让对面同步一次）';
		return plan;
	}
	const inUse = new Set<string>([mine]);
	for (const peer of peers) {
		if (peer.baselineHash) inUse.add(peer.baselineHash);
	}

	const rows: Row[] = [];
	for (const item of await listFiles(bundleDirForMode(baseDir, 'changes'))) {
		if (!item.name.toLowerCase().endsWith(BUNDLE_EXT)) continue;
		const file = path.join(bundleDirForMode(baseDir, 'changes'), item.name);
		let header: BundleHeader;
		try {
			header = (await readBundleInfo(file)).header;
		} catch {
			plan.kept.push({ name: item.name, why: '读不出包信息（不是我们的包 / 传坏了）' });
			continue;
		}
		if (header.mode !== 'changes') continue;
		if (header.lineage !== state.lineage) {
			plan.kept.push({ name: item.name, why: '另一个来源的包（多半是另一台机器另立的基准）' });
			continue;
		}
		// 回退环：这条线上唯一一份"往回走"的说明，靠正向导出再也生不出来
		if (header.targetGeneration <= (header.baseGeneration ?? 0)) {
			plan.kept.push({ name: item.name, why: `把大家带回第 ${header.targetGeneration} 版的那一份（回退说明）` });
			continue;
		}
		// 目标版本比我还新：可能是更新的内容，宁可多留
		if (header.targetGeneration > state.generation) {
			plan.kept.push({ name: item.name, why: '目标版本比我这一代还新（可能装着我还没有的内容）' });
			continue;
		}
		const base = baselineOfBundle(header);
		if (!base) {
			plan.kept.push({ name: item.name, why: '旧版包没记基准校验值，认不出它的起点' });
			continue;
		}
		if (!inUse.has(base)) {
			// 起点没人用：再也不可能被任何一台机器应用
			plan.drop.push({
				file,
				name: item.name,
				size: item.size,
				why: 'base-unused',
				baseGeneration: header.baseGeneration ?? null,
				targetGeneration: header.targetGeneration,
			});
			continue;
		}
		rows.push({
			file,
			name: item.name,
			size: item.size,
			header,
			base,
			baseGeneration: header.baseGeneration ?? null,
			targetGeneration: header.targetGeneration,
			created: header.created ?? item.mtime,
			checkpoint: header.targetFullBundle === true,
		});
	}

	// 同一份起点 ＋ 同一形态 ＋ 同一台机器导的：只留目标版本最新的那一份
	const groups = new Map<string, Row[]>();
	for (const row of rows) {
		// 别的机器导出的那一份，装的是它那一半改动，不参与"只留最新"
		if (row.header.source?.copyId !== state.copyId) continue;
		const key = `${row.base}|${row.checkpoint ? 'to-full' : 'to-latest'}|${row.checkpoint ? (row.header.targetBaselineHash ?? '') : ''}`;
		const list = groups.get(key);
		if (list) list.push(row);
		else groups.set(key, [row]);
	}
	for (const list of groups.values()) {
		if (list.length < 2) continue;
		const sorted = [...list].sort((a, b) => b.targetGeneration - a.targetGeneration || b.created - a.created);
		const [keep, ...rest] = sorted;
		if (keep) plan.kept.push({ name: keep.name, why: `第 ${keep.baseGeneration ?? '?'} 版那群包里的最新一份` });
		for (const row of rest) {
			plan.drop.push({
				file: row.file,
				name: row.name,
				size: row.size,
				why: 'superseded-sibling',
				baseGeneration: row.baseGeneration,
				targetGeneration: row.targetGeneration,
			});
		}
	}
	for (const row of rows) {
		if (plan.kept.some(item => item.name === row.name)) continue;
		if (plan.drop.some(item => item.name === row.name)) continue;
		plan.kept.push({ name: row.name, why: '还能用得上（有人以它的起点为基准）' });
	}
	plan.bytes = plan.drop.reduce((sum, item) => sum + item.size, 0);
	return plan;
}

/** 把计划里那几份移到回收站（记号在 `trashBundles` 里记，下一拍同步会把删除推走） */
export async function runBundleGc(baseDir: string, plan: GcPlan): Promise<TrashOutcome> {
	if (plan.drop.length === 0) return { moved: [], failed: [], target: '' };
	return trashBundles(baseDir, plan.drop.map(item => item.file));
}

/** 一句给人看的话（状态栏 / 日志；没问题时不写） */
export function describeGcRun(plan: GcPlan, moved: string[]): string {
	if (moved.length === 0) return '';
	const labels = new Set(plan.drop.map(item => item.why));
	const why = labels.has('base-unused') ? '基准已无电脑使用' : '同组中已有更新的版本';
	const kb = plan.bytes / 1024;
	const size = kb < 1024
		? `${Math.max(1, Math.round(kb))} KB`
		: `${(plan.bytes / 1048576).toFixed(1)} MB`;
	return `整理更新包：已移除 ${moved.length} 份（${why}），释放 ${size}`;
}

/** 各台电脑现在各自用的是哪一份基准（日志 / 悬停用） */
export function describeGcPeers(peers: PeerState[]): string[] {
	return peers.map(peer => `${peerLabel(peer)}：第 ${peer.baselineGeneration ?? '?'} 版 · ${peer.baselineHash ?? '未记'}`);
}
