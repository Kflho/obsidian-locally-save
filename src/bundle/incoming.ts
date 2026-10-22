import path from 'node:path';
import { executeBundlePlan, isDestructivePlan, landsOnTarget, planBundleApply, recoverToBaselineAndApply } from './apply';
import { debugEvent } from '../debugLog';
import type { ApplyOptions, ApplyPlan } from './apply';
import { baselineOfBundle } from './baseline';
import { listBundles } from './manage';
import type { ManagedBundle } from './manage';
import { loadState, rememberIncoming, saveState } from '../sync/state';
import type { IncomingRecord, PluginState } from '../sync/state';

/**
 * 失败的包**自动重试几次**（用户拍板的"持续协同，没问题就别让人管"）。
 *
 * 为什么不只靠手动的「立即同步」：包失败往往是一时的（包还没拷完、对面正在重写、
 * 完整副本临时不在），而记录成 `failed` 之后自动节拍就不再挑它 —— 用户不点，
 * 两边就永远差一截，而且**没有第二个人知道为什么**（283 就是这么卡住的）。
 *
 * 边界（别改成无限重试）：
 * - 最多 `MAX_FAILED_ATTEMPTS` 次，再多就是确定性失败，重试只会刷屏；
 * - 两次之间至少隔 `RETRY_FAILED_AFTER_MS`，否则每 30 秒一次；
 * - 手动「立即同步」不受次数限制（用户明确点了就该再试）；
 * - `dismissed` / `applied` 永远不重挑。
 */
export const MAX_FAILED_ATTEMPTS = 3;
export const RETRY_FAILED_AFTER_MS = 10 * 60 * 1000;

/**
 * 「收到的包」—— **自动应用**那一步要用的挑选与判断。
 *
 * 为什么要有这个功能：砍掉「同步到本地副本」之后，接收端只剩手动一条路
 * （打开 Obsidian → 选包 → 看报告 → 应用）。文件搬过来了却没人点，两边就不一致 ——
 * 这是包通道唯一的"手感缺口"。补法不是把副本通道请回来，而是：
 *
 * **每 30 秒看一眼同步包文件夹，按「方向」决定怎么处理**（策略见 `IncomingPolicy`）：
 * - 默认（没开 git、或 direction 都不是）＝只认**更新包 / 差量包**、只做不会动到本地已有东西的：
 *   要删文件 / 删空目录 / 覆盖本地改动 / 会产生冲突副本 → 一律不动手，只提示一句；
 * - **仅拉**（`download`，只收不发）＝跟对面保持一致：完整副本也收，会删 / 覆盖的也照做，
 *   本机改动进回收目录（`apply.strictness = 'mirror'` ＋ `alignToPeer`）—— 调用方开 `force`；
 * - **双向**（`both`）＝先弹一句确认（`confirm`），确认后才应用；应用完由调用方把本机改动回传。
 * - **按基准收**（0.14 起）：只有"起点正好是本机站的那一份完整副本"的包才收得下；
 *   同一份基准上同一个源头只取**最新**那一份（更新包是累积的，先应用旧的就等于往回退一格），
 *   别的源头的各自都要应用（那是各自那一半改动）；
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

/** `pickIncoming` 的选项 */
export interface PickIncomingOptions {
	/**
	 * 把上次停在「要人看一眼 / 失败了」的包**重新挑出来**（`needs-review` / `failed`）。
	 *
	 * 谁开：**手动的「立即同步」**。用户明确点了同步，就该再试一次 —— 不然一个被拦下的包
	 * 会永远躺在那里：两台机器的代数差着一截（用户报的 108 / 109），点同步却只说"已经最新"。
	 * 自动节拍（每 30 秒）不开：那会每半分钟弹一次同一句。
	 *
	 * `applied`（做完了）与 `dismissed`（用户自己点的取消）**不重挑**：见下面 `pickIncoming` 的说明。
	 */
	retryBlocked?: boolean;
}

/**
 * 挑出**还没处理过**的包（新的排前面 —— `listBundles` 就是这么排的）。
 *
 * 跳过的四种：
 * - 头部读不出来（不是我们的包 / 传坏了）：界面里列得出来，但自动这条路不碰它；
 * - 我自己的导出 / 已经应用过的（`bundleLog` 里记着的）；
 * - 源头就是我这台机器（`source.copyId` 相同）—— 就算日志被裁掉了也认得出来；
 * - 已经决定过的（`state.incoming` 里有记录）—— 只有 `retryBlocked` 时放行那两类
 *   "还没做完"的（`needs-review` / `failed`）。
 *
 * 完整包**也在候选里**：它不自动应用，但要提示一句（不然用户以为自动那步坏了）。
 */
