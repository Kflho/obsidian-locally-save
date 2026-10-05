import fs from 'node:fs';
import path from 'node:path';
import { readBundleInfo, verifyBundle } from './format';
import type { BundleEntry, BundleHeader, BundleInfo } from './format';
import { baselineOfBundle, compareBaseline, listingHashOfFiles } from './baseline';
import type { BaselineMatch } from './baseline';
import { appendBundleLog } from './log';
import { DEFAULT_MTIME_TOLERANCE_MS, dirsContainingFiles, planSync, sameRecord } from '../sync/diff';
import { CONFLICT_TRASH_DIR, dirExists, ensureDir, moveToTrash, pathExists, pickRemovableEmptyDirs, pruneEmptyDirs, removeEmptyDir, scanTree, statFile } from '../sync/disk';
import { VAULT_TRASH_DIR, excludePatterns } from '../sync/vault';
import { loadState, saveState } from '../sync/state';
import type { PluginState, StateIdInfo, StateIdRecord } from '../sync/state';
import { compareStateId, computeStateId } from '../sync/state-id';
import type { StateIdCompare } from '../sync/state-id';
import { formatStamp } from '../utils/format';
import type { Logger } from '../utils/log';
import { byDepthDesc, dirnameRel, toNative } from '../utils/paths';
import { YIELD_EVERY, yieldToUi } from '../utils/async';
import type { PluginSettings } from '../settings/model';
import type { ConflictStrategy, FileRecord, Inventory, SyncAction } from '../sync/types';

/**
 * 应用同步包 —— **先算后做**两步走。
 *
 * `planBundleApply()` 只读不写：把包和本地逐条比一遍，给出报告；接收方看过之后再
 * `executeBundlePlan()` 真正落盘。所以"打开包"这一步是安全的，可以随便点。
 *
 * ## 核心：包就是"对方"，应用完与包严格一致
 *
 * **界面上的手动应用只有一种语义：严格同步**（`strictness: 'mirror'`，见 `APPLY_CHOICES`）——
 * 包里点名的文件一律用包里的版本（本地那份先进回收目录）、`header.deleted` 点名的照删、
 * 本地多出来的文件也挪进回收目录。应用完**仓库 == 包送到的状态**，两边的状态编号当场可比
 * （见 `sync/state-id.ts`）。这是「基准点链条」能成立的前提：链条上的每个点内容都是确定的，
 * 谁也不必猜着合，文件也就不会冲突。
 *
 * **合并那条路（`normal`）仍然在**，交给 `sync/diff.ts` 的三方比对（基准 vs 本地 vs 包）：
 * 本地改过的保留、分歧留两份、本机独有的文件不动。它现在只有两条调用链在用 ——
 * 自动收包（`incoming.ts`）与接链（`chain.ts`）：那两处的边界是"只应用不会动到本地已有东西的包"，
 * 合并语义正好对上（完整副本从来不自动应用）。界面上不再给这个选择。
 *
 * `normal` 档在比对结果之上再修三个细节：
 * 1. 本地这份是**我以前发过的中间版本**（`entry.history`）→ 不是本地改动，直接覆盖；
 * 2. 本地这份**比包还旧**（没有 base 可比时）→ 那是旧副本，直接覆盖；
 * 3. 其余"两边都改过"的，才真的留冲突副本（进回收目录的「冲突」文件夹）。
 *
 * **更新包里"本地有、包里没有"不等于对方删了它**（它只装变过的文件）：删除只认
 * `header.deleted` 点名的清单；只有完整包才是完整清单。严格档下"包里送到的状态"由
 * `baseline`（本机站的基准点）＋ 条目 − 点名删除算出来 —— 那个 `baseline` 之所以可信，
 * 是因为 `checkAncestor` 要求包的起点与本机站的基准点**完全相等**。
 */

const TOLERANCE = DEFAULT_MTIME_TOLERANCE_MS;
const CHUNK = 4 * 1024 * 1024;

/** 本次应用有多"以包为准"（见 ApplyOptions.strictness） */
export type ApplyStrictness = 'normal' | 'listed-wins' | 'bundle-wins' | 'mirror';

/** 下拉框里的一项：怎么算、以及界面上怎么说 */
export interface ApplyChoice {
	key: string;
	label: string;
	strictness: ApplyStrictness;
	/** 本次临时覆盖"两边都改过时听谁的"；只有 `normal` 档会用到（不填 ＝ `keep-both`） */
	conflictStrategy?: ConflictStrategy;
}

/**
 * 「应用方式」的选项 —— **两类包各只剩一项**（0.11 起界面上不再给选择）。
 *
 * **完整副本是镜像**：它就是"另一台机器此刻的完整样子"。合并它会有无穷多种结果
 * （本机改过的算谁的、本机独有的留不留、删除传不传播），每一种都能配出一个
 * "既不等于包、又不等于本机"的仓库 —— 之后导出的更新包 `base` 就对不上，
 * 两台机器开始互相报"基准对不上"。
 *
 * **更新包是严格同步**：它的起点必须与本机站的基准点**完全相等**（`checkAncestor`），
 * 所以"包送到的状态"是确定的 ＝ 我站的那一点 ＋ 条目 − 点名删除。
 * 旧版本担心的"没提到的文件会被当成该删、一次清空仓库"在链条模型下不成立。
 *
 * 表留着是为了让"引擎支持哪几档"有个单一出处（`test/bundle.test.ts` 守着它）；
 * 界面（`ui/bundle-modal.ts`）**不读它**：手动应用一律严格档。
 * 合并那条路（`strictness: 'normal'`）只剩自动收包（`incoming.ts`）与接链（`chain.ts`）在用。
 */
export const APPLY_CHOICES: Record<'full' | 'changes', ApplyChoice[]> = {
	full: [
		{
			key: 'mirror',
			label: '完全镜像（完整副本只有这一种）：包里没有的本地文件全挪进回收目录，仓库 = 包',
			strictness: 'mirror',
		},
	],
	changes: [
		{
			key: 'strict',
			label: '严格同步（更新包只有这一种）：包里点名的文件一律用包里的版本（本地那份先挪进回收目录），'
				+ '点名的删除照删，包里送到的状态里没有的本地文件也挪走 —— 应用完这个仓库就是包里的样子',
			strictness: 'mirror',
		},
	],
};

/** 某一类包默认选哪一档（第一项） */
export function defaultApplyChoice(mode: 'full' | 'changes'): ApplyChoice {
	return APPLY_CHOICES[mode][0] as ApplyChoice;
}

/** 在某一类包的选项里找某一档；找不到（比如换过包的类型）就回到默认档 */
export function findApplyChoice(mode: 'full' | 'changes', key: string): ApplyChoice {
	return APPLY_CHOICES[mode].find(item => item.key === key) ?? defaultApplyChoice(mode);
}

export interface ApplyOptions {
	settings: PluginSettings;
	log: Logger;
	vaultRoot: string;
	stateFile: string;
	/** 要应用的 .lsave 文件 */
	file: string;
	/** 配置目录名（运行时才知道，用户可能改过） */
	configDir?: string;
	/** 本次临时覆盖冲突裁决；只有合并那条路（`strictness: 'normal'`）会用到 */
	conflictStrategy?: ConflictStrategy;
	/**
	 * **本次应用有多"以包为准"**。
	 *
	 * - `mirror`（界面上的手动应用一律用它）：**应用完仓库 == 包送到的状态** ——
	 *   包里点名的用包里的版本（本地那份进回收目录）、`header.deleted` 点名的照删、
	 *   本地多出来的也挪进回收目录。完整副本与更新包走的是同一套语义；
	 * - `normal`（不填时的默认）：走 `planSync` 三方比对 —— 本地改过的保留、分歧留两份、
	 *   我独有的文件不动。**只有自动收包（`incoming.ts`）与接链（`chain.ts`）在用**：
	 *   那条路的边界是"只应用不会动到本地已有东西的包"，合并语义正好对上；
	 * - `listed-wins` / `bundle-wins`：引擎里还留着（测试守着），界面上已经不给选。
	 *
	 * 排除规则命中的东西（配置目录等）都不动。
	 */
	strictness?: ApplyStrictness;
	/** 本次临时覆盖"删不删多余文件"；只有 `normal` 那条路会用到 */
	propagateDeletions?: boolean;
	/**
	 * **强制与包一致**：让本机变成和包一模一样。
	 *
	 * 用在"颠覆性改动"之后（在另一台机器上大删大改、重组了目录）：
	 * - 包里没有的本地文件**全删**（不管基准里有没有 —— 那些"我独有的残留"也会被清掉）
	 * - 本地改动一律**以包为准**（本地那份进回收目录，不留冲突副本）
	 *
	 * 默认关。排除规则命中的东西（配置目录等）不参与，所以"一致"是指"参与同步的那部分一致"。
	 */
	force?: boolean;
	/**
	 * 被删掉 / 被覆盖的本地版本先进回收目录。
	 *
	 * **严格档（`mirror` / `bundle-wins`）忽略这一项、必然备份**：那几个档会覆盖 / 挪走
	 * 本地已有的东西，"关掉回收 + 严格档" = 不可恢复的批量删除，这个组合不给走。
	 */
	keepBackup?: boolean;
	onProgress?: (done: number, total: number, file: string) => void;
}

