import path from 'node:path';
import { executeBundlePlan, isDestructivePlan, planBundleApply } from './apply';
import type { ApplyOptions, ApplyPlan } from './apply';
import { baselineOfBundle } from './baseline';
import { listBundles } from './manage';
import type { ManagedBundle } from './manage';
import { loadState, rememberIncoming, saveState } from '../sync/state';
import type { PluginState } from '../sync/state';

/**
 * 「收到的包」—— **自动应用**那一步要用的挑选与判断。
 *
 * 为什么要有这个功能：砍掉「同步到本地副本」之后，接收端只剩手动一条路
 * （打开 Obsidian → 选包 → 看报告 → 应用）。文件搬过来了却没人点，两边就不一致 ——
 * 这是包通道唯一的"手感缺口"。补法不是把副本通道请回来，而是：
 *
 * **每 30 秒看一眼同步包文件夹，只有完全不会动到本地已有东西时才自己应用**：
 * - 只认**更新包**（它是链条上的一环，只动它点名的文件）；完整包永远不自动应用 ——
 *   它可能删掉你本机独有的文件；
 * - **按链条顺序接**（0.11 起）：只有"起点正好是本机站的基准点"的那一环才收得下，
 *   别的先搁着等缺的那几环到齐（以前"只看最新那一个"是累积语义的产物，
 *   链条模型下最新的那一环前面还缺着环，强看它只会报"接不上"）；
 * - 要删文件 / 删空目录 / 覆盖本地改动 / 会产生冲突副本 → **一律不自动动手**，
 *   只提示一句，让人自己打开看；
 * - 我自己的导出、已经处理过的包，一律跳过（见 `pickIncoming`）；
 * - 每处理一个包都在状态文件里记一笔（`state.incoming`），所以不会每 30 秒重复提示。
 *
 * 这个文件不 import obsidian：挑选与判断都是纯逻辑，测试能拿临时目录直接跑。
 */

/** 一个"等着处理"的包 */
export interface IncomingCandidate {
	bundle: ManagedBundle;
	bundleId: string;
}

/**
 * 挑出**还没处理过**的包（新的排前面 —— `listBundles` 就是这么排的）。
 *
 * 跳过的四种：
 * - 头部读不出来（不是我们的包 / 传坏了）：界面里列得出来，但自动这条路不碰它；
 * - 我自己的导出 / 已经应用过的（`bundleLog` 里记着的）；
 * - 源头就是我这台机器（`source.copyId` 相同）—— 就算日志被裁掉了也认得出来；
 * - 已经决定过的（`state.incoming` 里有记录）。
 *
 * 完整包**也在候选里**：它不自动应用，但要提示一句（不然用户以为自动那步坏了）。
 */
export function pickIncoming(bundles: ManagedBundle[], state: PluginState): IncomingCandidate[] {
	const decided = new Set((state.incoming ?? []).map(item => item.id));
	const logged = new Set((state.bundleLog ?? []).map(entry => entry.bundleId));
	const out: IncomingCandidate[] = [];
	for (const bundle of bundles) {
		const header = bundle.header;
		if (!header) continue;
		if (decided.has(header.bundleId)) continue;
		if (logged.has(header.bundleId)) continue;
		if (header.source?.copyId === state.copyId) continue;
		out.push({ bundle, bundleId: header.bundleId });
	}
	return out;
}

/** 看一眼同步包文件夹里有没有"给我的新包" */
export async function listIncoming(baseDir: string, stateFile: string): Promise<IncomingCandidate[]> {
	const state = await loadState(stateFile);
	return pickIncoming(await listBundles(baseDir), state);
}

/** 一次自动应用的结果：给界面报账用 */
export type IncomingOutcome =
	/** 包里的东西本地已经有了（没有动作） */
	| { kind: 'already'; file: string }
	/** 自己应用完了 */
	| { kind: 'applied'; file: string; plan: ApplyPlan; written: number; deleted: number; stateIdCompare: string; pending: number }
	/** 会动到本地已有的东西：没自动应用，等用户自己决定 */
	| { kind: 'needs-review'; file: string; why: string }
	/** 试了但失败了 */
	| { kind: 'failed'; file: string; error: string };

/**
 * 处理一个包：算一遍 → 安全就自己应用，不安全就只报一句。
 *
 * 无论走哪条路都会在状态文件里**记一笔**（`rememberIncoming`），
 * 所以同一个包只处理一次 —— 不会每 30 秒弹一遍。
 */
