import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BUNDLE_EXT, BUNDLE_FORMAT, BUNDLE_VERSION, readBundleInfo, writeBundle } from './format';
import type { BundleDeletedEntry, BundleHeader, BundleInfo, BundleSource } from './format';
import { bundleDirForMode } from './paths';
import type { BundleMode } from './paths';
import { baselineOfBundle, baselineOfFullBundle, listingHashOfFiles } from './baseline';
import { anchorOfPoint, describeAnchorList, listFullAnchors, pickAnchor, planAutoStart } from './anchor';
import type { BundleAnchor } from './anchor';
import { listPointRefsSync, materializePointSync } from './points';
import { appendBundleLog } from './log';
import { DEFAULT_MTIME_TOLERANCE_MS, sameRecord } from '../sync/diff';
import { listFiles, removeFile, scanTree, statFile } from '../sync/disk';
import { VAULT_TRASH_DIR, excludePatterns } from '../sync/vault';
import { fingerprint } from '../sync/hash-cache';
import { cachedHash, copyRef, loadState, pruneHashes, raiseGeneration, saveState } from '../sync/state';
import type { PluginState, StateIdInfo, BundleLogEntry } from '../sync/state';
import { computeStateId } from '../sync/state-id';
import type { Inventory, FileRecord } from '../sync/types';
import type { Logger } from '../utils/log';
import { toNative, dirnameRel } from '../utils/paths';
import { yieldIfDue, yieldToUi } from '../utils/async';
import type { PluginSettings } from '../settings/model';

/**
 * 导出同步包。
 *
 * 「仅改动」模式靠状态文件里记的**上次导出时的样子**算差集：
 * 变过的文件进包，没了的文件进 `deleted` 列表（并带上它们的 base，
 * 让接收方能判断"我这边是不是也动过它"，动过就不删）。
 *
 * 只有包真正写完才推进世代与基准 —— 中途失败不能留下"已经导出过"的假记录，
 * 否则下一次「仅改动」会漏掉这批文件。
 */

export interface ExportOptions {
	settings: PluginSettings;
	log: Logger;
	vaultRoot: string;
	vaultName: string;
	stateFile: string;
	/**
	 * 导哪种包：`full` 完整副本 / `changes` 更新包。
	 *
	 * 从前是从设置里读一个"默认类型"下拉框，但那是**互斥**的语义 ——
	 * 用户要的是"完整包和更新包各是一个独立选项，可以都要"。
	 * 所以改成由调用方明确指定，一次调用导一种，要两种就调两次。
	 */
	mode: 'full' | 'changes';
	/**
	 * **这次更新包从哪个状态开始**：`null` / 不填 ＝ 我状态里那份最新的（原来的行为）；
	 * 给一个**基准指纹**（16 位十六进制）＝ 接着**那一份**完整副本往后算。
	 *
	 * 为什么给指纹而不是世代号：世代号说的是"内容走到第几版"，两边的"第 32 代"
	 * 完全可能是两份不同的完整副本（用户实测踩过：按代选锚，对面报「基准对不上」）。
	 * 指纹（`bundle/baseline.ts`）才是"这是哪一份东西"的判据 —— 也就是对方
	 * 「更新记录」顶上那行「基准：第 N 代 · 指纹 xxxx」里那个值。
	 *
	 * **找不到那一份时明确报错**，绝不悄悄换一份：包头部记的 `baseGeneration` /
	 * `baselineHash` 决定接收方怎么比对，偷偷换一份等于骗它。
	 */
	baseFingerprint?: string | null;
	/**
	 * **这次更新包到哪个状态为止**：`null` / 不填 ＝ 最新（当前仓库）。
	 *
	 * 给一个基准指纹 ＝ 送到**那一份完整副本记着的那一刻**：内容取自那份包的负载
	 * （不是你现在的仓库 —— b 那一刻的版本可能早就被改过了）。于是能导一份
	 * "从 a 到 b"的差量包：对方站在 a 上，收下就正好等于 b，状态编号当场对得上。
	 *
	 * 同样：**找不到就报错**，不悄悄改成"到最新" —— 那会把内容完全不同的包发给对方。
	 */
	toFingerprint?: string | null;
	/** 同步包文件夹；实际会写进它的 `full` / `changes` 子目录 */
	outDir: string;
	/**
	 * **这次导出的起点改成这一份清单**（`ui/bundle-modal.ts` 的"应用前先把本机改动存成包"会填）。
	 *
	 * 平时起点是"我站的这一点"（`state.bundle.fullFiles`），从磁盘上找；这里给的是一份
	 * **合成出来的点**，磁盘上没有它对应的包 —— 它是"我马上要应用的那份包**送到**的那一点"
	 * （更新包：我这点 ＋ 它的条目 − 它点名的删除；完整副本：它自己的清单）。
	 *
	 * 为什么要这么绕：严格同步会把我这儿"它那份里没有 / 跟它不一样的"东西全部换掉，
	 * 而这些**未必相对我自己的点算得出改动**。用户报过的现场：我这一点上有、对方那份完整副本里
	 * 没有的文件（我本地压根没动过它），按"我自己的点"算 `picked` 是空的 —— 存出来的包是**空的**，
	 * 等于什么都没存，而那条 `cp` 已经把它镜像走了。换成"以它送到的那一点为起点"之后，
	 * 这一环就是 **新点 → 新点 ＋ 我的东西**：我自己应用它＝把东西加回来，
	 * 发给对方（他站在新点上）应用＝同理。
	 */
	anchorOverride?: BundleAnchor;
	/**
	 * **本机什么都不推进**（与差量包一样）。
	 *
	 * 什么时候要：内容是"我现在的仓库"，但这一环送到的那一点**不是我导完之后站的点** ——
	 * 应用前存下的那一份就是（存完还要去应用对方的包，落点是对方那一点）。
	 */
	frozen?: boolean;
	/** 配置目录名（运行时才知道，用户可能改过） */
	configDir?: string;
	/**
	 * **这些路径这一趟不用管**（`parkLocalChangesFor` 用它排掉"对方那份包已经处理了的"）。
	 *
	 * 为什么要排：存包时的起点是"对方那份包**送到**的那一点"，于是"我本地跟它不一样"的文件里
	 * 混着两种东西 —— **我改过的**（要存进包 ✓）和**我压根没动、只是比对方旧**的（对方包里
	 * 已经带上了新版本，马上就会被换成那一版 ✗）。后一种存进包只会帮倒忙：这一环再被应用时
	 * 会把对方的新版本**改回我的旧版本**。排掉它们之后剩下的正好是"我这一半"。
	 */
	skipPaths?: Iterable<string>;
	/**
	 * **这些路径的内容不在仓库里**（内容指纹照这份表取）。
	 *
	 * 用在"起点是合成的那一份"上（`anchorOverride`）：被对方那份包覆盖的路径上，
	 * 落点是**对方那一版**，而仓库里还是改动前的旧版本 —— 照仓库读会算出一个描述别的状态的编号。
	 */
	stateIdHashes?: ReadonlyMap<string, string>;
	/**
	 * 已经扫好的仓库清单。
	 * 同步刚扫完的话直接传进来复用 —— 少一次全库遍历，自动留包就几乎不花时间。
	 */
	inventory?: Inventory;
	/**
	 * 一次导出多个包时，把**先导出来的那些**填进来。
	 *
	 * 完整包会清掉被它取代的旧更新包；万一哪个调用方反过来先导了更新包，
	 * 不把它排除掉的话，用户明明两个都勾了、最后却只剩完整包一个。
	 * 现在两条调用链都按 `plannedExportModes` 先导完整包，所以这是一道保险。
	 */
	keepPaths?: string[];
	/**
	 * 这一条导出记录**为什么而来**（写进「更新记录」那一行）。
	 *
	 * 流程自己发起的那次导出要写：应用前"先把我的改动存成包"——
	 * 不写的话用户在更新记录里看到一条来路不明的导出，会以为插件在乱写包
	 * （用户报过"我没看到改动的包"，当时就是没法从记录里认出哪一条是它）。
	 */
	logNote?: string;
	/**
	 * 进度回调：`done / total` ＝ **已经打进包里的文件数 / 总文件数**，从 0 数到总数。
	 *
	 * 内部还有一步"算指纹"（给接收方做三方合并用），但那跟用户没关系、不占数字：
	 * 用户看到的就该是"这些文件打包了多少个"。
	 */
	onProgress?: (done: number, total: number, file: string) => void;
}

export interface ExportOutcome {
	/** null ＝ 没有内容可导出（仅改动模式下没有任何变化） */
	file: string | null;
	reason?: string;
	entryCount: number;
	deletedCount: number;
	/** 包里一共有多少个文件夹（含空文件夹） */
	dirCount: number;
	/** 其中空文件夹几个（这些是"不记就传不过去"的那些） */
	emptyDirCount: number;
	payloadBytes: number;
	durationMs: number;
	header: BundleHeader | null;
	/** 上一个包的 ID：界面上用来提示"对方该接的是这个" */
	parentBundleId: string | null;
	/** 实际写到磁盘上的文件大小 */
	fileBytes: number;
	/** 是不是"从一个基准点一次带到最新"的更新包（差量包不算：它送到的是另一份完整副本） */
	cumulative: boolean;
	/**
	 * 这个包**从哪一个基准点来**（完整包为 null：它自己就是那个点）。
	 * 界面上要写出来：光有世代号对不上号，指纹 + 状态编号才认得出是对方站的哪一点。
	 */
	anchor: ExportAnchor | null;
	/** 这次顺手删掉了哪些旧环（同一环重导的 / 被完整副本取代的，文件名，已排序） */
	superseded: string[];
	/**
	 * 留着没删的更新包，以及为什么（链条上的另一环 / 别的血脉 / 世代不比新包小）。
	 * 界面上要如实说明 —— 不然用户会以为"清理开关没生效"，或者当成偶发 bug（报过）。
	 */
	keptChanges: { name: string; why: string }[];
}