/** 应用前的体检报告：接收方靠它判断"这次能同步到什么程度、会动哪些东西" */
export interface ApplyReport {
	/** 走的哪条通道：快速（血脉世代一致）还是逐文件合并 */
	mode: 'fast' | 'merge';
	sameLineage: boolean;
	sameGeneration: boolean;
	/** 包链对不上：对方上次导出的是别人 */
	parentMatches: boolean;
	/** 本地落后几代（正数＝还没应用基准那个完整副本） */
	generationGap: number | null;
	bundle: {
		id: string;
		mode: 'full' | 'changes';
		vault: string;
		created: number;
		entryCount: number;
		deletedCount: number;
		/** 包里带着的空文件夹总数（有文件的目录不算，它们会随文件写入被顺带建出来） */
		emptyDirCount: number;
		payloadBytes: number;
	};
	/** 本次实际采用的冲突裁决（严格档必然是 `remote-wins`：分歧一律听包的） */
	conflictStrategy: ConflictStrategy;
	propagateDeletions: boolean;
	keepBackup: boolean;
	/** 逐条分类 */
	adds: number;
	overwrites: number;
	skips: number;
	conflicts: number;
	/** 本地改过、却被包覆盖掉的数量（"以包为准"或强制一致才会出现） */
	forcedOverwrites: number;
	/** 这次是不是"强制与包一致" */
	forced: boolean;
	/** 本次用的强硬程度 */
	strictness: ApplyStrictness;
	/**
	 * 基准比对的结果（见 `bundle/baseline.ts`）：
	 * - `match`：跟这个包同一份完整副本 → 接着它往后应用是**确定的**；
	 * - `mismatch`：两边的完整副本基准不是同一份（**更新包这时已经被拒收了**，
	 *   见 `checkAncestor`；这个值还会出现在报告与日志里对账用）；
	 * - `unknown`：说不清（包是旧版本导的，或这台机器还没立过基准）。
	 * 光看世代号判不了这件事：它只说"内容走到第几版"，说不出"我们是从哪一份完整副本分出来的"。
	 */
	baselineMatch: BaselineMatch;
	/** 我这边的基准指纹（没有就是 null） */
	myBaseline: string | null;
	/** 这个包说的基准指纹（旧包没有就是 null） */
	bundleBaseline: string | null;
	/**
	 * **差量包要送到的那份完整副本的指纹**（普通更新包 / 旧包没有 → null）。
	 *
	 * 用来认出这种情况：这个包的目的地**正好就是我这边的基准** ——
	 * 那它点名要送的东西我全都有，应用它不会改动任何文件（用户实测遇到过：
	 * 把"第 32 → 36 代"的包发给一台**已经站在第 36 代**上的机器，
	 * 那边只看到一句"基准对不上"，看不出这其实是白跑一趟）。
	 */
	targetBaseline: string | null;
	/** 这个包要送到的地方，就是我现在的基准（＝它对我没有新东西） */
	targetIsMine: boolean;
	/**
	 * **导出方导完那一刻的状态编号**（包里记的，见 `sync/state-id.ts`）。
	 * 应用完接收方算一个自己的跟它比 —— 相同就是"两边文件内容一致"。旧包没有 → null。
	 */
	peerStateId: StateIdInfo | null;
	/** 本地停在"对方发过的中间版本"上、直接覆盖的数量 */
	historyMatches: number;
	/** 要删的本地文件总数 */
	deletes: number;
	/** 其中"包要求删、但本地改过所以保留"的 */
	keptDeletes: number;
	/** 其中"本地有、包里没有、且基准里也有"的（＝对方删过的） */
	extraDeletes: number;
	/**
	 * 严格档（「严格同步」）下"本地多出来、要挪进回收目录"的文件数。
	 *
	 * 它也算在 `deletes` 里（通知里报的总数要对得上），单独拎出来是为了让界面说清楚：
	 * "删 3 个"里有 2 个其实是我自己新建的、包里送到的状态里没有它们。
	 */
	localExtras: number;
	/** 本地与包已经完全一致的条目数 */
	synchronized: number;
	/**
	 * 本机这边**对方还没有**的改动有几个（文件数）。
	 *
	 * 两台机器互相发更新包时，每台只握着改动的一半：收下对方的之后，
	 * 自己这半得导出来发回去，对方才补得齐（用户问过："数据各半，会不会缺"）。
	 * 这个数就是"回礼包"里真正属于我的那部分 —— 包里刚带来的那些不算
	 * （对方本来就有；而且它们已经进了基准点，下一个包不会再带上）。
	 *
	 * `null` ＝ 这台机器还没有基准（没应用过完整副本），算不出来。
	 */
	pendingChanges: number | null;
	/** 同上，但我这边删掉、对方还留着的（回礼包会给它们一份删除清单） */
	pendingDeletes: number | null;
	/** 同步程度：已一致 / 总条目（0–100） */
	syncPercent: number;
	/** 会认出来的移动（改名/挪目录） */
	moves: number;
	/** 这次要在仓库里补建几个文件夹（包里有的目录，本地还没有） */
	foldersToCreate: number;
	/** 这次要删掉几个本地空文件夹（包里没有它） */
	foldersToRemove: number;
	/** 想删却删不掉的本地文件夹：清单里看不到东西、磁盘上还有（被排除规则挡住的文件） */
	foldersKept: number;
	/** 包里一共有多少个文件夹（含空文件夹，以及"有文件的"那些目录） */
	bundleDirCount: number;
	/** 本地仓库现在有多少个文件夹 */
	localDirCount: number;
	/** 两边都有的文件夹数（＝ 已经一致的） */
	foldersInSync: number;
	/**
	 * 这个包是**旧版本**导的（头部没记空文件夹）：这次目录只建不删。
	 * 理由：它没法表达"我这边有哪些空文件夹"，反推"本地多出来的都该删"会删错。
	 */
	bundleDirsUnknown: boolean;
}

/** 一条要落盘的动作（由比对结果翻译而来） */
export type ApplyAction =
	/** 用包里的内容写进这个路径（新增或覆盖）；backup ＝ 先把本地那份挪进回收目录 */
	| { kind: 'write'; path: string; entry: BundleEntry; backup?: boolean }
	/** 删掉本地的这个文件（对方删了它，或强制一致时"包里没有它"） */
	| { kind: 'delete'; path: string }
	/** 两边都改过：留两份，新的占原名 */
	| { kind: 'conflict'; path: string; entry: BundleEntry; winner: 'local' | 'remote' }
	/** 对方改名/挪了位置：本地跟着改名，不重传内容 */
	| { kind: 'rename'; path: string; from: string };

export interface ApplyPlan {
	info: BundleInfo;
	report: ApplyReport;
	actions: ApplyAction[];
	/** 要删掉的本地空文件夹（包里没有它；`mirror` 档会连"本机新建的"一起删） */
	foldersToRemove: string[];
	/**
	 * **应用之前**那一刻的基准点清单（计划时定下：`state.bundle.fullFiles` 当时的样子）。
	 *
	 * 执行阶段照它算新点，**不能再去读状态文件**：计划与执行之间状态可能已经往前走了 ——
	 * 最典型的就是"应用前先把本机改动存成一个包"（`ui/bundle-modal.ts` 的 `parkLocalChanges`），
	 * 那一步导出之后 `fullFiles` 变成"旧点 ＋ 我的改动"。照它算出来的新点就不等于
	 * 包送到的那一点（对方头部 `targetBaselineHash` 报的那个），两边从此对不上 ——
	 * 链条模型下这是硬伤：下一个包会被判"接不上"。
	 */
	pointBefore: Record<string, FileRecord>;
	/** 执行阶段照着做的策略 */
	options: { conflictStrategy: ConflictStrategy; propagateDeletions: boolean; keepBackup: boolean };
}

/**
 * 这次应用会不会"动到本地已经有的东西"：删文件、删空文件夹、覆盖本地改动、产生冲突副本。
 *
 * 谁在问这件事：
 * - 应用对话框 —— 要在动手前多问一句"确定吗"；
 * - 自动应用（`bundle/incoming.ts`）—— **只有不破坏才算"可以自己动手"**，
 *   一旦要删东西就退回去让人自己看。删除是唯一不可逆的动作，不赌。
 */
