import path from 'node:path';
import { executeBundlePlan, isDestructivePlan, planBundleApply } from './apply';
import type { ApplyOptions, ApplyPlan } from './apply';
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
 * - 只认**更新包**（自完整副本累积的改动，只动它点名的文件）；
 *   完整包永远不自动应用 —— 它可能删掉你本机独有的文件；
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

/**
 * 比"最新那个"旧的、还没处理过的包：记成一笔"被取代了"就走。
 *
 * 为什么可以跳过：**更新包是累积的**（自完整副本以来的全部改动），完整包更是完整清单 ——
 * 任何更新的包都包含旧包的全部内容。所以每次只看最新那一个既省事又不会漏东西；
 * 反过来说，如果哪天格式变了（不再累积），这条规矩就得跟着改。
 */
export async function skipSuperseded(stateFile: string, candidates: IncomingCandidate[]): Promise<void> {
	if (candidates.length === 0) return;
	try {
		const state = await loadState(stateFile);
		for (const item of candidates) {
			rememberIncoming(state, {
				id: item.bundleId,
				at: Date.now(),
				note: 'superseded',
				file: path.basename(item.bundle.file),
			});
		}
		await saveState(stateFile, state);
	} catch {
		// 同上：记不下不影响正确性，只是下次再看一眼
	}
}
