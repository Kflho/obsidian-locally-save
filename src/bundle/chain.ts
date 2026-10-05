import path from 'node:path';
import fs from 'node:fs';
import { executeBundlePlan, planBundleApply } from './apply';
import type { ApplyOptions } from './apply';
import { baselineOfBundle } from './baseline';
import { listBundles } from './manage';
import type { ManagedBundle } from './manage';
import { scanTree } from '../sync/disk';
import { VAULT_TRASH_DIR, excludePatterns } from '../sync/vault';
import { loadState } from '../sync/state';
import type { PluginState } from '../sync/state';
import { sameRecord, DEFAULT_MTIME_TOLERANCE_MS } from '../sync/diff';
import { toNative } from '../utils/paths';

/**
 * **自动接链**：让插件自己判断"本机能不能接到包链条的末端"。
 *
 * 链条模型（0.11 起）：**基准点**是链条上的节点 —— 完整包是一个点，**每份被应用的更新包**
 * 也落出一个新点；点与点之间是严格镜像，所以链条上每个节点的内容都是确定的，不需要人去指。
 * 链本身就是现成的数据：每个包的头部都记着"**我从哪一个基准点往外延伸**"
 * （`baselineHash`）与"**我落到哪一个基准点**"（`targetBaselineHash`，
 * 见 `bundle/export.ts`），首尾相接就串起来了。
 *
 * 为什么需要它（用户提的）：本机的点与"文件夹里有哪些包"原本是两件互不相干的事，全靠人手动对齐 ——
 * 手上有第 39 代的点、文件夹里是一条 39→46 的链，得手动重导一份完整副本才跟得上。
 *
 * 三条判据：
 * 1. **认链**：本机这一点往后，每一步都找"起点指纹 ＝ 当前落点"的那个包（同血脉）；
 * 2. **能不能接**：本机这一点必须**在链上**（是某个包的落点，或是一份完整包）。
 *    接不上**如实说缺哪一份**，绝不猜着合；
 * 3. **接到哪儿**：从本机这一点往后一路走到底（链末）。
 *
 * 执行时**不重新打包任何东西**：链上的完整副本与更新包都在文件夹里，按顺序应用即可；
 * 应用完 `state.bundle.fullHash` / `state.generation` 自然等于链末那一点。
 *
 * **本机的改动要保留**（用户明确选的）：接链会让完整副本镜像覆盖本机内容，所以接链前先把
 * "本机相对旧基准点的改动"记下来，接完再放回去 —— 最终内容 = **链末 + 本机改动**，基准点 = 链末。
 * 放回用的字节取自**原来那份包**（`extractPath`），所以放回去的就是本机原来那一版，不会走形。
 *
 * 这个文件不 import obsidian：分析是纯逻辑，执行只调 `apply.ts`，测试能拿临时目录直接跑。
 */

/** 链上的一个节点 */
export interface ChainNode {
	file: string;
	name: string;
	mode: 'full' | 'changes';
	/** 完整包：它自己那一代；更新包：应用完到达的那一代 */
	generation: number;
	/** 这个包**从哪一个基准点**往外延伸（完整包 ＝ 它自己） */
	baseline: string | null;
	/** **落到哪一个基准点**（完整包 ＝ 它自己；旧版更新包没记 → null，这一环接不下去） */
	target: string | null;
}

export interface ChainPlan {
	/** 本机现在站在链上的哪一份完整包（`null` ＝ 本机还没基准 / 基准不在链上） */
	from: ChainNode | null;
	/** 从本机基准往后要依次应用的包（空数组 ＝ 本机已经在链末） */
	steps: ChainNode[];
	/** 链末那一代（接完之后本机的世代） */
	endGeneration: number;
	/** 链末那份完整包（基准要切到它）；链末是更新包时为 null（那种情况另说） */
	endFull: ChainNode | null;
	/** 接不上的原因（能接时是 null）：缺哪一份完整包、本机没有基准、选中包不在链上… */
	problem: string | null;
	/** 本机相对旧基准的改动（接链后要放回去的那部分） */
	edits: LocalEdit[];
	/** 本机独有的文件（旧基准里没有、包里也不会有）—— 也会被放回去 */
	extraFiles: string[];
}

