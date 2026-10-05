import path from 'node:path';
import { BUNDLE_EXT, readBundleInfo } from './format';
import { bundleDirForMode } from './paths';
import { listFiles } from '../sync/disk';
import { listFullAnchors } from './anchor';
import { listPointRefsSync } from './points';
import { trashBundles } from './manage';
import { exportBundle } from './export';
import type { ExportOptions } from './export';

/**
 * **把相邻的更新包合并成一环**（用户要的："防止基准点太多、更新太碎"）。
 *
 * 链条模型下每份更新包是"从哪一点 → 落到哪一点"的一环。导出几次就攒出好几环：
 *
 * ```
 *   39 ──L1──► 44 ──L2──► 47 ──L3──► 51        三份包、四个点
 *   39 ────────── M ──────────► 51             合并后：一份包、两个点
 * ```
 *
 * 合并做的事就是**用一次"从段首到段末"的导出把中间那几环顶掉**：
 * - 起点＝段首那一环的起点，落点＝段末那一环的落点（所以**基准点重新算过**：
 *   中间那几个点不再有包，链条上只剩段首与段末）；
 * - 内容沿链条取（`points.ts` 的 `sources`：改过的在那一环的包里，没动过的还在起点那份包里）——
 *   复用现成的差量导出那条路（`baseFingerprint` + `toFingerprint`），不另写一套；
 * - 那几份小包**挪进回收站**（不是真删：万一还有机器站在中间某个点上，捞回来就能补上）；
 * - **本机什么都不推进**（差量包语义），只是如果本机正好站在段末那一点上，
 *   `state.bundle.fullFile` 要改指合并后的那一份（原来那份挪走了）。
 *
 * **只合"直线段"**：每一步只有一条出边的那些。有分叉（同一个点导过好几份不同落点的包）
 * 就跳过 —— 哪条是正路只有用户知道，插件不猜。
 */

/** 一段可以合并的相邻更新包 */
export interface MergePlan {
	/** 段首那一环的起点（合并后的包基于这一点） */
	anchorHash: string;
	anchorGeneration: number;
	/** 段末那一环的落点（合并后送到这一点） */
	targetHash: string;
	targetGeneration: number;
	/** 被顶掉的那几份包（按链条顺序，文件名） */
	links: string[];
	/** 那几份包现在一共多大（界面报数：合并前 / 合并后） */
	bytes: number;
	/** 中间经过的那几个点（报数用：少掉几个基准点） */
	middlePoints: string[];
}

/** 扫包目录、算出现在能合并哪几段（只读） */
export async function planBundleMerges(
	baseDir: string,
	lineage: string,
): Promise<{ plans: MergePlan[]; forks: number }> {
	const refs = listPointRefsSync(baseDir, lineage);
	const sizes = new Map<string, number>();
	for (const item of await listFiles(bundleDirForMode(baseDir, 'changes'))) {
		if (item.name.toLowerCase().endsWith(BUNDLE_EXT)) sizes.set(item.name, item.size ?? 0);
	}
	/** 每个点的世代：落点由更新包报，起点那份完整副本由它自己报 */
	const generations = new Map<string, number>();
	for (const ref of refs) generations.set(ref.hash, ref.generation);
	for (const anchor of await listFullAnchors(baseDir, lineage)) {
		if (anchor.hash) generations.set(anchor.hash, anchor.generation);
	}
	/** 谁落在哪个点上（同一点可能有好几份 —— 那就是分叉） */
	const outgoing = new Map<string, typeof refs>();
	for (const ref of refs) {
		if (!ref.from) continue; // 完整副本不是"一环"，不从它出发
		const list = outgoing.get(ref.from) ?? [];
		list.push(ref);
		outgoing.set(ref.from, list);
	}

	const plans: MergePlan[] = [];
	let forks = 0;
	/** 同一段链条可能从中间某个点起也被走一遍（走出来的更短）—— 按"落点"去重，留最长的那段 */
	const longest = new Map<string, MergePlan>();
	for (const start of refs) {
		const run: typeof refs = [];
		/** 防环：包被手工改坏时也不至于转不停 */
		const guard = new Set<string>([start.hash]);
		let current = start;
		while (true) {
			const next = outgoing.get(current.hash) ?? [];
			if (next.length > 1) forks++;
			if (next.length !== 1) break;
			const step = next[0] as (typeof refs)[number];
			if (guard.has(step.hash)) break;
			guard.add(step.hash);
			run.push(step);
			current = step;
		}
		if (run.length < 2) continue;
		const anchorHash = run[0]?.from as string;
		const anchorGeneration = generations.get(anchorHash);
		if (anchorGeneration === undefined) continue; // 段首那一点不在这堆包里（报不出区间，不碰）
		const last = run[run.length - 1] as (typeof refs)[number];
		const plan: MergePlan = {
			anchorHash,
			anchorGeneration,
			targetHash: last.hash,
			targetGeneration: last.generation,
			links: run.map(ref => ref.name),
			bytes: run.reduce((sum, ref) => sum + (sizes.get(ref.name) ?? 0), 0),
			middlePoints: run.slice(0, -1).map(ref => ref.hash),
		};
		const old = longest.get(plan.targetHash);
		if (!old || old.links.length < plan.links.length) longest.set(plan.targetHash, plan);
	}
	plans.push(...longest.values());
	plans.sort((a, b) => a.anchorGeneration - b.anchorGeneration);
	return { plans, forks };
}

