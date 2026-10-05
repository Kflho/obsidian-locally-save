import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BUNDLE_EXT, BUNDLE_FORMAT, BUNDLE_VERSION, readBundleInfo, writeBundle } from './format';
import type { BundleDeletedEntry, BundleHeader, BundleInfo, BundleSource } from './format';
import { bundleDirForMode } from './paths';
import type { BundleMode } from './paths';
import { baselineOfBundle, listingHashOfFiles } from './baseline';
import { anchorOfPoint, describeAnchorList, listFullAnchors, pickAnchor } from './anchor';
import type { BundleAnchor } from './anchor';
import { listPointRefsSync, materializePointSync } from './points';
import { appendBundleLog } from './log';
import { DEFAULT_MTIME_TOLERANCE_MS, sameRecord } from '../sync/diff';
import { listFiles, removeFile, scanTree, statFile } from '../sync/disk';
import { VAULT_TRASH_DIR, excludePatterns } from '../sync/vault';
import { fingerprint } from '../sync/hash-cache';
import { cachedHash, copyRef, loadState, pruneHashes, saveState } from '../sync/state';
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
	 * **把一份包里"我的改动"接到我当前站的这一点上**（只有 `rebaseBundle` 会填，见那个函数）。
	 *
	 * 有它时这次导的**不是"我现在的仓库"**，而是"我站的这一点 ＋ 那份包的改动"落出来的那一点：
	 * - 条目与内容都取自那份包（`sources` 逐文件指出"去哪份包的哪一段取"）；
	 * - 起点是**我站的这一点**（头部的 `baselineHash`），落点是合成出来的那一点；
	 * - **本机什么都不推进**（跟差量包一样：内容不是我现在的仓库）。
	 *
	 * 界面上唯一用到它的地方：应用别人的包之前先把本机改动存成一个更新包（`parkLocalChanges`），
	 * 应用完再把它接到**应用后落到的那个新点**上 —— 那一环**我自己应用**＝在新点上加回我的改动，
	 * **发给对方**（他站在新点上）应用＝同理。用户的原话："把新的部分变成一个更新包，
	 * 自己导入就等于在最新基准点基础上加上原来更新，给别人导入同理。"
	 */
	replayTarget?: BundleAnchor;
	/** 配置目录名（运行时才知道，用户可能改过） */
	configDir?: string;
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
		+ '或者把设置里「从哪个状态开始」改回「我站的这个基准点」',
	);
}

/**
 * 这次更新包**到哪个状态**为止（**只读**）。
 *
 * `null` ＝ 最新（当前仓库）；给了指纹就得在磁盘上找到那一份完整副本 ——
 * 找不到同样报错，不能悄悄改成"到最新"：那会把一份**内容完全不同**的包发给对方。
 */