export function pickIncoming(
	bundles: ManagedBundle[],
	state: PluginState,
	options: PickIncomingOptions = {},
): IncomingCandidate[] {
	// 同一个包可能被记过好几笔（先 needs-review、重试后 applied）：**以最后一笔为准**
	const decided = new Map<string, IncomingRecord>();
	for (const item of state.incoming ?? []) decided.set(item.id, item);
	const logged = new Set((state.bundleLog ?? []).map(entry => entry.bundleId));
	const out: IncomingCandidate[] = [];
	for (const bundle of bundles) {
		const header = bundle.header;
		if (!header) continue;
		if (logged.has(header.bundleId)) continue;
		if (header.source?.copyId === state.copyId) continue;
		const record = decided.get(header.bundleId);
		if (record) {
			const manual = options.retryBlocked === true
				&& (record.note === 'needs-review' || record.note === 'failed');
			const autoRetry = record.note === 'failed'
				&& (record.attempts ?? 0) < MAX_FAILED_ATTEMPTS
				&& Date.now() - record.at >= RETRY_FAILED_AFTER_MS;
			if (!manual && !autoRetry) continue;
		}
		out.push({ bundle, bundleId: header.bundleId });
	}
	return out;
}

/**
 * 货架上**看过、但没应用成功**的那些（`needs-review` / `failed`）。
 *
 * 给「立即同步」那句总结用：不能让用户看到"没有新改动"就以为没事 ——
 * 明明还有一份包躺着、两边的状态编号也不一样（用户报的"一台 108、一台 109，
 * 点同步都提示已经最新"）。
 */