export function isDestructivePlan(plan: ApplyPlan): boolean {
	return plan.actions.some(action => action.kind === 'delete')
		|| plan.foldersToRemove.length > 0
		|| plan.report.conflicts > 0
		|| plan.report.forcedOverwrites > 0;
}

export interface ApplyResult {
	written: number;
	skipped: number;
	conflicts: number;
	deleted: number;
	moved: number;
	/** 新建的目录（包里记着的空文件夹） */
	foldersCreated: number;
	/** 删空之后顺手收拾掉的空目录 */
	foldersRemoved: number;
	bytesWritten: number;
	failed: { path: string; error: string }[];
	conflictCopies: string[];
	durationMs: number;
	/**
	 * **应用完这一刻我这边**的状态编号（见 `sync/state-id.ts`）——落盘进状态文件，
	 * 更新记录里也记一条。它跟 `plan.report.peerStateId` 一比就见分晓。
	 */
	stateId: StateIdRecord;
	/**
	 * 跟包里那个编号比出来的结论：`match` ＝ **两边文件内容一致**；
	 * `mismatch` ＝ 还有差别（多半是我这边有对方没有的改动，就是那笔"欠回传"）；
	 * `unknown` ＝ 对方那个包没记编号（旧版本导的）。
	 */
	stateIdCompare: StateIdCompare;
}

/** 本地这份是不是"对方发过的中间版本"（跳过了一两个包，手里停在这一版） */
function matchesHistory(local: FileRecord, entry: BundleEntry): boolean {
	return (entry.history ?? []).some(
		record => record.size === local.size && Math.abs(record.mtime - local.mtime) <= TOLERANCE,
	);
}

/** 共同祖先检查的结论 */
type AncestorCheck =
	/** 放行。`first` ＝ 本机第一份（还没有基准）／`full` ＝ 同一条血脉的新完整副本／`update` ＝ 接在同一份基准上的更新包 */
	| { ok: true; kind: 'first' | 'full' | 'update' }
	| { ok: false; message: string };

/**
 * **这个包跟本机有没有共同祖先** —— 没有就不让应用（见 `planBundleApply` 里那段）。
 *
 * 三条规矩，判据都是"我这边站的基准"（`state.bundle.fullHash`，见 `bundle/baseline.ts`）：
 *
 * 1. **本机还没有基准** → 只收**完整副本**（它就是来立基准的），`first`。
 *    更新包一律拒绝：它只有"变过的那部分"，没有起点连算都算不出来。
 * 2. **完整副本** → 放行，`full`。它自带完整清单，就是一份新基准：
 *    对方重新立了基准、导了一份新的完整副本发过来 —— 这是**正路**，不是"没有共同祖先"。
 *    能不能接得上由三方比对逐文件回答（基准检查照样在，本机独有的文件不会被删）。
 * 3. **更新包** → 必须跟本机**同一份**基准（`baselineHash` 相等），否则拒绝。
 *    这条是要害：更新包只有变过的那部分，"基准里有、包里没有"才敢当成"对方删过它"；
 *    基准不是同一份时，本机一大批文件会被当成"对方删过"删掉 —— **那是丢数据的路**。
 *
 * 旧包（那会儿还没记指纹）在更新包这一条上判不出来 → 拒绝，并说清下一步：
 * 让对方用新版本重导一份，或者删掉本机状态文件从零开始（那等于"重新装机"）。
 */
function checkAncestor(state: PluginState, header: BundleHeader): AncestorCheck {
	const mine = state.bundle?.fullHash ?? null;
	// 第一次用（没有基准）：只收完整副本 —— 更新包没有起点，算都算不出来
	if (mine === null) {
		if (header.mode === 'full') return { ok: true, kind: 'first' };
		return {
			ok: false,
			message: '这台机器还没有基准点（没导过、也没应用过完整副本）：更新包是"从某一个基准点往后延伸"的差量，'
				+ '没有起点就没法算。让对方先导一份**完整副本**发过来，应用它之后这台机器才有基准点。',
		};
	}
	// 完整副本：自带完整清单，就是一份新基准 —— 放行（对方重新立基准是正路）
	if (header.mode === 'full') return { ok: true, kind: 'full' };
	const theirs = baselineOfBundle(header);
	if (theirs === null) {
		return {
			ok: false,
			message: '这个更新包是旧版本插件导的（没记基准指纹），跟本机的基准对不上号。'
				+ `本机现在的基准是 ${mine} —— 让对方用新版本插件按这个基准重导一份；`
				+ '要么删掉本机的状态文件重新开始（那等于重新装机，本机会当成第一份完整副本收下）。',
		};
	}
	if (theirs !== mine) {
		// 差量包的特例：**它要送到的地方正好就是我站的基准点** → 放行。
		// 这种情况下包里点名要送的东西我全都有（应用它一个文件都不会改），
		// 而报告里那句 `targetIsMine` 正是给用户看的"白跑一趟，让对方按我的指纹重导"。
		// 拦在这里反而看不出这个结论，只剩一句"基准对不上"。
		if (header.targetBaselineHash !== undefined && header.targetBaselineHash === mine) {
			return { ok: true, kind: 'update' };
		}
		/**
		 * **链条中间断了：拒绝，并把"从哪个基准点开始"指出来。**
		 *
		 * 更新包是从**某一个基准点**往外延伸的差分，"起点里有、包里没提到"不算被删 ——
		 * 可一旦起点跟本机站的不是同一个点，这条前提就没了：本机一大批文件会被当成
		 * "对方删过它们"（用户报过的"删除一万个"）。所以不猜着合。
		 *
		 * 出路按**成功率**排：让对方从本机这一点重导（最省事，前提是对方手里有这个点）；
		 * 把中间缺的那几份包一起发过来按顺序应用（链本身就在文件夹里）；完整副本兜底。
		 */
		const at = state.bundle?.fullGeneration !== null && state.bundle?.fullGeneration !== undefined
			? `（第 ${state.bundle.fullGeneration} 代${state.bundle.fullFile ? ` · 来自 ${state.bundle.fullFile}` : ''}）`
			: '';
		return {
			ok: false,
			message: `**接不上，不合并**：这个更新包从「${theirs}」这个基准点往外延伸，本机站在「${mine}」上${at} —— `
				+ '不是同一个点，插件不猜着合（起点对不上时，本机一大批文件会被当成"对方删过它们"）。\n'
				+ '按顺序往下走，二选一：\n'
				+ `① 让对方**从本机这个基准点重导**一份更新包：导出时把「更新包：从哪个状态」选成`
				+ `「第 ${state.bundle?.fullGeneration ?? '?'} 代 · 基准 ${mine}」；\n`
				+ '② 或者让对方把**中间缺的那几份包**一起发过来，按顺序应用（本机站在链条上某一点，缺的是它后面那几步）。\n'
				+ '都不行就让对方导一份**完整副本**：完整清单自带基准，可以直接应用（但它会镜像覆盖本机内容）。',
		};
	}
	return { ok: true, kind: 'update' };
}