/** 本机相对基准改过（或新建）的一个文件 */
export interface LocalEdit {
	path: string;
}

/**
 * 按头部算出"这个包的基准指纹"：
 * - 完整包：它自己的清单指纹（接收方也能重算，不信任头部字段）；
 * - 更新包：它声称基于的那份（`baselineHash`，旧包没有 → null，接不上）。
 */
function baselineOf(bundle: ManagedBundle): string | null {
	const header = bundle.header;
	if (!header) return null;
	return baselineOfBundle(header);
}

/**
 * 把文件夹里的包串成链，并算出"本机能不能接、接到哪儿"。
 *
 * `only`（可选）＝ 只看包含这个文件的链 —— 界面上是"选中某个包之后，认出它所在的整条链"。
 */
export async function planChain(
	options: ApplyOptions,
	/** 同步包文件夹（`ApplyOptions` 里没有它 —— 应用只需要单个包的路径） */
	baseDir: string,
	only?: string,
): Promise<ChainPlan> {
	const state = await loadState(options.stateFile);
	const bundles = (await listBundles(baseDir)).filter(item => item.header);

	// 链上的包：同血脉 + 认得出"从哪一点来、落到哪一点"
	const sameLineage = bundles.filter(item => item.header?.lineage === state.lineage);
	const nodes = sameLineage.map(node);

	/** 指纹 → 节点（同指纹只留最新那一份）：完整包用它自己的指纹认，更新包用它落到的那一点认 */
	const byHash = new Map<string, ChainNode>();
	/** 指纹 → **完整包**：链末正好落在一份完整副本上时，那一点可以当成一份新基准来用 */
	const fullByHash = new Map<string, ChainNode>();
	for (const item of nodes) {
		const keys = item.mode === 'full' ? [item.baseline, item.target] : [item.target];
		for (const key of keys) {
			if (!key) continue;
			if (item.mode === 'full') fullByHash.set(key, item);
			const old = byHash.get(key);
			if (!old || item.generation >= old.generation) byHash.set(key, item);
		}
	}

	const mine = state.bundle?.fullHash ?? null;
	const emptyPlan = (problem: string): ChainPlan => ({
		from: null, steps: [], endGeneration: state.generation, endFull: null, problem,
		edits: [], extraFiles: [],
	});
	if (sameLineage.length === 0) return emptyPlan('这个文件夹里没有跟我同血脉的包（先把对方的包拷进来）');
	if (mine === null) return emptyPlan('本机还没有基准点（没导过、也没应用过完整副本）：先应用一份完整副本，之后才谈得上接链');

	// 本机站在链上的哪一点：一份完整包（它就是那一点），或者"落到这一点"的那个包
	const arrive = nodes.find(item => item.mode === 'changes' && item.target === mine) ?? null;
	const startNode = byHash.get(mine) ?? null;
	if (!arrive && !startNode) {
		return emptyPlan(`本机现在的基准点（指纹 ${mine}）不在这个文件夹里的任何一条链上：中间缺那几份包。`
			+ '让对方把它们一起发过来（或者让对方按本机这个点重导一份更新包）');
	}
	const fromNode = arrive ?? (startNode as ChainNode);

	// 从这一点往后接：每一步都必须是"起点指纹 ＝ 当前落点"，接不上就停在那儿并说清。
	// 同一个起点上有好几份包（两台机器各导了一份）时取**最新**的那份，另一份是并行的支线。
	const steps: ChainNode[] = [];
	const used = new Set<string>([fromNode.file]);
	let cursor: string | null = mine;
	let generation = fromNode.generation;
	for (;;) {
		const next = nodes
			.filter(item => item.mode === 'changes'
				&& item.baseline === cursor
				&& item.target !== null
				&& !used.has(item.file))
			.sort((a, b) => b.generation - a.generation)[0];
		// 防环：世代必须往前走
		if (!next || next.generation <= generation) break;
		steps.push(next);
		used.add(next.file);
		cursor = next.target;
		generation = next.generation;
	}

	if (only !== undefined) {
		// 只关心"包含选中的那个包"：它必须在链上，否则整条链跟它无关
		const inChain = path.resolve(fromNode.file) === path.resolve(only)
			|| steps.some(step => path.resolve(step.file) === path.resolve(only));
		if (!inChain) {
			return emptyPlan('选中的这个包不在本机所在的这条链上（它接的是别的基准点）—— 先在「管理同步包」里看它该接在谁后面');
		}
	}

	// 终点正好是一份完整包时（落点指纹就是它）：那一点可以当成一份新基准来用
	const endFull = cursor === null ? null : (fullByHash.get(cursor) ?? null);
	if (steps.length === 0) {
		return {
			from: fromNode, steps: [], endGeneration: generation, endFull,
			problem: endFull ? null : '本机已经在这条链的末端了（后面没有更新的包）',
			edits: [], extraFiles: [],
		};
	}

	// 本机相对**旧基准点**改过哪些文件：接链是镜像覆盖，所以这些要先记下来再放回
	const edits = await collectLocalEdits(options, state);
	return {
		from: fromNode,
		steps,
		endGeneration: generation,
		endFull,
		problem: null,
		edits: edits.edits,
		extraFiles: edits.extra,
	};
}

