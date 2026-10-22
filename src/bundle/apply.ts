import fs from 'node:fs';
import path from 'node:path';
import { debugEvent } from '../debugLog';
import { readBundleInfo, readBundleInfoSync, verifyBundle } from './format';
import type { BundleEntry, BundleHeader, BundleInfo, BundleMove } from './format';
import { baselineOfBundle, baselineOfFullBundle, compareBaseline, listingHashOfFiles } from './baseline';
import type { BaselineMatch } from './baseline';
import { appendBundleLog } from './log';
import { DEFAULT_MTIME_TOLERANCE_MS, dirsContainingFiles, planSync, sameRecord } from '../sync/diff';
import { CONFLICT_TRASH_DIR, dirExists, ensureDir, moveToTrash, pathExists, pickRemovableEmptyDirs, pruneEmptyDirs, removeEmptyDir, scanTree, statFile } from '../sync/disk';
import { VAULT_TRASH_DIR, excludePatterns } from '../sync/vault';
import { loadState, raiseGeneration, saveState } from '../sync/state';
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
	/**
	 * 同步包文件夹（`settings.bundleDir`）。
	 *
	 * 只给「仅拉/对齐到对面」那条路用：要把本机误改的文件恢复成基准里的版本，
	 * 得找到**起点那份完整副本**（`state.bundle.fullFile`）并读它负载里的旧内容。
	 * 普通互相应用不会读它。
	 */
	bundleDir?: string;
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
	/**
	 * **目标是"对方那一份状态"**：不把本机改动接在包上，而是按"基准 ＋ 包里的条目 − 包点名的删除"
	 * 算出对方那一点，然后严格镜像过去。
	 *
	 * 用在「让我和对面一致」/「让对面和我一致」那种**单向对齐**上（`syncDirection` 的
	 * upload / download）：本机改过的、多出来的文件都会先进回收目录（备份），最后两边**状态编号一致**。
	 * 平时的应用**不要**开它 —— 默认语义是"我的内容 ＋ 对方的改动"，那才是互相应用。
	 */
	alignToPeer?: boolean;
	/**
	 * 这台机器是**「仅拉」**（只收不发）：本机没有"要回传的那一半"。
	 *
	 * 为什么不能只靠 `alignToPeer`：完整副本走的是完全镜像，那条路本来就**不**开 `alignToPeer`
	 * （它用不到"从基准恢复误改"），可「仅拉」的方向对完整副本同样成立 ——
	 * 报告里的 `pendingChanges` / `pendingDeletes` 要记 0，界面才不会说
	 * "你这边还有 N 个改动没发出去"、`state.pendingReturn` 也不会挂一笔永远发不出去的账。
	 * 应用前"把我这一半存成包"那一步同理（`shouldParkLocalChanges`）。
	 */
	receiveOnly?: boolean;
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
	/**
	 * ~~包链对不上：对方上次导出的是别人~~ —— **0.14 起不再用它判"漏了中间那份包"**。
	 *
	 * 头部那个 `parentBundleId` 是"**导出方上一次导出的是哪一份**"，不是"接收方上一次应用的是哪一份"。
	 * 基准点模型里根本没有链条：两台机器都在同一份完整副本上往外长，对方的上一份导出
	 * 跟我上一份应用对不上是常态。拿它比只会误报 —— 用户报的现场：回退到第 112 代完整副本
	 * （内容严格等于 112），再应用一份「112 → 最新」的更新包，却被提示「中间可能还有一份没到」。
	 * 真正该拦的（基准不是同一份）由 `checkAncestor` 拦并指路；"本地停在我发过的中间版本上"
	 * 由条目的 `history` 认（`historyMatches`）。字段留着只为老代码/老包兼容，界面不再据此提示。
	 */
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
	 * **本机站的这一点在这个包的路线上**（头部的 `viaHashes` 里有它）——
	 * 合并相邻更新包之后常见：链条上只剩两端的点，而我站在被吞掉的某一个点上。
	 * 应用它照样直接落到落点（中间那几环不必补），界面上要说清这一点，别只报"基准对不上"。
	 */
	viaMine: boolean;
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
	/**
	 * **本机误改、这次从基准完整副本恢复回去**的文件数（只出现在"对齐到对面"那条路）。
	 *
	 * 只拉不推的机器规则是"跟对面严格相等"：对方包里只装变过的文件，本机在没被点名的
	 * 文件上误改了，正常镜像会把它当成"我这一半"留着 —— 状态编号就永远差一点。
	 * 这一档会从起点那份完整副本里读回原版、把误改挪进回收目录，应用完编号才对得上。
	 */
	restored: number;
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
	/**
	 * 其中"目标位置已经有东西"的移动（严格档会先把那份挪进回收目录的「冲突」再搬）。
	 *
	 * 为什么会发生：更新包是**累积**的，同一条移动会一直带在包里；接收方上次已经搬过、
	 * 后来旧路径又被重新建了出来（改名时旧文件夹留成空壳、用户手建、`emptyDirs` 补建都算）。
	 * 这时"源在 + 目标在"不是冲突，而是**这条移动已经做过**——见 `moveSpecs` 那段。
	 */
	moveReplacements: number;
	/** 这次要在仓库里补建几个文件夹（包里有的目录，本地还没有） */
	foldersToCreate: number;
	/** 这次要删掉几个本地空文件夹（包里没有它） */
	foldersToRemove: number;
	/** 想删却删不掉的本地文件夹：清单里看不到东西、磁盘上还有（被排除规则挡住的文件） */
	foldersKept: number;
	/**
	 * **应用完我站的基准会跟着落到这儿**（见 `ApplyPlan.adoptBaseline`）—— `null` ＝ 基准不动。
	 * 界面上说一句：用户盯着"我站在第几代"这个数，它动了就得让他知道。
	 */
	baselineAdopted: { generation: number; hash: string } | null;
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
	/**
	 * 对方改名/挪了位置：本地跟着改名，不重传内容。
	 *
	 * `replace` ＝ 目标位置已经有东西（多半是**同一份累积包里这条移动早就做过**、
	 * 旧路径又被重新建了出来）。严格档下以包为准：先把目标那份挪进回收目录的「冲突」，
	 * 再把源搬过去 —— 这是"目标已存在"唯一会被自动执行的那条路（见 `moveSpecs` 那段）。
	 */
	| { kind: 'rename'; path: string; from: string; dir?: boolean; replace?: boolean }
	/**
	 * 本机误改、但**这个包没点名**的路径：从起点那份完整副本读回原版。
	 *
	 * 只在"对齐到对面"（只拉不推）时出现。内容和 `write` 一样落盘，区别是内容来自
	 * **另一份包**（`sourceFile` / `sourceInfo`），不是当前这份更新包。
	 */
	| {
		kind: 'restore';
		path: string;
		entry: BundleEntry;
		sourceFile: string;
		sourceInfo: BundleInfo;
	} ;

export interface ApplyPlan {
	info: BundleInfo;
	report: ApplyReport;
	actions: ApplyAction[];
	/** 要删掉的本地空文件夹（包里没有它；`mirror` 档会连"本机新建的"一起删） */
	foldersToRemove: string[];
	/**
	 * **应用之前我这边内容的样子**（计划时定下：`state.bundle.files` 当时的样子）。
	 *
	 * 包里的条目就是**接在它上面**的 —— 严格镜像算"包送到的状态"（`kept`）、
	 * `checkAncestor` 那条"算一遍落点"、以及"应用前先把我这边的改动存成包"
	 * （`parkLocalChangesFor` 的起点），用的都是这一份。
	 *
	 * **不是我站的那份完整副本**（`fullFiles`）：0.14 起两者会不一样 ——
	 * 更新包不推进基准，"我站的那份完整副本"因此会比我的内容旧。拿旧的那一份当底，
	 * 落点整个算错：早先几份更新包带来的那些文件全成了"我这边改过的"。用户报过现场：
	 * 对面明明跟上一代一字不差，应用时却导出一份「第 88 → 89 代」的"我的改动"包。
	 *
	 * 执行阶段照这份快照算，**不能再去读状态文件**：计划与执行之间状态可能已经往前走了 ——
	 * 最典型的就是"应用前先把本机改动存成一个包"，照它算出来的落点就不等于包送到的那一点。
	 */
	contentBefore: Record<string, FileRecord>;
	/**
	 * **计划阶段认定"磁盘上已经搬完"的移动**（源没了、目标在）：`from` → `to` 一条一对。
	 *
	 * 为什么执行阶段还要它：这类移动**没有动作**（不需要再搬），可状态里的记录还停在旧路径。
	 * 不把记录跟着搬过去，下一份累积包还会按旧路径算"点上该有什么"，于是刚搬过去的东西
	 * 又被当成"本地多出来的"挪进回收目录（用户报的「application 里只剩 1111」就是这个）。
	 */
	relocated: { from: string; to: string }[];
	/**
	 * **应用完我就接在这个包的起点上**（它头部报的那一份完整副本）—— `null` ＝ 基准不动。
	 *
	 * 什么时候要动：这个包的起点**不是我站的那一份**（`checkAncestor` 里"算一遍落点对得上"
	 * 那条例外放行的），而我的新内容确实就是"它那份起点 ＋ 这个包"。内容既然是从它长出来的，
	 * 那才是我该站的点 —— 两边这才回到同一份完整副本上，下一次互发的包直接收得下，
	 * 不必每次都靠"算一遍落点"兜着。
	 *
	 * **两道闸**（少一道就会记上一个假点）：
	 * - 头部得写着 `baseFullBundle`：起点**真是一份完整副本**。合成出来的那种不算 ——
	 *   "应用前先把本机改动存成包"那一份的起点是"对方那份包送到的那一点"（一个状态），
	 *   谁手里都没有它的包文件，接上去两边就再也说不清站在哪一份上了；
	 * - 清单是**倒推**出来的（落点里包点名的路径换回它带的 `base` 版本），
	 *   并且要用头部那个 `baselineHash` **验一遍**；验不过（旧包没带 base、有条目没写成）
	 *   就是 `null`，宁可不动。
	 */
	adoptBaseline: { files: Record<string, FileRecord>; generation: number; hash: string } | null;
	/**
	 * 这一趟是不是「对齐到对面」（只拉不推的机器）：应用完**与对方严格相等** ——
	 * 本机在包里没点名的文件上误改的，这次会从基准完整副本恢复，不是留着当"我这一半"。
	 *
	 * 调用方据此决定：应用前**不要**把本机改动存成回传包（那是双向语义）。
	 */
	alignToPeer: boolean;
	/**
	 * **这一趟送到的那一点上有哪些目录**（严格镜像的收尾照它办：那一点上没有的目录都清掉，
	 * 有的一个不少）。空目录也是内容的一部分，所以这份名单必须与那一点完全一致。
	 */
	deliveredDirs: string[];
	/**
	 * **想删却没删掉的目录**（磁盘上不空，多是被排除规则挡住的文件）——
	 * 它们还在，就得记进目录基准；否则下一轮 `hasChanges` 会把它当成"仓库多了个目录"，
	 * 把刚应用完的更新包又导一遍。
	 */
	foldersKept: string[];
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
	return plan.actions.some(action => action.kind === 'delete' || action.kind === 'restore')
		|| plan.foldersToRemove.length > 0
		|| plan.report.conflicts > 0
		|| plan.report.moveReplacements > 0
		|| plan.report.forcedOverwrites > 0;
}