/** 只读地算一遍：包与本地差在哪儿、能同步到什么程度 */
export async function planBundleApply(options: ApplyOptions): Promise<ApplyPlan> {
	const info = await readBundleInfo(options.file);
	const header = info.header;
	const { settings } = options;

	if (settings.bundleVerify) {
		const ok = await verifyBundle(options.file, info);
		if (!ok) throw new Error('同步包校验失败：文件可能在传输中损坏了，请重新拷一份再试');
	}

	const requested = options.strictness ?? 'normal';
	/**
	 * **完整副本一律"完全镜像"**（不合并、不按设置）。
	 *
	 * 为什么把选择权收掉：完整副本是"另一台机器此刻的完整样子"，合并它会有无穷多种结果 ——
	 * 本机改过的算谁的、本机独有的留不留、删除要不要传播，每一种都能配出一个"看起来对、
	 * 实际上两边都不一样"的仓库。仓库一旦既不等于包、又不等于本机，后面导出的更新包
	 * `base` 就对不上，两台机器开始互相报"基准对不上"（用户报过这类乱七八糟的错误）。
	 *
	 * 改成镜像之后语义只有一句：**应用完，这个仓库就是那个包**。
	 * - 本机独有的文件**挪进回收目录**（不是删掉，随时捞得回来）；
	 * - 本机改过的文件被包的版本覆盖（旧的同样进回收目录）；
	 * - 包里没提到的目录也跟着清掉。
	 *
	 * 更新包也是同一套：它的起点必须与本机站的基准点**完全相等**（`checkAncestor`），
	 * 所以"包送到的状态"同样确定 ＝ 我站的那一点 ＋ 条目 − 点名删除；
	 * 不在其中的本地文件（自己新建的、对方删过的）一样挪进回收目录。那边**没有共同祖先就直接拒收**，
	 * 所以也不存在"合出一个乱七八糟的状态"。
	 */
	const mirrorFull = header.mode === 'full';
	/**
	 * **更新包也开放"严格同步"**（0.11 起：完整副本与更新包一样，应用完就是包）。
	 *
	 * 旧版本把更新包上的"以包为准 / 完全镜像"降级成按设置，理由是"包里没提到的文件会被当成该删，
	 * 一次清空仓库"。**那条理由在链条模型下不成立了**：更新包的起点必须与本机站的基准点**完全相等**
	 * （`checkAncestor` 拦在前面），所以"包送到的状态"是确定的 ——
	 * ＝ 我站的那一点 ＋ 包里点名的条目 − 包里点名的删除。镜像它就是"变成那份状态"，不会清空。
	 */
	const strictness: ApplyStrictness = mirrorFull ? 'mirror' : requested;
	/** 严格档：应用完**仓库 == 包送到的状态**（完整副本自带完整清单；更新包按起点清单补全） */
	const strict = strictness === 'mirror' || strictness === 'bundle-wins';
	// 以包为准：分歧一律听包的 —— 直接交给比对引擎的冲突策略，
	// 它同时覆盖了"两边都改"「本地改了对方删了」这些分支
	// 合并那条路（`normal`）只剩自动收包与接链在用（界面上一律走严格档）：
	// "两边都改了怎么办"那个设置项已经删了 —— 这里的默认值就是它的历史默认值。
	const conflictStrategy: ConflictStrategy = strictness === 'normal'
		? (options.conflictStrategy ?? 'keep-both')
		: 'remote-wins';
	// 删除传播与备份只在"合并"那条路上听调用方/设置；严格档必然传播、必然先备份
	const propagateDeletions = strictness === 'normal' ? (options.propagateDeletions ?? true) : true;
	// **应用必然先备份**：严格档会覆盖/挪走本地东西，强制档更可能一次删很多 ——
	// "关掉回收目录 + 严格档" = 不可恢复的批量删除，这个组合不给走
	const keepBackup = strictness !== 'normal' || (options.keepBackup ?? true);

	const state = await loadState(options.stateFile);
	const sameLineage = header.lineage === state.lineage;
	// 更新包是链条上的一环：接收方只要**站在它声明的那一点上**（基准指纹相等）就能收
	const sameGeneration = header.baseGeneration === null
		|| (sameLineage && state.generation >= header.baseGeneration);
	const fastPath = sameGeneration;

	/**
	 * **没有共同祖先就拒绝**（只放行完整副本）。
	 *
	 * - 本机**还没有基准**（第一次用、或刚把状态文件清了）→ 只收**完整副本**：
	 *   它就是来立基准的，而且应用方式固定是镜像（见 `mirrorFull`），不存在"猜着合并"；
	 * - **更新包**必须跟本机**同一份**基准 —— 它只有变过的那部分，
	 *   基准不是同一份的话，本机一大批文件会被当成"对方删过"删掉。拒绝，并说清下一步。
	 */
	const ancestor = checkAncestor(state, header);
	if (!ancestor.ok) throw new Error(ancestor.message);

	// ------------------------------------------------------------ 三方
	const local = await scanTree(options.vaultRoot, {
		exclude: excludePatterns(settings.excludePatterns, options.configDir),
		skipTopLevelDirs: [VAULT_TRASH_DIR],
	});

	// 基准：我上次应用/导出之后的样子；缺的地方用包自己带的 base 补
	// （包说"我以为你原来是这样"，对一台新机器来说这就是它的基准）
	const baseline: Record<string, FileRecord> = { ...(state.bundle?.files ?? {}) };
	/**
	 * 包**自己带的 base 优先**（它比本机那份记录更贴近事实）。
	 *
	 * 为什么不能让本机记录压过它：本机那份记录只是"上一次我这边记下的样子" ——
	 * 对方重新立过基准、或者我这边中间导/应用过别的包时，它对**这个包**来说就是过期的。
	 * 过期的后果很具体：接收方明明停在"对方发过的中间版本"上（包的 `history` 里写着那一版），
	 * 却因为 base 对不上被判成"本地改动"，于是不走 `history` 那条路 ——
	 * 白白留一个冲突副本，甚至拿包里那份盖掉本地（用户报过的"应用完反而多出一堆冲突"）。
	 *
	 * 没有 base 的（完整副本、旧包）不碰本机记录：那种情况下本机的记忆才是唯一的依据。
	 */
	const seed = (path: string, size?: number, mtime?: number) => {
		if (size === undefined || mtime === undefined) return;
		baseline[path] = { size, mtime };
	};
	for (const entry of header.entries) seed(entry.path, entry.baseSize, entry.baseMtime);
	for (const item of header.deleted) seed(item.path, item.baseSize, item.baseMtime);

	// "对方"＝包：完整包是完整清单；更新包只有它提到的那部分（这正是我们要的 ——
	// 没提到的一律当作"与我无关"，绝不推断删除）
	const entriesByPath = new Map(header.entries.map(entry => [entry.path, entry]));
	const remote: Inventory = {
		files: new Map(header.entries.map(entry => [entry.path, { size: entry.size, mtime: entry.mtime }])),
		dirs: new Set(header.emptyDirs ?? []),
	};

	// 完整副本走上面那段镜像逻辑（不比对）；更新包按 `normal` / `listed-wins` 走三方比对 ——
	// `listed-wins` 要的正是"哪些是包里点名的、哪些只是我独有的"
	const planned = strictness === 'normal'
		? planSync(local, remote, baseline, {
			// 包是只读的：借"仅下载"方向只为不产生写回对方的动作，冲突裁决仍听设置
			direction: 'download',
			directionDecidesConflict: false,
			conflictStrategy,
			propagateDeletions,
			mtimeToleranceMs: TOLERANCE,
		})
		// 完整副本与强制档都不走三方比对：目标是"仓库 == 包"，直接两侧比就行
		// （三方比对在"只有本地改了"时会判成"上传"、在这个方向上被过滤掉 —— 那就不叫以包为准了）
		: { actions: [], unchanged: 0, summary: { add: 0, modify: 0, delete: 0, move: 0, conflict: 0 }, moves: 0, folders: [], removedFolders: [] };

	// ------------------------------------------------- 比对结果 → 落地动作
	const actions: ApplyAction[] = [];
	let adds = 0;
	let overwrites = 0;
	let conflicts = 0;
	let forcedOverwrites = 0;
	let historyMatches = 0;
	let deletes = 0;
	let moves = 0;
	/** 本地多出来、这次要删的（对方删过的，或镜像档下我独有的） */
	let extraDeletes = 0;
	/** 严格档下"本地多出来、要挪走"的文件数（见报告里的 `localExtras`） */
	let localExtras = 0;
	const localDeleted = new Set(header.deleted.map(item => item.path));

	// ------------------------------------------- 不走三方比对的两条路
	//
	// **镜像**（完整副本）：规则只有一句 —— 应用完，这个仓库就是那个包。
	//   - 包里点名的文件：本地缺 → 新增；不一致 → 覆盖（本地那份动过的先进回收目录）；
	//   - 包里没提到的本地文件：**全删**（连本机新建的也删）—— 完整副本是完整清单，
	//     "包里没有它"就是它不该在；
	//   - 不搞三方比对、不按设置合并：合并出来的状态既不等于包、也不等于本机，
	//     下一次导出的更新包 `base` 就对不上，两台机器开始互相报"基准对不上"。
	//
	// **严格镜像（更新包的「严格同步」档）**：应用完**仓库 == 包送到的状态** ——
	//   - 包里点名的文件：一律用包里的版本（本地动过的那份先挪进回收目录）；
	//   - `header.deleted` 点名的照删；
	//   - **本地多出来的文件全挪进回收目录**（不在"包送到的状态"里的，一个不留）——
	//     更新包的"送到的状态" ＝ 我站的那一点 ＋ 条目 − 点名删除（起点相等由 checkAncestor 保证）。
	//
	// **`listed-wins`（界面「以包为准」，只给更新包）**：只动**包里点名**的文件 ——
	//   - 条目一律用包里的版本（不管包里那份是新的还是旧的），本地改过的那份进回收目录；
	//   - `header.deleted` 点名的照删；
	//   - **包里没提到的一个不动**（更新包只有变过的那部分，"没提到"什么也不代表）。
	//
	// 两条都不能走三方比对：因为"只有本地改了、包里没改"时三方比分会判成"上传"（本地说了算），
	// 在包的方向上被过滤掉 —— 那就不叫"以包为准"了。
	if (mirrorFull || strict || strictness === 'listed-wins') {
		// ① 包里点名的文件：本地缺 → 新增；不一致 → 覆盖（本地那份动过的先挪进回收目录）
		for (const entry of header.entries) {
			const here = local.files.get(entry.path);
			if (!here) {
				adds++;
				actions.push({ kind: 'write', path: entry.path, entry });
				continue;
			}
			if (here.size === entry.size && Math.abs(here.mtime - entry.mtime) <= TOLERANCE) continue;

			const base = baseline[entry.path];
			const localChanged = base
				? here.size !== base.size || Math.abs(here.mtime - base.mtime) > TOLERANCE
				: false;
			if (localChanged) forcedOverwrites++;
			overwrites++;
			actions.push({
				kind: 'write',
				path: entry.path,
				entry,
				// 本地那份动过的先挪进回收目录 —— 严格档下 `keepBackup` 本来就是 true
				// （见上面那段：强制档必然先备份），绝不让"严格同步"顺手抹掉本地改动
				backup: localChanged && keepBackup,
			});
		}

		// ② 包里**没有**的本地文件
		if (mirrorFull || strict) {
			/**
			 * "包送到的状态"里有哪些文件：
			 * - 完整副本：包自己的完整清单（`entries`）；
			 * - 更新包：**我站的那一点**（`baseline`，起点相等由 `checkAncestor` 保证）
			 *   ＋ 包里点名的条目 − 包里点名的删除。
			 * 不在这个集合里的本地文件（我自己新建的、对方删过的、以及那边压根没有的）
			 * 一律挪进回收目录 —— 这就是"严格同步"的承诺：应用完仓库 == 包。
			 */
			const kept = new Set<string>(mirrorFull ? [] : Object.keys(baseline));
			for (const entry of header.entries) kept.add(entry.path);
			for (const item of header.deleted) kept.delete(item.path);
			for (const file of local.files.keys()) {
				if (kept.has(file)) continue;
				deletes++;
				if (!localDeleted.has(file)) localExtras++;
				// 走 `delete` 动作：开着回收目录时它们都进回收目录，捞得回来
				actions.push({ kind: 'delete', path: file });
			}
		} else {
			// `listed-wins`：只删 `header.deleted` **点名**的那些，其余一个不动
			for (const item of header.deleted) {
				if (!local.files.has(item.path)) continue;
				deletes++;
				actions.push({ kind: 'delete', path: item.path });
			}
		}
	}

	for (const action of planned.actions) {
		const entry = entriesByPath.get(action.path);
		switch (action.kind) {
			case 'download': {
				if (!entry) break;
				const here = local.files.get(action.path);
				if (!here) {
					adds++;
					actions.push({ kind: 'write', path: action.path, entry });
					break;
				}

				// 本地有、且内容与包不同 → 覆盖。本地那份动过没有？
				const base = baseline[action.path];
				const localChanged = base
					? here.size !== base.size || Math.abs(here.mtime - base.mtime) > TOLERANCE
					: false;
				if (localChanged) forcedOverwrites++;
				overwrites++;
				actions.push({
					kind: 'write',
					path: action.path,
					entry,
					// 完整副本镜像时，本地那份动过的要先挪进回收目录（默认档下走到这儿说明它没动过）
					backup: mirrorFull && localChanged && keepBackup,
				});
				break;
			}
			case 'delete-local': {
				// ⚠ **更新包里"没提到"不等于"被删了"**：它只装自起点那一点以来变过的文件，
				// 其余文件在包里根本不出现。要是照着三方比对的结果删，接收方仓库里
				// 每个没被提到的文件都会被判成"对方删过它" —— 一个 1 万文件的仓库、
				// 一个只改了 1 个文件的更新包，会算出"删除 10203 个"（用户报过的 bug）。
				//
				// 所以：更新包只按它**点名**的删除清单（`header.deleted`）删；
				// 只有完整包才是"完整清单"，那时"基准里有、包里没有"确实是对方删过它。
				if (header.mode !== 'full' && !localDeleted.has(action.path)) break;
				deletes++;
				actions.push({ kind: 'delete', path: action.path });
				break;
			}
			case 'rename-local': {
				if (!action.from) break;
				moves++;
				actions.push({ kind: 'rename', path: action.path, from: action.from });
				break;
			}
			case 'conflict': {
				if (!entry) break;
				const here = local.files.get(action.path);
				// 细化：本地停在"我发过的中间版本"→ 不是本地改动，直接覆盖
				if (here && matchesHistory(here, entry)) {
					historyMatches++;
					overwrites++;
					actions.push({ kind: 'write', path: action.path, entry });
					break;
				}
				// 细化：包里没给基准，而本地这份比包还旧 → 那是旧副本，直接覆盖
				const hasBase = entry.baseSize !== undefined;
				if (here && !hasBase && here.mtime <= header.created + TOLERANCE) {
					overwrites++;
					actions.push({ kind: 'write', path: action.path, entry });
					break;
				}
				// 真的两边都改过：留两份
				conflicts++;
				actions.push({
					kind: 'conflict',
					path: action.path,
					entry,
					winner: action.winner ?? 'remote',
				});
				break;
			}
			default:
				// upload / delete-remote / rename-remote：包是只读的，不该出现（出现了也当无事发生）
				break;
		}
	}

	// 完全镜像那档已经在上面一并处理过了（"包里没有的全删"），这里不再补

	// ------------------------------------------------------------ 统计
	let synchronized = 0;
	for (const entry of header.entries) {
		const here = local.files.get(entry.path);
		if (here && here.size === entry.size && Math.abs(here.mtime - entry.mtime) <= TOLERANCE) {
			synchronized++;
		}
	}

	// "包要求删、但本地改过所以保留"的：只统计，不动手（删除是唯一不可逆的动作）
	let keptDeletes = 0;
	// 多余文件重新按最终动作统一次数（镜像那一档在上面先记过一批，这里一并算上）
	extraDeletes = 0;
	for (const action of actions) {
		if (action.kind !== 'delete') continue;
		if (localDeleted.has(action.path)) continue; // 包点名要删的
		extraDeletes++; // 包里没点名、却要删 → "完整包里没有它"（对方删过的，或镜像时的本机独有）
	}

	// ------------------------------------------------- 我这边的"另一半"
	//
	// 两台机器互相发更新包时，每台只握着改动的一半：收下对方这包之后，
	// 我这边的改动得自己导出来发回去（"回礼包"），对方才补得齐。
	// 这里先算清楚"属于我的那部分"有多少，界面上应用前就告诉用户 ——
	// 不然用户只能对着两边都是"各半"的文件夹猜（用户问过：数据会不会缺）。
	const anchor = state.bundle?.fullFiles ?? null;
	let pendingChanges = 0;
	let pendingDeletes = 0;
	/**
	 * 应用**完整副本**时，"我这边对方还没有的"要按**这个包**当基准算，不能按旧基准 ——
	 * 基准马上就要换成它了。
	 *
	 * 算得还特别准：包里的清单与本地一致的有 `synchronized` 个，其余本地文件
	 * （本机改过的、本机独有的）就是"我这一半"。本机删过的那些在包里有、本地没有，
	 * 也算我这一半的删除。
	 *
	 * 前提是**本机有基准**：没有基准时这台机器压根导不出更新包，算这个没有意义。
	 */
	if (anchor && header.mode === 'full' && strictness === 'normal') {
		pendingChanges = local.files.size - synchronized;
		for (const entry of header.entries) {
			if (!local.files.has(entry.path)) pendingDeletes++;
		}
	} else if (anchor) {
		for (const [file, record] of local.files) {
			// 跟基准一模一样 → 不是改动
			const atAnchor = anchor[file];
			if (atAnchor && sameRecord(record, atAnchor, TOLERANCE)) continue;
			// 包里刚带来的那一版也不算"我的"：对方本来就有
			const entry = entriesByPath.get(file);
			if (entry && sameRecord(record, entry, TOLERANCE)) continue;
			pendingChanges++;
		}
		for (const file of Object.keys(anchor)) {
			if (local.files.has(file)) continue;
			// 这个删除是包里点名的（对方删的），不是我这边删的
			if (localDeleted.has(file)) continue;
			pendingDeletes++;
		}
	}
	for (const item of header.deleted) {
		const here = local.files.get(item.path);
		if (!here) continue;
		// 严格档下这些会被删掉，就不算"保留"了
		if (strictness !== 'normal' && strictness !== 'listed-wins') continue;
		const base = baseline[item.path];
		const stillBase = base && here.size === base.size && Math.abs(here.mtime - base.mtime) <= TOLERANCE;
		if (!stillBase) keptDeletes++;
	}

	const total = header.entries.length;

	// ------------------------------------------------- 目录（空文件夹）
	//
	// 包里的目录 = `emptyDirs` ＋ 所有条目的上级目录（后者随文件写入顺带建出来）。
	// 本地有、包里没有的**空**目录要不要删：
	// - **完整副本镜像**：删 —— 它的承诺就是"仓库和包完全一样"（文件如此，目录也该如此）；
	// - 更新包（`normal`）：只删**基准里记过**的（＝对方删过它），本机新建的留着，
	//   还要看「同步删除」开关。
	// 执行时只走 `rmdir`（非空必然失败），所以判断错了也只会"没删掉"，不会连带删掉有内容的目录。
	const bundleDirs = dirsInBundle(header);
	/**
	 * 这个包**记没记**空文件夹。
	 *
	 * 早期版本导的包头部没有 `emptyDirs` 这个字段 —— 它没能力表达"我有这些空文件夹"，
	 * 所以**不能**拿它反推"本地多出来的目录都是对方没有的"：那样完整副本镜像会把本机
	 * 和对方都有的空文件夹也删掉。这种情况下目录只建不删，并在报告里说明白。
	 */
	const bundleRecordsDirs = Array.isArray(header.emptyDirs);
	const foldersToRemove: string[] = [];
	/** 想删却删不掉的：清单里看着是空的，磁盘上还有东西（被排除规则挡住的文件） */
	const foldersKept: string[] = [];
	if (bundleRecordsDirs) {
		const baseDirs = new Set(state.bundle?.dirs ?? []);
		const filled = dirsContainingFiles(local);
		const candidates: string[] = [];
		for (const dir of local.dirs) {
			if (bundleDirs.has(dir)) continue;
			if (filled.has(dir)) continue; // 里面有文件：交给文件规则，别在这里抢着删
			// 完整副本是镜像：包里没有的目录都得清掉（连本机新建的）
			if (mirrorFull) {
				candidates.push(dir);
				continue;
			}
			if (!baseDirs.has(dir)) continue;
			if (strictness === 'normal' && !propagateDeletions) continue;
			candidates.push(dir);
		}
		// 清单说"这个目录下没有文件"，不等于磁盘上真的空：被排除规则挡住的东西
		// （*.lsave、desktop.ini…）在清单里根本看不见，而 rmdir 照样会失败。
		// 所以按**磁盘**问一遍，并且从深到浅累计（父目录要等子目录都能删才算能删）——
		// 不然就是"列着几十个、每轮只删掉十几个"那种查不出的怪现象。
		const picked = await pickRemovableEmptyDirs(options.vaultRoot, candidates);
		foldersToRemove.push(...picked.removable);
		foldersKept.push(...picked.kept);
	}

	const report: ApplyReport = {
		mode: fastPath ? 'fast' : 'merge',
		sameLineage,
		sameGeneration,
		parentMatches: header.parentBundleId === null || header.parentBundleId === state.lastBundleId,
		generationGap: header.baseGeneration === null || !sameLineage
			? null
			: header.baseGeneration - state.generation,
		bundle: {
			id: header.bundleId,
			mode: header.mode,
			vault: header.vault,
			created: header.created,
			entryCount: header.entries.length,
			deletedCount: header.deleted.length,
			emptyDirCount: (header.emptyDirs ?? []).length,
			payloadBytes: header.payloadBytes,
		},
		conflictStrategy,
		propagateDeletions,
		keepBackup,
		strictness,
		baselineMatch: compareBaseline(state.bundle?.fullHash ?? null, header),
		myBaseline: state.bundle?.fullHash ?? null,
		bundleBaseline: baselineOfBundle(header),
		targetBaseline: header.targetBaselineHash ?? null,
		targetIsMine: (header.targetBaselineHash ?? null) !== null
			&& header.targetBaselineHash === state.bundle?.fullHash,
		peerStateId: header.stateId ?? null,
		forced: mirrorFull || strictness !== 'normal',
		adds,
		overwrites,
		skips: synchronized,
		conflicts,
		forcedOverwrites,
		historyMatches,
		deletes,
		keptDeletes,
		extraDeletes,
		localExtras,
		synchronized,
		syncPercent: total === 0 ? 100 : Math.round((synchronized / total) * 100),
		pendingChanges: anchor ? pendingChanges : null,
		pendingDeletes: anchor ? pendingDeletes : null,
		moves,
		// 本地还没有的目录都算"要补建"：有文件的那些会随文件写入顺带建出来，
		// 空文件夹靠执行阶段显式建（`header.emptyDirs`）
		foldersToCreate: [...bundleDirs].filter(dir => !local.dirs.has(dir)).length,
		foldersToRemove: foldersToRemove.length,
		foldersKept: foldersKept.length,
		bundleDirCount: bundleDirs.size,
		localDirCount: local.dirs.size,
		foldersInSync: [...bundleDirs].filter(dir => local.dirs.has(dir)).length,
		bundleDirsUnknown: !bundleRecordsDirs,
	};

	return {
		info,
		report,
		actions,
		foldersToRemove,
		pointBefore: { ...(state.bundle?.fullFiles ?? {}) },
		options: { conflictStrategy, propagateDeletions, keepBackup },
	};
}