/** 清理旧环的结果：删了哪些、留了哪些（留的要说清原因） */
export interface SupersededReport {
	removed: string[];
	kept: { name: string; why: string }[];
}

/**
 * **起点是怎么定下来的** —— 界面上要说清"这一份为什么从这一点往外导"。
 *
 * 默认那条路（用户拍板："我希望更新有严格顺序，所以应该基于最新基准点"）是**自动接线头**：
 * 应用完整副本回退到老一点之后再导出，接的是这条线的最新点（第 54 代），而不是本机站的
 * 那一点（第 39 代）——否则会从 39 分出一条岔、还会撞上历史上用过的号。
 */
export interface ExportStartInfo {
	/**
	 * - `auto`：自动接在这条线的**最新点**后面（本机落在后面时）；
	 * - `explicit`：用户在下拉里指定了起点；
	 * - `self`：从**我站的这一点**往外导（我就是线头，或者线头接不上 —— 见 `problem`）。
	 */
	picked: 'auto' | 'explicit' | 'self';
	/** 我站的这一点（还没有基准点时 null） */
	mine: { generation: number; hash: string; name: string } | null;
	/** 自动接上的那个线头（`picked === 'auto'` 时才有） */
	head: { generation: number; hash: string; name: string } | null;
	/** 为什么没接线头（正常时为 null）：中间缺几份包、那份完整副本不在目录里… */
	problem: string | null;
}

/** 更新包基于的那份完整副本（界面上把"第几代 + 基准指纹 + 状态编号 + 包名"都写出来） */
export interface ExportAnchor {
	/** 起点：从第几代开始 */
	generation: number;
	/**
	 * 起点那份完整副本的**基准指纹** —— 选起点要认的就是它：
	 * 对方「更新记录」顶上写着「基准：第 N 代 · 指纹 xxxx」，照那个选。
	 * （世代号说不出"我们是从哪一份完整副本分出来的"，只看代可能选到另一份东西 —— 用户实测踩过。）
	 */
	hash: string | null;
	file: string | null;
	name: string | null;
	/** 起点那份完整包记的状态编号（旧版本导的包没有 → null） */
	stateId: string | null;
	/** 终点到哪儿：`checkpoint` ＝ 某一份完整副本那一刻（不是当前仓库） */
	checkpoint: boolean;
	/** 终点世代：接收方应用之后到达的世代 */
	targetGeneration: number;
	/** 终点那份完整副本的基准指纹（只有差量包有） */
	targetHash: string | null;
	/** 起点是怎么定下来的（自动接线头 / 用户指定 / 从我站的这一点） */
	start?: ExportStartInfo;
}

/** 文件名里不能有的字符换成下划线（仓库名可能含 : / 之类） */
function safeName(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'vault';
}

/**
 * 这些文件路径涉及到的**所有上级目录**（有文件的目录会随文件写入被顺带建出来，
 * 所以它们不算"空文件夹"）。差量包按终点那份包的清单算，普通包按当前仓库算。
 */
function dirsContainingPaths(paths: Iterable<string>): Set<string> {
	const covered = new Set<string>();
	for (const file of paths) {
		let dir = dirnameRel(file);
		while (dir) {
			if (covered.has(dir)) break;
			covered.add(dir);
			dir = dirnameRel(dir);
		}
	}
	return covered;
}

/**
 * 一次要导两种时**先导哪个**：**先完整副本、后更新包**。
 *
 * 顺序曾经是反的（先更新、后完整），那样会演出一幕很怪的戏：先按老基准算出一个更新包
 * ——顺手把上一个更新包当成"被它取代的旧包"清掉——再导完整副本。用户看到的
 * 是"我那个老包没了，然后又生成了一个一模一样的"。
 *
 * 而完整副本一写完，它自己就是最新的基准：这时更新包按它算**必然是空的**。
 * 写一个谁都用不上的空包（接收方应用它什么也不会发生，还让人以为漏了什么），
 * 不如不写、并说清楚为什么。要"一个小文件传出去"就单独勾更新包，别同时勾完整副本。
 *
 * 两条调用链（手动导出弹窗 / 同步后的自动留包）都走这个函数，免得哪天又各写各的。
 */
export function plannedExportModes(want: { changes: boolean; full: boolean }): BundleMode[] {
	const modes: BundleMode[] = [];
	if (want.full) modes.push('full');
	if (want.changes) modes.push('changes');
	return modes;
}

/**
 * **仓库自上次导出以来动过没有**（判据与 `ui/actions.ts` 里"自动留包要不要写包"那条一致：
 * 大小 + 修改时间，2 秒容差；空文件夹也算）。
 *
 * 只给完整副本"要不要占新世代"用：没动过就说明这份内容上一代已经装过了，
 * 固化成基准是"换个基准"，不是"往前走一代"。
 * `state.bundle` 还没有时（第一次）算作动过 —— 那时确实是从零往前一步。
 */
function hasLocalChanges(state: PluginState, inventory: Inventory): boolean {
	const before = state.bundle?.files;
	if (!before) return true;
	if (inventory.files.size !== Object.keys(before).length) return true;
	for (const [file, record] of inventory.files) {
		const at = before[file];
		if (!at || !sameRecord(record, at, DEFAULT_MTIME_TOLERANCE_MS)) return true;
	}
	const dirs = new Set(state.bundle?.dirs ?? []);
	if (inventory.dirs.size !== dirs.size) return true;
	for (const dir of inventory.dirs) {
		if (!dirs.has(dir)) return true;
	}
	return false;
}

/**
 * **本机自基准以来改了什么** —— 只统计，不写盘。 *
 * 给"要不要换基准""立一份新完整包"这类决定用的：用户得先看到"我这边有多少东西
 * 是基准里没有的"，才知道换掉基准会不会把没传出去的改动留在一份老包上。
 * 判据与导出挑成员同一条（大小 + 修改时间，2 秒容差），所以数字跟"下一次导更新包
 * 会装几个文件"对得上。
 *
 * `null` ＝ 本机还没有基准（没导过、也没应用过完整副本），那就算不出来。
 */
export function describeLocalChanges(
	state: PluginState,
	inventory: Inventory,
): { changed: number; deleted: number } | null {
	const anchor = state.bundle?.fullFiles ?? null;
	if (!anchor) return null;
	let changed = 0;
	let deleted = 0;
	for (const [file, record] of inventory.files) {
		const at = anchor[file];
		if (!at || !sameRecord(record, at, DEFAULT_MTIME_TOLERANCE_MS)) changed++;
	}
	for (const file of Object.keys(anchor)) {
		if (!inventory.files.has(file)) deleted++;
	}
	return { changed, deleted };
}

/** 一次导出"要装什么"的挑选结果，连同后续要用的基准数据（**不写盘**） */
interface BundleWork {
	state: PluginState;
	inventory: Inventory;
	/** 上次导出（任何类型）时仓库的样子：每个条目的 `base` —— 接收方最可能就停在这个版本 */
	previous: Record<string, FileRecord>;
	/** 这次更新包**从哪个状态**开始（一份完整副本）；还没立过基准时是 null */
	anchor: BundleAnchor | null;
	/** 起点是怎么定下来的（自动接线头 / 用户指定 / 从本机这一点）—— 界面上要说清 */
	start: ExportStartInfo | null;
	/**
	 * 这次更新包**到哪个状态为止**：
	 * - `null` ＝ 最新（当前仓库，含刚改的东西）—— 默认；
	 * - 有值 ＝ 另一份完整副本：导的是"从起点到那一份"的差量，内容取自那份包的负载。
	 */
	target: BundleAnchor | null;
	/**
	 * 条目 / 删除项的 `base` 从哪儿取：
	 * - `anchor`：**这次明确指定了起点**（`options.baseGeneration`）—— 对方就站在那份完整副本上，
	 *   它手里是这个文件的哪一版，只有那份清单知道（拿"我上次导出的样子"当 base 会把
	 *   对方正常的旧版本误判成"它也改过"，满屏冲突副本）；
	 * - `previous`：默认那条路 —— 接收方**最可能**停在我上次导出的那一版上（原行为，不动）。
	 */
	baseFrom: 'anchor' | 'previous';
	/** 自上次完整包以来各文件经历过的中间版本 */
	history: Record<string, FileRecord[]>;
	picked: string[];
	deleted: BundleDeletedEntry[];
	/**
	 * 这一份"从 a 到 b"的差量包**已经导过了**（`changes/` 里躺着一份一模一样的）：
	 * 记下那份包的文件名，调用方据此不重复生成（内容由两份完整包决定，重导只是白写一遍）。
	 */
	existing: string | null;
}

/**
 * 这次更新包**从哪个状态**开始（**只读**）。
 *
 * 默认（没指定）＝ 状态里那份最新的，行为与以前完全一致，一个包都不多读。
 * 指定了指纹时去**磁盘上**把那份完整包找回来（完整副本是还原点，一直躺在 `full/` 里）；
 * 找不到就报错 —— 换成"最新那份"会让包头部记错基准，接收方按它比对只会得出错误结论。
 */
async function resolveAnchor(options: ExportOptions, state: PluginState): Promise<BundleAnchor | null> {
	// 调用方合成的起点（"我马上要应用的那份包送到的那一点"）：磁盘上没有它，直接用它
	if (options.anchorOverride) return options.anchorOverride;
	const fromState: BundleAnchor | null = state.bundle?.fullFiles
		? {
			generation: state.bundle.fullGeneration ?? state.generation,
			hash: state.bundle.fullHash ?? null,
			files: state.bundle.fullFiles,
			emptyDirs: [],
			name: state.bundle.fullFile ?? '（状态里记着的那份完整副本，磁盘上已找不到）',
			file: '',
			stateId: state.stateId ?? null,
			mtime: 0,
		}
		: null;

	const requested = options.baseFingerprint ?? null;
	if (requested === null) return fromState;
	// 要的就是我自己这份基准：直接用状态里的清单（那份包文件被挪走 / 删了也照样能算）
	if (fromState && fromState.hash === requested) return fromState;

	const anchors = await listFullAnchors(options.outDir, state.lineage);
	const found = pickAnchor(anchors, requested);
	if (found) return found;

	// 链条上的点（某份更新包落出的那一点）：清单沿链条叠加算出来
	const point = materializePointSync(options.outDir, state.lineage, requested);
	if (point) return anchorOfPoint(point);

	const refs = listPointRefsSync(options.outDir, state.lineage);
	throw new Error(
		`「更新包从哪个状态开始」选的是基准 ${requested}，但这个文件夹里没有这一个状态。`
		+ `${describeAnchorList([...anchors, ...refs])}。`
		+ '先把那份包拷进来（或从回收站捞回来），'
		+ '或者把设置里「从哪个状态开始」改回「自动」',
	);
}