/** 一个包 → 链上的一个节点：从哪一点来、落到哪一点 */
function node(bundle: ManagedBundle): ChainNode {
	const header = bundle.header;
	const mode = header?.mode ?? 'changes';
	const baseline = baselineOf(bundle);
	return {
		file: bundle.file,
		name: bundle.name,
		mode,
		generation: header?.targetGeneration ?? 0,
		baseline,
		// 完整包：它自己就是那一点；更新包：头部记着落点（旧版包没记 → null）
		target: mode === 'full' ? baseline : (header?.targetBaselineHash ?? null),
	};
}

/**
 * 本机相对**旧基准**改过 / 新建的文件（接链要放回去的那部分）。
 *
 * 判据与导出挑成员完全一致（大小 + 修改时间，2 秒容差），所以"会被放回的"正好是
 * "下次更新包里会装的那些"。每个文件记下**它现在这份出自哪份包** —— 放回时从那份包里取字节。
 * 本机独有的（基准里没有、包里也不会有）同样要放回，它们的字节在本地磁盘上而不是包里。
 */
async function collectLocalEdits(
	options: ApplyOptions,
	state: PluginState,
): Promise<{ edits: LocalEdit[]; extra: string[] }> {
	const anchor = state.bundle?.fullFiles ?? null;
	const inventory = await scanTree(options.vaultRoot, {
		exclude: excludePatterns(options.settings.excludePatterns, options.configDir),
		skipTopLevelDirs: [VAULT_TRASH_DIR],
	});
	if (!anchor) return { edits: [], extra: [] };

	// 本机改过的：字节在磁盘上（extractPath 的 abs 走本地文件），来源记空串
	const edits: LocalEdit[] = [];
	const extra: string[] = [];
	for (const [file, record] of inventory.files) {
		const at = anchor[file];
		if (!at) {
			extra.push(file); // 本机独有的：放回时也从磁盘取
			continue;
		}
		if (!sameRecord(record, at, DEFAULT_MTIME_TOLERANCE_MS)) edits.push({ path: file });
	}
	return { edits, extra };
}