/**
 * 包里"有哪些目录"：记着的空文件夹 ＋ 每个条目的上级目录。
 *
 * 后者不必逐个记 —— 它们会随着文件写入被 `ensureDir` 顺带建出来，
 * 但判断"本地这个空目录是不是包里没有"时得能算出来。
 */
function dirsInBundle(header: BundleInfo['header']): Set<string> {
	const dirs = new Set<string>(header.emptyDirs ?? []);
	for (const entry of header.entries) {
		let dir = dirnameRel(entry.path);
		while (dir) {
			if (dirs.has(dir)) break;
			dirs.add(dir);
			dir = dirnameRel(dir);
		}
	}
	return dirs;
}

/** 真正落盘 */
/**
 * 同一时间只允许跑一次应用。
 *
 * 同步那边有 plugin 层的串行锁，应用这边以前没有 —— 两个对话框一起点、或者
 * "应用完顺便同步副本"还没跑完又点一次，两份计划会互相踩着写同一批文件。
 */
let applying = false;

export async function executeBundlePlan(plan: ApplyPlan, options: ApplyOptions): Promise<ApplyResult> {
	if (applying) throw new Error('另一次应用还在进行中：等它跑完再点');
	applying = true;
	try {
		return await runPlan(plan, options);
	} finally {
		applying = false;
	}
}