/** `resolveStart` 的结论：拿哪一点当起点、base 从哪儿取、界面上怎么说 */
interface StartResolution {
	anchor: BundleAnchor | null;
	/** 条目的 `base` 取起点清单里的版本（起点不是我站的这一点时必须这样） */
	fromAnchor: boolean;
	info: ExportStartInfo;
}

/**
 * 这次更新包**从哪一点往外导**（只读）—— 三种来路，一处说了算：
 *
 * 1. **合成的起点**（`anchorOverride`：应用前"先把我的改动存成包"那一趟）；
 * 2. **用户在下拉里指定了起点**（`baseFingerprint`）：走老那条路，找不到就报错；
 * 3. **默认：自动接在这条线的最新点后面**（用户拍板："我希望更新有严格顺序，
 *    所以应该基于最新基准点"）。我本来就是线头时 `planAutoStart` 给出 `head: null`，
 *    于是与老行为**完全一样**（从我站的这一点往外导）；只有"我落在后面"时才接上线头 ——
 *    回退到第 39 代之后再导出，接的是这条线的最新点（第 54 代），不是从 39 分出一条岔。
 *
 * 线头算不出来（中间那几环被清掉、那份完整副本不在目录里）时**退回我站的这一点**，
 * 并把原因放进 `info.problem`（界面上如实说一句）；号仍然从高水位往后发，不会撞号。
 */
async function resolveStart(options: ExportOptions, state: PluginState): Promise<StartResolution> {
	const mine = state.bundle?.fullHash
		? {
			generation: state.bundle.fullGeneration ?? state.generation,
			hash: state.bundle.fullHash,
			name: state.bundle.fullFile ?? '（状态里记着的那份包）',
		}
		: null;

	// ① 合成的起点：磁盘上没有它，直接用它（界面上不显示"起点是怎么来的"）
	if (options.anchorOverride) {
		return {
			anchor: options.anchorOverride,
			fromAnchor: true,
			info: { picked: 'self', mine, head: null, problem: null },
		};
	}
	// ② 明确指定了起点：找不到就报错，绝不悄悄换一份（包头部记的基准决定接收方怎么比对）
	if (options.baseFingerprint !== null && options.baseFingerprint !== undefined) {
		return {
			anchor: await resolveAnchor(options, state),
			fromAnchor: true,
			info: { picked: 'explicit', mine, head: null, problem: null },
		};
	}

	// ③ 默认：接在这条线的最新点后面
	const plan = await planAutoStart(options.outDir, state);
	if (plan.head && plan.head.hash !== mine?.hash) {
		try {
			const anchor = await resolveAnchor({ ...options, baseFingerprint: plan.head.hash }, state);
			if (anchor) {
				return { anchor, fromAnchor: true, info: { picked: 'auto', mine: plan.mine, head: plan.head, problem: null } };
			}
		} catch {
			// 线头那一点算不出来（缺环 / 缺那份完整副本）：往下走，退回"我站的这一点"
		}
		return {
			anchor: await resolveAnchor(options, state),
			fromAnchor: false,
			info: {
				picked: 'self',
				mine: plan.mine,
				head: null,
				problem: plan.problem
					?? '这条线的最新点算不出来（中间那几份包不在包目录里）：这一份只能从你站的这一点往外导',
			},
		};
	}
	return {
		anchor: await resolveAnchor(options, state),
		fromAnchor: false,
		info: { picked: 'self', mine: plan.mine, head: null, problem: plan.problem },
	};
}

/**
 * 这次更新包**到哪个状态**为止（**只读**）。
 *
 * `null` ＝ 最新（当前仓库）；给了指纹就得在磁盘上找到那一份完整副本 ——
 * 找不到同样报错，不能悄悄改成"到最新"：那会把一份**内容完全不同**的包发给对方。
 */
async function resolveTarget(options: ExportOptions, state: PluginState): Promise<BundleAnchor | null> {
	const requested = options.toFingerprint ?? null;
	if (requested === null) return null;
	const anchors = await listFullAnchors(options.outDir, state.lineage);
	const found = pickAnchor(anchors, requested);
	if (found) return found;

	// 链条上的点：内容散在链条上好几份包里，`sources` 会告诉导出那条路每个文件去哪取
	const point = materializePointSync(options.outDir, state.lineage, requested);
	if (point) return anchorOfPoint(point);

	const refs = listPointRefsSync(options.outDir, state.lineage);
	throw new Error(
		`「更新包到哪个状态为止」选的是状态 ${requested}，但这个文件夹里没有这一个状态。`
		+ `${describeAnchorList([...anchors, ...refs])}。`
		+ '先把那份包拷进来（或从回收站捞回来），'
		+ '或者把设置里「到哪个状态为止」改回「最新（当前仓库）」',
	);
}

/**
 * 算这次要装什么（**纯计算，不写盘**）。
 *
 * `exportBundle` 与「导出预览」共用它 —— 预览要能把"会装进去哪些文件、会点名删哪些"
 * 摊开给人看；两条路各写一遍挑选逻辑的话，迟早会出现"预览说一套、实际导另一套"。
 */
async function prepareBundle(options: ExportOptions, mode: BundleMode): Promise<BundleWork> {
	const exclude = excludePatterns(options.settings.excludePatterns, options.configDir);
	const state = await loadState(options.stateFile);
	const inventory = options.inventory
		?? await scanTree(options.vaultRoot, { exclude, skipTopLevelDirs: [VAULT_TRASH_DIR] });

	/** 上次导出（任何类型）时仓库的样子：用来当每个文件的 base —— 接收方最可能就是这个版本 */
	const previous = state.bundle?.files ?? {};
	/**
	 * 这次更新包**从哪一点往外导**（只读）。默认是**自动接在这条线的最新点后面**：
	 * 我本来就是线头时与老行为完全一样（从我站的这一点往外导）；只有"我落在后面"
	 * （回退过 / 没跟上）时才不同 —— 见 `resolveStart` 与 `anchor.ts` 的 `planAutoStart`。
	 */
	const start = mode === 'changes' ? await resolveStart(options, state) : null;
	const anchor = start?.anchor ?? null;
	/** 这次更新包到哪个状态为止（null ＝ 最新，也就是当前仓库） */
	const target = mode === 'changes' ? await resolveTarget(options, state) : null;
	/** 自上次完整包以来各文件经历过的中间版本 */
	const history = state.bundle?.history ?? {};
	/**
	 * 条目 / 删除项的 `base` 从哪儿取：
	 * - `anchor`：**明确指定了起点**（下拉里选的 / 自动接上的线头 / 合成的起点）—— 接收方就站在
	 *   那一点上，它手里是这个文件的哪一版只有那份清单知道（拿"我上次导出的样子"当 base 会把
	 *   对方正常的旧版本误判成"它也改过"，满屏冲突副本）；
	 * - `previous`：默认那条路（起点就是我站的这一点）—— 接收方**最可能**停在我上次导出的那一版上。
	 */
	const baseFrom: 'anchor' | 'previous' = start?.fromAnchor === true ? 'anchor' : 'previous';
	const anchorFiles = anchor?.files ?? null;

	if (mode === 'changes' && !anchorFiles) {
		throw new Error(
			'还没导出过完整副本：更新包是"从某个状态到某个状态"的差量，没有起点就没法算。'
			+ '请先用「完整副本」导一次（对方也必须先应用它）',
		);
	}

	// ------------------------------------------------------ 挑出要装进包的文件
	const picked: string[] = [];
	const deleted: BundleDeletedEntry[] = [];
	/** 这一趟不用管的路径（见 `ExportOptions.skipPaths`）：起点/终点两侧的比较都跳过它们 */
	const skip = new Set(options.skipPaths ?? []);
	const pushDeleted = (file: string, base: FileRecord) => {
		if (skip.has(file)) return;
		const baseHash = cachedHash(state, file, base);
		deleted.push({
			path: file,
			baseSize: base.size,
			baseMtime: base.mtime,
			...(baseHash ? { baseHash } : {}),
		});
	};

	if (mode === 'full') {
		picked.push(...[...inventory.files.keys()].filter(file => !skip.has(file)));
	} else if (target) {
		// 「从 a 到 b」的差量：两边都是**完整清单**，直接比两份清单 ——
		// 跟当前仓库没关系（b 那一刻的内容可能早就被改过了，它只存在于 b 那份包里）。
		for (const [file, atTarget] of Object.entries(target.files)) {
			if (skip.has(file)) continue;
			const atAnchor = anchorFiles?.[file];
			if (!atAnchor || !sameRecord(atTarget, atAnchor, DEFAULT_MTIME_TOLERANCE_MS)) picked.push(file);
		}
		for (const [file, atAnchor] of Object.entries(anchorFiles ?? {})) {
			if (target.files[file]) continue;
			// 到 b 为止它已经不在了 → 点名删除；站在 a 上的接收方手里就是 a 那一版
			pushDeleted(file, atAnchor);
		}
	} else {
		// 成员：自**起点那一点**以来变过的 —— 默认起点就是"我站的这个基准点"，
		// 于是这一环只装自上一环以来的新改动（链条就是这么一环一环往外长的）。
		// 明确指定了老起点时，"变过"相对那份老清单算，这一份就把中间那几代一起带上（赶超包）。
		for (const [file, record] of inventory.files) {
			if (skip.has(file)) continue;
			const atAnchor = anchorFiles?.[file];
			if (!atAnchor || !sameRecord(record, atAnchor, DEFAULT_MTIME_TOLERANCE_MS)) picked.push(file);
		}
		// 删除清单同理：自起点以来"没了"的文件
		for (const [file, atAnchor] of Object.entries(anchorFiles ?? {})) {
			if (inventory.files.has(file)) continue;
			// base：站在起点的接收方手里就是起点那一版；默认那条路仍用"上次导出时的样子"
			// （更贴近接收方手里的版本），没有就用完整包时的
			pushDeleted(file, baseFrom === 'anchor' ? atAnchor : (previous[file] ?? atAnchor));
		}
	}
	picked.sort();

	// 「从 a 到 b」的包，内容由**两份完整包**决定，重导只会写出一个一模一样的文件 ——
	// 已经躺在 changes/ 里就直说，别写（自动留包那条路尤其要紧：它会一轮接一轮地跑）
	const existing = target ? await findExistingCheckpoint(options, state, anchor, target) : null;

	return { state, inventory, previous, anchor, start: start?.info ?? null, target, baseFrom, history, picked, deleted, existing };
}