/** 合并一段的结果：合并后那份包、挪进回收站的那几份、以及没挪动的 */
export interface MergeOutcome {
	/** 合并后的包（已经有一份一模一样的时，这里给的是那一份的文件名） */
	file: string;
	reason?: string;
	trashed: string[];
	/** 挪不动的（回收站里已经有同名的之类），如实报出来 */
	failed: { name: string; error: string }[];
}

/**
 * 执行一段合并（**先算后做**：调用方先把 `planBundleMerges` 的结果摊给用户看）。
 *
 * 顺序是硬的：**先把合并后的包写出来、确认落地，才去挪那几份小的** ——
 * 写失败就什么都不动（那几份包是"目前唯一的改动备份"）。
 */
export async function mergeBundleGroup(options: ExportOptions, plan: MergePlan): Promise<MergeOutcome> {
	const outcome = await exportBundle({
		...options,
		mode: 'changes',
		outDir: options.outDir,
		baseFingerprint: plan.anchorHash,
		toFingerprint: plan.targetHash,
		logNote: `合并了相邻的 ${plan.links.length} 份更新包（${plan.anchorGeneration} → ${plan.targetGeneration} 代）`,
	});
	/**
	 * 写不出来有两种情况，都别当成失败：
	 * - **已经有一份一模一样**（同一环重导过）：那就用它，照样把那几份小的挪走；
	 * - 没有内容可导（理论上不该发生：那几份包里明明有改动）—— 如实说，不动任何包。
	 */
	let file = outcome.file;
	if (!file) {
		file = await findRing(options.outDir, plan.anchorHash, plan.targetHash);
		if (!file) throw new Error(outcome.reason ?? '合并后的包没能写出来，这次什么都没动');
	}
	const trashed = await trashBundles(options.outDir, plan.links.map(name => path.join(bundleDirForMode(options.outDir, 'changes'), name)));
	return {
		file,
		reason: outcome.reason,
		trashed: trashed.moved,
		failed: trashed.failed.map(item => ({ name: path.basename(item.path), error: item.error })),
	};
}

/** 目录里有没有一份"从 a 到 b"的更新包（同一环重导过时用它）；给的是**完整路径**（与导出那条路一致） */
async function findRing(outDir: string, anchorHash: string, targetHash: string): Promise<string | null> {
	const dir = bundleDirForMode(outDir, 'changes');
	for (const item of await listFiles(dir)) {
		if (!item.name.toLowerCase().endsWith(BUNDLE_EXT)) continue;
		try {
			const header = (await readBundleInfo(path.join(dir, item.name))).header;
			if (header.mode !== 'changes') continue;
			if (header.baselineHash !== anchorHash || header.targetBaselineHash !== targetHash) continue;
			return path.join(dir, item.name);
		} catch {
			// 读不出头部的跳过
		}
	}
	return null;
}