async function runPlan(plan: ApplyPlan, options: ApplyOptions): Promise<ApplyResult> {
	const started = Date.now();
	const stamp = formatStamp(Date.now());
	const trashRoot = `${options.vaultRoot}/.trash/locally-save`;
	const { keepBackup } = plan.options;
	const result: ApplyResult = {
		written: 0,
		skipped: 0,
		conflicts: 0,
		deleted: 0,
		moved: 0,
		foldersCreated: 0,
		foldersRemoved: 0,
		bytesWritten: 0,
		failed: [],
		conflictCopies: [],
		durationMs: 0,
		// 真正算完再填（在文件、目录都动完之后）—— 这里先占位，类型上要求有
		stateId: { id: '', files: 0, dirs: 0, unverified: 0, at: started },
		stateIdCompare: 'unknown',
	};

	const total = plan.actions.length;
	let done = 0;
	// 只算"包里已经有、本地也一致"的那些（跟报告里的同步程度一致）
	result.skipped = plan.report.skips;

	for (const action of plan.actions) {
		options.onProgress?.(done++, total, action.path);
		try {
			const target = toNative(options.vaultRoot, action.path);

			switch (action.kind) {
				case 'write': {
					// 本地这里是个**文件夹**、包里是个文件（或反过来）：默认档不去动别人的目录，
					// 报成明确失败；强制两档才把目录挪进回收目录腾位置
					if (await dirExists(target)) {
						if (!plan.report.forced) {
							throw new Error('本地这里是同名的文件夹，包里是一个文件：换个位置或先把文件夹挪走（“以包为准/完全镜像”档会自动把它挪进回收目录）');
						}
						await moveToTrash(target, toNative(options.vaultRoot, `.trash/locally-save/${CONFLICT_TRASH_DIR}`), action.path, stamp);
					}
					// 强制模式下覆盖本地改动前，先把本地那份挪进回收目录
					if (action.backup) {
						await moveToTrash(
							target,
							toNative(options.vaultRoot, `.trash/locally-save/${CONFLICT_TRASH_DIR}`),
							action.path,
							stamp,
						);
					}
					await extractEntry(options.file, plan.info, action.entry, target);
					result.written++;
					result.bytesWritten += action.entry.size;
					break;
				}
				case 'delete': {
					/**
					 * 它可能**已经被这次应用里的前一个动作挪走了**：完整副本镜像时，
					 * "本地这里是个同名文件夹、包里是个文件"会让 write 动作把整个文件夹挪进回收目录，
					 * 而计划里同时还有"删掉那个文件夹里的文件"这条（两者说的是同一批东西）。
					 * 源文件已经不在就别再当成失败 —— 它是被**同一个操作**收拾掉的，
					 * 东西在回收目录里好好的（以前这里会多报一条 ENOENT，看着像出错）。
					 */
					if (!plan.report.forced || await pathExists(target)) {
						if (keepBackup) await moveToTrash(target, trashRoot, action.path, stamp);
						else await fs.promises.rm(target, { force: true });
					}
					result.deleted++;
					break;
				}
				case 'rename': {
					const from = toNative(options.vaultRoot, action.from);
					await ensureDir(path.dirname(target));
					try {
						await fs.promises.rename(from, target);
					} catch {
						// 跨盘 / 权限问题：退回"复制 + 删旧的"
						await fs.promises.copyFile(from, target);
						await fs.promises.rm(from, { force: true });
					}
					result.moved++;
					break;
				}
				case 'conflict': {
					// 留两份：新的那份占原名，**输的那份挪进回收目录的「冲突」文件夹**。
					// 不留在原地是因为：留在仓库里的冲突副本会跟着同步传到对面去，两边各滚一份
					const conflictDir = `.trash/locally-save/${CONFLICT_TRASH_DIR}`;
					if (action.winner === 'remote') {
						await moveToTrash(target, toNative(options.vaultRoot, conflictDir), action.path, stamp);
						await extractEntry(options.file, plan.info, action.entry, target);
						result.written++;
						result.bytesWritten += action.entry.size;
					} else {
						// 本地这份更新：原名不动，把包里那份写进冲突文件夹
						await extractEntry(
							options.file,
							plan.info,
							action.entry,
							toNative(options.vaultRoot, `${conflictDir}/${stamp}/${action.path}`),
						);
					}
					result.conflictCopies.push(`${conflictDir}/${stamp}/${action.path}`);
					result.conflicts++;
					break;
				}
			}
		} catch (error) {
			result.failed.push({ path: action.path, error: describe(error) });
		}
		// 长循环里让一步：几百个文件的包应用下来，界面得有机会重绘
		// （否则进度条不动、点什么都没反应，看起来就是"卡死了"）
		if (done > 0 && done % YIELD_EVERY === 0) await yieldToUi();
	}

	options.onProgress?.(done, total, '');

	// 包里记着的**空文件夹**建出来：有文件的目录会随着文件写入被 ensureDir 顺带建出来，
	// 空的没有"顺带"可搭，不建就永远传不过来
	for (const dir of plan.info.header.emptyDirs ?? []) {
		try {
			const abs = toNative(options.vaultRoot, dir);
			// 同名文件挡路：不删不挪（目录 / 文件冲突要不要强推是 normal 与强制档的区别，不是"建目录"这一步说了算）
			if (await statFile(abs)) {
				result.failed.push({ path: dir, error: '要建文件夹的位置是一个同名文件，没有动它' });
				continue;
			}
			await ensureDir(abs);
			result.foldersCreated++;
		} catch (error) {
			result.failed.push({ path: dir, error: describe(error) });
		}
	}

	// 收尾：把"被删空 / 挪空"的目录收拾掉，别留一串空壳
	result.foldersRemoved += await pruneEmptyDirs(options.vaultRoot, [
		...plan.actions.filter(action => action.kind === 'delete').map(action => action.path),
		...plan.actions.flatMap(action => (action.kind === 'rename' && action.from ? [action.from] : [])),
	]);

	// 包里没有的本地空目录（强制档全删、默认档只删"对方删过的"）。
	// 放在文件动作之后：被文件删除腾空的目录这时候才可能真的空。
	// 仍然只走 rmdir —— 非空目录删不动，所以这一批不会碰到有内容的目录。
	// **深的先删**：父目录要等子目录没了才可能是空的（这里再排一次，不依赖上游顺序）
	for (const dir of [...(plan.foldersToRemove ?? [])].sort(byDepthDesc)) {
		if (await removeEmptyDir(toNative(options.vaultRoot, dir))) result.foldersRemoved++;
	}

	// 认祖归宗 + 世代对齐
	const state = await loadState(options.stateFile);
	state.lineage = plan.info.header.lineage;
	/**
	 * **世代 ＝ 内容在这个血脉里的版本号**（不是"我操作过几次"，也不是"我见过哪一段"）。
	 *
	 * 所以：**应用任何包之后，直接采纳包说的那一代**。应用完我的内容就等于那份包，
	 * 状态相同 → 世代必须相同 —— 两边一台一台对下去，同一个内容永远是同一个号，
	 * 这样"两边都报第 46 代"才说明它们确实一样。
	 *
	 * 以前这里是 `Math.max`（"只增不减"），按的是"这份副本见过这条血脉的哪一段"：
	 * 于是同一份内容在两台机器上会报出不同的世代号（一台 46、另一台 50），
	 * 用户看到的就是"状态明明相同、代数却对不上"—— 那个定义已经废掉了，别再请回来。
	 *
	 * 往回走是**允许**的，而且是对的：应用一份更老的完整副本之后，我的内容就是那一刻的内容，
	 * 世代号理当跟着回到那一代，否则它就不再是"内容的版本号"了。
	 * `removeSupersededChanges` 那边也不受影响：更新包只有在"基准世代 ≤ 本机世代"时才收得下，
	 * 所以世代**更高**的更新包一定是更晚的内容，那条"比我新的不删"照样守得住。
	 */
	state.generation = plan.info.header.targetGeneration;
	state.lastBundleId = plan.info.header.bundleId;

	/**
	 * **状态编号**：应用完这一刻整个仓库长什么样的短指纹（见 `sync/state-id.ts`）。
	 *
	 * 必须**重新扫一遍仓库**再算：计划阶段那份清单是动手之前的，写、删、建目录之后就不作数了。
	 * 这一步不报进度（进度只认"包里几个文件"）；指纹大多命中缓存（我们刚按包里的版本写过），
	 * 冷缓存时才真要读一遍仓库 —— 所以循环里按时间让帧。
	 *
	 * 算完与**包里那个编号**一比：相同 ＝ 两边文件内容一致。这就是用户要的那句话 ——
	 * 世代号只说"这是第几版内容"、基准指纹只说"从哪份完整副本分出来的"，
	 * 两者都不回答"此刻两边的文件到底一样吗"，只有把内容算一遍才算数。
	 */
	const inventory = await scanTree(options.vaultRoot, {
		exclude: excludePatterns(options.settings.excludePatterns, options.configDir),
		skipTopLevelDirs: [VAULT_TRASH_DIR],
	});
	const stateIdInfo = await computeStateId({
		vaultRoot: options.vaultRoot,
		state,
		files: inventory.files,
		dirs: inventory.dirs,
	});
	result.stateId = { ...stateIdInfo, at: Date.now() };
	result.stateIdCompare = compareStateId(stateIdInfo, plan.info.header.stateId ?? null);
	state.stateId = result.stateId;

	// 应用**完整包** ＝ 我这边也有了一个新基准（之后可以照着它往外导更新包），
	// 所以中间版本记录重置；应用更新包则保留
	const isFull = plan.info.header.mode === 'full';

	// 基准的正确含义是**"两边上次达成一致的样子"**，所以只能记两边都见过的东西：
	// - 包里有的 → 真的写成了包里的样子才记（冲突没写成的、失败的都不记）
	// - 包里点名删的 → 划掉
	// - 其余（我独有的、对方从没见过的文件）→ **保持原样**，绝不能记进去
	// 以前这里图省事写成"当前仓库的完整清单"，于是把我独有的文件也记进了基准；
	// 下次一应用，它们就成了"基准里有、包里没有" → 被当成"对方删过它"而删掉。
	// （用户的报障：第一次不删、第二次才删。）
	/**
	 * 应用**完整副本**时的新"共同基准"＝**这个包自己的清单里、我这边真的写成了一致**的那些。
	 *
	 * 绝不能拿"我原来的基准"当底（以前的写法是 `{...baseline}`）：我独有的、包里根本
	 * 没有的文件会漏进基准 —— 之后我一导更新包，它们就被当成"我删掉了它们"发给对方。
	 * 用户报过的现场：对方那台机器的**仓库比它的状态旧**（状态还是从另一台机器拷过去的），
	 * 于是它凭空多出一批"我删过它"，要求我们删掉两个本地明明还在的 schedule 文件。
	 *
	 * 从"包自己的清单"出发还有个好处：只拿到一半（有些文件写失败了）时，基准也只包含
	 * 真正拿到的那部分 —— 不会声称"我有"，也就不会把没有的算成"被我删了"。
	 *
	 * 本地这一份跟包里那一版不一致时的处理（冲突里本地那份赢了、或者压根没写成）：
	 * 这个路径**不记进基准** —— 基准是"两边都见过的那一版"，对方手里是包里那一版，
	 * 本机那一份相对基准就是一处改动，下次导更新包会带上它（`base` 由更新包自己说）。
	 */
	/**
	 * 应用**之前**那个基准点的清单（见下面 `nextFullFiles`）。
	 *
	 * **照计划里那份快照算，不读现在的状态**：计划与执行之间可能已经导出过一次
	 * （"应用前先把本机改动存成一个包"），那一步会让状态里的点往前走 ——
	 * 照它算出来的新点就不是包送到的那一点了（见 `ApplyPlan.pointBefore`）。
	 */
	const anchorBefore: Record<string, FileRecord> = { ...plan.pointBefore };
	/** 这次**真的写成了一致**的那些条目（新基准点由它拼出来） */
	const freshAnchor: Record<string, FileRecord> = {};
	for (const entry of plan.info.header.entries) {
		const current = await statFile(toNative(options.vaultRoot, entry.path));
		const agreed = current
			&& current.size === entry.size
			&& Math.abs(current.mtime - entry.mtime) <= TOLERANCE;
		// 这一个路径先按"没成一致"算：一致的话下面再补回来
		delete anchorBefore[entry.path];
		if (!agreed) continue;
		freshAnchor[entry.path] = { size: entry.size, mtime: entry.mtime };
	}
	for (const item of plan.info.header.deleted) {
		delete anchorBefore[item.path];
	}

	// 目录基准同理：只记**两边都见过**的目录（包里点了名的，且这次真的在本地）
	const keepDirs: string[] = [];
	for (const dir of dirsInBundle(plan.info.header)) {
		if (await dirExists(toNative(options.vaultRoot, dir))) keepDirs.push(dir);
	}
	keepDirs.sort();
	/**
	 * **基准点跟着应用往前走**（0.11 起的链条模型）：
	 *
	 * 应用任何包之后，本机站到**这个包送到的那一点**上 —— 完整副本是它自己的清单，
	 * 更新包是"起点那份清单 ＋ 包里写成了一致的条目 − 包里点名的删除"（＝对方导出时站的
	 * 那一点，对方头部 `targetBaselineHash` 报的就是它的指纹）。
	 *
	 * 为什么必须与对方算得一模一样：两边的点对不上，下一个包就会报"基准对不上"，
	 * 而链条本来要的就是"**点与点之间严格镜像、链条上每个节点内容都确定**"——
	 * 谁也不必去猜、去合，文件也就不会冲突。
	 *
	 * 应用是"**确认的**基准点"（`pointConfirmed: true`）：对方导出时手里就是这一点，
	 * 我这边也到了，两边都有。自己导出的那一点只算"可能的"（见 `export.ts`），
	 * 等对方应用、并把这一点报成它的基准时再翻成确认。
	 *
	 * 收益（用户的原话：一台机器常导包、另一台常应用包，两边互相不知道对方在哪）：
	 * 接收方应用完自动站到链条末端，下次它导出的更新包就"从末端往外延伸"（只有新改动），
	 * 回传对方直接收 —— 不必再手动重导一份几百 MB 的完整副本。
	 * 开销：状态文件里的 `fullFiles` 从"只有完整副本时才有"变成"每次都写"
	 * （一万文件约 +0.7–1 MB）；**读盘与 CPU 零额外开销**（复用这次本来就做过的扫描与编号计算）。
	 */
	const nextFullFiles: Record<string, FileRecord> = isFull
		? { ...freshAnchor }
		: { ...anchorBefore, ...freshAnchor };
	state.bundle = {
		lastExport: state.bundle?.lastExport ?? 0,
		// 三方比对的祖先与"我站的那一点"是同一份东西（都是"两边都见过的那一份"）
		files: nextFullFiles,
		fullFiles: nextFullFiles,
		fullGeneration: plan.info.header.targetGeneration,
		// 令牌按新基准点重算：对方下一个包一比就知道我站在哪一点上
		fullHash: listingHashOfFiles(nextFullFiles),
		// 界面上要能说清"我站在哪一点上"：就是刚应用完的这一份包
		fullFile: path.basename(options.file),
		pointConfirmed: true,
		history: isFull ? {} : (state.bundle?.history ?? {}),
		dirs: keepDirs,
	};
	// 记一笔"我收过什么"（界面上的「更新记录」）
	appendBundleLog(state, {
		at: Date.now(),
		direction: 'apply',
		mode: plan.info.header.mode,
		bundleId: plan.info.header.bundleId,
		file: path.basename(options.file),
		vault: plan.info.header.vault,
		base: plan.info.header.baseGeneration,
		target: plan.info.header.targetGeneration,
		entries: plan.info.header.entries.length,
		deleted: plan.info.header.deleted.length,
		stateId: stateIdInfo.id,
	});

	/**
	 * 暂存"欠对方一个回传"，**不立刻生成回礼包**。
	 *
	 * 立刻生成的话：对方收到又会生成一个，两边互相套娃、没完没了（用户报过"无限套娃"）；
	 * 而且那些包里大半是"回声"（刚收到的内容原样发回去），纯属白占地方。
	 * 改正记账：下次导出更新包时一起带上 —— 那一环本来就是"从当前基准点往外延伸"的，
	 * 我这半和对方那半都在里面；导完这笔账就结清（见 export.ts）。
	 */
	const pendingChanges = plan.report.pendingChanges ?? 0;
	const pendingDeletes = plan.report.pendingDeletes ?? 0;
	state.pendingReturn = pendingChanges + pendingDeletes > 0
		? {
			at: Date.now(),
			bundleId: plan.info.header.bundleId,
			file: path.basename(options.file),
			vault: plan.info.header.vault,
			changes: pendingChanges,
			deletes: pendingDeletes,
		}
		: null;
	await saveState(options.stateFile, state);

	result.durationMs = Date.now() - started;
	options.log.debug(
		`应用同步包完成（冲突策略 ${plan.options.conflictStrategy}）：`
		+ `写入 ${result.written}、冲突 ${result.conflicts}、删除 ${result.deleted}、移动 ${result.moved}`,
	);
	return result;
}