/**
 * 已经导过这一份"从 a 到 b"的包了吗：`changes/` 里有没有一份**同一个起点、同一个终点、
 * 同一份终点内容**的更新包（终点那份完整副本被重导过 → 状态编号变了 → 不算同一份）。
 *
 * 为什么靠"翻目录"而不是记在状态里：状态文件每轮同步都要读写，能少一个字段就少一个；
 * 而包就在手边，条件完全可以从它自己身上看出来。删掉那个包就能重新导一份。
 */
async function findExistingCheckpoint(
	options: ExportOptions,
	state: PluginState,
	anchor: BundleAnchor | null,
	target: BundleAnchor,
): Promise<string | null> {
	const dir = bundleDirForMode(options.outDir, 'changes');
	for (const item of await listFiles(dir)) {
		if (!item.name.toLowerCase().endsWith(BUNDLE_EXT)) continue;
		try {
			const header = (await readBundleInfo(path.join(dir, item.name))).header;
			if (header.mode !== 'changes' || header.lineage !== state.lineage) continue;
			if (header.baseGeneration !== (anchor?.generation ?? null)) continue;
			if (header.targetGeneration !== target.generation) continue;
			if ((header.stateId?.id ?? null) !== (target.stateId?.id ?? null)) continue;
			return item.name;
		} catch {
			// 读不出头部：不是我们的包，跳过
		}
	}
	return null;
}

/** 「导出预览」要看的东西：这次会装哪些文件、点名删哪些、大概多大 */
export interface BundleExportPreview {
	mode: BundleMode;
	fileCount: number;
	deletedCount: number;
	bytes: number;
	/** 会装进包里的文件（界面只列前若干个，其余报个数） */
	files: string[];
	/** 点名要删的文件（更新包才有意义） */
	deleted: string[];
	/** 更新包基于的那份完整副本是第几代；null ＝ 还没立过基准 */
	anchorGeneration: number | null;
	/** 那份完整副本的**基准指纹** —— 选起点认的就是它（跟对方「更新记录」里那个对得上） */
	anchorFingerprint: string | null;
	/** 那份完整副本的文件名（界面上对得上号） */
	anchorName: string | null;
	/** 终点：null ＝ 最新（当前仓库）；有值 ＝ 送到那份完整副本那一刻（差量包） */
	targetGeneration: number | null;
	targetName: string | null;
	/** 这一份"从 a 到 b"的包已经导过了（同名文件还在）：不会重复生成 */
	existing: string | null;
	/** 起点是怎么定下来的（自动接线头 / 用户指定 / 从本机这一点） */
	start: ExportStartInfo | null;
	/** 算不出来时的原因（例如"还没导过完整副本"）：预览照样打开，把原因写在界面上 */
	problem?: string;
}

/**
 * 只算不写：`sync-preview` 命令与「导出预览」窗口用它。
 *
 * 算不出来（最典型的是"更新包还没有基准"）时**不抛错** —— 预览的职责是把情况说清楚，
 * 而不是甩一条异常给调用方。
 */
