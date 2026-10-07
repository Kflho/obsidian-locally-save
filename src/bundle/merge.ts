import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BUNDLE_EXT, BUNDLE_FORMAT, BUNDLE_VERSION, readBundleInfo, writeBundle } from './format';
import type { BundleDeletedEntry, BundleEntry, BundleHeader, BundleSource, BundleWriteProgress } from './format';
import { bundleDirForMode } from './paths';
import { listFiles } from '../sync/disk';
import { listFullAnchors } from './anchor';
import { baselineOfBundle } from './baseline';
import { listBundles, trashBundles } from './manage';
import { appendBundleLog } from './log';
import { copyRef, loadState, saveState } from '../sync/state';
import type { Logger } from '../utils/log';

/**
 * **把首尾相接的几份更新包合并成一份**（用户要的："防止基准点太多、更新太碎"）。
 *
 * 0.14 起"点"只有完整包，但**包与包之间照样能首尾相接**：一份差量包送到的是一份完整副本
 * （F1），下一份从 F1 往外算的包起点就是它 —— 导出几次就攒出这么一串：
 *
 * ```
 *   F0 ──L1──► F1 ──L2──► F2        两份包、三个完整副本
 *   F0 ────────── M ──────────► F2  合并后：一份包，站在 F0 上的机器一步到位
 * ```
 *
 * **合并 ＝ 把那几份包的负载接起来**：顺着链条把每份的条目叠上去（后面的覆盖前面的），
 * 段首那份记的 `base` 就是段首那份完整副本里的版本，删除项取"最后一次提到它时是删"的那些。
 * 头部两端照旧：起点＝段首那份的起点、终点＝段末那份的终点。
 *
 * 它现在是个**清历史遗留**的工具：新模型下同一份起点 + 同一形态 + 同一台机器导的包
 * 会被自动取代（`removeSupersededChanges`），所以一般攒不出长串；真正还会串起来的，
 * 是"一台机器站在 F1 上、另一台站在 F0 上"这种多机器场景。
 *
 * 为什么是"拼装"而不是"重新导一遍"（**用户报的「39 到 54、54 到 55 合不上」之后改的**）：
 * 重新导要先把**段首那一份**算出来，而它得从一份完整副本起步 —— 用户把第 39 代那份完整副本
 * 删了（几百 MB，太占地方），于是"算不出起点"就什么都合不了。可合并要的东西其实**全在这几份包里**：
 * 内容在它们的负载里、版本关系在它们的 `base` 里。拼装这条路**一份完整副本都不需要**，
 * 也不读仓库 —— 手头只有这几份，照样合得成。
 *
 * 顺带：拼装出来的包**跟"重新导一份"给接收方的东西是一样的**（同样的两个端点、同样的内容），
 * 而且中间版本的记录（`history`）也一并带上 —— 站在被吞掉的那一份上的机器照样收得下
 * （见 `apply.ts` 的 `checkAncestor`：起点相等，或者"算一遍落点"正好对得上）。
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

/** 一条"边"：某份包从哪个指纹 → 落到哪个指纹（合并只用到这几个字段） */
interface RingRef {
	/** 落点指纹（完整包 ＝ 它自己的清单指纹；更新包 ＝ 头部报的落点） */
	hash: string;
	generation: number;
	/** 从哪一份完整副本来（完整包 ＝ null，它不是"一环"） */
	from: string | null;
	/** 这一环基于的那一代（头部 `baseGeneration`）——起点那份包不在文件夹里时，区间还得靠它报出来 */
	baseGeneration: number | null;
	file: string;
	name: string;
	mtime: number;
}

/**
 * 扫一遍包目录，把每份能读出头部的包变成一条"边"。
 *
 * 从前这一步由 `bundle/points.ts` 提供（它还会把"链条上的点"物化出来）。
 * 0.14 起点只有完整副本了，合并要的只是**包与包之间的首尾关系**（谁的落点 ＝ 谁的起点），
 * 就地扫一遍就够 —— 同一个指纹只留一份（两台机器可能各导过一份一模一样的落点）：留最近写的那份。
 */