/** 接链的结果（给界面报账） */
export interface ChainOutcome {
	applied: { name: string; written: number; deleted: number; failed: number }[];
	/** 放回本机的改动：成功几个 */
	restored: number;
	/** 放回时发现**链末也改过这个文件**（按"本机那份赢"处理，如实报数） */
	conflicts: number;
	/** 放回失败 / 本机那一版已经找不到的 */
	failed: { path: string; error: string }[];
	/** 接完之后的世代 */
	generation: number;
	/** 中止的原因（接链途中失败） */
	problem: string | null;
}

/**
 * 真去接链：**先算后做**由调用方保证（先用 `planChain` 出报告，用户确认后才调这里）。
 *
 * 顺序（每一步失败都能停下来说清，不会留下半截状态）：
 * 1. 把"本机相对旧基准的改动"连同字节一起**先存到临时目录**（不依赖原来那份包还在不在）；
 * 2. 按顺序应用链上的包（完整副本镜像、更新包只动点名的）；
 * 3. 把存下的改动放回仓库 —— 这一版是本机的版本，链末也改过就按"本机赢"（如实报数）。
 */
export async function runChain(
	options: ApplyOptions,
	plan: ChainPlan,
	scratchDir: string,
): Promise<ChainOutcome> {
	const outcome: ChainOutcome = {
		applied: [], restored: 0, conflicts: 0, failed: [], generation: 0, problem: null,
	};

	// ---- ① 先把本机的改动存到临时目录（连同字节，不依赖包还在不在）
	const saved: { path: string; file: string }[] = [];
	for (const edit of plan.edits) {
		const saved_file = path.join(scratchDir, edit.path);
		try {
			await copyFile(toNative(options.vaultRoot, edit.path), saved_file);
			saved.push({ path: edit.path, file: saved_file });
		} catch (error) {
			outcome.failed.push({ path: edit.path, error: `没能先存下它：${describe(error)}` });
		}
	}
	for (const file of plan.extraFiles) {
		const saved_file = path.join(scratchDir, file);
		try {
			await copyFile(toNative(options.vaultRoot, file), saved_file);
			saved.push({ path: file, file: saved_file });
		} catch (error) {
			outcome.failed.push({ path: file, error: `没能先存下它：${describe(error)}` });
		}
	}

	// 有东西没存下来就**不往下走**：接链会镜像覆盖，存不下的那些会丢
	if (outcome.failed.length > 0) {
		outcome.problem = '有几样本机改动没能先存下来，为了不丢东西，这次没有接链';
		return outcome;
	}

	// ---- ② 依次应用链上的包
	for (const step of plan.steps) {
		try {
			const stepOptions: ApplyOptions = { ...options, file: step.file };
			const applied = await planBundleApply(stepOptions);
			const result = await executeBundlePlan(applied, stepOptions);
			outcome.applied.push({
				name: step.name,
				written: result.written,
				deleted: result.deleted,
				failed: result.failed.length,
			});
		} catch (error) {
			outcome.problem = `接链在「${step.name}」这一步停下了：${describe(error)}`;
			break;
		}
	}

	// ---- ③ 把本机的改动放回去（本机那一版赢；链末也改过的只是报个数）
	for (const item of saved) {
		try {
			const target = toNative(options.vaultRoot, item.path);
			const record = await copyFile(item.file, target);
			outcome.restored++;
			if (record === 'overwrote') outcome.conflicts++;
		} catch (error) {
			outcome.failed.push({ path: item.path, error: describe(error) });
		}
	}

	outcome.generation = (await loadState(options.stateFile)).generation;
	return outcome;
}

/** 复制一个文件（两个方向都要能建目录）；返回它是不是覆盖了已有文件 */
async function copyFile(from: string, to: string): Promise<'new' | 'overwrote'> {
	const existed = await fs.promises.stat(to).then(() => true, () => false);
	await fs.promises.mkdir(path.dirname(to), { recursive: true });
	await fs.promises.copyFile(from, to);
	return existed ? 'overwrote' : 'new';
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