export async function handleIncoming(options: ApplyOptions, candidate: IncomingCandidate): Promise<IncomingOutcome> {
	const file = candidate.bundle.file;
	const name = path.basename(file);
	try {
		// 完整包从来不自动应用：它可能删掉本机独有的文件，只提示一句让人自己看
		if (candidate.bundle.header?.mode !== 'changes') {
			await rememberDecision(options.stateFile, candidate.bundleId, 'needs-review', name);
			return {
				kind: 'needs-review',
				file: name,
				why: '它是完整副本（可能删掉你本机独有的文件），完整包从来不自动应用',
			};
		}

		const plan = await planBundleApply(options);
		const report = plan.report;

		// 包里没有新东西（本地已经一致）：记一笔，不打扰
		if (plan.actions.length === 0 && plan.foldersToRemove.length === 0) {
			await rememberDecision(options.stateFile, candidate.bundleId, 'already', name);
			return { kind: 'already', file: name };
		}

		if (isDestructivePlan(plan)) {
			const parts: string[] = [];
			if (report.deletes > 0) parts.push(`删 ${report.deletes} 个文件`);
			if (plan.foldersToRemove.length > 0) parts.push(`删 ${plan.foldersToRemove.length} 个空文件夹`);
			if (report.conflicts > 0) parts.push(`${report.conflicts} 处两边都改过`);
			if (report.forcedOverwrites > 0) parts.push(`覆盖 ${report.forcedOverwrites} 处本地改动`);
			const why = parts.length > 0 ? parts.join('、') : '会动到本地已有的东西';
			await rememberDecision(options.stateFile, candidate.bundleId, 'needs-review', name);
			return { kind: 'needs-review', file: name, why };
		}

		const result = await executeBundlePlan(plan, options);
		await rememberDecision(options.stateFile, candidate.bundleId, 'applied', name);
		return {
			kind: 'applied',
			file: name,
			plan,
			written: result.written,
			deleted: result.deleted,
			stateIdCompare: result.stateIdCompare,
			pending: (report.pendingChanges ?? 0) + (report.pendingDeletes ?? 0),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await rememberDecision(options.stateFile, candidate.bundleId, 'failed', name);
		return { kind: 'failed', file: name, error: message };
	}
}

/** 记下"这个包我处理过了"（重新读一遍状态，别把 apply 刚写的东西盖掉） */
async function rememberDecision(
	stateFile: string,
	bundleId: string,
	note: string,
	file: string,
): Promise<void> {
	try {
		const state = await loadState(stateFile);
		rememberIncoming(state, { id: bundleId, at: Date.now(), note, file });
		await saveState(stateFile, state);
	} catch {
		// 记不下只是"下次可能再提示一遍"，不该让已经成功的应用看起来失败
	}
}

/** 一次"看一眼收到的包"的结果：给界面报账用 */
export interface IncomingSweep {
	/** 自己按顺序接下来了的（链条上的那几环） */
	applied: { file: string; written: number; deleted: number; stateIdCompare: string; pending: number }[];
	/** 要人看的：会动本机东西 / 是完整副本 / 试了失败（理由照旧） */
	review: { file: string; why: string; kind: 'needs-review' | 'failed'; full: boolean }[];
	/** 链条没接上、先搁着的：本机站在前面某一环上，缺中间那几环 */
	waiting: string[];
}

/**
 * **按链条顺序**把能接上的包依次应用（0.11 起的链条模型）。
 *
 * 为什么不再"只看最新那一个"：那是"更新包自完整副本累积"那套语义的产物 ——
 * 每份包都含全部改动，所以看最新那个就够了。改成链条之后，每份包只装**自上一环以来的改动**，
 * 最新那一环是从上一环的落点往外延伸的：本机没走到上一环，收它只会得到"接不上"。
 * 正确的做法是从本机站的那一点往后一环一环接，缺环就停在那儿等它到齐。
 *
 * 安全边界不变（在 `handleIncoming` 里）：只自动应用不会动本机已有东西的更新包；
 * 碰上"要删文件 / 要覆盖本地改动"的那一环就停下并报一句 —— 后面的环自然也就搁着。
 */
export async function sweepIncoming(
	optionsFor: (file: string) => ApplyOptions,
	stateFile: string,
	candidates: IncomingCandidate[],
): Promise<IncomingSweep> {
	const sweep: IncomingSweep = { applied: [], review: [], waiting: [] };
	const pending = [...candidates];

	// 完整副本：从来不自动应用（它可能删掉本机独有的文件）—— 照旧报一句、记一笔，不在链条里
	for (const item of [...pending]) {
		if (item.bundle.header?.mode !== 'full') continue;
		pending.splice(pending.indexOf(item), 1);
		const outcome = await handleIncoming(optionsFor(item.bundle.file), item);
		if (outcome.kind !== 'applied' && outcome.kind !== 'already') {
			sweep.review.push({
				file: outcome.file,
				why: outcome.kind === 'needs-review' ? outcome.why : outcome.error,
				kind: outcome.kind === 'needs-review' ? 'needs-review' : 'failed',
				full: true,
			});
		}
	}

	/** 本机现在站的基准点：只有"起点正好是它"的那一环收得下 */
	let cursor = (await loadState(stateFile)).bundle?.fullHash ?? null;

	// 兜底上限：正常链条就几环，卡住时别把这一拍拖住
	for (let guard = 0; guard < 64 && pending.length > 0; guard++) {
		const index = pending.findIndex(item => {
			const header = item.bundle.header;
			return header?.mode === 'changes' && baselineOfBundle(header) === cursor;
		});
		if (index < 0) break; // 没有接得上的了（缺环，或者剩下的都是别的基准）
		const [candidate] = pending.splice(index, 1);
		if (!candidate) break;
		const outcome = await handleIncoming(optionsFor(candidate.bundle.file), candidate);
		if (outcome.kind === 'applied') {
			sweep.applied.push({
				file: outcome.file,
				written: outcome.written,
				deleted: outcome.deleted,
				stateIdCompare: outcome.stateIdCompare,
				pending: outcome.pending,
			});
			// 接着往下接：本机现在站到它送到的那一点上了
			cursor = (await loadState(stateFile)).bundle?.fullHash ?? cursor;
			continue;
		}
		if (outcome.kind === 'already') {
			cursor = candidate.bundle.header?.targetBaselineHash ?? cursor;
			continue;
		}
		sweep.review.push({
			file: outcome.file,
			why: outcome.kind === 'needs-review' ? outcome.why : outcome.error,
			kind: outcome.kind === 'needs-review' ? 'needs-review' : 'failed',
			full: false,
		});
	}

	// 剩下的：起点不是本机这一点（缺中间那几环）—— 不记账、不动它，等缺的环到了再看
	for (const item of pending) sweep.waiting.push(path.basename(item.bundle.file));
	return sweep;
}