async function resolveTarget(options: ExportOptions, state: PluginState): Promise<BundleAnchor | null> {
	// `rebaseBundle` 合成的那个落点：内容来自另一份包，起点是我现在站的这一点
	if (options.replayTarget) return options.replayTarget;
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
	/** 这次更新包从哪个状态开始（默认就是我状态里最新的那份完整副本） */
	const anchor = mode === 'changes' ? await resolveAnchor(options, state) : null;
	/** 这次更新包到哪个状态为止（null ＝ 最新，也就是当前仓库） */
	const target = mode === 'changes' ? await resolveTarget(options, state) : null;
	/** "把另一份包的改动接到我这一点上"（`rebaseBundle`）：内容不在仓库里，base 只能取起点清单 */
	const replay = options.replayTarget !== undefined && options.replayTarget !== null;
	/** 自上次完整包以来各文件经历过的中间版本 */
	const history = state.bundle?.history ?? {};
	// 明确指定过起点（＝对着"还站在那份完整副本上"的对方导的）：base 取那份清单里的版本。
	// replay 同理：接收方站在**我这一点**上，他手里是这一点记着的那一版
	const baseFrom: 'anchor' | 'previous' = replay
		|| (options.baseFingerprint !== null && options.baseFingerprint !== undefined)
		? 'anchor'
		: 'previous';
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
	const pushDeleted = (file: string, base: FileRecord) => {
		const baseHash = cachedHash(state, file, base);
		deleted.push({
			path: file,
			baseSize: base.size,
			baseMtime: base.mtime,
			...(baseHash ? { baseHash } : {}),
		});
	};

	if (mode === 'full') {
		picked.push(...inventory.files.keys());
	} else if (target) {
		// 「从 a 到 b」的差量：两边都是**完整清单**，直接比两份清单 ——
		// 跟当前仓库没关系（b 那一刻的内容可能早就被改过了，它只存在于 b 那份包里）。
		for (const [file, atTarget] of Object.entries(target.files)) {
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
	// 已经躺在 changes/ 里就直说，别写（自动留包那条路尤其要紧：它会一轮接一轮地跑）。
	// `rebaseBundle` 那条路不查：它是流程自己发起的一次性动作，内容也**不是**由两份完整包决定的
	// （落点里含"我的改动"，只有那份来源包知道），查到别的包反而会认错。
	const existing = target && !replay ? await findExistingCheckpoint(options, state, anchor, target) : null;

	return { state, inventory, previous, anchor, target, baseFrom, history, picked, deleted, existing };
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
			problem: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function exportBundle(options: ExportOptions): Promise<ExportOutcome> {
	const started = Date.now();
	const { mode } = options;
	const work = await prepareBundle(options, mode);
	const { state, inventory, previous, anchor, target, baseFrom, history, picked, deleted, existing } = work;
	/** 终点是一份完整副本（差量包）：内容取自那份包，结束时到达它的世代 */
	const checkpoint = target !== null;
	/**
	 * **仓库自上次导出以来动过没有**（判据与"自动留包要不要写包"那条完全一样）。
	 *
	 * 它决定了完整副本要不要占一个**新世代号**：内容与上次打包时一模一样 →
	 * 不推进（世代号记的是"这份内容走到哪儿了"，不是"我点了几次导出"）。
	 *
	 * 为什么非这样不可（用户报的"多一代"）：本机第 39 代，收到并应用了别人
	 * 「39 → 46」的更新包之后，本机内容**就是第 46 代**、`state.generation` 也到了 46。
	 * 这时再导一份完整副本若照旧 `+1`，它会自称"第 47 代" —— 可它装的内容一代都没往前走。
	 * 于是本机导出的更新包变成「46 → 47」（对面看着像凭空多一代），
	 * 而对面应用后也停在 47 上，两边的"第几代"跟内容再也对不上。
	 */
	const moved = hasLocalChanges(state, inventory);
	/**
	 * 这一份包结束时到达的世代：
	 * - 差量包（终点是某份完整副本）＝**那份完整副本记着的那一代**（内容到它为止）；
	 * - 完整副本＋内容没动过 ＝ **还是当前这一代**（留还原点最典型：把已经掌握的内容固化成基准点，
	 *   一代都不该多占）；
	 * - 其余（完整副本＋有改动、更新包）＝ **当前代 + 1**（内容确实往前走了一代）。
	 */
	const targetGeneration = checkpoint
		? (target?.generation ?? state.generation + 1)
		: (mode === 'full' && !moved ? state.generation : state.generation + 1);
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
	 * **这一份包送到的那一个基准点**（清单）＝ 接收方应用完站到的那一点，
	 * 也是我自己**这次导完**站到的那一点（下面是 `state.bundle` 那段）。
	 *
	 * 算法必须与接收方**一模一样**：起点那份清单 ＋ 这次进包的文件（用扫描到的记录）
	 * − 这次点名的删除。**不能直接拿"当前仓库的清单"顶替** —— 2 秒容差之内的修改时间漂移
	 * 在这边算作"没变"（于是没进包），接收方那边当然也保持原样；两边算出来的必须还是同一个点，
	 * 否则下一个包会凭空报"基准对不上"。
	 */
	const landedPoint: Record<string, FileRecord> = checkpoint
		? { ...(target?.files ?? {}) }
		: mode === 'full'
			? { ...Object.fromEntries(inventory.files) }
			: (() => {
				const point: Record<string, FileRecord> = { ...(anchor?.files ?? {}) };
				for (const file of picked) {
					const record = inventory.files.get(file);
					if (record) point[file] = { size: record.size, mtime: record.mtime };
				}
				for (const item of deleted) delete point[item.path];
				return point;
			})();

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
	 * **差量包（到某一份完整副本）例外**：它送到的是 b 那一刻，不是我现在的仓库 ——
	 * 所以直接带上**那份包记着的状态编号**，接收方应用完一比正好是"跟对方完全一致"；
	 * 我自己的 `state.stateId` 这一刻并没有重算（也不该拿它冒充 b）。
	 *
	 * 放在写包**之前**：头部要先写、偏移量提前算好（不回写）。这一步不算进度 ——
	 * 进度只认"打进包里几个文件"；指纹基本都在缓存里（上面那个循环刚算过变过的那些），
	 * 冷缓存时才真要读一遍仓库。
	 */
	const stateIdInfo: StateIdInfo | null = checkpoint
		? (target?.stateId ?? null)
		: await computeStateId({
			vaultRoot: options.vaultRoot,
			state,
			files: inventory.files,
			dirs: inventory.dirs,
		});
	/** 我自己的状态编号：差量包不重算（它不是我现在的仓库，不该拿它冒充） */
	const ownStateId = checkpoint ? null : stateIdInfo;

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
	 * **差量包（到某一份完整副本）什么都不推进**：它代表的不是"我现在的仓库"（内容是 b 那一刻的），
	 * 所以我这边没有"导出过一次当前状态"可言 —— 世代不动、基准不动、状态编号不动、
	 * 欠对方的那笔回传也不结清（我这半的最新改动它并没有带上）。
	 */
	if (!checkpoint) {
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
		...(checkpoint ? { checkpoint: true } : {}),
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

/** `rebaseBundle` 的参数：比普通导出多一样 —— **要"换起点"的那份包** */
export interface RebaseOptions extends ExportOptions {
	/** 那份要换起点的包（通常是应用别人的包之前，`parkLocalChanges` 把本机改动存下来的那份） */
	source: string;
}

/**
 * **把一份包里的改动，接到我当前站的基准点上，导成一环新包**（用户拍板的语义：
 * "把新的部分变成一个更新包，自己导入就等于在最新基准点基础上加上原来更新，给别人导入同理"）。
 *
 * 用在哪：严格同步会**用包里的版本覆盖我改过的文件、把我多出来的文件挪走**，动手前先把
 * 我这一半存成一个更新包（`parkLocalChanges`）—— 但那份包接的是**应用前**那一点，
 * 而对方导完包之后已经往前走到新点了，所以他直接应用它会判"接不上"。
 * 所以应用成功之后，把它**重新接一次**：
 *
 * ```
 *   park 包：  旧点 O ──► O ＋ 我的改动          （应用前存下的那份，只有我自己用得上）
 *   rebase 后：新点 N ──► N ＋ 我的改动          ← 这一环谁都能用
 * ```
 *
 * - **起点**＝我现在站的这一点（应用成功之后就是那个新点）；
 * - **条目与内容**都取自那份包（字节不去仓库读：仓库里现在是包送到的状态）；
 * - **落点**＝起点清单 ＋ 那份包的条目 − 那份包点名的删除，指纹与状态编号当场算出来，
 *   接收方应用完一比就是"跟对方完全一致"；
 * - **我这边什么都不推进**（与差量包一样：内容不是我现在的仓库）——
 *   想把这些改动加回自己这边，**应用这份包**就是（基准点也跟着到那一点）。
 *
 * 失败一律抛错：调用方要么把来源包留着当备份，要么明确告诉用户"改动还在那份包里"。
 */
export async function rebaseBundle(options: RebaseOptions): Promise<ExportOutcome> {
	const state = await loadState(options.stateFile);
	// 起点＝**我现在站的这一点**。不读设置里那两个下拉：这一步是流程自己发起的，
	// 用户在那儿选的是"手动导出要导哪一段"，跟这里没关系（照它算会把包接到错误的点上）。
	const anchor = await resolveAnchor({ ...options, baseFingerprint: null }, state);
	if (!anchor) {
		throw new Error(
			'这台机器还没有基准点：这一环是"从某一点往外延伸"的，没有起点就算不出来。'
			+ '先应用一份完整副本（或自己导一次完整副本），有了基准点再试',
		);
	}
	const info = await readBundleInfo(options.source);
	if (info.header.mode !== 'changes') {
		throw new Error('只有更新包能这样"换起点"：完整副本自带完整清单，谁都能随时应用它，不必换');
	}

	// 落点＝起点那份清单 ＋ 这份包的条目 − 这份包点名的删除
	const files: Record<string, FileRecord> = { ...anchor.files };
	const sources = new Map<string, { file: string; offset: number; size: number; mtime: number; hash?: string }>();
	/** 内容不在仓库里，编号要用**这份包记着的**指纹算（见 `computeStateId` 的 `hashes`） */
	const hashes = new Map<string, string>();
	for (const entry of info.header.entries) {
		files[entry.path] = { size: entry.size, mtime: entry.mtime };
		sources.set(entry.path, {
			file: options.source,
			offset: info.payloadOffset + entry.offset,
			size: entry.size,
			mtime: entry.mtime,
			...(entry.hash ? { hash: entry.hash } : {}),
		});
		if (entry.hash) hashes.set(entry.path, entry.hash);
	}
	for (const item of info.header.deleted) delete files[item.path];

	/**
	 * 落点上的目录：**起点这一边的目录**（我站的这一点上有什么，仓库里就有 —— 我这边
	 * 刚跟包严格同步过）＋ 条目带出来的上级目录 ＋ 那份包记着的空文件夹。
	 *
	 * 空文件夹取"落点里有、但底下没有文件"的那些 —— 与接收方应用完自己算出来的
	 * 目录集一致（空文件夹不写进包就永远传不过去）。
	 */
	const exclude = excludePatterns(options.settings.excludePatterns, options.configDir);
	const inventory = options.inventory
		?? await scanTree(options.vaultRoot, { exclude, skipTopLevelDirs: [VAULT_TRASH_DIR] });
	const coveredLand = dirsContainingPaths(Object.keys(files));
	const landDirs = new Set<string>(inventory.dirs);
	for (const dir of coveredLand) landDirs.add(dir);
	for (const dir of info.header.emptyDirs ?? []) landDirs.add(dir);
	const emptyDirs = [...landDirs].filter(dir => !coveredLand.has(dir)).sort();

	// 落点的状态编号：接收方应用完算一个自己的跟它比 —— 相同就是"两边文件内容一致"
	const stateId = await computeStateId({
		vaultRoot: options.vaultRoot,
		state,
		files: Object.entries(files),
		dirs: landDirs,
		hashes,
	});

	const target: BundleAnchor = {
		// 内容＝"新点 ＋ 我的改动"，确实是往前走了一版
		generation: (anchor.generation ?? state.generation) + 1,
		hash: listingHashOfFiles(files),
		files,
		emptyDirs,
		name: `应用前存下的那份改动（${path.basename(options.source)}）`,
		file: '',
		stateId,
		mtime: 0,
		sources,
	};

	return exportBundle({
		...options,
		mode: 'changes',
		baseFingerprint: null,
		toFingerprint: null,
		replayTarget: target,
		inventory,
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
			kept.push({ name: item.name, why: '不是同一条血脉（多半是另一台机器导的）' });
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