/** 一步到位（命令与自动化用）；界面走 plan + execute 两步 */
export async function applyBundle(options: ApplyOptions): Promise<{ plan: ApplyPlan; result: ApplyResult }> {
	const plan = await planBundleApply(options);
	return { plan, result: await executeBundlePlan(plan, options) };
}

/** 把包里某个文件的字节流式写进仓库（不把整个文件读进内存） */
async function extractEntry(file: string, info: BundleInfo, entry: BundleEntry, target: string): Promise<void> {
	await ensureDir(path.dirname(target));
	const source = await fs.promises.open(file, 'r');
	const destination = await fs.promises.open(target, 'w');
	const buffer = Buffer.alloc(CHUNK);
	let read = 0;
	let chunks = 0;
	try {
		while (read < entry.size) {
			const want = Math.min(CHUNK, entry.size - read);
			const { bytesRead } = await source.read(buffer, 0, want, info.payloadOffset + entry.offset + read);
			if (bytesRead <= 0) break;
			await destination.write(buffer, 0, bytesRead);
			read += bytesRead;
			// 单个大文件（几百 MB 的附件）也不能一口气读到黑：中途让出事件循环
			if (++chunks % YIELD_EVERY === 0) await yieldToUi();
		}
		if (read !== entry.size) {
			throw new Error(`${entry.path} 在包里不完整（读出 ${read}/${entry.size} 字节）`);
		}
	} finally {
		await source.close();
		await destination.close();
	}
	// 把修改时间对齐成包里的值：下次比对才会认定"没变过"
	await fs.promises.utimes(target, entry.mtime / 1000, entry.mtime / 1000);
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 供界面复用：把一条比对动作翻成人话 */
export function describeAction(action: ApplyAction): string {
	switch (action.kind) {
		case 'write':
			return '写入';
		case 'delete':
			return '删除';
		case 'conflict':
			return action.winner === 'remote' ? '冲突（以包为准）' : '冲突（以本地为准）';
		case 'rename':
			return '改名';
	}
}

/** 未使用但保留：SyncAction 与 ApplyAction 的对应关系写在 planBundleApply 里 */
export type { SyncAction };