async function listRings(baseDir: string, lineage: string): Promise<RingRef[]> {
	const byHash = new Map<string, RingRef>();
	for (const item of await listBundles(baseDir)) {
		const header = item.header;
		if (!header || header.lineage !== lineage) continue;
		const from = baselineOfBundle(header);
		const hash = header.mode === 'full' ? from : (header.targetBaselineHash ?? null);
		if (!hash) continue; // 旧版更新包没记落点：接不出下一环，不能当边
		const ref: RingRef = {
			hash,
			generation: header.targetGeneration,
			from: header.mode === 'full' ? null : from,
			baseGeneration: header.baseGeneration ?? null,
			file: item.file,
			name: item.name,
			mtime: item.mtime,
		};
		const old = byHash.get(hash);
		if (!old || ref.mtime >= old.mtime) byHash.set(hash, ref);
	}
	return [...byHash.values()].sort((a, b) => b.generation - a.generation || b.mtime - a.mtime);
}

/** 扫包目录、算出现在能合并哪几段（只读） */
export async function planBundleMerges(
	baseDir: string,
	lineage: string,
): Promise<{ plans: MergePlan[]; forks: number }> {
	const refs = await listRings(baseDir, lineage);
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
	/** 有分叉的那几个点（同一个点导过好几份不同落点的包）：按点去重，界面上报"几处" */
	const forkPoints = new Set<string>();
	/** 同一段链条可能从中间某个点起也被走一遍（走出来的更短）—— 按"落点"去重，留最长的那段 */
	const longest = new Map<string, MergePlan>();
	for (const start of refs) {
		/**
		 * 从这一点往后能接上的那一串环 —— **含它自己这一环**（它就是"从这一点出发"的那一环）。
		 *
		 * 踩过：这里曾经只收"后继的那几环"，段首那一环自己反倒被丢掉，于是
		 * 报出来的区间整体偏一环；手里只有两环时（用户报的「39 到 54、54 到 55 合不上」）
		 * 连"两环"都凑不齐，合并窗口里空空的、什么都合不了。
		 */
		const run: typeof refs = start.from ? [start] : [];
		/** 防环：包被手工改坏时也不至于转不停 */
		const guard = new Set<string>([start.hash]);
		let current = start;
		while (true) {
			const next = outgoing.get(current.hash) ?? [];
			if (next.length > 1) forkPoints.add(current.hash);
			if (next.length !== 1) break;
			const step = next[0] as (typeof refs)[number];
			if (guard.has(step.hash)) break;
			guard.add(step.hash);
			run.push(step);
			current = step;
		}
		if (run.length < 2) continue;
		const first = run[0] as (typeof refs)[number];
		const anchorHash = first.from as string;
		/**
		 * 段首那一代的号：链条上那一点报过的（一份完整副本 / 别处的落点），
		 * 或者**这一环自己记的**（头部 `baseGeneration`）—— 起点那份完整副本被删掉时，
		 * 就只剩后者了（用户报的：「可能是因为我把 39 代完整包删了」——正是这个原因）。
		 */
		const anchorGeneration = generations.get(anchorHash) ?? first.baseGeneration;
		if (anchorGeneration === null || anchorGeneration === undefined) continue;
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
	return { plans, forks: forkPoints.size };
}

/** 合并要用到的东西：**只有包目录、日志、状态文件** —— 拼装不读仓库，也不碰本机的世代与基准 */
export interface MergeOptions {
	outDir: string;
	log: Logger;
	stateFile: string;
	/** 包名里那段仓库名（拿不到时用段首那份包记着的） */
	vaultName?: string;
	/** 每打进包里一个文件报一次（数字含义与导出完全一样：已经打包了几个 / 一共几个） */
	onProgress?: BundleWriteProgress;
}

/** 合并一段的结果：合并后那份包、挪进回收站的那几份、以及没挪动的 */
export interface MergeOutcome {
	/** 合并后的包（完整路径） */
	file: string;
	/** 同一环已经有一份时用它，不再重复写（包内容一模一样） */
	reused: boolean;
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
export async function mergeBundleGroup(options: MergeOptions, plan: MergePlan): Promise<MergeOutcome> {
	const dir = bundleDirForMode(options.outDir, 'changes');
	const links: { name: string; file: string; header: BundleHeader; payloadOffset: number }[] = [];
	for (const name of plan.links) {
		const file = path.join(dir, name);
		try {
			const info = await readBundleInfo(file);
			links.push({ name, file, header: info.header, payloadOffset: info.payloadOffset });
		} catch (error) {
			throw new Error(`合并要用的「${name}」现在读不出包信息了（${describe(error)}）—— 包目录刚被动过？重新打开这个窗口再看一遍`);
		}
	}
	const first = links[0];
	const last = links[links.length - 1];
	if (!first || !last) throw new Error('这一段里没有可合并的包');
	// 复核算计划时看到的那一串环现在还是不是首尾相接（包目录可能刚被动过：删了 / 挪了 / 又导了一份）
	for (let index = 0; index < links.length; index += 1) {
		const link = links[index] as (typeof links)[number];
		const expected = index === 0 ? plan.anchorHash : (links[index - 1] as (typeof links)[number]).header.targetBaselineHash;
		if (link.header.mode !== 'changes' || (link.header.baselineHash ?? null) !== expected) {
			throw new Error(`合并要用的这几环现在接不上了（「${link.name}」的起点对不上）—— 包目录刚被动过？重新打开这个窗口再看一遍`);
		}
	}
	if ((last.header.targetBaselineHash ?? null) !== plan.targetHash) {
		throw new Error(`合并要送到的那一点变了（「${last.name}」的落点对不上）—— 重新打开这个窗口再看一遍`);
	}

	/**
	 * 每个路径**最后一次**被提到的样子（后面的环覆盖前面的），
	 * 以及**第一次**被提及时记的 `base` —— 那就是段首那一点的版本，接收方在起点上手里正是它。
	 */
	type Mention = { kind: 'entry'; entry: BundleEntry; link: number } | { kind: 'deleted'; item: BundleDeletedEntry; link: number };
	const finalMention = new Map<string, Mention>();
	const headBase = new Map<string, { size?: number; mtime?: number; hash?: string }>();
	/** 中间版本：这一路上它经历过的那些版（被吞掉的环落出来的那一版），给"跳过几个包"的接收方认 */
	const history = new Map<string, { size: number; mtime: number }[]>();
	const pushHistory = (rel: string, record: { size: number; mtime: number }) => {
		const list = history.get(rel) ?? [];
		if (!list.some(item => item.size === record.size && item.mtime === record.mtime)) list.push({ ...record });
		history.set(rel, list);
	};
	const recordBase = (rel: string, base: { size?: number; mtime?: number; hash?: string }) => {
		if (!headBase.has(rel)) headBase.set(rel, base);
	};
	for (let index = 0; index < links.length; index += 1) {
		const header = (links[index] as (typeof links)[number]).header;
		for (const entry of header.entries ?? []) {
			recordBase(entry.path, {
				...(entry.baseSize !== undefined ? { size: entry.baseSize } : {}),
				...(entry.baseMtime !== undefined ? { mtime: entry.baseMtime } : {}),
				...(entry.baseHash ? { hash: entry.baseHash } : {}),
			});
			// 这一环落地的那一版，就是"后面某一环的 base"——只有当它不是最后一版时才算中间版本
			pushHistory(entry.path, entry);
			for (const item of entry.history ?? []) pushHistory(entry.path, item);
			finalMention.set(entry.path, { kind: 'entry', entry, link: index });
		}
		for (const item of header.deleted ?? []) {
			recordBase(item.path, {
				...(item.baseSize !== undefined ? { size: item.baseSize } : {}),
				...(item.baseMtime !== undefined ? { mtime: item.baseMtime } : {}),
				...(item.baseHash ? { hash: item.baseHash } : {}),
			});
			finalMention.set(item.path, { kind: 'deleted', item, link: index });
		}
	}

	/** 组装要写进新包的条目：内容一律从"最后一次提到它的那一环"的负载里取（拼装，不读仓库） */
	const sources: BundleSource[] = [];
	const deleted: BundleDeletedEntry[] = [];
	for (const rel of [...finalMention.keys()].sort()) {
		const mention = finalMention.get(rel) as Mention;
		const base = headBase.get(rel) ?? {};
		const baseFields = {
			...(base.size !== undefined ? { baseSize: base.size } : {}),
			...(base.mtime !== undefined ? { baseMtime: base.mtime } : {}),
			...(base.hash ? { baseHash: base.hash } : {}),
		};
		if (mention.kind === 'deleted') {
			deleted.push({ path: rel, ...baseFields });
			continue;
		}
		const link = links[mention.link] as (typeof links)[number];
		/** 中间版本：留到**这一版之前**的那些（最后那一版就是条目本身，不算历史） */
		const carried = (history.get(rel) ?? []).filter(
			item => !(item.size === mention.entry.size && item.mtime === mention.entry.mtime),
		);
		sources.push({
			path: rel,
			abs: '',
			from: { file: link.file, offset: link.payloadOffset + mention.entry.offset },
			size: mention.entry.size,
			mtime: mention.entry.mtime,
			...(mention.entry.hash ? { hash: mention.entry.hash } : {}),
			...baseFields,
			...(carried.length > 0 ? { history: carried } : {}),
		});
	}

	const state = await loadState(options.stateFile);
	const baseGeneration = first.header.baseGeneration ?? plan.anchorGeneration;
	const targetGeneration = last.header.targetGeneration;
	const stateId = last.header.stateId ?? null;
	const vault = first.header.vault || options.vaultName || 'vault';
	/** 这一路经过的那几个中间点（不含起点与落点）：站在它们上面的机器照样收得下 */
	const viaHashes = links
		.slice(0, -1)
		.map(link => link.header.targetBaselineHash)
		.filter((hash): hash is string => typeof hash === 'string' && hash.length > 0);

	/** 同一环已经有一份了（以前合过 / 手工导过）：直接用那一份，不再重复写 */
	const existing = await findRing(options.outDir, plan.anchorHash, plan.targetHash);
	let file = existing;
	let reused = existing !== null;
	if (existing) {
		options.log.debug(`合并：第 ${baseGeneration} → ${targetGeneration} 代的那一环已经有一份了（${path.basename(existing)}），直接用它的`);
	}
	if (!file) {
		const bundleId = randomUUID();
		const name = `${safeName(vault)}-更新-${baseGeneration}代到${targetGeneration}代`
			+ `-状态${stateId?.id ?? '未记'}-${bundleId.slice(0, 6)}${BUNDLE_EXT}`;
		file = path.join(dir, name);
		await writeBundle(
			file,
			{
				format: BUNDLE_FORMAT,
				version: BUNDLE_VERSION,
				bundleId,
				parentBundleId: first.header.bundleId,
				created: Date.now(),
				mode: 'changes',
				vault,
				lineage: first.header.lineage,
				source: copyRef(state),
				baseGeneration,
				targetGeneration,
				...(first.header.baselineHash ? { baselineHash: first.header.baselineHash } : {}),
				...(plan.targetHash ? { targetBaselineHash: plan.targetHash } : {}),
				// **段末那一环送到的是"一份完整副本"时，合并出来的这一份也一样**：
				// 接收方应用它就该把基准推到那一份（否则它还站在老基准上，下一步导出的包
				// 对方收不下，报"基准对不上"）。标记**从段末那一环继承** ——
				// 段末是"→最新状态"的包时天然没有它。
				...(last.header.targetFullBundle === true ? { targetFullBundle: true } : {}),
				...(viaHashes.length > 0 ? { viaHashes } : {}),
				...(stateId ? { stateId } : {}),
				deleted,
				emptyDirs: [...(last.header.emptyDirs ?? [])].sort(),
			},
			sources,
			(written, total, writtenPath) => options.onProgress?.(written, total, writtenPath),
		);
		// 记一笔（更新记录里那句话就是"合并了相邻的 N 份更新包"）：本机什么都不推进，只换了个包
		const logEntry = {
			at: Date.now(),
			direction: 'export' as const,
			mode: 'changes' as const,
			bundleId,
			file: path.basename(file),
			base: baseGeneration,
			target: targetGeneration,
			entries: sources.length,
			deleted: deleted.length,
			checkpoint: true,
			note: `合并了相邻的 ${links.length} 份更新包（${baseGeneration} → ${targetGeneration} 代）`,
			...(stateId?.id ? { stateId: stateId.id } : {}),
		};
		appendBundleLog(state, logEntry);
		reused = false;
	}
	/**
	 * 本机正好站在**段末那一点**上时：那一份的"见证包"（原来那一环）马上要被挪走，
	 * 界面上「← 本机现在的基准」那一行会找不到主人 —— 改指合并后的这一份。
	 * 它落到的是同一点（`fullHash` 没变），只是换了个包名。
	 */
	if (state.bundle && plan.targetHash && state.bundle.fullHash === plan.targetHash) {
		state.bundle.fullFile = path.basename(file);
	}
	await saveState(options.stateFile, state);

	// 新的那份已经落地，这才把那几份小的挪进回收站（不是真删：万一还有机器站在中间某个点上，捞回来就能补上）
	const trashed = await trashBundles(
		options.outDir,
		plan.links.map(name => path.join(dir, name)),
	);
	return {
		file,
		reused,
		trashed: trashed.moved,
		failed: trashed.failed.map(item => ({ name: path.basename(item.path), error: item.error })),
	};
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function safeName(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'vault';
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