export async function planBundleExport(options: ExportOptions): Promise<BundleExportPreview> {
	try {
		const work = await prepareBundle(options, options.mode);
		let bytes = 0;
		for (const file of work.picked) {
			bytes += work.target ? (work.target.files[file]?.size ?? 0) : (work.inventory.files.get(file)?.size ?? 0);
		}
		return {
			mode: options.mode,
			fileCount: work.picked.length,
			deletedCount: work.deleted.length,
			bytes,
			files: work.picked,
			deleted: work.deleted.map(item => item.path),
			anchorGeneration: work.anchor?.generation ?? null,
			anchorFingerprint: work.anchor?.hash ?? null,
			anchorName: work.anchor?.name ?? null,
			targetGeneration: work.target?.generation ?? null,
			targetName: work.target?.name ?? null,
			existing: work.existing,
			start: work.start,
		};
	} catch (error) {
		return {
			mode: options.mode,
			fileCount: 0,
			deletedCount: 0,
			bytes: 0,
			files: [],
			deleted: [],
			anchorGeneration: null,
			anchorFingerprint: null,
			anchorName: null,
			targetGeneration: null,
			targetName: null,
			existing: null,
			start: null,
			problem: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function exportBundle(options: ExportOptions): Promise<ExportOutcome> {
	const started = Date.now();
	const { mode } = options;
	const work = await prepareBundle(options, mode);
	const { state, inventory, previous, anchor, start, target, baseFrom, history, picked, deleted, existing } = work;
	/** 终点是一份完整副本（差量包）：内容取自那份包，结束时到达它的世代 */
	const checkpoint = target !== null;
	/**
	 * **本机什么都不推进**：差量包（内容不是我现在的仓库），以及"应用前先把本机改动存成包"
	 * 那一趟（`frozen`：内容是我现在的仓库，但这一环送到的那一点不是我导完之后站的点）。
	 */
	const frozen = checkpoint || options.frozen === true;
	/**
	 * **这一刻整个仓库的状态编号**（内容指纹，见 `sync/state-id.ts`）：
	 * 既写进包头部（接收方应用完对账用），也用来判"内容动没动"。
	 * - **差量包**：用它送到的那份包记着的编号（它不是我现在的仓库）；
	 * - **起点是合成的那种**（应用前存下的那一份）：照**落点**算（`landedPoint` ＝ 合成起点
	 *   ＋ 进包的文件 − 点名的删除），那些"不在仓库里"的版本用包条目里带的指纹（`stateIdHashes`）；
	 * - 其余：照现在的仓库算。
	 */
	const landedPoint = landedPointOf(mode, checkpoint, target, anchor, inventory, picked, deleted);
	const stateIdInfo: StateIdInfo | null = checkpoint
		? (target?.stateId ?? null)
		: options.anchorOverride
			? await computeStateId({
				vaultRoot: options.vaultRoot,
				state,
				files: Object.entries(landedPoint),
				dirs: landedDirsOf(options.anchorOverride, landedPoint),
				...(options.stateIdHashes ? { hashes: options.stateIdHashes } : {}),
			})
			: await computeStateId({
				vaultRoot: options.vaultRoot,
				state,
				files: inventory.files,
				dirs: inventory.dirs,
			});
	/**
	 * **仓库自上次导出以来动过没有。**
	 *
	 * 判据是**内容**（状态编号），不是"大小 + 修改时间"：文件被别的东西碰了一下
	 * （网盘同步、编辑器重写、`touch`）时，大小和修改时间会变、**内容一个字都没变** ——
	 * 用户的原话："导出完整副本本身根本不改变内容，不应该增加世代"。
	 * 拿记录判会为这种"没变的内容"白占一个世代号，两边的号又对不上。
	 * （状态里没有编号的旧状态文件退回按记录判，保守。）
	 */
	const moved = state.stateId
		? stateIdInfo !== null && stateIdInfo.id !== state.stateId.id
		: hasLocalChanges(state, inventory);
	/**
	 * **手里的包就是这个血脉的账本**：同一份内容报过的最小号 —— 状态里那个号被旧版本撑大了就照它改回来。
	 */
	const smallestForPoint = await smallestGenerationOf(options.outDir, state.lineage, state.bundle?.fullHash ?? null);
	/**
	 * **同一份内容只有一个世代号** —— 状态里那个号可能已经被旧版本撑大了，先照手里的包改回来。
	 *
	 * 为什么会撑大（用户报的）：他那边把「更新包从哪个状态开始」钉在第 39 代（对面还在 39），
	 * 于是**每次自动留包都重导一遍同一份内容**，而更新包是无条件 `+1` 的 ——
	 * 39→48 / 39→49 / 39→50 三份包状态编号一模一样、世代号却一路涨，
	 * 对面应用完永远对不上（"内容没变代数就不应该变，但实际每次导出包就多一代"）。
	 *
	 * 手里这些包就是"内容 ↔ 世代号"的账本：谁报过**我这站这一点**（`fullHash`）、报的是几代，
	 * 取最小的那个 —— 完整副本报的是它自己那一刻，更新包报的是它的落点，两边都算数。
	 */
	if (!frozen && state.bundle?.fullHash) {
		const known = smallestForPoint;
		if (known !== null && known < state.generation) {
			options.log.debug(
				`世代号改回第 ${known} 代：手里有包报过同一份内容（状态里记的是第 ${state.generation} 代；`
				+ '同一份内容只能有一个号，见 export.ts 里那段）',
			);
			state.generation = known;
			state.bundle.fullGeneration = known;
			// 高水位也跟着回到真号（它只会被抬高，所以这里只能"不低过已知的真号"）——
			// 旧版本留下的错号不该继续占着号段
			raiseGeneration(state, known);
		}
	}
	/**
	 * **新内容从第几号往后发**：手里的高水位 ＋ 当前这一点 ＋ **这次要接上去的起点**。
	 *
	 * 三样都要看：
	 * - 高水位：这个血脉里发过的最大号（回退不会把它拉低，见 `sync/state.ts` 的 `maxGeneration`）；
	 * - `state.generation`：我站的这一点（旧状态文件没有高水位时的兜底）；
	 * - **`anchor.generation`**：这次接的那一点 —— 回退之后接在线头（第 54 代）后面导出时，
	 *   新号从 54 往后，而不是从我这个老点（第 39 代）往后。
	 */
	const highWater = Math.max(state.maxGeneration ?? 0, state.generation, anchor?.generation ?? 0);
	/**
	 * 这一份包结束时到达的世代：
	 * - 差量包（终点是某份完整副本）＝**那份完整副本记着的那一代**（内容到它为止）；
	 * - 合成的起点（"应用前存的改动"那一环）＝**它送到的那一点 + 1**（不低于高水位）；
	 * - **仓库自上次导出以来没动过 → 沿用当前这一代**：内容与上次打包时一模一样，
	 *   它就是同一版内容，一代都不该多占（完整副本如此，**更新包同样如此** ——
	 *   把起点钉在老状态上时，每次自动留包都会重导同一份内容，见上面 `moved` 那段）。
	 *   回退之后**什么都不改**就导出时也走这一条：那一份落到的是你已经站着的那个老点，
	 *   号就是那个老点的号（"把大家带回第 39 代"），不是新占一个号；
	 * - 其余（仓库动过）＝ **高水位 + 1**：正常情况（我就是线头）它就是"当前代 + 1"，与老行为一致；
	 *   **回退之后再导出**时它保证两件事：不撞历史上用过的号、接在线头后面 ——
	 *   回退到第 39 代、接在线头（第 54 代）后面导出的就是「54 → 55」，
	 *   而不是从 39 分岔的「39 → 40」（用户报的："这样会搞乱更新顺序产生分支"）。
	 */
	const targetGeneration = checkpoint
		? (target?.generation ?? highWater + 1)
		: options.anchorOverride
			? Math.max(highWater, anchor?.generation ?? state.generation) + 1
			: (!moved ? state.generation : highWater + 1);
	/** 报告里那段"从第几代 · 状态 · 到第几代"（完整包没有基准） */
	const anchorReport: ExportAnchor | null = mode === 'changes' && anchor
		? {
			generation: anchor.generation,
			hash: anchor.hash,
			file: anchor.file || null,
			name: anchor.name,
			stateId: anchor.stateId?.id ?? null,
			checkpoint,
			targetGeneration,
			targetHash: checkpoint ? (target?.hash ?? null) : null,
			// 起点是怎么定下来的（自动接线头时界面要写清"为什么从这一点往外导"）
			...(start ? { start } : {}),
		}
		: null;

	/** 没写包的那几种情况共用一份结果（省得每处抄一遍字段） */
	const emptyOutcome = (reason: string): ExportOutcome => ({
		file: null,
		reason,
		entryCount: 0,
		deletedCount: 0,
		dirCount: 0,
		emptyDirCount: 0,
		payloadBytes: 0,
		durationMs: Date.now() - started,
		header: null,
		parentBundleId: state.lastExportedBundleId,
		cumulative: true,
		anchor: anchorReport,
		fileBytes: 0,
		superseded: [],
		keptChanges: [],
	});

	if (mode === 'changes' && existing) {
		// 差量包的内容由**两份完整包**决定，重导只会写出一模一样的文件 —— 直说，别写
		options.log.debug(`更新包：第 ${anchor?.generation} → ${target?.generation} 代的差量包已经导过了（${existing}）`);
		return emptyOutcome(
			`这一份「第 ${anchor?.generation} → ${target?.generation} 代」的差量包已经导过了（${existing}），`
			+ '内容一模一样，没有重复生成；删掉那个包就能重导',
		);
	}

	if (mode === 'changes' && picked.length === 0 && deleted.length === 0) {
		options.log.debug('更新包：起点与终点之间没有任何变化');
		return emptyOutcome(checkpoint
			? `第 ${anchor?.generation} 代与第 ${target?.generation} 代之间没有任何变化，不需要导出`
			: `自第 ${anchor?.generation ?? '?'} 代完整副本以来没有任何变化，不需要导出`);
	}

	/**
	 * **自动接线头时"什么都没改" → 不导**（用户拍板的"严格顺序"那条边上的一格）：
	 * 回退本身不用发新包 —— 把那份完整副本发给对方应用就行（它自带完整清单）；
	 * 而你这边"自上次导出 / 应用以来一个字都没动"，接在线头后面导只会写出
	 * "把大家带回那个老点"的重复包，每导一次还重新生成一份。
	 *
	 * 只管**自动**选的那条路：用户在下拉里**明确钉住**一个老起点时照旧导出
	 * （那是"给我一份从那个点到现在的差量"的明确要求，测试 45/48 守着这条）。
	 */
	if (mode === 'changes' && !checkpoint && !options.anchorOverride && !moved && start?.picked === 'auto') {
		options.log.debug('更新包：自动接线头，但本机自上次导出以来没有改动 —— 不重复导出');
		return emptyOutcome(
			'你自上次导出以来没有改动：这一份接在线头后面也没新东西可发；'
			+ '回退本身把那份完整副本发给对方应用就够了'
			+ '（等你改出东西来再导，那一份会接在这条线的最新点后面）',
		);
	}

	/**
	 * 差量包（终点不是"最新"）：每个文件的内容**取终点那一刻的**，不是当前仓库的。
	 *
	 * 两个来源：
	 * - 终点是**链条上的一个点**（`points.ts` 算出来的）：`sources` 已经逐文件算好
	 *   "去哪份包的哪一段取" —— 改过的在那一环的包里，没动过的还在起点那份包里；
	 * - 终点是一份**完整副本**：读一次它的头部拿到负载起点，再按条目的 offset 取。
	 */
	let checkpointInfo: BundleInfo | null = null;
	const checkpointSources = new Map<string, { file: string; offset: number; size: number; mtime: number; hash?: string }>();
	if (checkpoint && target) {
		if (target.sources) {
			for (const [file, where] of target.sources) checkpointSources.set(file, where);
		} else {
			checkpointInfo = await readBundleInfo(target.file);
			for (const entry of checkpointInfo.header.entries) {
				checkpointSources.set(entry.path, {
					file: target.file,
					offset: checkpointInfo.payloadOffset + entry.offset,
					size: entry.size,
					mtime: entry.mtime,
					...(entry.hash ? { hash: entry.hash } : {}),
				});
			}
		}
	}

	// ------------------------------------------------------ 组装源文件清单
	// 中间版本记录：只留还在仓库里的文件；导出时把它带进包，导完再把这一版的 base 记进去
	const nextHistory: Record<string, FileRecord[]> = {};
	for (const [file, records] of Object.entries(history)) {
		if (inventory.files.has(file)) nextHistory[file] = records;
	}

	const sources: BundleSource[] = [];
	/** 进度的分母：**要打进包里的文件数**；分子是"已经打进去几个"，从 0 数到它 */
	const progressTotal = picked.length;
	// 开跑先报一次 0，并**强制让一帧**：数字得真的从 0 开始显示。
	// DOM 写进去要等浏览器拿到渲染机会才画得出来，不让这一帧就会被后面的循环挤掉。
	options.onProgress?.(0, progressTotal, picked[0] ?? '');
	await yieldToUi();
	let lastYieldAt = Date.now();
	for (const file of picked) {
		// 这一步（算指纹）不报进度：数字只认"打进包里几个文件"，见 writeBundle 那边的回调。
		// 循环本身是纯 CPU 的（命中缓存时一个 I/O 都没有），按时间让一帧，界面别僵住。
		lastYieldAt = await yieldIfDue(lastYieldAt);

		// base：**站在起点的接收方**手里是这一版。默认那条路取"我上次导出时的样子"
		// （接收方最可能停在那儿）；明确指定了起点时只能取那份清单里的版本 ——
		// 拿我上次导出的（更新的）那一版当 base，会把对方正常的旧版本误判成"它也改过"。
		const base = baseFrom === 'anchor' ? anchor?.files[file] : previous[file];
		const baseHash = base ? cachedHash(state, file, base) : null;
		// 中间版本：更早的那些（跳过包的人停在其中一个）
		const carried = nextHistory[file] ?? [];
		const baseFields = {
			...(mode === 'changes' && base ? { baseSize: base.size, baseMtime: base.mtime } : {}),
			...(mode === 'changes' && baseHash ? { baseHash } : {}),
			...(mode === 'changes' && carried.length > 0 ? { history: carried.map(item => ({ ...item })) } : {}),
		};

		if (checkpoint) {
			const where = checkpointSources.get(file);
			if (!where) continue;
			sources.push({
				path: file,
				// 内容不从仓库读：a→b 的包里装的是 **b 那一刻**的字节
				abs: '',
				from: { file: where.file, offset: where.offset },
				size: where.size,
				mtime: where.mtime,
				...(where.hash ? { hash: where.hash } : {}),
				...baseFields,
			});
			continue;
		}

		const record = inventory.files.get(file);
		if (!record) continue;
		const hash = await fingerprint(options.vaultRoot, state, file, record, true);
		sources.push({
			path: file,
			abs: toNative(options.vaultRoot, file),
			size: record.size,
			mtime: record.mtime,
			...(hash ? { hash } : {}),
			...baseFields,
		});

		// 这一版导出去之后，它就成了"以前的版本"，记进历史供下一个包使用
		if (mode === 'changes' && base && !carried.some(item => sameRecord(item, base, DEFAULT_MTIME_TOLERANCE_MS))) {
			nextHistory[file] = [...carried, { ...base }];
		}
	}

	const now = Date.now();
	const bundleId = randomUUID();
	/** 哪些目录"有文件"（它们的上级目录都算）：差量包按终点那份包的清单算 */
	const covered = dirsContainingPaths(checkpoint ? Object.keys(target?.files ?? {}) : [...inventory.files.keys()]);
	// 空目录：有文件的目录会随文件写入被顺带建出来，**空文件夹不记就永远传不过去**。
	// 差量包用的是**终点那份包记着的**空文件夹清单（它那一刻的样子），不是当前仓库的
	const emptyDirs = checkpoint
		? [...(target?.emptyDirs ?? [])].sort()
		: [...inventory.dirs].filter(dir => !covered.has(dir)).sort();

	/**
	 * 这一份包的**基准指纹**（见 `bundle/baseline.ts`）—— **导出前**那一刻我站的基准点：
	 * - 导完整包：包自己就是一份新基准，指纹由它自己的清单算出来（接收方也能重算，不信任头部）；
	 * - 导更新包：带上"我基于的**那一个基准点**"的指纹 —— 对方**必须站在这点上**才收得下
	 *   （我手里只有变过的那部分，算不出别人站的点在哪儿）。
	 *   指定了老起点时带的就是老那份的指纹：站在那份上的接收方一比正好是 `match`。
	 *   旧状态文件 / 旧包没有这个令牌就留空 → 对方判成"说不清"，界面会说明。
	 */
	const freshBaseline = listingHashOfFiles(landedPoint);
	const baselineHash = mode === 'full' ? freshBaseline : (anchor?.hash ?? null);

	/**
	 * **状态编号**：这一刻整个仓库长什么样的短指纹（见 `sync/state-id.ts`）。
	 *
	 * 写进包头部 → 接收方应用完算一个自己的跟它比：相同就是"两边文件内容一致"。
	 * 世代号做不到这件事（它只说内容走到第几版），用户提的
	 * "需要一个编号让用户能确定当前文件状态"就是这个。
	 *
	 * （真正算它的是函数开头那段 —— 它还要用来判"内容动没动"。这里只是说明它是什么。）
	 */
	/** 我自己的状态编号：不推进本机时不算（那不是我现在的仓库该报的数） */
	const ownStateId = frozen ? null : stateIdInfo;

	/**
	 * 文件名：**一眼能看出这是哪种包、从第几代到第几代、落到哪个状态**。
	 *
	 * ```
	 * 我的笔记-完整-36代-状态3f9a2c1d4e5f6a7b-e34cc7.lsave
	 * 我的笔记-更新-32代到37代-状态3f9a2c1d4e5f6a7b-5f4807.lsave
	 * ```
	 *
	 * 为什么改成这样：原来的 `xxx-full-20261005-191243-1d15cf.lsave` 只有"哪种包 + 什么时候"，
	 * 文件夹里攒了几个之后根本认不出谁是谁 —— 得逐个点开看报告才知道它接的是哪一代
	 * （用户提的："包起名太费解"）。现在：
	 * - **完整 / 更新**：中文，不用再猜 full / changes；
	 * - **第几代到第几代**：完整包写它立的基准世代；更新包写「起点代到终点代」——
	 *   终点就是接收方应用完到达的世代（差量包的终点是它送到的那一刻）；
	 * - **目标状态**：包头部记的那个状态编号（见 `sync/state-id.ts`）＝ **接收方应用完
	 *   应该落在哪个状态**。世代号说不出"这是哪一份完整副本"，状态编号才认得出是不是同一份东西；
	 *   对不上时打开列表一看便知（列表里每行也写着同一个编号）。
	 *
	 * **时间戳去掉了**（用户提的："状态后面那一长串数字没用"）：文件名里本来就只有"什么时候导的"
	 * 这一条信息，而列表里每一行都有修改时间、更新记录里也写着；一串 15 位数字反而把名字撑长。
	 * **同秒连导两个靠末尾那 6 位包 ID**（随机，不会撞）—— 这个名字只是给人看的，
	 * 认包一律读头部，改它不影响任何判断逻辑。
	 */
	const generationLabel = mode === 'full'
		? `${targetGeneration}代`
		: `${anchor?.generation ?? '?'}代到${targetGeneration}代`;
	const stateLabel = stateIdInfo?.id ? `状态${stateIdInfo.id}` : '状态未记';
	const file = path.join(
		bundleDirForMode(options.outDir, mode),
		`${safeName(options.vaultName)}-${mode === 'full' ? '完整' : '更新'}-${generationLabel}`
		+ `-${stateLabel}-${bundleId.slice(0, 6)}${BUNDLE_EXT}`,
	);

	/**
	 * **这个包一路上经过哪几个基准点**（不含起点与落点）：站在它们上面的机器照样收得下这个包
	 * （见 `BundleHeader.viaHashes` 与 `apply.ts` 的 `checkAncestor`）。
	 */
	const viaHashes = target?.hash && anchor?.hash && target.hash !== anchor.hash
		? await viaPointsFor(
			options,
			state,
			{ hash: anchor.hash, generation: anchor.generation },
			targetGeneration,
			landedPoint,
			new Set<string>([...sources.map(source => source.path), ...deleted.map(item => item.path)]),
		)
		: [];

	const { header } = await writeBundle(
		file,
		{
			format: BUNDLE_FORMAT,
			version: BUNDLE_VERSION,
			bundleId,
			parentBundleId: state.lastExportedBundleId,
			created: now,
			mode,
			vault: options.vaultName,
			lineage: state.lineage,
			source: copyRef(state),
			// 完整包免校验（baseGeneration 为 null）。
			// 更新包说"我从**哪一份**完整副本往后算"：接收方只要**应用过那一份**
			// （也就是世代 ≥ 基准世代）就能收，不必逐个按顺序应用。
			// 这个值取的是**这次实际用的起点**（可能在设置里指定了老那份），不是"我最新那份"。
			baseGeneration: mode === 'changes' ? (anchor?.generation ?? state.generation) : null,
			targetGeneration,
			...(baselineHash ? { baselineHash } : {}),
			// 这个包**送到**哪一点（＝接收方应用完站到的那一点，也是我这次导完站到的那一点）。
			// 普通更新包与差量包都带上：链条就是靠"上一点的指纹 ＝ 下一个包的 baselineHash +
			// 每个包的 targetBaselineHash"首尾相接认出来的（`bundle/chain.ts`）。
			...(checkpoint
				? (target?.hash ? { targetBaselineHash: target.hash } : {})
				: { targetBaselineHash: freshBaseline }),
			// **这个包一路上经过哪几个基准点**：站在中间某一点的机器也能收它（见 `BundleHeader.viaHashes`）
			...(viaHashes.length > 0 ? { viaHashes } : {}),
			...(stateIdInfo ? { stateId: stateIdInfo } : {}),
			deleted,
			emptyDirs,
		},
		sources,
		// 每打包完一个文件，数字 +1（0 → 文件数，就这么个数）
		(written, _total, writtenPath) => options.onProgress?.(written, progressTotal, writtenPath),
	);

	/**
	 * 包写成功了才推进世代与基准。
	 *
	 * **不推进本机（`frozen`）的两趟**：差量包（它代表的不是我现在的仓库 —— 内容是 b 那一刻的），
	 * 以及"应用前先把本机改动存成包"那一趟（存完还要去应用对方的包，落点是对方那一点）。
	 * 这两趟都是：世代不动、基准不动、状态编号不动、欠对方的那笔回传也不结清。
	 */
	if (!frozen) {
		/**
		 * **基准点跟着这次导出往前走**（见 `landedPoint`）：我手里现在就是这一点，
		 * 下一个包自然"从这一点往外延伸"（＝只有我上次导出之后的新改动）。
		 *
		 * 这一点的身份是 **"可能的基准点"**：包还没被对方合并，链条上还不能算数
		 * （`pointConfirmed: false`）。对方应用之后，它下次发来的包会把这一点报成自己的基准
		 * （`baselineHash`）—— 那一刻它就成了**确认的基准点**（`apply.ts` 里翻成 true）。
		 *
		 * 为什么不能像以前那样"导出更新包不动基准"：那样下一个包又从头累积一遍，
		 * 包只会越滚越大（用户报的就是这个），链条也就永远长不出来。
		 *
		 * 导完整包 ＝ 重新立一个点：更新包的中间版本记录一起清零
		 * （这正是"包会越滚越大"的节制阀，所以完整包不是可有可无的）。
		 */
		state.bundle = {
			lastExport: now,
			files: landedPoint,
			fullFiles: landedPoint,
			fullGeneration: targetGeneration,
			fullHash: freshBaseline,
			// 界面上要能说清"我站在哪一点上"：刚写的这份包就是那一点的来处
			fullFile: path.basename(file),
			pointConfirmed: false,
			history: mode === 'full' ? {} : nextHistory,
			// 目录基准：接收方靠它认出"这个空目录是对方删了"（基准里有、包里没有）还是"我独有的"（一律保留）
			dirs: [...inventory.dirs],
		};
		state.generation = targetGeneration;
		// 该发的都发出去了：欠对方的那笔回传结清（见 state.pendingReturn）
		state.pendingReturn = null;
		// 我现在的状态编号（更新记录顶部与每条都显示它；对方应用完会算一个跟它比）
		if (ownStateId) state.stateId = { ...ownStateId, at: now };
	}
	/**
	 * **高水位只增不减**：刚发出去的号（以及起点报的号）都记进来 —— 下一次"新内容"从它 +1 发。
	 * `frozen` 那两趟（差量包 / 应用前存下的改动）也记：号确实发出去了，别人手里就有了这一份。
	 */
	raiseGeneration(state, targetGeneration, anchor?.generation);
	state.lastExportedBundleId = bundleId;
	pruneHashes(state, new Set(inventory.files.keys()));
	// 记一笔"我导出过什么"（界面上的「更新记录」）—— 只在包写成功、状态要落盘时才记
	const logEntry: BundleLogEntry = {
		at: now,
		direction: 'export',
		mode,
		bundleId,
		file: path.basename(file),
		// 记录里记的是**这个包从哪一代到哪一代**（指定了起点 / 终点时就是指定的那两代）——
		// 界面上"第 N → M 代"那行要跟包头部对得上
		base: mode === 'changes' ? (anchor?.generation ?? null) : null,
		target: targetGeneration,
		entries: sources.length,
		deleted: deleted.length,
		...(frozen ? { checkpoint: true } : {}),
		...(options.logNote ? { note: options.logNote } : {}),
	};
	// 差量包记的是**终点那一刻**的状态编号（接收方应用完对的就是它），不是我当前的
	if (stateIdInfo) logEntry.stateId = stateIdInfo.id;
	appendBundleLog(state, logEntry);
	await saveState(options.stateFile, state);

	// 旧的更新包该退休了 —— 但必须**等新包写成功、状态也落盘之后**再动它们：
	// 旧包是"目前唯一的改动备份"，新包还没落地就先把旧的删了，导出一旦失败就什么都不剩。
	// 一律清理（以前是个设置项）：更新包是累积的，旧包留着纯占地、还让人以为漏应用了；
	// 没删掉的那些会在报告里如实说明理由（别的血脉 / 世代不比新包小）
	const prune = await removeSupersededChanges(options, header, file, state.generation);
	const superseded = prune.removed;

	options.log.debug(
		`导出${mode === 'full' ? '完整' : (checkpoint ? '差量' : '更新')}包：${file}（${sources.length} 个文件，${header.payloadBytes} 字节`
		+ `${anchorReport
			? `，第 ${anchorReport.generation} → ${checkpoint ? anchorReport.targetGeneration : '最新'} 代`
			: ''}）`
		+ (superseded.length > 0 ? `；顺手清掉 ${superseded.length} 个被它取代的旧更新包` : '')
		+ (prune.kept.length > 0 ? `；changes 里还有 ${prune.kept.length} 个更新包没动（${prune.kept.map(item => item.why).join('、')}）` : ''),
	);

	return {
		file,
		entryCount: sources.length,
		deletedCount: deleted.length,
		fileBytes: (await statFile(file))?.size ?? header.payloadBytes,
		// 包里的目录 = 记着的空文件夹 ＋ 有文件那些目录（它们由文件写入顺带建出来）
		dirCount: covered.size + emptyDirs.length,
		emptyDirCount: emptyDirs.length,
		payloadBytes: header.payloadBytes,
		durationMs: Date.now() - started,
		header,
		parentBundleId: state.lastExportedBundleId,
		cumulative: mode === 'changes',
		anchor: anchorReport,
		superseded,
		keptChanges: prune.kept,
	};
}

/**
 * **这一份包送到的那一个基准点**（清单）＝ 接收方应用完站到的那一点，也是我自己**这次导完**
 * 站到的那一点。
 *
 * 算法必须与接收方**一模一样**：起点那份清单 ＋ 这次进包的文件（用扫描到的记录）
 * − 这次点名的删除。**不能直接拿"当前仓库的清单"顶替** —— 2 秒容差之内的修改时间漂移
 * 在这边算作"没变"（于是没进包），接收方那边当然也保持原样；两边算出来的必须还是同一个点，
 * 否则下一个包会凭空报"基准对不上"。
 */
function landedPointOf(
	mode: BundleMode,
	checkpoint: boolean,
	target: BundleAnchor | null,
	anchor: BundleAnchor | null,
	inventory: Inventory,
	picked: string[],
	deleted: BundleDeletedEntry[],
): Record<string, FileRecord> {
	if (checkpoint) return { ...(target?.files ?? {}) };
	if (mode === 'full') return { ...Object.fromEntries(inventory.files) };
	const point: Record<string, FileRecord> = { ...(anchor?.files ?? {}) };
	for (const file of picked) {
		const record = inventory.files.get(file);
		if (record) point[file] = { size: record.size, mtime: record.mtime };
	}
	for (const item of deleted) delete point[item.path];
	return point;
}

/**
 * **哪些点"在这个包的覆盖范围里"** —— 站在它们上面的机器收得下这个包（填进头部 `viaHashes`）。
 *
 * 判据是**内容**，不是世代号、也不只是来路（踩过：中间隔了一份完整副本之后，来路就断了 ——
 * 用户实测"39→53，再导一份完整副本成了 54，重导 39→54 给站在 53 的机器，被拒"）：
 *
 * > 候选点 P 里凡是"P 与落点不一样"的路径，都必须是**这一包裹住的**路径（进包的条目或点名的删除）。
 *
 * 那样 P 应用完正好落成落点（不一样的那些都被包换掉了，一样的一个没动）。反过来：
 * - **兄弟包**（同一个起点、另一条支路）过不了：它动过的路径不在这一包的名单里；
 * - 候选只取**世代夹在起点与落点之间**的点，而且只读清单（`materializePointSync` 不读负载），
 *   所以这一步只是几次头部叠加，不慢。
 */
async function viaPointsFor(
	options: ExportOptions,
	state: PluginState,
	anchor: { hash: string; generation: number },
	targetGeneration: number,
	/** 落点清单（＝接收方应用完该有的样子） */
	landedPoint: Record<string, FileRecord>,
	/** 这一包裹住的路径：进包的条目 ＋ 点名的删除 */
	covered: ReadonlySet<string>,
): Promise<string[]> {
	const via: string[] = [];
	const seen = new Set<string>();
	for (const ref of listPointRefsSync(options.outDir, state.lineage)) {
		if (ref.hash === anchor.hash || seen.has(ref.hash)) continue;
		seen.add(ref.hash);
		// 先按世代筛一道（读清单不便宜）：只有夹在起点与落点之间的才可能是"路上"的点
		if (!(ref.generation > anchor.generation && ref.generation < targetGeneration)) continue;
		const point = materializePointSync(options.outDir, state.lineage, ref.hash);
		if (!point) continue;
		if (isOnTheWay(point.files, landedPoint, covered)) via.push(ref.hash);
	}
	return via;
}

/**
 * **P 是不是"在这一包的覆盖范围里"**：P 与落点不一样的每一条路径，都必须是这一包裹住的。
 *
 * 一样的不必动；不一样的必须进包（条目）或点名删掉 —— 这样 P 应用完正好落成落点，
 * 严格镜像的前提（"送到的状态是确定的"）才成立。
 */
function isOnTheWay(
	point: Record<string, FileRecord>,
	landed: Record<string, FileRecord>,
	covered: ReadonlySet<string>,
): boolean {
	for (const [path, record] of Object.entries(point)) {
		const atTarget = landed[path];
		if (atTarget && sameRecord(record, atTarget, DEFAULT_MTIME_TOLERANCE_MS)) continue;
		if (!covered.has(path)) return false;
	}
	for (const path of Object.keys(landed)) {
		if (point[path]) continue; // 上面比过了
		if (!covered.has(path)) return false;
	}
	return true;
}

/**
 * **同一份内容，手里的包报的是第几代**（取最小的那个）；说不出就是 `null`。
 *
 * 用在哪：`exportBundle` 开头那段"世代号被撑大了就改回来"。判据是**内容本身**：
 * - **完整副本**：它自己就是那一刻的内容，`hash` 是它自己清单的指纹 → 比 `pointHash` 就行；
 * - **更新包**：头部写着"我落到哪一点"（`targetBaselineHash`）与那一代 → 同一个落点就是同一份内容。
 *
 * 只认**同一条血脉**的包（别的机器导的不算账）；读不出头部的一律跳过（不是我们的包 / 传坏了）。
 * 包目录里通常只有几份（清理规则会去掉多余的环），所以这一步就是读几个文件的尾部，不慢。
 *
 * （"新内容发第几号"是另一件事，看 `maxGeneration` 那条高水位 —— 别混在一起：
 *   乱塞外部包的数字会让本机的号虚高，把"比我新的包不删"那道闸门顶穿。）
 */
async function smallestGenerationOf(outDir: string, lineage: string, pointHash: string | null): Promise<number | null> {
	if (pointHash === null) return null;
	const found: number[] = [];
	for (const anchor of await listFullAnchors(outDir, lineage)) {
		if (anchor.hash === pointHash) found.push(anchor.generation);
	}
	const dir = bundleDirForMode(outDir, 'changes');
	for (const item of await listFiles(dir)) {
		if (!item.name.toLowerCase().endsWith(BUNDLE_EXT)) continue;
		try {
			const header = (await readBundleInfo(path.join(dir, item.name))).header;
			if (header.lineage !== lineage) continue;
			if (header.targetBaselineHash !== pointHash) continue;
			found.push(header.targetGeneration);
		} catch {
			// 读不出头部的（不是我们的包 / 传坏了）不参与记账
		}
	}
	return found.length > 0 ? Math.min(...found) : null;
}

/**
 * **"我马上要落到的那一点"** —— 手头这份包送到的地方（严格同步存包时的起点）。
 *
 * 为什么不是"我现在站的这一点"：
 * - **完整副本**：它自己的清单就是那个点；
 * - **更新包**：我应用前站的这一点（计划时那份快照）＋ 它的条目 − 它点名的删除
 *   （对方头部 `targetBaselineHash` 报的就是它，见 `apply.ts` 的 `nextFullFiles`）。
 *
 * 拿它当起点存出来的就是「**新点 → 新点 ＋ 我的东西**」：我自己应用它＝在新点上把东西加回来，
 * 发给对方（他导出那个包之后正站在同一个新点上）应用＝同理。
 * 用"我自己的点"当起点会漏东西：我这一点上有、对方那份里没有的文件（我本地没动过它）
 * 相对我自己的点**算不出任何改动**，存出来是个空包，而严格同步照样把它换走（踩过）。
 */
export function landedAnchorOf(
	header: BundleHeader,
	/** 应用**之前**我站的那一点（`ApplyPlan.pointBefore` 那份快照，不是现读的状态） */
	pointBefore: Record<string, FileRecord>,
): BundleAnchor {
	const files: Record<string, FileRecord> = header.mode === 'full'
		? Object.fromEntries(header.entries.map(entry => [entry.path, { size: entry.size, mtime: entry.mtime }]))
		: { ...pointBefore };
	if (header.mode !== 'full') {
		for (const entry of header.entries) files[entry.path] = { size: entry.size, mtime: entry.mtime };
		for (const item of header.deleted) delete files[item.path];
	}
	return {
		generation: header.targetGeneration,
		hash: header.mode === 'full' ? baselineOfFullBundle(header.entries) : listingHashOfFiles(files),
		files,
		emptyDirs: [...(header.emptyDirs ?? [])],
		name: '（这份包送到的那一点）',
		file: '',
		// 对方那份包记的状态编号就是这个点该有的编号（旧包没记 → null，界面不写这一句）
		stateId: header.stateId ?? null,
		mtime: 0,
	};
}

/**
 * **合成起点的那一份**送到的那一点上有哪些目录（算状态编号用）。
 *
 * 两份来源：合成起点自带的空目录（对方那份包记着的"我有这些空文件夹"）＋ 落点上文件的上级目录。
 * 与接收方应用完自己扫出来的那份对得上（根目录不算一条 —— 扫描出来的目录清单里也没有它）。
 */
function landedDirsOf(anchor: BundleAnchor, landedPoint: Record<string, FileRecord>): string[] {
	const dirs = new Set<string>(anchor.emptyDirs ?? []);
	for (const file of Object.keys(landedPoint)) {
		const dir = dirnameRel(file);
		if (dir) dirs.add(dir);
	}
	return [...dirs].sort();
}

/**
 * **应用别人的包之前，先把"我这边的东西"存成一个包**（用户要的："本地最新更新保存为一个更新包"）。
 *
 * 严格同步会覆盖我改过的文件、把我多出来的文件挪走 —— 那些东西只躺在回收目录里就是散的，
 * 存成一个包才认得出是一整套，也才搬得走。**起点＝那份包送到的那一点**（`landedAnchorOf`），
 * 所以这一环谁都能用：自己应用＝在新点上把东西加回来，发给对方＝他站在同一点上应用也一样。
 *
 * `frozen`：存完**不推进本机状态** —— 我接下来要去站的是对方那一点。
 * 返回 `file: null` ＝ 我这边跟那个点没有任何差别，没什么可存的（不是失败）。
 */
export async function parkLocalChangesFor(
	options: ExportOptions,
	/** 这次要应用的那份包（计划里的头部）与"应用前我站的那一点" */
	incoming: { header: BundleHeader; pointBefore: Record<string, FileRecord> },
): Promise<ExportOutcome> {
	const landed = landedAnchorOf(incoming.header, incoming.pointBefore);
	/**
	 * 被对方那份包覆盖的路径上，落点是**对方那一版**（我仓库里还是改动前的旧版本）——
	 * 那些版本的指纹就在包条目里带着，交给导出那头算编号用（见 `ExportOptions.stateIdHashes`）。
	 */
	const hashes = new Map<string, string>();
	for (const entry of incoming.header.entries) {
		if (entry.hash) hashes.set(entry.path, entry.hash);
	}
	return exportBundle({
		...options,
		mode: 'changes',
		baseFingerprint: null,
		toFingerprint: null,
		anchorOverride: landed,
		stateIdHashes: hashes,
		// 对方那份包**已经处理**的路径不进这一环：它们在严格同步里会被换成对方那一版，
		// 我手里那份只是"比对方旧"，不是"我改过"（见 `ExportOptions.skipPaths`）
		skipPaths: [
			...incoming.header.entries.map(entry => entry.path),
			...incoming.header.deleted.map(item => item.path),
		],
		frozen: true,
		// 记录里认得出这是流程自己写的那一份（不然用户在更新记录里看到一条来路不明的导出）
		logNote: options.logNote ?? '应用前先把本机的东西存下来（接在应用后落到的那个点上）',
	});
}

/**
 * 删掉被新包**完全取代**的旧更新包。
 *
 * **链条模型（0.11 起）**：更新包是**基准点链条上的一环**（"从哪一点 → 落到哪一点"），
 * 所以默认**一环都不删** —— 删了它，还站在那一环起点的机器就接不上来了（"中间断了"）。
 * 只有下面这两种情况才算真的被取代：
 *
 * - **完整副本**：它是完整清单，谁都能取代（换基准那条路；站在老点上的机器直接应用它就行）；
 * - **同一环**（起点与落点两个指纹都一样：同一段区间重导了一遍）→ 旧的留着没有意义。
 *
 * 其余一律留着，并说明为什么（`kept`）：悄悄留着会让人以为"清理没生效"，
 * 或者当成偶发 bug（用户报过：同一个操作第一遍没清、第二遍清了）。
 *
 * 只删**确定**能删的，条件缺一不可：
 * - 同一个 `changes` 目录里的 `.lsave`（别的目录不碰）；
 * - 是**更新包**（完整包不碰：那是你的还原点）；
 * - 同一条血脉（`lineage` 一致）—— 别的机器导的包不动；
 * - 世代**严格更小**；而且不是刚写出来的那个。
 *
 * `keepPaths` 是"同一次导出里刚生成的包"：两个都勾时先导完整包、再导更新包，
 * 不排除它的话，用户明明要了两个，最后只剩完整包一个。
 *
 * 内容安全性：删掉的那一份，内容必定还在别处（完整清单里，或同一环的新包里）；
 * 读不出头部、或者任何一条对不上的，一律留着（宁可多留，不可误删）。
 */
async function removeSupersededChanges(
	options: ExportOptions,
	header: BundleHeader,
	keep: string,
	/** 新包落地之后本机所在的世代（判"这个旧包是不是比我更新"用它，见下面那段） */
	generation: number,
): Promise<SupersededReport> {
	const dir = bundleDirForMode(options.outDir, 'changes');
	const keepPaths = new Set((options.keepPaths ?? []).map(item => path.resolve(item)));
	keepPaths.add(path.resolve(keep));
	/** 这一环：我从哪一点来（完整副本免这一条：它是完整清单，谁都能取代） */
	const myBase = header.mode === 'full' ? null : baselineOfBundle(header);
	/** 落到哪一点（旧版更新包没记 → null，那就只按"起点 ＋ 世代"认同一环） */
	const myTarget = header.mode === 'full' ? null : (header.targetBaselineHash ?? null);
	const removed: string[] = [];
	const kept: { name: string; why: string }[] = [];
	for (const item of await listFiles(dir)) {
		if (!item.name.toLowerCase().endsWith(BUNDLE_EXT)) continue;
		const candidate = path.join(dir, item.name);
		if (keepPaths.has(path.resolve(candidate))) continue;
		let other: BundleHeader;
		try {
			other = (await readBundleInfo(candidate)).header;
		} catch {
			continue; // 读不出头部（不是我们的包 / 传坏了）：不动它
		}
		if (other.mode !== 'changes') continue;
		// 到这儿它就是一个"看着该被取代"的更新包了：没删就得说清为什么
		if (other.lineage !== header.lineage) {
			kept.push({ name: item.name, why: '不是同一份基准线上的包（多半是另一台机器导的）' });
			continue;
		}
		/**
		 * **链条模型（0.11 起）：更新包不再"越攒越大的那一份"，而是链条上的一环一环。**
		 *
		 * 每一环都是"从某一个基准点 → 落到下一个基准点"，所以**不同环之间谁也取代不了谁** ——
		 * 删了它，还站在那一环起点的机器就接不上来了（那正是"中间断了"）。
		 * 只有**同一环**（起点与落点都一样，也就是同一段区间重导了一遍）才算旧的那份多余。
		 *
		 * 完整副本仍然免这一条：它是完整清单，谁都能取代它（换基准那条路）。
		 */
		if (header.mode !== 'full') {
			const otherBase = baselineOfBundle(other);
			const otherTarget = other.targetBaselineHash ?? null;
			if (otherBase !== myBase || otherTarget !== myTarget) {
				kept.push({
					name: item.name,
					why: `链条上的另一环（第 ${other.baseGeneration ?? '?'} → ${other.targetGeneration} 代）—— 还站在那一点上的机器要用它`,
				});
				continue;
			}
		}
		/**
		 * **回退环一律留着**：那种包的落点号**比起点号还小**（"把大家带回第 39 代"）——
		 * 它是这条线上唯一一份"往回走"的说明，靠后面的正向导出再也生不出来。
		 * 而且它按号比永远显得"旧"：拿世代当闸门时会把它当成过时的包清掉
		 * （回退之后导一次全量，下一次导出就会把那份回退说明删掉 —— 用户看到的是
		 * "我那个包没了"，实测报过这类"同一个操作两遍结论不一样"）。
		 */
		if (other.targetGeneration <= (other.baseGeneration ?? 0)) {
			kept.push({
				name: item.name,
				why: `把大家带回第 ${other.targetGeneration} 代的那一份（回退说明）—— 正向导出生不出来，留着`,
			});
			continue;
		}
		/**
		 * 世代这一道闸：**不许删"比我更新的"包**（那个包可能是更新内容的唯一副本，宁可留着）。
		 *
		 * 跟谁比？**新包落地之后本机所在的世代**（`generation`），不是它头部那个 `targetGeneration`：
		 * 完整副本在"内容没动过"时不推进世代（留还原点就是这种），
		 * 那时头部记的还是当前这一代，拿它比会把**同一个世代**的旧更新包判成"不比这次小"而永远清不掉 ——
		 * 用户就会看到"我立了新基准，旧更新包还躺着"（报过）。
		 * 按"落地后的世代"比，内容没动的完整副本照样能把同代的旧更新包清干净，
		 * 同时"世代更大"（状态文件被换过 / 装过更晚的包）的包仍然一个不碰。
		 */
		if (other.targetGeneration > generation) {
			kept.push({ name: item.name, why: '记的世代不比这次的新（导出过更晚的包）' });
			continue;
		}
		await removeFile(candidate);
		removed.push(item.name);
	}
	removed.sort();
	kept.sort((a, b) => a.name.localeCompare(b.name));
	return { removed, kept };
}