/**
 * 这次应用之前要不要"先把本机改动存成包"（`parkLocalChangesFor`）。
 *
 * 三个条件缺一不可：
 * - **严格档**：只有它会覆盖 / 挪走本机的东西，存一份才有意义；
 * - **不是对齐到对面**：目标就是对方那一点，本机误改会从基准恢复（`restore`），
 *   不是要回传的那一半；
 * - **不是「仅拉」**：只收不发的机器一个包都不写。完整副本走完全镜像、`alignToPeer`
 *   本来就是 false —— 光靠它拦不住，用户报的现场是"回退到第 112 代完整副本，
 *   只同步了一下，却冒出一个包被 git 推了上去"。
 */
export function shouldParkLocalChanges(plan: ApplyPlan, receiveOnly: boolean): boolean {
	const strict = plan.report.strictness === 'mirror' || plan.report.strictness === 'bundle-wins';
	return strict && !plan.alignToPeer && !receiveOnly;
}

export interface ApplyResult {
	written: number;
	skipped: number;
	conflicts: number;
	deleted: number;
	moved: number;
	/** 从基准完整副本恢复回去的本机误改文件数（只拉不推那条路） */
	restored: number;
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
	/**
	 * **这一趟"动手的路径"到底落成了没有**（`collectApplyProblems` 逐条核对）：
	 * 写 / 改名 / 删 / 补建的空文件夹。`ok === false` 表示计划说会到位的没到位 ——
	 * 调用方据此走 `recoverToBaselineAndApply`（强制回退到基准再应用一遍）。
	 *
	 * **本地多出来的文件不算问题**：那是"我这一半"，本来就该由下一次导出带回去。
	 */
	effects?: { ok: boolean; problems: string[] };
	/**
	 * **应用完对不上 → 强制回退到基准再应用**那一步的结论（没走这条兜底就是 undefined）。
	 *
	 * 用户要的兜底：有基准包 + 更新包，信息就是全的，"不管怎么样都能成功"。
	 * `matched` 为 false 说明连兜底都没对上（那种情况要看 `problems` / `failed`）。
	 */
	recovered?: {
		baselineFile: string;
		baselineGeneration: number | null;
		matched: boolean;
	};
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
	| { ok: true; kind: 'first' | 'full' | 'update'; viaLanding?: boolean }
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
/**
 * **"算一遍落点"对不对**：我现在的清单 ＋ 这个包的条目 − 点名的删除，
 * 算出来的指纹等于包头部报的 `targetBaselineHash` → 应用完正好落到对方那一点。
 *
 * 同一个判据两处用：`checkAncestor`（应用前放行）与 `incoming.ts`（自动收包时，
 * 起点不是我站的那一份、但落点对得上的恢复包也要能接）。**只读、只看头部与状态记录**，
 * 不扫仓库 —— 自动收包每 30 秒都要跑，不能因为一个候选就扫一遍整库。
 * 有 `moves` 的包这里算不出移动（与 `checkAncestor` 的口径一致）：恢复包用 `noMoves` 导，
 * 避免带着移动来走这条路。
 */
export function landsOnTarget(state: PluginState, header: BundleHeader): boolean {
	if (header.mode !== 'changes' || header.targetBaselineHash === undefined) return false;
	const landed: Record<string, FileRecord> = { ...(state.bundle?.files ?? {}) };
	for (const entry of header.entries) landed[entry.path] = { size: entry.size, mtime: entry.mtime };
	for (const item of header.deleted) delete landed[item.path];
	return listingHashOfFiles(landed) === header.targetBaselineHash;
}

function checkAncestor(state: PluginState, header: BundleHeader): AncestorCheck {
	const mine = state.bundle?.fullHash ?? null;
	// 第一次用（没有基准）：只收完整副本 —— 更新包没有起点，算都算不出来
	if (mine === null) {
		if (header.mode === 'full') return { ok: true, kind: 'first' };
		return {
			ok: false,
			message: '这台机器还没有基准点（没导过、也没应用过完整副本）。'
				+ '更新包只装"从某一个基准点往后变过的部分"，没有起点就算不出来。'
				+ '让对方先导一份完整副本发过来，应用它之后这台机器才有基准点。',
		};
	}
	// 完整副本：自带完整清单，就是一份新基准 —— 放行（对方重新立基准是正路）
	if (header.mode === 'full') return { ok: true, kind: 'full' };
	const theirs = baselineOfBundle(header);
	if (theirs === null) {
		return {
			ok: false,
			message: '这个更新包是旧版本插件导的（没记基准信息），跟本机的基准对不上号。'
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
		 * **包覆盖了本机站的这一点 → 放行**（用户拍板的规则："覆盖对方基准点的任意更新包都是可加载的"）。
		 *
		 * 什么时候会出现：合并相邻更新包之后（`bundle/merge.ts`），链条上只剩两端的点，
		 * 而对方还站在被吞掉的某一个点上（他上次收到的就是那一环）。那个点在**这个包的路线上**
		 * 时（头部 `viaHashes`），包里装的就是"从他这一点往后所有变过的文件"：
		 * - 路线上相邻两点之间"没变过"的文件，在他的点上与他手里的版本一致，不在包里（也不用动）；
		 * - "变过"的都在包里，而且装的是**落点那一版** —— 写完就正好落到落点。
		 * 所以这种情况下严格镜像照样成立，不必让他先补中间那几环。
		 *
		 * **兄弟不算覆盖**：同一个起点导出的两份不同落点的包，谁也不在谁的路线上（`viaHashes`
		 * 是沿落点来路算出来的），照旧拒收。
		 */
		if ((header.viaHashes ?? []).includes(mine)) {
			return { ok: true, kind: 'update' };
		}
		/**
		 * **算一遍"应用完我会落到哪一点"，跟包里报的落点比一比。**
		 *
		 * 怎么算：我这边现在的样子 ＋ 包里的条目 − 包里点名的删除 —— 这就是接收方应用完真正会落到的
		 * 那一份清单（严格镜像就是这么算的，见执行阶段那个 `nextFullFiles`）。它等于包头部报的
		 * `targetBaselineHash`，就说明**应用完正好落到对方那一点**：跟落点不一样的那些路径全在包里，
		 * 一样的一条没动。那跟"起点严格相等"是一回事，收下它是确定的。
		 *
		 * 用 `files`（我这边现在的样子）而不是 `fullFiles`（我站的那份完整包）：0.14 起两者会不一样 ——
		 * 我可能应用过对方从同一份完整包导出的上一份更新包，内容已经往前走了，
		 * 而严格档算"送到什么状态"用的正是 `files` 那一份（见上面 `baseline` 那段）。两边要一致。
		 *
		 * 为什么光有 `viaHashes` 还不够（用户实测）：**中间隔了一份完整副本**之后，
		 * 旧的那些环会被那份完整副本清掉（`removeSupersededChanges`：完整清单取代老环），
		 * 于是"沿来路认点"就认不出对方站在哪 —— 而内容上他确实在路线上，算一遍就能证明。
		 * （0.14 起新包不再写 `viaHashes` 了，这一条判据是主力。）
		 */
		if (landsOnTarget(state, header)) {
			return { ok: true, kind: 'update', viaLanding: true };
		}
		/**
		 * **链条中间断了：拒绝，并把"该从哪一份完整副本开始"指出来。**
		 *
		 * 更新包是从**某一份完整副本**往外延伸的累积差分，"起点里有、包里没提到"不算被删 ——
		 * 可一旦起点跟本机站的不是同一份，这条前提就没了：本机一大批文件会被当成
		 * "对方删过它们"（用户报过的"删除一万个"）。所以不猜着合。
		 */
		const at = state.bundle?.fullGeneration !== null && state.bundle?.fullGeneration !== undefined
			? `（第 ${state.bundle.fullGeneration} 代${state.bundle.fullFile ? ` · 来自 ${state.bundle.fullFile}` : ''}）`
			: '';
		return {
			ok: false,
			message: `接不上，不合并：这个更新包是从「${theirs}」这份完整副本往外算的，本机站在「${mine}」上${at}。`
				+ '不是同一份基准，插件不猜着合（基准不是同一份时，本机一批文件会被当成“对方删过它们”）。\n'
				+ '二选一：\n'
				+ `① 让对方按本机这份基准重导一份更新包：导出时把「更新包：从哪个状态开始」选成`
				+ `「第 ${state.bundle?.fullGeneration ?? '?'} 代 · 基准 ${mine}」（那份完整副本得在对方的包目录里）；\n`
				+ '② 或者让对方直接导一份完整副本发过来：完整清单自带基准，谁都能应用'
				+ '（代价是它按镜像覆盖本机内容，本机独有的文件会进回收目录）。',
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
	 * 一次清空仓库"。**那条理由不成立了**：更新包的起点必须与本机站的**那一份完整副本完全相等**
	 * （`checkAncestor` 拦在前面），所以"包送到的状态"是确定的 ——
	 * ＝ 我站的那一份完整副本 ＋ 包里点名的条目 − 包里点名的删除。镜像它就是"变成那份状态"，不会清空。
	 */
	const strictness: ApplyStrictness = mirrorFull ? 'mirror' : requested;
	/** 严格档：应用完**仓库 == 包送到的状态**（完整副本自带完整清单；更新包按起点清单补全） */
	const strict = strictness === 'mirror' || strictness === 'bundle-wins';
	/**
	 * **对齐到对面**（只拉不推）：目标是"对方那一点"，不是"我的内容 ＋ 对方的改动"。
	 * 只跟严格档一起用 —— 合并档没有"严格相等"这回事，也就无从恢复。
	 */
	const alignToPeer = options.alignToPeer === true && !mirrorFull && strictness === 'mirror';
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
	// 更新包是从**某一份完整副本**往外算的：接收方只要站在那份上（基准指纹相等）就能收
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
	//
	// **对齐到对面（只拉）也用这一份**，不能用"我站的那份完整副本"（`fullFiles`）：
	// 更新包是累积的 —— 我可能已经应用过同一份基准上的上一份更新包，内容早就往前走了，
	// 而 `fullFiles` 停在那份完整副本上。拿它当底，上几份包带来的东西（尤其是**移动过去的**
	// 那些文件：包里只有一条 `move`，不带内容）会被当成"我这边多出来的"挪进回收目录，
	// 下一次再报"跟对方还差一点"。`fullFiles` 只在"恢复本机误改"那一步当**原版参考**用。
	const baseline: Record<string, FileRecord> = {
		...(state.bundle?.files ?? {}),
	};
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
	/** 目标位置已经有东西的移动：严格档先把它挪进回收目录的「冲突」再搬 */
	let moveReplacements = 0;
	/** 本地多出来、这次要删的（对方删过的，或镜像档下我独有的） */
	let extraDeletes = 0;
	/** 严格档下"本地多出来、要挪走"的文件数（见报告里的 `localExtras`） */
	let localExtras = 0;
	const localDeleted = new Set(header.deleted.map(item => item.path));

	/**
	 * **我站的那一份完整副本**（`state.bundle.fullFiles`）—— 只在两处当"原版参考"：
	 * 只拉那台恢复本机误改（`restore`），以及移动自愈（记录被旧版本弄丢时认出"这还是起点的树"）。
	 * 别拿它当"我这边内容的样子"（见下面 `contentBefore`）。
	 */
	const anchor = state.bundle?.fullFiles ?? null;
	/**
	 * **我这边内容的样子**（`state.bundle.files`）＝ 上次跟对方交换之后两边的样子。
	 *
	 * 它才是"包里的条目接在哪儿"的答案（见 `ApplyPlan.contentBefore` 那段）：
	 * "我自基准以来改了什么""我这边对方还没有的改动"都得跟**它**比，不能跟我站的那份
	 * 完整副本比 —— 更新包不推进基准，那份完整副本会比我的内容旧，早先几份更新包
	 * 带来的文件会被整片当成"我改过的"（用户报过的"对面明明一致、却导出我的改动包"）。
	 *
	 * 这条记录**可能被旧版本写坏过**（改名失败却把记录划掉了），所以只能当"线索"，
	 * 不能当"仓库里到底有什么"的判决书 —— 后者一律以磁盘扫描为准（`local.files`）。
	 */
	const contentBefore: Record<string, FileRecord> = {
		/**
		 * **一律用"我这边内容的样子"**（`state.bundle.files`），包括「对齐到对面」（只拉）：
		 * 更新包是累积的，同一份基准上的上一份包带来的东西已经在我这份记录里；
		 * 拿"我站的那份完整副本"顶替会把它整片当成"我这边改过的 / 多出来的" ——
		 * 移动过去的文件尤其明显：包里只有一条 `move`、不带内容，记录一换就被删掉，
		 * 下一轮再报"目标已经存在 / 跟对方还差一点"（真机复现过）。
		 *
		 * 只拉那台真正要额外做的是**恢复本机误改**（下面 `restore` 那一段）：
		 * 目标点 ＝ 这份记录 ＋ 包里的条目 − 点名删除，对不上基准的部分从完整副本恢复。
		 */
		...(state.bundle?.files ?? {}),
	};
	/**
	 * **这个包送到的那一点上该有哪些文件**（"落点"）。
	 *
	 * 严格镜像的删除收尾、以及移动"点上的记录跟着搬过去"，都以**它**为准 ——
	 * 不能以"我上次记下的样子"（`contentBefore`）或"我站的那份完整副本"为准：
	 * - `contentBefore` 会过时 / 被写坏：本机手工把文件夹改过名、或者旧版本改名失败
	 *   却把记录划掉了，它就少掉一批文件；照它判，这些文件会被当成"本地多出来的"删掉
	 *   （用户报的「application 里只剩 1111」）；
	 * - 完整副本更旧（更新包不推进基准），拿它判会把累积包带来的东西整片当成"本机独有"。
	 *
	 * 算法与 `checkAncestor` 的"算一遍落点"、`startPointOf` 的倒推是同一份：
	 * 完整副本 ＝ 它自己的清单；更新包 ＝ 我这边内容的样子 ＋ 条目 − 点名删除。
	 * 移动会把这个集合里的路径从旧前缀换到新前缀（见 `moveSpecs` 那段）。
	 */
	const deliveredFiles: Record<string, FileRecord> = header.mode === 'full'
		// 完整副本自带完整清单：应用完仓库就是它，不接在本地清单上
		? Object.fromEntries(header.entries.map(entry => [entry.path, { size: entry.size, mtime: entry.mtime }]))
		: { ...contentBefore };
	if (header.mode !== 'full') {
		for (const entry of header.entries) deliveredFiles[entry.path] = { size: entry.size, mtime: entry.mtime };
		for (const item of header.deleted) delete deliveredFiles[item.path];
	}

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
			/**
			 * "本地动过没有"：跟**我站的那份完整包**比。停在我自己发过的某一版上**不算**本地改动 ——
			 * 新模型下这是常态（对方站在同一份完整包上，我多半刚应用过他上一份更新包，
			 * 那些文件相对这份完整包当然"变过"）。判据就是条目带的 `history`（见 `export.ts`），
			 * 不认它的话每应用一份累积包都会把对方自己发来的东西当成本地改动备份一遍。
			 */
			const localChanged = base
				? (here.size !== base.size || Math.abs(here.mtime - base.mtime) > TOLERANCE)
					&& !matchesHistory(here, entry)
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
		if (!mirrorFull && !strict) {
			// `listed-wins`：只删 `header.deleted` **点名**的那些，其余一个不动
			for (const item of header.deleted) {
				if (!local.files.has(item.path)) continue;
				deletes++;
				actions.push({ kind: 'delete', path: item.path });
			}
		}
		// 严格镜像那一批**推迟到移动算完之后**再删：判据是"**送到的点上**有没有它"，
		// 而移动会把路径换掉 —— 先删就会把刚搬过去 / 早就手工搬好的东西当成
		// "本地多出来的"挪进回收目录（用户报的「application 里只剩 1111」，见下面那段）。
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
	// 多余文件按最终动作统一次数（严格镜像的删除收尾在移动算完之后才跑 —— 见下面那段，
	// 所以这里不能再减一遍；`extraDeletes` 在收尾之后统一算）

	// ------------------------------------------------- 我这边的"另一半"
	//
	// 两台机器互相发更新包时，每台只握着改动的一半：收下对方这包之后，
	// 我这边的改动得自己导出来发回去（"回礼包"），对方才补得齐。
	// 这里先算清楚"属于我的那部分"有多少，界面上应用前就告诉用户 ——
	// 不然用户只能对着两边都是"各半"的文件夹猜（用户问过：数据会不会缺）。
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
	 * **判断里不能带 `strictness`**（踩过）：这里原来是 `&& strictness === 'normal'`，
	 * 界面改成"应用永远走严格档"之后就永远进不来了 —— 于是退回下面那条按**旧基准**算的分支：
	 * 完整副本要删掉的"我这点上有、它那份里没有"的文件（本地没动过、跟旧基准一模一样）
	 * 一个都不算，`pendingChanges` 可能是 0 → **不触发"先把我的改动存成包"** →
	 * 一条 `cp` 就把它们镜像走了（只进回收目录，没有包）。用户报的"没看到改动的包"就是这个。
	 *
	 * 前提是**本机有基准**：没有基准时这台机器导不出更新包，只提示一句（界面那边负责说）。
	 */
	if (anchor && header.mode === 'full') {
		pendingChanges = local.files.size - synchronized;
		for (const entry of header.entries) {
			if (!local.files.has(entry.path)) pendingDeletes++;
		}
	} else if (anchor) {
		for (const [file, record] of local.files) {
			// 跟"我上次交换完的样子"一模一样 → 不是我改的
			const at = contentBefore[file];
			if (at && sameRecord(record, at, TOLERANCE)) continue;
			// 包里刚带来的那一版也不算"我的"：对方本来就有
			const entry = entriesByPath.get(file);
			if (entry && sameRecord(record, entry, TOLERANCE)) continue;
			pendingChanges++;
		}
		for (const file of Object.keys(contentBefore)) {
			if (local.files.has(file)) continue;
			// 这个删除是包里点名的（对方删的），不是我这边删的
			if (localDeleted.has(file)) continue;
			pendingDeletes++;
		}
	}
	/**
	 * 对齐到对面时**没有"我这一半"要回传**：本机跟目标不一样的改动，这一趟要么被包覆盖、
	 * 要么从基准恢复（下面的 `restore`）—— 它们不是要发给对方的东西。
	 *
	 * **「仅拉」的完整副本也一样**（它走完全镜像，`alignToPeer` 是 false）：那个方向
	 * 本来就不写包，报告里再写"你这边还有 N 个改动没发出去"只会让人以为漏发了，
	 * `state.pendingReturn` 也会挂一笔永远发不出去的账（用户报的：回退某份完整副本之后
	 * 只同步了一下，却冒出一个要上传的包）。
	 */
	if (alignToPeer || options.receiveOnly === true) {
		pendingChanges = 0;
		pendingDeletes = 0;
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
	/**
	 * **这一趟送到的那一点上有哪些目录**（镜像的收尾就照它办）。
	 *
	 * 空目录也是内容的一部分，所以"哪些目录该在"只能由**那一点**说了算：
	 * - 包里的空文件夹（导出方的全部空文件夹，不是增量）＋ 条目的上级目录；
	 * - 那一点上**还留着的文件**的上级目录 —— 那些文件自基准以来没动过、不在包条目的名单里，
	 *   但它们的目录同样是那一点的内容（本地也就有）。
	 * - 被点名的删除要划掉：它的目录要是空了、导出方也没留着，那这一点上就没有它了。
	 *
	 * 底稿是**这个包送到的那一点**（`deliveredFiles`，上面已经算好：我这边内容的样子
	 * ＋ 条目 − 点名删除，移动会把路径换过去），不是"我站的那份完整副本" ——
	 * 同一件事只能有一份算法（跟 `checkAncestor` 那条"算一遍落点"、严格档的删除收尾对齐），
	 * 否则早先几份更新包带来的文件会从"这一点"上凭空消失、它们的目录会被当成多余的去删。
	 */

	/**
	 * **移动/改名操作**（包版本 2）：包里没有这些文件的内容，接收方直接改名。
	 *
	 * 硬前提：源文件必须还在、且与我记录的版本一致（`size + mtime`），目标不能已存在。
	 * 缺一条就**整包拒绝**（不是跳过这一条）—— 包里没有内容，硬做只会落一个错误的状态。
	 * 自动收包那条路会把它当成"要人看"，不会动手。
	 */
	const moveActions: ApplyAction[] = [];
	/** 这一趟被 replace 的移动目标（那份旧的被挪进回收目录了）：它们底下的条目必须重写一遍 */
	const replacedTargets: { path: string; dir: boolean }[] = [];
	/**
	 * 这一趟**已经在磁盘上做完**的移动（源没了 / 目标里已经有同一份）：执行阶段照它把
	 * 状态里的记录从旧路径挪到新路径。不这么做，下一份累积包仍按旧路径算"点上有什么"，
	 * 刚搬过去的东西又会被当成"本地多出来的"删掉。
	 */
	const relocations: { from: string; to: string }[] = [];
	const caseOnly = (a: string, b: string): boolean => a !== b && a.toLowerCase() === b.toLowerCase();
	const moveSpecs = header.moves ?? [];
	/**
	 * **把这一趟的移动先"演"一遍**（只改这份影子清单，不碰磁盘）。
	 *
	 * 为什么不能只看扫描快照：累积更新包里，链式移动是**两条**操作（旧 → 中间、中间 → 新）。
	 * 接收方可能还站在**基准**上（手里只有"旧"）—— 第一条把它搬到"中间"之后，第二条的源
	 * 在扫描快照里根本不存在，会被判成"两个路径都不在"而整包拒绝。
	 * 用户报的现场：对面站在 100 代基准上，打不开「…/electronic/… 改名成 …/theory/electronic/…」那个包。
	 * 影子清单让"前面那条移动搬过去的东西"能被后面的移动看见（执行阶段本来就按顺序做）。
	 */
	const plannedFiles = new Map(local.files);
	/** 这一趟的移动**送到**的路径：后面拿它区分"本地原来就有"和"刚才搬过来的" */
	const movedTo = new Set<string>();
	/**
	 * 点上**可以跟着移动走**的路径：我这边内容记录里的（`contentBefore`），
	 * 加上前面几跳搬过来的。目录移动靠它把"落点"里的旧路径换成新路径；
	 * 条目路径不在这里 —— 条目说的是"对方现在这个位置上的文件"，不该被搬走。
	 */
	const movable = new Set<string>(Object.keys(contentBefore));
	for (let moveIndex = 0; moveIndex < moveSpecs.length; moveIndex++) {
		const move = moveSpecs[moveIndex]!;
		/** 后面的移动会不会接着把目标送到（链式改名：旧 → 中间 → 最终） */
		const laterReaches = moveSpecs.slice(moveIndex + 1).some(next =>
			next.to === move.to
			|| next.to.startsWith(`${move.to}/`)
			|| move.to.startsWith(`${next.to}/`)
			|| next.from === move.to
			|| next.from.startsWith(`${move.to}/`)
			|| move.to.startsWith(`${next.from}/`));
		const fromAbs = toNative(options.vaultRoot, move.from);
		const toAbs = toNative(options.vaultRoot, move.to);
		if (move.from === move.to || move.to.startsWith(`${move.from}/`)) {
			throw new Error(`包里的移动操作不合法：${move.from} → ${move.to}`);
		}
		/**
		 * 磁盘上这份是不是包里那条移动记着的版本（导出端对文件移动会带 `size` / `mtime`）。
		 * 用来区分"源还是要搬的那一份"与"旧路径后来又被建了一个新的"。
		 */
		const sameMoveRecord = (record: FileRecord, spec: BundleMove): boolean => spec.size !== undefined
			&& record.size === spec.size
			&& (spec.mtime === undefined || Math.abs(record.mtime - spec.mtime) <= TOLERANCE);

		if (move.kind === 'file') {
			const disk = plannedFiles.get(move.from);
			const targetRecord = plannedFiles.get(move.to);
			// 这一份是**累积**更新包：同一条移动可能早在上一份包里就做过了。
			// 源没了、目标在 → 当成"已经搬过"，不重复做，也不报错。
			// 但**状态里的记录得跟着走**（`relocations`）：否则下一份累积包按旧路径算
			// "点上有什么"，目标那边的东西又会被当成"本地多出来的"删掉。
			if (!disk && targetRecord) {
				if (deliveredFiles[move.from]) delete deliveredFiles[move.from];
				deliveredFiles[move.to] = { size: targetRecord.size, mtime: targetRecord.mtime };
				if (movable.delete(move.from)) movable.add(move.to);
				if (contentBefore[move.from]) relocations.push({ from: move.from, to: move.to });
				continue;
			}
			// 源和目标都没有：可能后面还有一条"上一份状态 → 现在"的链式移动接着搬（见导出端）；
			// 没有的话就是真对不上（漏了包 / 本地删过），报出来，别悄悄落一个不完整的状态。
			if (!disk && !targetRecord) {
				if (laterReaches) continue;
				throw new Error(
					`包里要把 ${move.from} 改名成 ${move.to}，但本地两个路径都不在。`
					+ '更新包只带改名、不带内容，补不了缺的文件。先确认这个路径去哪了'
					+ '（被删掉或挪走了？回收目录里找找），或者把'
					+ `「第 ${header.baseGeneration ?? '?'} 代」那份完整副本`
					+ '重新应用一遍，让本机回到基准，再应用这个包；'
					+ '再不行就让对方导一份完整副本（或一份带这个文件内容的包）',
				);
			}
			if (!disk) throw new Error(`包里要把 ${move.from} 改名成 ${move.to}，但本地没有源文件：让对方重发一份带内容的包`);
			const base = contentBefore[move.from];
			/**
			 * **链式移动的第二跳**：源是这一趟前面那条移动刚搬过来的（不在扫描快照里、
			 * 在影子清单里）。`contentBefore` 记的是更早那个路径、没有这一版 ——
			 * 拿包自己带的 `size` / `mtime` 核对（导出端记的就是源该有的那一版）。
			 */
			const producedHere = !local.files.has(move.from) && movedTo.has(move.from);
			/** 磁盘上这份就是包里记着的那一版（文件移动带 `size` / `mtime`） */
			const sameAsMove = sameMoveRecord(disk, move);
			const caseRename = caseOnly(move.from, move.to);
			const targetTaken = !caseRename && await pathExists(toAbs);
			/**
			 * **源不是我记录里的那一份**、也不像包记录的版本 → 这个路径是后来新建的
			 * （累积包里同一条移动会一直带着，接收方早搬过、又在旧名字下写了新东西）。
			 * - 目标已经在 → 这条移动早做完了：跳过（新内容是条目 / 完整包的事）；
			 * - 目标也不在 → 搬不了：包里只有一条改名、没有内容，说不清该把谁搬过去。
			 */
			if (!base && !producedHere && !sameAsMove) {
				if (targetTaken) {
					// 只补目标那份的记录（源可能是条目带来的新内容，别从 deliveredFiles 里划掉）
					if (targetRecord) deliveredFiles[move.to] = { size: targetRecord.size, mtime: targetRecord.mtime };
					continue;
				}
				throw new Error(
					`包里要把 ${move.from} 改名成 ${move.to}，但本地这个路径不是包里记着的那一份`
					+ '（后来新建过），目标也不在。更新包只带改名、不带内容：'
					+ '先把本机恢复到基准（重新应用那份完整副本）再应用，或让对方发一份完整副本',
				);
			}
			if (base && !sameRecord(disk, base, TOLERANCE)) {
				throw new Error(`包里要把 ${move.from} 改名成 ${move.to}，但本地这份源文件已经改过：先处理冲突，或让对方重发带内容的包`);
			}
			if (move.size !== undefined && !sameAsMove) {
				throw new Error(`包里要把 ${move.from} 改名成 ${move.to}，但本地源文件与包记录的版本不一致`);
			}
			// 这一趟**别的**移动刚送到的目标（同一个目标两条移动）：包里自相矛盾，拒绝
			if (movedTo.has(move.to) && !local.files.has(move.to)) {
				throw new Error(`包里要把 ${move.from} 改名成 ${move.to}，但本地目标已经存在：先把它挪走`);
			}
			/**
			 * **源和目标同时在，不一定是冲突**：累积更新包里同一条移动会一直带着，
			 * 接收方上一份包里已经搬过、旧路径后来又新建了（用户报的
			 * 「改名之后又在旧名字下写了一篇新笔记」）。上面的"源不是记录里那一份"
			 * 已经跳过了新建的源；走到这里说明源就是要搬的那一份，目标真占着 →
			 * 严格档以包为准：把目标那份挪进回收目录的「冲突」再搬；合并档拒绝。
			 */
			let replace = false;
			if (targetTaken) {
				if (!strict) {
					throw new Error(`包里要把 ${move.from} 改名成 ${move.to}，但本地目标已经存在：先把它挪走`);
				}
				replace = true;
				moveReplacements++;
				replacedTargets.push({ path: move.to, dir: false });
			}
			const record = deliveredFiles[move.from];
			if (record) {
				delete deliveredFiles[move.from];
				deliveredFiles[move.to] = record;
			}
			if (movable.delete(move.from)) movable.add(move.to);
			plannedFiles.delete(move.from);
			plannedFiles.set(move.to, { size: disk.size, mtime: disk.mtime });
			movedTo.add(move.to);
			moveActions.push({
				kind: 'rename',
				path: move.to,
				from: move.from,
				...(replace ? { replace: true } : {}),
			});
			moves++;
			continue;
		}

		// 目录移动：源整棵树没被本地改过 —— 目标不存在时整棵改名；目标在时按文件并进去
		if (move.from === '' || move.to === '') throw new Error('包里的目录移动操作缺少路径');
		const fromPrefix = `${move.from}/`;
		const toPrefix = `${move.to}/`;
		/**
		 * 源 / 目标都以**影子清单**为准（见上面 `plannedFiles` 那段）：链式目录移动的第二跳，
		 * 源是前面那一条刚搬过来的，磁盘上还不在 —— 只看磁盘同样会误报"两个路径都不在"。
		 */
		const sourceUnder = [...plannedFiles.keys()].filter(file => file.startsWith(fromPrefix)).sort();
		const targetUnder = [...plannedFiles.keys()].filter(file => file.startsWith(toPrefix));
		const sourceDir = sourceUnder.length > 0 || await dirExists(fromAbs);
		const targetIsDir = await dirExists(toAbs);
		/** 目标位置站着的是个**同名文件**（不是文件夹）：要腾开只能替换它 */
		const targetIsFile = !targetIsDir && await pathExists(toAbs);
		const targetDir = targetUnder.length > 0 || targetIsDir || targetIsFile;
		const caseRename = caseOnly(move.from, move.to);
		/**
		 * **点上的记录跟着移动走**（旧前缀 → 新前缀）。
		 *
		 * 只搬"我这边内容记录里的路径"（`movable`：`contentBefore` 的路径，以及前面几跳搬过来的），
		 * **不碰条目**：条目说的是"对方现在这个位置上的文件"（改名之后又在旧名字下建的新笔记
		 * 就是这样），它的路径不是"被移动过的路径"。
		 */
		const relocatedHere: string[] = [];
		const relocatePoint = (): void => {
			for (const file of [...movable]) {
				if (!file.startsWith(fromPrefix)) continue;
				if (entriesByPath.has(file)) continue;
				const toPath = toPrefix + file.slice(fromPrefix.length);
				const record = deliveredFiles[file];
				if (record) {
					delete deliveredFiles[file];
					deliveredFiles[toPath] = record;
					relocatedHere.push(toPath);
					relocations.push({ from: file, to: toPath });
				}
				movable.delete(file);
				movable.add(toPath);
			}
		};
		/**
		 * **移动包里没有内容**（`move` 只带路径）：点上该有的文件在磁盘上找不到、
		 * 包里也没有它的条目，就是真补不上 —— 报出来，别假装搬到了。
		 * （目标那边其实已经有了的话（手工搬过 / 上一份包搬过），`plannedFiles` 里就有它。）
		 */
		const verifyRelocated = (): void => {
			const missing = relocatedHere.filter(file => !plannedFiles.has(file) && !entriesByPath.has(file));
			if (missing.length === 0) return;
			throw new Error(
				`包里要把文件夹 ${move.from} 移到 ${move.to}，但本地两处都没有 ${missing[0]}`
				+ `（共 ${missing.length} 个）。移动包只带改名、不带内容，补不了缺的文件：`
				+ `先把本机恢复到基准（重新应用「第 ${header.baseGeneration ?? '?'} 代」那份完整副本），`
				+ '或者让对方发一份完整副本',
			);
		};

		// 只改大小写：大小写不敏感的文件系统上是同一个目录，大小写敏感时目标也不存在 —— 直接改名
		if (caseRename) {
			if (!sourceDir) {
				throw new Error(`包里要把文件夹 ${move.from} 移到 ${move.to}，但本地没有这个文件夹：让对方重发一份带内容的包`);
			}
			for (const file of sourceUnder) {
				const disk = plannedFiles.get(file);
				if (!disk) continue;
				const toPath = toPrefix + file.slice(fromPrefix.length);
				plannedFiles.delete(file);
				plannedFiles.set(toPath, disk);
				movedTo.add(toPath);
			}
			relocatePoint();
			// 只改大小写不核对"点上缺没缺"：同一个目录在磁盘上只有一份，改名不会丢内容
			moveActions.push({ kind: 'rename', path: move.to, from: move.from, dir: true });
			moves++;
			continue;
		}

		/**
		 * **源没了 / 只剩空壳**：累积包里这条移动早做过了（上一份包已经搬完，或者本机手工搬过）。
		 *
		 * 这一步以前是直接 `continue` 的 —— 那正是「application 里只剩 1111」的来源：
		 * `deliveredFiles` 还停在旧路径，严格镜像于是把**目标那边**的文件当成"本地多出来的"
		 * 全删了。现在点上的记录照样搬到新路径，目标那边的东西就都在"那一点"上了。
		 */
		if (!sourceDir || sourceUnder.length === 0) {
			if (targetDir) {
				relocatePoint();
				verifyRelocated();
				continue;
			}
			if (!sourceDir) {
				if (laterReaches) continue;
				throw new Error(
					`包里要把文件夹 ${move.from} 移到 ${move.to}，但本地两个路径都不在。`
					+ '更新包只带改名、不带内容，补不了缺的文件。先确认这个文件夹去哪了'
					+ '（被删掉或挪走了？回收目录里找找），或者把'
					+ `「第 ${header.baseGeneration ?? '?'} 代」那份完整副本`
					+ '重新应用一遍，让本机回到基准，再应用这个包；'
					+ '再不行就让对方导一份完整副本（或一份带这些文件内容的包）',
				);
			}
			throw new Error(`包里要把文件夹 ${move.from} 移到 ${move.to}，但本地没有它下面的文件`);
		}

		/** 源里的文件得是原来那一份（改过就停下，包里没有内容可以覆盖） */
		for (const file of sourceUnder) {
			if (movedTo.has(file)) continue; // 前面那一跳搬过来的：已经按包记录核对过一次
			const disk = plannedFiles.get(file);
			if (!disk) continue;
			const base = contentBefore[file];
			if (base) {
				if (!sameRecord(disk, base, TOLERANCE)) {
					throw new Error(`包里的文件夹移动 ${move.from} → ${move.to} 做不了：${file} 在本地被改过或不见了`);
				}
				continue;
			}
			/**
			 * 记录里没有它，但**起点那份完整副本里有、内容还是那一版**：它仍然是这棵树的一部分
			 * （旧版本改名失败时会把记录划掉）。这时整条移动不能拒 —— 拒了这台机器就永远卡住。
			 */
			if (anchor && anchor[file] && sameRecord(disk, anchor[file], TOLERANCE)) continue;
			// 其余的是改名之后在旧名字下新建的内容：不跟着搬，交给删除收尾（严格档进回收目录）
		}

		/** 目标位置什么都没有：整棵 rename（最快、也保住空目录结构），记录跟着走 */
		if (!targetDir) {
			for (const file of sourceUnder) {
				const disk = plannedFiles.get(file);
				if (!disk) continue;
				const toPath = toPrefix + file.slice(fromPrefix.length);
				plannedFiles.delete(file);
				plannedFiles.set(toPath, disk);
				movedTo.add(toPath);
			}
			relocatePoint();
			/**
			 * **源里少了"点上该有的文件"就停下**：包里只有改名、没有内容，
			 * 就这么整棵搬过去会少一个文件、编号永远对不上。
			 * 调用方会拿这条错误去走**强制回退到基准再应用**（`recoverToBaselineAndApply`）——
			 * 有基准完整副本就有内容，补得回来（用户要的"不管本机怎么改过都能成功"）。
			 */
			verifyRelocated();
			moveActions.push({ kind: 'rename', path: move.to, from: move.from, dir: true });
			moves++;
			continue;
		}

		/** 目标是同名文件：整棵搬过去、把那一个文件替换掉（只有严格档会走到这儿） */
		if (targetIsFile) {
			if (!strict) {
				throw new Error(`包里要把文件夹 ${move.from} 移到 ${move.to}，但本地目标已经存在：先把它挪走`);
			}
			for (const file of sourceUnder) {
				const disk = plannedFiles.get(file);
				if (!disk) continue;
				const toPath = toPrefix + file.slice(fromPrefix.length);
				plannedFiles.delete(file);
				plannedFiles.set(toPath, disk);
				movedTo.add(toPath);
			}
			relocatePoint();
			verifyRelocated();
			moveReplacements++;
			replacedTargets.push({ path: move.to, dir: true });
			moveActions.push({ kind: 'rename', path: move.to, from: move.from, dir: true, replace: true });
			moves++;
			continue;
		}

		/**
		 * **目标目录已经存在：按文件并进去，不整棵替换。**
		 *
		 * 整棵替换（先把目标挪进回收目录、再把源 rename 过来）会连带扔掉目标里**已经在该在**
		 * 的东西：累积包里这条移动会一直带着，目标那边多半装着上几份包搬过去的文件，
		 * 而源这边可能只剩一个空壳 —— 一次替换就把它们全扫进回收目录，用户看到的就是
		 * 「application 里只剩新写的那一个 1111」。按文件并：目标上没有的搬过去、
		 * 目标上已有的（同一份）不动、目标上占着别的版本的按严格档进回收目录的「冲突」。
		 */
		if (!strict) {
			throw new Error(`包里要把文件夹 ${move.from} 移到 ${move.to}，但本地目标已经存在：先把它挪走`);
		}
		relocatePoint();
		for (const file of sourceUnder) {
			const disk = plannedFiles.get(file);
			if (!disk) continue;
			const toPath = toPrefix + file.slice(fromPrefix.length);
			// 条目会把这个位置写成包里的那一版（移动包里它只带路径，内容由条目给）
			if (entriesByPath.has(toPath)) continue;
			const pointRecord = deliveredFiles[toPath];
			const targetRecord = plannedFiles.get(toPath);
			if (targetRecord) {
				// 目标已经是"点上那一版"（点上没记录时：目标就是先到的那一份，留着它）
				if (!pointRecord || sameRecord(targetRecord, pointRecord, TOLERANCE)) continue;
				moveReplacements++;
				replacedTargets.push({ path: toPath, dir: false });
			} else if (!pointRecord) {
				/**
				 * 点上没有它、目标也没有：这是"记录被旧版本写坏过"的现场 —— 那棵树其实还在源里。
				 * 搬过去比留在旧路径下被当成"本地多出来的"删掉强（内容不动，下一轮再对账）。
				 */
				deliveredFiles[toPath] = { size: disk.size, mtime: disk.mtime };
				relocatedHere.push(toPath);
			}
			plannedFiles.delete(file);
			plannedFiles.set(toPath, disk);
			movedTo.add(toPath);
			moveActions.push({
				kind: 'rename',
				path: toPath,
				from: file,
				...(targetRecord ? { replace: true } : {}),
			});
			moves++;
		}
		verifyRelocated();
	}
	/**
	 * **被 replace 掉的目标，底下的条目要重写一遍。**
	 *
	 * 计划阶段算条目的时候，目标还站在"上一趟搬过去的那一版"上，跟条目一比一样就跳过了写入；
	 * 可 `replace` 的 rename 会把目标换成**源**那一份（源里可能是基准版本 / 旧版本）。
	 * 不补写的话，应用完目标那里是旧内容 → 状态编号对不上（真机复现：恢复完最后差一个文件）。
	 * 内容一样时多写一次也无害（这个操作本来就要求幂等）。
	 */
	if (replacedTargets.length > 0) {
		const written = new Set(actions.filter(action => action.kind === 'write').map(action => action.path));
		for (const entry of header.entries) {
			const under = replacedTargets.some(item => item.dir
				? entry.path === item.path || entry.path.startsWith(`${item.path}/`)
				: entry.path === item.path);
			if (!under || written.has(entry.path)) continue;
			written.add(entry.path);
			if (local.files.has(entry.path)) overwrites++;
			else adds++;
			actions.push({ kind: 'write', path: entry.path, entry });
		}
	}
	/**
	 * **严格镜像的删除收尾：照"送到的点"判，不照"我上次记下的样子"判。**
	 *
	 * `deliveredFiles` 已经算进移动（旧前缀 → 新前缀）、也吸收了"这条移动早做过了"的情况，
	 * 所以它是"这一点上到底该有哪些文件"的答案：
	 * - 它在点上 → 留着（本机改过的也留着，那是"我这一半"）；
	 * - 它不在点上 → 挪进回收目录（本机新建的、对方删过的、旧路径留下的）。
	 *
	 * **判据必须用磁盘快照 + 移动影子清单（`plannedFiles`），不能用 `baseline`**：
	 * `baseline` 只是我上次记下的样子，本机手工改过名 / 旧版本改名失败时它就过时了；
	 * 照它判，刚搬过去（或手工搬好）的文件会被当成"本地多出来的"整批删掉。
	 */
	if (mirrorFull || strict) {
		for (const file of plannedFiles.keys()) {
			if (deliveredFiles[file]) continue;
			deletes++;
			if (!localDeleted.has(file)) localExtras++;
			// 走 `delete` 动作：开着回收目录时它们都进回收目录，捞得回来
			actions.push({ kind: 'delete', path: file });
		}
	}
	// 多余文件按最终动作统一次数（包点名要删的算"删除"，其余算"本地多出来的"）
	extraDeletes = 0;
	for (const action of actions) {
		if (action.kind !== 'delete' || localDeleted.has(action.path)) continue;
		extraDeletes++;
	}
	actions.unshift(...moveActions);
	const deliveredDirs = new Set<string>(header.emptyDirs ?? []);
	for (const file of Object.keys(deliveredFiles)) deliveredDirs.add(dirnameRel(file));
	deliveredDirs.delete('');

	/**
	 * **对齐到对面时，本机误改的文件要恢复成"那一点上的版本"**。
	 *
	 * 为什么普通镜像做不到：更新包只装"自起点以来变过的"文件；本机在**没被点名**的文件上
	 * 改过之后，那个路径不在条目里，严格镜像不会动它（它被当成"我这一半"）。双向同步这是
	 * 对的（要回传），**只拉不推**就不对了 —— 规则是"和另一半严格相等"，留着误改编号永远差一点。
	 *
	 * 恢复的内容从**起点那份完整副本**里读（它才是"那一点上的原版"）。没有那份包文件就
	 * **明确报错**，不能假装恢复/悄悄删掉：删掉只会让目标里少一个文件，编号照样对不上。
	 */
	const restoreActions: ApplyAction[] = [];
	if (alignToPeer && anchor) {
		const touched = new Set<string>([...entriesByPath.keys(), ...localDeleted]);
		/**
		 * **移动过的路径整棵子树都不恢复**：目录移动只点了一条 `move`，
		 * 它底下的文件（`旧/一.md` 那些）不在 `touched` 里 —— 只按精确路径排除的话，
		 * 已经搬到新位置的文件会被判成"本机误改"，从基准完整副本恢复回**旧路径**，
		 * 新路径那份又被当成"本地多出来的"挪走。第二步（再来一份累积包）就会
		 * 旧路径、新路径同时在 → 报"本地目标已经存在"（真机复现的 bug）。
		 */
		const underMove = (file: string): boolean => (header.moves ?? []).some(move =>
			file === move.from || file === move.to
			|| file.startsWith(`${move.from}/`) || file.startsWith(`${move.to}/`));
		const candidates: { path: string; record: FileRecord }[] = [];
		for (const [file, record] of Object.entries(anchor)) {
			// 包点名的（条目 / 删除 / 移动）交给原来的动作；这里只管"谁都没提、本机却改了"的
			if (touched.has(file) || underMove(file)) continue;
			// 目标那一点上已经没有它（被删 / 被移走）→ 不是恢复的事
			if (!deliveredFiles[file]) continue;
			const here = local.files.get(file);
			if (here && sameRecord(here, record, TOLERANCE)) continue;
			candidates.push({ path: file, record });
		}
		if (candidates.length > 0) {
			const paths = candidates.map(item => item.path);
			// 路径要进日志：只报"1 个改动"没人能自查是哪个文件
			debugEvent('apply.restore-needed', { count: paths.length, paths: paths.slice(0, 10) });
			const source = findBaselineBundle(state, options, candidates.length, paths);
			const byPath = new Map(source.info.header.entries.map(entry => [entry.path, entry]));
			for (const candidate of candidates) {
				const entry = byPath.get(candidate.path);
				if (!entry) {
					throw new Error(
						`要恢复 ${candidate.path}，但基准完整副本「${path.basename(source.file)}」里没有这个文件：`
						+ '状态里记的基准和磁盘上那份包不是同一份，先把对应的完整副本放回包目录再应用',
					);
				}
				restoreActions.push({
					kind: 'restore',
					path: candidate.path,
					entry,
					sourceFile: source.file,
					sourceInfo: source.info,
				});
			}
			actions.push(...restoreActions);
		}
	}

	/**
	 * **应用完我就接在这个包的起点上**（见 `ApplyPlan.adoptBaseline`）——
	 * 只在这个包的起点**确实不是我站的那一份**、而且它**真是一份完整副本**时才算
	 * （头部 `baseFullBundle`：合成出来的起点不是"点"，谁手里都没有它的包文件；
	 * "送到我站的这一点"那种白跑一趟也不算 —— 我手里那一点比它更靠前，留着更好）。
	 */
	const declaredStart = header.mode === 'changes' ? baselineOfBundle(header) : null;
	const myFullHash = state.bundle?.fullHash ?? null;
	const adoptBaseline = declaredStart !== null
		&& header.targetFullBundle !== true
		&& header.baseFullBundle === true
		&& myFullHash !== null
		&& declaredStart !== myFullHash
		&& header.targetBaselineHash !== myFullHash
		? startPointOf(header, deliveredFiles, state.generation)
		: null;

	const foldersToRemove: string[] = [];
	/** 想删却删不掉的：清单里看着是空的，磁盘上还有东西（被排除规则挡住的文件） */
	const foldersKept: string[] = [];
	if (bundleRecordsDirs) {
		const baseDirs = new Set(state.bundle?.dirs ?? []);
		const filled = dirsContainingFiles(local);
		const candidates: string[] = [];
		for (const dir of local.dirs) {
			if (deliveredDirs.has(dir)) continue; // 那一点上有它 → 留着（空目录也是内容）
			if (filled.has(dir)) continue; // 里面有文件：交给文件规则，别在这里抢着删
			// **严格镜像**：那一点上没有的目录都清掉（连本机新建的）。完整副本与更新包一样 ——
			// 更新包这边的判据是"那一点上有没有它"，不是"我以前记没记过它"：
			// 按记录判会漏掉本机新建的空文件夹，两边目录集合从此不一样，状态编号也就永远对不上。
			if (mirrorFull || strict) {
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

	/**
	 * 文件移动把文件从旧目录挪走之后，旧目录可能空了，而计划阶段它里面还有文件
	 * （`filled` 把它排除了）—— 这里补进删除清单，执行收尾时再 rmdir；
	 * 非空删不动，所以多列了也安全。目录移动本身会把整棵旧树 rename 走，不用补。
	 */
	for (const action of moveActions) {
		if (action.kind !== 'rename' || action.dir) continue;
		let dir = dirnameRel(action.from);
		while (dir !== '' && !deliveredDirs.has(dir)) {
			if (!foldersToRemove.includes(dir)) foldersToRemove.push(dir);
			dir = dirnameRel(dir);
		}
	}

	const report: ApplyReport = {
		mode: fastPath ? 'fast' : 'merge',
		sameLineage,
		sameGeneration,
		// 只报"导出方的上一份导出"这件事实，**界面不拿它判漏包**（见 `ApplyReport.parentMatches` 那段）
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
		viaMine: ancestor.viaLanding === true || (header.viaHashes ?? []).includes(state.bundle?.fullHash ?? ''),
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
		restored: restoreActions.length,
		synchronized,
		syncPercent: total === 0 ? 100 : Math.round((synchronized / total) * 100),
		pendingChanges: anchor ? pendingChanges : null,
		pendingDeletes: anchor ? pendingDeletes : null,
		moves,
		moveReplacements,
		// 本地还没有的目录都算"要补建"：有文件的那些会随文件写入顺带建出来，
		// 空文件夹靠执行阶段显式建（`header.emptyDirs`）
		foldersToCreate: [...bundleDirs].filter(dir => !local.dirs.has(dir)).length,
		foldersToRemove: foldersToRemove.length,
		foldersKept: foldersKept.length,
		baselineAdopted: adoptBaseline
			? { generation: adoptBaseline.generation, hash: adoptBaseline.hash }
			: null,
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
		contentBefore,
		relocated: relocations,
		adoptBaseline,
		alignToPeer,
		deliveredDirs: [...deliveredDirs].sort(),
		foldersKept: [...foldersKept].sort(),
		options: { conflictStrategy, propagateDeletions, keepBackup },
	};
}

/**
 * **把包声明的起点倒推出来**（清单层面）—— 见 `ApplyPlan.adoptBaseline`。
 *
 * 怎么倒推：拿"应用完我这边该有的样子"（落点），把包里**点名过**的路径换回它自己带的
 * `base` 版本（条目与点名删除都带着）、点名的删除按 `base` 加回来 —— 得到的正是
 * **对方导出时站的那一点**（更新包的每个 `base` 一律取自那份完整副本的清单，见 `export.ts`）。
 *
 * **必须用头部那个 `baselineHash` 验一遍**才对得上号：差一条都不认。
 * 验不过（旧包没带 base / 有些条目没写成 / 落点里混进了起点上没有的东西）就返回 `null` ——
 * 宁可不动基准，也不能把一个假点记上去（那会让两边的"站在同一份完整副本上"变成谎话）。
 */
function startPointOf(
	header: BundleHeader,
	landed: Record<string, FileRecord>,
	/** 头部没给起点世代时的兜底（正常的新包一定带着 `baseGeneration`） */
	fallbackGeneration: number,
): { files: Record<string, FileRecord>; generation: number; hash: string } | null {
	const declared = baselineOfBundle(header);
	if (!declared) return null;
	const start: Record<string, FileRecord> = { ...landed };
	for (const entry of header.entries) {
		const hasSize = entry.baseSize !== undefined;
		const hasMtime = entry.baseMtime !== undefined;
		// 记了一半的说不清（不猜）
		if (hasSize !== hasMtime) return null;
		if (hasSize) {
			start[entry.path] = { size: entry.baseSize as number, mtime: entry.baseMtime as number };
			continue;
		}
		// 没带 base ＝ 起点那份清单里**没有**它（新文件）—— 导出方就是这么记的（`export.ts` 的 `baseFields`）
		delete start[entry.path];
	}
	for (const item of header.deleted) {
		// 点名删除的路径在起点上一定存在（它就是从那一点上没的），没带 base 就没法倒推
		if (item.baseSize === undefined || item.baseMtime === undefined) return null;
		start[item.path] = { size: item.baseSize, mtime: item.baseMtime };
	}
	if (listingHashOfFiles(start) !== declared) return null;
	return { files: start, generation: header.baseGeneration ?? fallbackGeneration, hash: declared };
}

/** 找到"我站的那一份完整副本"的包文件（恢复本机误改时读它的负载） */
interface BaselineBundleSource {
	file: string;
	info: BundleInfo;
}

/**
 * 找本机基准对应的**完整副本文件** —— 只给"对齐到对面"那条恢复路径用。
 *
 * 怎么认：完整包自带完整清单，所以**重算它的基准指纹**（`baselineOfFullBundle`）
 * 跟 `state.bundle.fullHash` 比。不能信任文件名，也不能拿"最新的那份完整包"顶替：
 * 状态里记的基准可能不是磁盘上最新的那一份（用户可能又导过一份完整包、换过基准）。
 *
 * 找的地方按"最可能"排：包目录的 `full/`、包目录本身、当前包旁边的 `full/`、当前包所在目录。
 * 找不到就**抛错并指路**，绝不悄悄拿别的完整包恢复 —— 那会把内容写成另一份状态。
 */
function findBaselineBundle(
	state: PluginState,
	options: ApplyOptions,
	needed: number,
	paths: string[] = [],
): BaselineBundleSource {
	const hash = state.bundle?.fullHash ?? null;
	/** 报错里带上前几个路径：用户要能自己核对"到底哪个文件被判成本机改动" */
	const where = paths.length === 0
		? ''
		: `（涉及：${paths.slice(0, 5).join('、')}${paths.length > 5 ? ` 等 ${paths.length} 个` : ''}）`;
	if (!hash) {
		throw new Error(
			`本机有 ${needed} 个改动不在这份包里${where}，但本机还没有完整副本，没法把它们恢复成“对面那一版”：`
			+ '先应用一份完整副本当基准，再让对方按那份基准重导更新包',
		);
	}
	const dirs = new Set<string>();
	if (options.bundleDir) {
		dirs.add(path.join(options.bundleDir, 'full'));
		dirs.add(options.bundleDir);
	}
	const near = path.dirname(options.file);
	dirs.add(path.join(near, '..', 'full'));
	dirs.add(near);

	const wanted = state.bundle?.fullFile ?? null;
	const candidates = new Set<string>();
	if (wanted) {
		for (const dir of dirs) candidates.add(path.join(dir, wanted));
	}
	for (const dir of dirs) {
		let names: string[];
		try {
			names = fs.readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			if (name.toLowerCase().endsWith('.lsave')) candidates.add(path.join(dir, name));
		}
	}

	for (const file of candidates) {
		let info: BundleInfo;
		try {
			info = readBundleInfoSync(file);
		} catch {
			continue;
		}
		if (info.header.mode !== 'full') continue;
		if (baselineOfFullBundle(info.header.entries) !== hash) continue;
		return { file, info };
	}

	throw new Error(
		`本机有 ${needed} 个改动不在这份包里${where}；要按“仅拉＝跟对面严格相等”把它们恢复成基准那一版，`
		+ `得读基准完整副本「${wanted ?? hash}」的原版内容，但它不在包目录里。\n`
		+ '下一步：把那份完整包放回同步包文件夹的 full/ 再应用；'
		+ '或者让对方导一份新的完整副本过来（完整清单自带基准，谁都能应用）',
	);
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

/**
 * 现在有没有一次"应用"正在进行。
 *
 * git 同步要避开：`pull`/`rebase` 可能在应用正读某个包的时候把它挪走（或者把文件换掉）。
 * 界面那条路没有插件级的 busy 标记，所以只能问这里。
 */
export function isApplying(): boolean {
	return applying;
}

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
		restored: 0,
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
							throw new Error('本地这里是同名的文件夹，包里是一个文件：换个位置或先把文件夹挪走');
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
				case 'restore': {
					/**
					 * 本机误改的版本先进回收目录（跟冲突输的那一份同一个去处）：
					 * 用户可能只是手滑改了，捞得回来；留在原地会跟着下一次同步传出去。
					 */
					if (await dirExists(target)) {
						await moveToTrash(
							target,
							toNative(options.vaultRoot, `.trash/locally-save/${CONFLICT_TRASH_DIR}`),
							action.path,
							stamp,
						);
					} else if (keepBackup && await pathExists(target)) {
						await moveToTrash(
							target,
							toNative(options.vaultRoot, `.trash/locally-save/${CONFLICT_TRASH_DIR}`),
							action.path,
							stamp,
						);
					}
					await extractEntry(action.sourceFile, action.sourceInfo, action.entry, target);
					result.restored++;
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
					/**
					 * 目标位置已经有东西（严格档的"以包为准"）：先把它挪进回收目录的「冲突」，
					 * 再把源搬过去。两份都在，捞得回来；不这么做，`rename` 在 Windows 上会
					 * 直接失败（"目标已存在"），整包停在那儿、每轮重试都过不去。
					 */
					if (action.replace && await pathExists(target)) {
						await moveToTrash(
							target,
							toNative(options.vaultRoot, `.trash/locally-save/${CONFLICT_TRASH_DIR}`),
							action.path,
							stamp,
						);
						result.conflicts++;
						result.conflictCopies.push(`.trash/locally-save/${CONFLICT_TRASH_DIR}/${stamp}/${action.path}`);
					}
					if (action.dir) {
						// 目录移动：整棵 rename。跨盘时不能退回 copyFile（那只能复制文件），明确报错
						try {
							await fs.promises.rename(from, target);
						} catch (error) {
							throw new Error(`文件夹改名失败（${action.from} → ${action.path}）：${describe(error)}`);
						}
					} else {
						try {
							await fs.promises.rename(from, target);
						} catch {
							// 跨盘 / 权限问题：退回"复制 + 删旧的"
							await fs.promises.copyFile(from, target);
							await fs.promises.rm(from, { force: true });
						}
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

	// 收尾：**把那一点上没有的目录清掉**（空目录也是内容的一部分，所以这不是"顺手收拾空壳"，
	// 而是镜像的收尾动作）。`plan.deliveredDirs` 就是"这一趟之后该有哪些目录"：
	// 那一点上有、本地没建出来的（比如空文件夹）上面刚建好了，剩下的空目录就都是那一点上没有的。
	// 传 `keep` 是为了**别把刚建好的那些又收掉**（踩过：对面把一个文件夹里的文件删光、
	// 文件夹留着，这边删完文件顺手把空壳收掉 → 状态编号当场对不上，用户看到"还差一点"而文件一个不差）。
	result.foldersRemoved += await pruneEmptyDirs(
		options.vaultRoot,
		[
			...plan.actions.filter(action => action.kind === 'delete').map(action => action.path),
			...plan.actions.flatMap(action => (action.kind === 'rename' && action.from ? [action.from] : [])),
		],
		plan.deliveredDirs,
	);

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
	/**
	 * **做完之后逐条核对**：计划里说"要到位"的东西真到位了吗？
	 *
	 * 只看这个计划**动手的路径**（写 / 改名 / 删 / 补建目录），不看"仓库里有没有别的文件" ——
	 * 本机多出来的东西（"我这一半"）不是错误，它本来就该由下一次导出带回去。
	 * 核不上就走强制回退那条兜底（`recoverToBaselineAndApply`），别停在"编号还差一点"上。
	 */
	result.effects = await collectApplyProblems(plan, inventory, options.vaultRoot);
	state.stateId = result.stateId;

	/**
	 * **世代 ＝ 内容在这个血脉里的版本号**。
	 *
	 * - 应用完的内容正好等于包的目标（`match`）→ 采纳包说的那一代；
	 * - 内容里还留着**本机独有的改动**（合并了，编号对不上）→ 取"本机与包"较大的那个，
	 *   **绝不往回退**。踩过：B 已经导出过第 102 代、再应用 A 的第 101 代（B 的改动留在合并结果里），
	 *   旧代码直接把 B 的号改回 101 —— A 那边应用 B 的 102 包后是 102，两边内容一样、代数却不同。
	 *   取 max 之后两边都停在 102，且不会出现"后应用的那台把号拉低"。
	 * - 旧包没记状态编号 → 只能按"内容就是包"处理（照旧采纳目标的号）。
	 */
	const exactTarget = plan.info.header.stateId ? result.stateIdCompare === 'match' : true;
	state.generation = exactTarget
		? plan.info.header.targetGeneration
		: Math.max(state.generation, plan.info.header.targetGeneration);
	// 高水位只增不减：应用别人的包时把它报过的号一并算进来（回退那一趟不会把水位拉低，
	// 于是"回退之后再导出"不会去撞历史上用过的号，见 sync/state.ts 的 maxGeneration）
	raiseGeneration(state, plan.info.header.targetGeneration, plan.info.header.baseGeneration);

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
	 * 应用**之前**我这边内容的样子（见下面 `nextFullFiles`）。
	 *
	 * **照计划里那份快照算，不读现在的状态**：计划与执行之间可能已经导出过一次
	 * （"应用前先把本机改动存成一个包"），那一步会让状态里的东西往前走 ——
	 * 照它算出来的新清单就不是包送到的那一份了（见 `ApplyPlan.contentBefore`）。
	 */
	const contentBefore: Record<string, FileRecord> = { ...plan.contentBefore };
	/** 这次**真的写成了一致**的那些条目（新清单由它拼出来） */
	const freshAnchor: Record<string, FileRecord> = {};
	/**
	 * 移动操作已经执行完了：把新路径记进来、旧路径从清单里划掉。
	 * 这一步必须在条目循环之前做 —— `nextFullFiles` 由 `contentBefore + freshAnchor` 拼出来。
	 *
	 * **只在新路径真的有了那一条时才划掉旧记录**：改名可能失败（目标被占 / 文件被锁 /
	 * 跨盘目录 rename 报错）。失败时源还老老实实躺在旧路径上，把记录划掉等于告诉下一轮
	 * "这个文件我这边没有"—— 下一份累积包就会按"点上没有它"把它挪进回收目录
	 * （用户报的「改名失败之后，再同步一次 application 里只剩 1111」就是这么来的）。
	 */
	for (const action of plan.actions) {
		if (action.kind !== 'rename') continue;
		if (action.dir) {
			const fromPrefix = `${action.from}/`;
			const toPrefix = `${action.path}/`;
			/**
			 * 源的记录可能来自两处：应用前的 `contentBefore`，和**这一趟前面几跳刚搬过来**的
			 * `freshAnchor`（链式改名：旧 → 中间 → 最终，同一个包里两条 rename）。
			 * 只搬 `contentBefore` 的话，中间那一跳的记录会留在 `freshAnchor` 里 ——
			 * `nextFullFiles` 拼出来就有一条"磁盘上已经不在"的假记录。
			 */
			const under = [...Object.keys(contentBefore), ...Object.keys(freshAnchor)]
				.filter(item => item.startsWith(fromPrefix));
			for (const file of [...new Set(under)]) {
				const toPath = toPrefix + file.slice(fromPrefix.length);
				const current = await statFile(toNative(options.vaultRoot, toPath));
				if (!current) continue;
				freshAnchor[toPath] = current;
				delete contentBefore[file];
				delete freshAnchor[file];
			}
		} else {
			const current = await statFile(toNative(options.vaultRoot, action.path));
			if (!current) continue;
			freshAnchor[action.path] = current;
			delete contentBefore[action.from];
			// 链式文件移动：上一跳刚记下的中间路径也要跟着往前挪，别留成假记录
			delete freshAnchor[action.from];
		}
	}
	/**
	 * **计划阶段认定"磁盘上已经搬完"的移动**（源没了 / 目标已经有同一份）：
	 * 没有动作，但记录得从旧路径挪到新路径 —— 否则下一份累积包还会按旧路径判"点上有什么"。
	 */
	for (const item of plan.relocated ?? []) {
		const current = await statFile(toNative(options.vaultRoot, item.to));
		if (!current) continue;
		freshAnchor[item.to] = current;
		delete contentBefore[item.from];
		// 链式移动的中间那一跳：上一轮 relocation 刚把它记进 freshAnchor
		delete freshAnchor[item.from];
	}
	for (const entry of plan.info.header.entries) {
		const current = await statFile(toNative(options.vaultRoot, entry.path));
		const agreed = current
			&& current.size === entry.size
			&& Math.abs(current.mtime - entry.mtime) <= TOLERANCE;
		// 这一个路径先按"没成一致"算：一致的话下面再补回来
		delete contentBefore[entry.path];
		delete freshAnchor[entry.path];
		if (!agreed) continue;
		freshAnchor[entry.path] = { size: entry.size, mtime: entry.mtime };
	}
	/**
	 * 从基准恢复的路径：照样**只有真写成了一致才记进清单**。
	 * 恢复失败（文件被占用 / 权限）时不能声称"我这边就是基准那一版"，
	 * 否则下一次应用会按一个假记录判断"没变过"。
	 */
	for (const action of plan.actions) {
		if (action.kind !== 'restore') continue;
		delete contentBefore[action.path];
		delete freshAnchor[action.path];
		const current = await statFile(toNative(options.vaultRoot, action.path));
		const agreed = current
			&& current.size === action.entry.size
			&& Math.abs(current.mtime - action.entry.mtime) <= TOLERANCE;
		if (agreed) freshAnchor[action.path] = { size: action.entry.size, mtime: action.entry.mtime };
	}
	for (const item of plan.info.header.deleted) {
		delete contentBefore[item.path];
		delete freshAnchor[item.path];
	}
	/**
	 * **严格镜像收尾删掉的那些**（本机多出来的 / 旧路径留下的）：记录里不能再留着。
	 *
	 * 留着就是"假记录"：`state.bundle.files` 声称某个路径存在，磁盘上却没有。
	 * 下一次应用会拿它算"送到的点"（`deliveredFiles`），多出一条谁都没有的路径 ——
	 * `checkAncestor` 的"算一遍落点"跟着算错，一份明明接得上的包会被判成"接不上"；
	 * `hasChanges` 也会因此永远判"有变化"，自动留包白扫一遍、状态栏还一直说"没同步"。
	 * 删除失败（文件被占用 / 权限）时路径还在，记录就留着 —— 它确实是本机的内容。
	 */
	for (const action of plan.actions) {
		if (action.kind !== 'delete') continue;
		if (await statFile(toNative(options.vaultRoot, action.path))) continue;
		delete contentBefore[action.path];
		delete freshAnchor[action.path];
	}

	// 目录基准：**照"这一趟送到的那一点"记**（`plan.deliveredDirs`），不是只记包里点过名的。
	//
	// 踩过：更新包只带"变过的文件"，`dirsInBundle` 里只有这些文件的上级目录；
	// 一台有多层目录的机器应用完更新包后，`state.bundle.dirs` 只剩那一小撮目录 ——
	// 下一次 `hasChanges` 一看"仓库里 200 个目录、记录里 3 个"，判定有变化，
	// 于是把刚应用完的同一份更新包又导了一遍（用户报的"100→101 导了两次"）。
	const keepDirs = new Set<string>();
	for (const dir of plan.deliveredDirs) {
		if (await dirExists(toNative(options.vaultRoot, dir))) keepDirs.add(dir);
	}
	// 想删却没删掉的（被排除规则挡住的）也还在：记进基准，别让下一轮以为是"新目录"
	for (const dir of plan.foldersKept) {
		if (await dirExists(toNative(options.vaultRoot, dir))) keepDirs.add(dir);
	}
	const sortedDirs = [...keepDirs].sort();
	/**
	 * **只有落到一份真基准点上时，"我站的那一份完整包"才往前走**（0.14，用户拍板，
	 * 见 `docs/只有完整包才算基准点-实施计划.md`）：
	 *
	 * - **完整副本**：它自己就是一份新基准（`freshAnchor` ＝ 真的写成了一致的那些条目）；
	 * - **差量包**（头部 `targetFullBundle`）：它送到的是**另一份完整副本** ——
	 *   清单 ＝ 应用前我这边的内容 ＋ 包里的条目 − 点名的删除，正好是终点那份完整副本的样子
	 *   （对方头部 `targetBaselineHash` 报的就是它的指纹，必须算得一模一样）；
	 * - **更新包**（送到"最新状态"）：**基准点不动** —— 它只是"从我站的这份完整包往外长的一层"。
	 *   内容那一半照旧前进（`files` / `history` / `dirs` / 世代 / 状态编号），
	 *   所以下一个包还是从同一份完整包往外算（累积语义），这一点是"回传对方直接收得下"的关键。
	 * - **例外：这个包的起点不是我站的那一份**（`plan.adoptBaseline`，`checkAncestor` 那条
	 *   "算一遍落点对得上"放行的）→ 基准跟着它走。内容上我的新状态就是"它那份起点 ＋ 这个包"，
	 *   再把我留在一个它没有的旧点上，两边就永远对不上（下一次还要靠"算一遍落点"兜着），
	 *   我一导出更新包又变成"从我那个旧点算起的整库回声"。
	 *
	 * ⚠ **"落到基准上"＝包里点名的都写成 / 删成了**（`failed` 与 `foldersKept` 都为空），
	 * 不是"此刻内容编号与包一致"：站在一个点上的机器**允许有本地改动**（检查点走合并档、
	 * 或只拉那台还没恢复完，都可能有），那些改动在"点之上"，不算没落到。
	 * 但文件没写成 / 文件夹删不掉时，这一趟只是"改了大部分"；这时把点换过去就是谎报基准 ——
	 * 用户报的现场：应用 100 代完整副本之后列表标着「← 本机现在的基准」、世代却还是 108、
	 * 状态编号也对不上，之后导出的包全接不上。旧包没记状态编号时没法对账，照老规矩认。
	 */
	const wantsBaseline = isFull || plan.info.header.targetFullBundle === true;
	/** 写入 / 删除 / 建目录都成了；这一步决定"基准能不能换过去" */
	const landedCleanly = result.failed.length === 0 && plan.foldersKept.length === 0;
	const landedOnBaseline = wantsBaseline && landedCleanly;
	const previous = state.bundle;
	/** 没落到基准时退回"上一次确认过的那个点"；一个真点都没有就如实留空（别拿半份清单冒充基准） */
	const fallback = previous?.fullHash
		? {
			fullFiles: previous.fullFiles ?? null,
			fullGeneration: previous.fullGeneration ?? null,
			fullHash: previous.fullHash,
			fullFile: previous.fullFile ?? null,
		}
		: { fullFiles: null, fullGeneration: null, fullHash: null, fullFile: null };
	const adopt = wantsBaseline ? null : plan.adoptBaseline;
	const nextFullFiles: Record<string, FileRecord> = isFull
		? { ...freshAnchor }
		: { ...contentBefore, ...freshAnchor };
	const landedHash = listingHashOfFiles(nextFullFiles);
	const baseline = landedOnBaseline
		? {
			fullFiles: nextFullFiles,
			fullGeneration: plan.info.header.targetGeneration,
			// 令牌：站在哪一份完整包上，对方下一个包一比就知道
			fullHash: landedHash,
			/**
			 * 只有**真完整包**才能记成"我站的那份包文件"。
			 * 差量包（`targetFullBundle`）的终点是一份完整副本，但手里这个文件是**更新包** ——
			 * 记上它，后面恢复本机改动时会去找一个 mode=full 的文件、或把更新包名当基准报出去
			 * （用户报的「得读基准完整副本「…-更新-…」」就是这么来的）。终点那份完整包
			 * 在不在本机由 `findBaselineBundle` 按指纹扫，`fullFile` 记不清就留空。
			 */
			fullFile: isFull ? path.basename(options.file) : null,
		}
		: (adopt
			? {
				fullFiles: adopt.files,
				fullGeneration: adopt.generation,
				fullHash: adopt.hash,
				// 接过别人的起点时那份包**不在本机**（从头部与 base 倒推出来的）→ 如实留空
				fullFile: null,
			}
			: fallback);
	state.bundle = {
		lastExport: previous?.lastExport ?? 0,
		files: nextFullFiles,
		...baseline,
		history: isFull ? {} : (previous?.history ?? {}),
		dirs: sortedDirs,
	};
	if (wantsBaseline && !landedOnBaseline) {
		options.log.debug(
			`基准没有换过去：${result.failed.length} 个路径没写成 / 删掉、${plan.foldersKept.length} 个文件夹删不掉 —— `
			+ `应用完的内容（${stateIdInfo.id}）不能声称站上了这个点（包里 ${plan.info.header.stateId?.id ?? '未记'}）`,
		);
	}
	if (adopt) {
		options.log.debug(
			`基准跟着这个包落到第 ${adopt.generation} 代（${adopt.hash}）：这个包的起点不是我原来站的那一份，`
			+ '而我的内容就是它 ＋ 这个包 —— 接上它，两边才回到同一份完整副本上',
		);
	}
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
		...(plan.info.header.moves && plan.info.header.moves.length > 0
			? { moves: plan.info.header.moves.length }
			: {}),
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

/**
 * **做完之后逐条核对：计划里说"要到位"的东西真到位了吗？**
 *
 * 只看这个计划**动手的路径**，不看"仓库里有没有别的文件" ——
 * 本机多出来的（"我这一半"）不是错误，它本来就该由下一次导出带回去。
 *
 * 判据：
 * - `write` / `restore` / `fill`：文件在，且大小 + 修改时间与包里那一版一致；
 * - `rename`：目标在（文件看清单，目录看磁盘）；
 * - `delete`：路径真的没了；
 * - 包里记着的空文件夹：在；`foldersToRemove`：真删掉了。
 *
 * 为什么要这一步：应用是"先算后做"，做完之后没人核对过结果。某个 rename 在 Windows 上失败、
 * 某个文件被占用写不进去、或者清单算错了，`failed` 未必都兜得住；
 * 而"包送到的点"是可以逐条核对的 —— 核不上就走强制回退那条兜底。
 */
async function collectApplyProblems(
	plan: ApplyPlan,
	inventory: Inventory,
	vaultRoot: string,
): Promise<{ ok: boolean; problems: string[] }> {
	const problems: string[] = [];
	const LIMIT = 20;
	const note = (text: string): void => {
		if (problems.length < LIMIT) problems.push(text);
	};
	const abs = (rel: string): string => toNative(vaultRoot, rel);
	for (const action of plan.actions) {
		switch (action.kind) {
			case 'write':
			case 'restore': {
				const record = inventory.files.get(action.path);
				if (!record) {
					note(`${action.path}：计划要写的文件不在`);
					break;
				}
				if (record.size !== action.entry.size
					|| Math.abs(record.mtime - action.entry.mtime) > TOLERANCE) {
					note(`${action.path}：内容或修改时间与包里那一版不一致`);
				}
				break;
			}
			case 'rename': {
				if (action.dir) {
					if (!await dirExists(abs(action.path))) note(`${action.path}：文件夹没搬成`);
					break;
				}
				if (!inventory.files.has(action.path)) note(`${action.path}：改名后的文件不在`);
				break;
			}
			case 'delete': {
				// 走磁盘问：清单里看不见被排除规则挡住的东西，删除动作却真的会碰它们
				if (await pathExists(abs(action.path))) note(`${action.path}：要删的文件还在`);
				break;
			}
			default:
				break;
		}
	}
	for (const dir of plan.info.header.emptyDirs ?? []) {
		if (inventory.dirs.has(dir)) continue;
		if (await dirExists(abs(dir))) continue;
		note(`${dir}：包里记着的空文件夹不在`);
	}
	for (const dir of plan.foldersToRemove) {
		if (await dirExists(abs(dir))) note(`${dir}：该删的空文件夹还在`);
	}
	return { ok: problems.length === 0, problems };
}

/**
 * **兜底：强制回退到基准，再把这一份重新应用一遍。**
 *
 * 用户的原话："有基准包和对应更新包的情况下，是包括了所有信息，一定能更新成功的。"
 * 所以不再逐条猜"本机这一处改动该怎么合"：
 *
 * 1. 找到**我站在的那一份完整副本**（`findBaselineBundle`：重算指纹，不认文件名）；
 * 2. 把它按**完全镜像**应用一遍 —— 仓库回到那个基准点，本机多出来 / 改过的进回收目录；
 * 3. 再把这份更新包重新算、重新应用 —— 起点严格相等，包送到的状态是确定的；
 * 4. 结果里带上 `recovered`，界面据此说清"做了强制回退"。
 *
 * 基准包不在本机时 `findBaselineBundle` 会**报错并指路**（把它放回包目录 / 让对方发一份），
 * 绝不悄悄换一份、也绝不硬合 —— 那两种都会落一个说不清的状态。
 */
export async function recoverToBaselineAndApply(options: ApplyOptions): Promise<{
	plan: ApplyPlan;
	result: ApplyResult;
	baselineFile: string;
	baselineGeneration: number | null;
}> {
	const state = await loadState(options.stateFile);
	const baseline = findBaselineBundle(state, options, 1);
	const fullOptions: ApplyOptions = {
		...options,
		file: baseline.file,
		strictness: 'mirror',
		alignToPeer: false,
		receiveOnly: options.receiveOnly === true,
	};
	options.log.debug(`强制回退到基准「${path.basename(baseline.file)}」：先把它应用一遍`);
	const fullPlan = await planBundleApply(fullOptions);
	const fullResult = await executeBundlePlan(fullPlan, fullOptions);
	if (fullResult.failed.length > 0) {
		options.log.debug(
			`强制回退：完整副本有 ${fullResult.failed.length} 个路径没落地（${fullResult.failed[0]?.path ?? ''}），`
			+ '继续尝试应用更新包',
		);
	}

	const plan = await planBundleApply(options);
	const result = await executeBundlePlan(plan, options);
	const matched = result.stateIdCompare === 'match'
		&& result.failed.length === 0
		&& (result.effects?.ok ?? true);
	result.recovered = {
		baselineFile: path.basename(baseline.file),
		baselineGeneration: baseline.info.header.targetGeneration,
		matched,
	};
	options.log.debug(
		`强制回退应用完成：基准「${path.basename(baseline.file)}」，`
		+ `${matched ? '已与包里那一点严格对齐' : '仍然没对上（看 failed / effects）'}`,
	);
	return {
		plan,
		result,
		baselineFile: baseline.file,
		baselineGeneration: baseline.info.header.targetGeneration,
	};
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
		case 'restore':
			return '恢复';
		case 'conflict':
			return action.winner === 'remote' ? '冲突（以包为准）' : '冲突（以本地为准）';
		case 'rename':
			return '改名';
	}
}

/** 未使用但保留：SyncAction 与 ApplyAction 的对应关系写在 planBundleApply 里 */
export type { SyncAction };