export function unappliedIncoming(bundles: ManagedBundle[], state: PluginState): IncomingCandidate[] {
	const decided = new Map<string, string>();
	for (const item of state.incoming ?? []) decided.set(item.id, item.note);
	const logged = new Set((state.bundleLog ?? []).map(entry => entry.bundleId));
	const out: IncomingCandidate[] = [];
	for (const bundle of bundles) {
		const header = bundle.header;
		if (!header || logged.has(header.bundleId)) continue;
		if (header.source?.copyId === state.copyId) continue;
		const note = decided.get(header.bundleId);
		if (note !== 'needs-review' && note !== 'failed') continue;
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
	| {
		kind: 'applied';
		file: string;
		plan: ApplyPlan;
		written: number;
		deleted: number;
		restored: number;
		stateIdCompare: string;
		pending: number;
		/**
		 * 这一份是**强制回退到基准再应用**才落下的（第一遍没对上）。
		 * 「仅拉」的严格相等就是靠它兜底的，界面要如实说一句。
		 */
		recovered?: boolean;
	}
	/** 会动到本地已有的东西：没自动应用，等用户自己决定 */
	| { kind: 'needs-review'; file: string; why: string }
	/** 用户在确认窗里点了取消：记一笔就不再问，也不提示（他刚刚才做过选择） */
	| { kind: 'dismissed'; file: string }
	/** 试了但失败了 */
	| { kind: 'failed'; file: string; error: string };

/**
 * 收包策略：**由「方向」决定**（拼装见 `ui/actions.ts` 的 `incomingPolicy`）。
 *
 * 默认一个都不开 ＝ 老的安全边界（只自动应用不会动本地已有东西的更新包）。
 */
export interface IncomingPolicy {
	/**
	 * 会删文件 / 删空目录 / 覆盖本地改动 / 产生冲突副本时也照做。
	 *
	 * **只有「仅拉」才开**：那台机器的职责就是"变成对面那样"，
	 * 本机被覆盖 / 删掉的东西进回收目录（`strictness: 'mirror'` 必然备份）。
	 * 「双向」不靠它：那边是**逐包确认**（`confirm`）—— 用户点了「应用」就等于
	 * 对这一份放了行，不必再开一个全局的 `force`。
	 */
	force?: boolean;
	/** 完整副本也自动应用（默认不；「仅拉」才开 —— 它可能删掉本机独有的文件） */
	allowFull?: boolean;
	/** 覆盖应用参数（「仅拉」用 `strictness: 'mirror'` ＋ `alignToPeer`：目标 ＝ 对面那一点） */
	apply?: Partial<ApplyOptions>;
	/**
	 * 动手前问一句；返回 false ＝ 这次不应用（`kind: 'dismissed'`）。
	 * 「双向」用它在界面弹确认窗 —— 注意这里是**异步**的，窗口开着时这一轮收包就停在这儿。
	 *
	 * 返回 `'defer'`：现在问不了（窗口不在前台 / 没有可交互的界面）—— 别挂起，
	 * 记 `needs-review`，等用户手动同步时再问。REST / 后台节拍触发时就是这种情形。
	 */
	confirm?: (candidate: IncomingCandidate, plan: ApplyPlan) => Promise<boolean | 'defer'>;
}

/**
 * 处理一个包：算一遍 → 安全就自己应用，不安全就只报一句。
 *
 * 「不安全」只对**没人问过**的那条路成立：默认策略里会删 / 会覆盖的包只记 `needs-review`
 * （老的安全边界，一个字都不能松）。**问过并确认了**（`policy.confirm` 返回 true）就照做 ——
 * 用户已经看过"会删几个、覆盖几个"那份账，再拦一次等于让他白点（见 `handleIncoming` 里那段）。
 *
 * 无论走哪条路都会在状态文件里**记一笔**（`rememberIncoming`），
 * 所以同一个包只处理一次 —— 不会每 30 秒弹一遍（手动「立即同步」会重试 `needs-review` / `failed`）。
 */
export async function handleIncoming(
	options: ApplyOptions,
	candidate: IncomingCandidate,
	policy: IncomingPolicy = {},
): Promise<IncomingOutcome> {
	const file = candidate.bundle.file;
	const name = path.basename(file);
	try {
		// 完整包默认不自动应用：它可能删掉本机独有的文件，只提示一句让人自己看。
		// 「仅拉」是"变成对面那样"，调用方会开 allowFull —— 那不是悄悄删，是用户的明确选择。
		if (candidate.bundle.header?.mode !== 'changes' && !policy.allowFull) {
			await rememberDecision(options.stateFile, candidate.bundleId, 'needs-review', name);
			return {
				kind: 'needs-review',
				file: name,
				why: '完整副本可能会删掉你本机独有的文件，所以不自动应用',
			};
		}

		const applyOptions: ApplyOptions = policy.apply ? { ...options, ...policy.apply } : options;
		/**
		 * **「仅拉」的兜底**：本机被改乱、算不出计划时别直接记成失败 ——
		 * 有基准完整副本 + 这份包，信息就是全的：强制回退到基准，再应用一遍就落。
		 * 用户的原话："不管本机怎么改过，有基准包和对应更新包就一定能成功。"
		 */
		let plan: ApplyPlan;
		try {
			plan = await planBundleApply(applyOptions);
		} catch (error) {
			if (policy.force && candidate.bundle.header?.mode === 'changes') {
				const again = await recoverToBaselineAndApply(applyOptions);
				await rememberDecision(options.stateFile, candidate.bundleId, 'applied', name);
				return {
					kind: 'applied',
					file: name,
					plan: again.plan,
					written: again.result.written,
					deleted: again.result.deleted,
					restored: again.result.restored,
					stateIdCompare: again.result.stateIdCompare,
					pending: (again.plan.report.pendingChanges ?? 0) + (again.plan.report.pendingDeletes ?? 0),
					recovered: true,
				};
			}
			throw error;
		}
		const report = plan.report;

		// 包里没有新东西（本地已经一致）：记一笔，不打扰。
		// **"只有空文件夹要补建"也算有东西**：列出来的空目录也是内容（见 AGENTS），
		// 只按文件动作判"已经有了"会把一份"新建空文件夹"的包直接记成 already、再也不碰它。
		if (plan.actions.length === 0 && plan.foldersToRemove.length === 0 && report.foldersToCreate === 0) {
			await rememberDecision(options.stateFile, candidate.bundleId, 'already', name);
			return { kind: 'already', file: name };
		}

		/**
		 * 「双向」：先问一句。取消就记一笔 dismissed —— 同一个包不再弹第二次
		 * （用户刚刚亲手做过选择，再弹就是烦人；想应用还能从「打开同步包并应用…」手动来）。
		 *
		 * **他点了「应用」＝ 看过这份账了**，下面那条"会删文件就不动手"的兜底**不能再用**：
		 * 那份兜底是给**没人问过**的自动路径准备的。这里是"问过了、用户选了应用"，
		 * 再拦一次等于让他白点一下 —— 而且包被记成 `needs-review`、以后再也不会被挑出来，
		 * 两边就永远差着一代（用户报的"一台 108、一台 109，点同步都提示已经最新"）。
		 */
		let confirmed = false;
		if (policy.confirm) {
			const answer = await policy.confirm(candidate, plan);
			if (answer === 'defer') {
				// 窗口不在前台：确认框没人能点。**不能挂在这里**（syncNow 的锁会一直占着，
				// 后面每次同步都只写一笔 sync.start 就没了，用户看到的就是"命令 204、没反应"）。
				// 记成 needs-review：手动「立即同步」会再挑它、再问一次。
				await rememberDecision(options.stateFile, candidate.bundleId, 'needs-review', name);
				return {
					kind: 'needs-review',
					file: name,
					why: '窗口不在前台，没弹确认框；回到 Obsidian 再同步一次会再问',
				};
			}
			if (!answer) {
				await rememberDecision(options.stateFile, candidate.bundleId, 'dismissed', name);
				return { kind: 'dismissed', file: name };
			}
			confirmed = true;
		}

		if (!policy.force && !confirmed && isDestructivePlan(plan)) {
			const parts: string[] = [];
			if (report.deletes > 0) parts.push(`删 ${report.deletes} 个文件`);
			if (plan.foldersToRemove.length > 0) parts.push(`删 ${plan.foldersToRemove.length} 个空文件夹`);
			if (report.conflicts > 0) parts.push(`${report.conflicts} 处两边都改过`);
			if (report.forcedOverwrites > 0) parts.push(`覆盖 ${report.forcedOverwrites} 处本地改动`);
			if (report.moveReplacements > 0) parts.push(`${report.moveReplacements} 处移动的目标位置已经有东西`);
			const why = parts.length > 0 ? parts.join('、') : '会动到本地已有的东西';
			await rememberDecision(options.stateFile, candidate.bundleId, 'needs-review', name);
			return { kind: 'needs-review', file: name, why };
		}

		let result = await executeBundlePlan(plan, applyOptions);
		/**
		 * **「仅拉」做完了要核对**：这个方向的承诺是"跟对面严格相等"。
		 * 有动作没落地、或者编号对不上（本机被改乱过）→ 强制回退到基准再应用一遍。
		 * 这是"不管本机怎么改过都能成功"的最后一道闸（`recoverToBaselineAndApply`）。
		 */
		let recovered = false;
		const broken = result.failed.length > 0
			|| result.effects?.ok === false
			|| (plan.alignToPeer === true && result.stateIdCompare !== 'match');
		if (policy.force && broken && plan.info.header.mode === 'changes') {
			const again = await recoverToBaselineAndApply(applyOptions);
			plan = again.plan;
			result = again.result;
			recovered = true;
		}
		await rememberDecision(options.stateFile, candidate.bundleId, 'applied', name);
		return {
			kind: 'applied',
			file: name,
			plan,
			written: result.written,
			deleted: result.deleted,
			restored: result.restored,
			stateIdCompare: result.stateIdCompare,
			pending: (plan.report.pendingChanges ?? 0) + (plan.report.pendingDeletes ?? 0),
			...(recovered ? { recovered: true } : {}),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// 日志里带上包头部坐标：只有文件名时，事后对不上是哪一份基准/落点
		const header = candidate.bundle.header;
		debugEvent('incoming.failed', {
			file: name,
			bundleId: candidate.bundleId,
			mode: header?.mode,
			generated: header?.baseGeneration,
			targetGeneration: header?.targetGeneration,
			baselineHash: header?.baselineHash,
			targetBaselineHash: header?.targetBaselineHash,
			peerStateId: header?.stateId?.id,
		}, error);
		await rememberDecision(options.stateFile, candidate.bundleId, 'failed', name, message);
		return { kind: 'failed', file: name, error: message };
	}
}

/** 记下"这个包我处理过了"（重新读一遍状态，别把 apply 刚写的东西盖掉） */
async function rememberDecision(
	stateFile: string,
	bundleId: string,
	note: string,
	file: string,
	error?: string,
): Promise<void> {
	try {
		const state = await loadState(stateFile);
		// 失败次数累加：自动重试的上限看它（成功/别的结论不再累加）
		const previous = (state.incoming ?? []).filter(item => item.id === bundleId).pop();
		const attempts = note === 'failed' ? (previous?.attempts ?? 0) + 1 : previous?.attempts;
		rememberIncoming(state, {
			id: bundleId,
			at: Date.now(),
			note,
			file,
			...(error ? { error: error.slice(0, 500) } : {}),
			...(attempts ? { attempts } : {}),
		});
		await saveState(stateFile, state);
	} catch {
		// 记不下只是"下次可能再提示一遍"，不该让已经成功的应用看起来失败
	}
}

/** 一次"看一眼收到的包"的结果：给界面报账用 */
export interface IncomingSweep {
	/** 自己接下来了的（起点正好是本机站的那一份完整副本） */
	applied: {
		file: string;
		written: number;
		deleted: number;
		restored: number;
		stateIdCompare: string;
		pending: number;
		/** 这一份是靠**强制回退到基准再应用**才落下的 */
		recovered?: boolean;
	}[];
	/** 要人看的：会动本机东西 / 是完整副本 / 试了失败（理由照旧） */
	review: { file: string; why: string; kind: 'needs-review' | 'failed'; full: boolean }[];
	/** 用户在确认窗里取消的（记了一笔就不再问，也不提示） */
	dismissed: string[];
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
 * 每条路的安全边界（在 `handleIncoming` 里）：默认只自动应用不会动本机已有东西的更新包，
 * 碰上"要删文件 / 要覆盖本地改动"的那一份就停下报一句（其余照旧搁着）；
 * 「仅拉」的 `force` 与「双向」的 `confirm` 是**用户按方向明确选的**，不是悄悄放宽。
 */
export async function sweepIncoming(
	optionsFor: (file: string) => ApplyOptions,
	stateFile: string,
	candidates: IncomingCandidate[],
	policy: IncomingPolicy = {},
): Promise<IncomingSweep> {
	const sweep: IncomingSweep = { applied: [], review: [], dismissed: [], waiting: [] };
	const pending = [...candidates];

	// 完整副本：默认不自动应用（它可能删掉本机独有的文件）；「仅拉」开了 allowFull 才收
	for (const item of [...pending]) {
		if (item.bundle.header?.mode !== 'full') continue;
		pending.splice(pending.indexOf(item), 1);
		const outcome = await handleIncoming(optionsFor(item.bundle.file), item, policy);
		if (outcome.kind === 'dismissed') {
			sweep.dismissed.push(outcome.file);
			continue;
		}
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

		const outcome = await handleIncoming(optionsFor(chosen.bundle.file), chosen, policy);
		if (outcome.kind === 'dismissed') {
			sweep.dismissed.push(outcome.file);
			continue;
		}
		if (outcome.kind === 'applied') {
			sweep.applied.push({
				file: outcome.file,
				written: outcome.written,
				deleted: outcome.deleted,
				restored: outcome.restored,
				stateIdCompare: outcome.stateIdCompare,
				pending: outcome.pending,
				...(outcome.recovered ? { recovered: true } : {}),
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

	/**
	 * **起点不是我站的那一份、但落点算出来对得上的包**：也要能自动接。
	 *
	 * 用户报的现场：只拉那台误改了一行，对方（只推）导了一份"从旧完整副本到最新"的恢复包；
	 * 只拉那台的起点已经被它自己导出的完整副本挪走了 —— 按上面的"起点严格相等"永远挑不到它，
	 * 只能手动应用。可这份包的内容是确定的：**我现在的清单 ＋ 条目 − 删除**正好等于它头部报的
	 * 落点指纹（`landsOnTarget`），应用完一定落到那道状态，不会"猜着合"。
	 *
	 * 只处理落点对得上的，最多 16 份（防御坏目录）；同一轮里按目标世代从大到小挑，
	 * 应用一份后状态变了，其余候选下一轮再算 —— 不拿旧计划硬套新状态。
	 */
	for (let guard = 0; guard < 16 && pending.length > 0; guard++) {
		const state = await loadState(stateFile);
		const candidates = pending.filter(item => item.bundle.header?.mode === 'changes'
			&& landsOnTarget(state, item.bundle.header));
		if (candidates.length === 0) break;
		const chosen = candidates.sort((a, b) => generationOf(b) - generationOf(a))[0]!;
		pending.splice(pending.indexOf(chosen), 1);

		const outcome = await handleIncoming(optionsFor(chosen.bundle.file), chosen, policy);
		if (outcome.kind === 'dismissed') {
			sweep.dismissed.push(outcome.file);
			continue;
		}
		if (outcome.kind === 'applied') {
			sweep.applied.push({
				file: outcome.file,
				written: outcome.written,
				deleted: outcome.deleted,
				restored: outcome.restored,
				stateIdCompare: outcome.stateIdCompare,
				pending: outcome.pending,
				...(outcome.recovered ? { recovered: true } : {}),
			});
			continue;
		}
		if (outcome.kind === 'already') continue;
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
