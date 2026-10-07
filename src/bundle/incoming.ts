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
 * - 只认**更新包 / 差量包**（它们只动点名的文件）；完整包永远不自动应用 ——
 *   它可能删掉你本机独有的文件；
 * - **按基准收**（0.14 起）：只有"起点正好是本机站的那一份完整副本"的包才收得下；
 *   同一份基准上同一个源头只取**最新**那一份（更新包是累积的，先应用旧的就等于往回退一格），
 *   别的源头的各自都要应用（那是各自那一半改动）；
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
	/** 自己接下来了的（起点正好是本机站的那一份完整副本） */
	applied: { file: string; written: number; deleted: number; stateIdCompare: string; pending: number }[];
	/** 要人看的：会动本机东西 / 是完整副本 / 试了失败（理由照旧） */
	review: { file: string; why: string; kind: 'needs-review' | 'failed'; full: boolean }[];
	/** 起点不是本机站的那一份完整副本、先搁着的（等对方按本机这份基准重导，或者补一份完整副本） */
	waiting: string[];
}

/**
 * **按基准**把能接上的包依次应用（0.14 起；从前是"按链条一环一环接"）。
 *
 * 判据只有一条：**包的起点 ＝ 本机现在站的那一份完整副本**（`checkAncestor` 那条硬规矩）。
 * 一趟里可能接上好几份，两种情况：
 *
 * - **差量包**（送到另一份完整副本）：应用完基准就前进到它终点那份 → 接着看下一段；
 * - **更新包**（送到"最新状态"）：应用完**基准不动** —— 所以不能"应用一份就换下一个基准"，
 *   也不能在同一份基准上反复挑（同一个源头先后导的几份里，只有**最新**那一份有用，
 *   先应用旧的就等于把内容往回退一格）。
 *
 * 于是规则是：**同一份基准上，按源头分组，每个源头只取终点世代最大的那一份**；
 * 剩下的同源旧包记一笔"不用管"（它们的内容确实过时了）。不同源头的各自都要应用 ——
 * 那装的是各自那一半改动，漏一份就丢数据。
 *
 * 安全边界不变（在 `handleIncoming` 里）：只自动应用不会动本机已有东西的更新包；
 * 碰上"要删文件 / 要覆盖本地改动"的那一份就停下报一句（其余照旧搁着）。
 */
export async function sweepIncoming(
	optionsFor: (file: string) => ApplyOptions,
	stateFile: string,
	candidates: IncomingCandidate[],
): Promise<IncomingSweep> {
	const sweep: IncomingSweep = { applied: [], review: [], waiting: [] };
	const pending = [...candidates];

	// 完整副本：从来不自动应用（它可能删掉本机独有的文件）—— 照旧报一句、记一笔，不在自动那条线上
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

	/** 本机现在站的基准：只有"起点正好是它"的包收得下 */
	let cursor = (await loadState(stateFile)).bundle?.fullHash ?? null;
	/** 同一个源头里，哪一份是"最新"的那一份（其余同源旧包这一趟就作废） */
	const sourceOf = (item: IncomingCandidate): string => item.bundle.header?.source?.copyId ?? item.bundleId;
	const generationOf = (item: IncomingCandidate): number => item.bundle.header?.targetGeneration ?? 0;

	// 兜底上限：正常一趟就几份，卡住时别把这一拍拖住
	for (let guard = 0; guard < 64 && pending.length > 0; guard++) {
		const mine = pending.filter(item => item.bundle.header?.mode === 'changes'
			&& baselineOfBundle(item.bundle.header) === cursor);
		if (mine.length === 0) break; // 没有接得上的了（缺那一份完整副本，或者剩下的都是别的基准）

		const newest = new Map<string, IncomingCandidate>();
		for (const item of mine) {
			const held = newest.get(sourceOf(item));
			if (!held || generationOf(item) >= generationOf(held)) newest.set(sourceOf(item), item);
		}
		// 先应用世代小的那一份（内容往后走），多个源头时顺序稳定
		const chosen = [...newest.values()].sort((a, b) => generationOf(a) - generationOf(b))[0];
		if (!chosen) break;
		pending.splice(pending.indexOf(chosen), 1);

		/**
		 * 同一个源头、被它取代的那几份：**记一笔"不用管"就不再回头看了**。
		 * 不记的话每 30 秒都会重新挑到它们（基准没变，它们看着还是"接得上"），
		 * 而它们的内容确实过时了 —— 更新的那一份是累积差量，把旧的说的全说了。
		 */
		for (const item of mine) {
			if (item === chosen) continue;
			// 别的源头的"最新那一份"：留着，下一轮接着应用（那是另一台机器那一半改动）
			if (newest.get(sourceOf(item)) === item) continue;
			pending.splice(pending.indexOf(item), 1);
			await rememberDecision(stateFile, item.bundleId, 'already', path.basename(item.bundle.file));
		}

		const outcome = await handleIncoming(optionsFor(chosen.bundle.file), chosen);
		if (outcome.kind === 'applied') {
			sweep.applied.push({
				file: outcome.file,
				written: outcome.written,
				deleted: outcome.deleted,
				stateIdCompare: outcome.stateIdCompare,
				pending: outcome.pending,
			});
			// 差量包会把基准推到它终点那份完整副本上；更新包不动基准（那就接着挑别的源头）
			cursor = (await loadState(stateFile)).bundle?.fullHash ?? cursor;
			continue;
		}
		if (outcome.kind === 'already') {
			cursor = (await loadState(stateFile)).bundle?.fullHash ?? cursor;
			continue;
		}
		sweep.review.push({
			file: outcome.file,
			why: outcome.kind === 'needs-review' ? outcome.why : outcome.error,
			kind: outcome.kind === 'needs-review' ? 'needs-review' : 'failed',
			full: false,
		});
	}

	// 剩下的：起点不是本机站的这一份完整副本（缺那份包，或者它已经被更新的取代了）—— 不动它
	for (const item of pending) sweep.waiting.push(path.basename(item.bundle.file));
	return sweep;
}
