import fs from 'node:fs';
import path from 'node:path';
import { readBundleInfo, verifyBundle } from './format';
import type { BundleEntry, BundleInfo } from './format';
import { DEFAULT_MTIME_TOLERANCE_MS, dirsContainingFiles, planSync } from '../sync/diff';
import { CONFLICT_TRASH_DIR, dirExists, ensureDir, moveToTrash, pruneEmptyDirs, removeEmptyDir, scanTree, statFile } from '../sync/disk';
import { VAULT_TRASH_DIR, excludePatterns } from '../sync/runner';
import { loadState, saveState } from '../sync/state';
import { formatStamp } from '../utils/format';
import type { Logger } from '../utils/log';
import { dirnameRel, toNative } from '../utils/paths';
import type { PluginSettings } from '../settings/model';
import type { ConflictStrategy, FileRecord, Inventory, SyncAction } from '../sync/types';

/**
 * 应用同步包 —— **先算后做**两步走。
 *
 * `planBundleApply()` 只读不写：把包和本地逐条比一遍，给出报告；接收方看过之后再
 * `executeBundlePlan()` 真正落盘。所以"打开包"这一步是安全的，可以随便点。
 *
 * ## 核心：包就是"对方"，交给我们那套比对引擎
 *
 * 完整包 = 一份**完整清单**，和"本地文件夹副本"在结构上是同一种东西。所以这里
 * **复用 `planSync()` 的三方比对**（基准 vs 本地 vs 包），而不是另发明一套规则：
 *
 * | | 本地副本同步 | 同步包应用 |
 * |---|---|---|
 * | 增 / 删 / 改 | 三方比对 | **同一套** |
 * | 冲突 | 留两份（**新的占原名**）/ 以本地为准 / 以副本为准 | **同一套设置** |
 * | 删除 | 基准检查 + 传播开关 | **同一套** |
 * | 移动 | 认出来就直接改名 | **同一套** |
 *
 * 应用时用"仅下载"方向 —— 包是只读的，不能往里写；但冲突裁决仍听设置
 * （`directionDecidesConflict: false`），所以"新的那份占原名"这条规则和副本那边完全一致。
 *
 * 三个细节在比对结果之上再修一下（都是"包里没有基准时"才用得上）：
 * 1. 本地这份是**我以前发过的中间版本**（`entry.history`）→ 不是本地改动，直接覆盖；
 * 2. 本地这份**比包还旧**（没有 base 可比时）→ 那是旧副本，直接覆盖；
 * 3. 其余"两边都改过"的，才真的留冲突副本。
 *
 * 于是"本地有、包里没有"也交给了基准判断，不需要用户先选立场：
 * 基准里也有 → 对方删了它（按传播开关处理）；基准里没有 → 我独有的文件，一律保留。
 */

const TOLERANCE = DEFAULT_MTIME_TOLERANCE_MS;
const CHUNK = 4 * 1024 * 1024;

/** 本次应用有多"以包为准"（见 ApplyOptions.strictness） */
export type ApplyStrictness = 'normal' | 'bundle-wins' | 'mirror';

/** 三档在界面上的说法 */
export const STRICTNESS_LABELS: Record<ApplyStrictness, string> = {
	normal: '按设置（安全）：本地改过的保留，分歧留两份，我独有的文件不动',
	'bundle-wins': '以包为准：分歧一律听包的（本地那份进回收目录），对方删过的也跟着删',
	mirror: '完全镜像：包里没有的本地文件全删（连我本机新建的），仓库 = 包',
};

export interface ApplyOptions {
	settings: PluginSettings;
	log: Logger;
	vaultRoot: string;
	stateFile: string;
	/** 要应用的 .lsave 文件 */
	file: string;
	/** 配置目录名（运行时才知道，用户可能改过） */
	configDir?: string;
	/** 本次临时覆盖冲突裁决；不填就跟随设置 */
	conflictStrategy?: ConflictStrategy;
	/**
	 * **强硬程度**（本次应用有多"以包为准"）。
	 *
	 * - `normal`（默认）：按设置 —— 本地改过的保留、分歧留两份、我独有的文件不动
	 * - `bundle-wins`：分歧一律听包的（本地那份进回收目录）；对方删过的文件跟着删，
	 *   不管本地改没改 —— 用在"对方做过颠覆性改动"之后
	 * - `mirror`：在 `bundle-wins` 之上，**包里没有的本地文件全删**（连我本机新建的也删）
	 *   → 参与同步的那部分内容与包完全一致
	 *
	 * 排除规则命中的东西（配置目录等）三档都不动。
	 */
	strictness?: ApplyStrictness;
	/** 本次临时覆盖"删不删多余文件"；不填就跟随设置 */
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
	/** 被删掉的本地版本先进回收目录（默认跟随设置里的「删除前先备份」） */
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
	/** 本次实际采用的策略（界面回显：是跟随设置还是临时覆盖） */
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
	/** 本地停在"对方发过的中间版本"上、直接覆盖的数量 */
	historyMatches: number;
	/** 要删的本地文件总数 */
	deletes: number;
	/** 其中"包要求删、但本地改过所以保留"的 */
	keptDeletes: number;
	/** 其中"本地有、包里没有、且基准里也有"的（＝对方删过的） */
	extraDeletes: number;
	/** 本地与包已经完全一致的条目数 */
	synchronized: number;
	/** 同步程度：已一致 / 总条目（0–100） */
	syncPercent: number;
	/** 会认出来的移动（改名/挪目录） */
	moves: number;
	/** 这次要在仓库里补建几个文件夹（空文件夹；已有的不算） */
	foldersToCreate: number;
	/** 这次要删掉几个本地空文件夹（包里没有它） */
	foldersToRemove: number;
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
	/** 执行阶段照着做的策略 */
	options: { conflictStrategy: ConflictStrategy; propagateDeletions: boolean; keepBackup: boolean };
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
}

/** 本地这份是不是"对方发过的中间版本"（跳过了一两个包，手里停在这一版） */
function matchesHistory(local: FileRecord, entry: BundleEntry): boolean {
	return (entry.history ?? []).some(
		record => record.size === local.size && Math.abs(record.mtime - local.mtime) <= TOLERANCE,
	);
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

	const strictness: ApplyStrictness = options.strictness ?? 'normal';
	// 以包为准：分歧一律听包的 —— 直接交给比对引擎的冲突策略，
	// 它同时覆盖了"两边都改"「本地改了对方删了」这些分支
	const conflictStrategy = strictness === 'normal'
		? (options.conflictStrategy ?? settings.conflictStrategy)
		: 'remote-wins';
	const propagateDeletions = strictness === 'normal'
		? (options.propagateDeletions ?? settings.propagateDeletions)
		: true;
	const keepBackup = strictness === 'normal'
		? (options.keepBackup ?? settings.deletedToTrash)
		// 强制档必然要删东西（可能一次删很多），**强制先备份**：
		// 关掉回收目录 + 强制 = 不可恢复的批量删除，这个组合不给走
		: true;

	const state = await loadState(options.stateFile);
	const sameLineage = header.lineage === state.lineage;
	// 更新包是累积的：接收方只要**应用过基准那个完整包**（世代 ≥ 基准世代）就能收
	const sameGeneration = header.baseGeneration === null
		|| (sameLineage && state.generation >= header.baseGeneration);
	const fastPath = sameGeneration;

	// ------------------------------------------------------------ 三方
	const local = await scanTree(options.vaultRoot, {
		exclude: excludePatterns(settings.excludePatterns, options.configDir),
		skipTopLevelDirs: [VAULT_TRASH_DIR],
	});

	// "对方"＝包：完整包是完整清单；更新包只有它提到的那部分（这正是我们要的 ——
	// 没提到的一律当作"与我无关"，绝不推断删除）
	const entriesByPath = new Map(header.entries.map(entry => [entry.path, entry]));
	const remote: Inventory = {
		files: new Map(header.entries.map(entry => [entry.path, { size: entry.size, mtime: entry.mtime }])),
		dirs: new Set(header.emptyDirs ?? []),
	};

	// 基准：我上次应用/导出之后的样子；缺的地方用包自己带的 base 补
	// （包说"我以为你原来是这样"，对一台新机器来说这就是它的基准）
	const baseline: Record<string, FileRecord> = { ...(state.bundle?.files ?? {}) };
	const seed = (path: string, size?: number, mtime?: number) => {
		if (baseline[path] === undefined && size !== undefined && mtime !== undefined) {
			baseline[path] = { size, mtime };
		}
	};
	for (const entry of header.entries) seed(entry.path, entry.baseSize, entry.baseMtime);
	for (const item of header.deleted) seed(item.path, item.baseSize, item.baseMtime);

	const planned = strictness === 'normal'
		? planSync(local, remote, baseline, {
			// 包是只读的：借"仅下载"方向只为不产生写回对方的动作，冲突裁决仍听设置
			direction: 'download',
			directionDecidesConflict: false,
			conflictStrategy,
			propagateDeletions,
			mtimeToleranceMs: TOLERANCE,
		})
		// 强制档不走三方比对：目标是"仓库 == 包"，直接两侧比就行
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

	const localDeleted = new Set(header.deleted.map(item => item.path));

	// ------------------------------------------------- 强制档：直接"以包为准"
	if (strictness !== 'normal') {
		// ① 包里有的：本地缺 → 新增；不一致 → 覆盖（本地那份动过的先挪进回收目录）
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
				backup: localChanged && keepBackup,
			});
		}

		// ② 包里没有的本地文件：
		//   `bundle-wins` → 只删"基准里也有"的（＝对方删过的）
		//   `mirror`      → 全删（连本机新建的也删）
		for (const file of local.files.keys()) {
			if (entriesByPath.has(file)) continue;
			const seenBefore = baseline[file] !== undefined;
			if (strictness === 'bundle-wins' && !seenBefore) continue;
			deletes++;
			actions.push({ kind: 'delete', path: file });
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
					// 以包为准/镜像时，本地那份动过的要先挪进回收目录（默认模式下走到这儿说明它没动过，没什么可备份的）
					backup: strictness !== 'normal' && localChanged && keepBackup,
				});
				break;
			}
			case 'delete-local': {
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
	for (const item of header.deleted) {
		const here = local.files.get(item.path);
		if (!here) continue;
		// 强制模式下这些会被删掉，就不算"保留"了
		if (strictness !== 'normal') continue;
		const base = baseline[item.path];
		const stillBase = base && here.size === base.size && Math.abs(here.mtime - base.mtime) <= TOLERANCE;
		if (!stillBase) keptDeletes++;
	}

	const total = header.entries.length;

	// ------------------------------------------------- 目录（空文件夹）
	//
	// 包里的目录 = `emptyDirs` ＋ 所有条目的上级目录（后者随文件写入顺带建出来）。
	// 本地有、包里没有的**空**目录要不要删，三档不同：
	// - `mirror`（强制一致）：删 —— 这一档的承诺就是"仓库和包完全一样"（文件如此，目录也该如此）；
	// - `bundle-wins`：只删**基准里记过**的（＝对方删过它），本机新建的留着 ——
	//   和它处理文件的那条规矩一模一样（`seenBefore`）；
	// - `normal`：与 `bundle-wins` 同，但还要看「同步删除」开关。
	// 执行时只走 `rmdir`（非空必然失败），所以判断错了也只会"没删掉"，不会连带删掉有内容的目录。
	const bundleDirs = dirsInBundle(header);
	const foldersToRemove: string[] = [];
	{
		const baseDirs = new Set(state.bundle?.dirs ?? []);
		const filled = dirsContainingFiles(local);
		for (const dir of local.dirs) {
			if (bundleDirs.has(dir)) continue;
			if (filled.has(dir)) continue; // 里面有文件：交给文件规则，别在这里抢着删
			if (strictness === 'mirror') {
				foldersToRemove.push(dir);
				continue;
			}
			if (!baseDirs.has(dir)) continue;
			if (strictness === 'normal' && !propagateDeletions) continue;
			foldersToRemove.push(dir);
		}
		foldersToRemove.sort();
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
		forced: strictness !== 'normal',
		adds,
		overwrites,
		skips: synchronized,
		conflicts,
		forcedOverwrites,
		historyMatches,
		deletes,
		keptDeletes,
		extraDeletes,
		synchronized,
		syncPercent: total === 0 ? 100 : Math.round((synchronized / total) * 100),
		moves,
		// 本地还没有的才算"要补建"：包会把空文件夹全带一遍，建已有的目录是空操作
		foldersToCreate: (header.emptyDirs ?? []).filter(dir => !local.dirs.has(dir)).length,
		foldersToRemove: foldersToRemove.length,
	};

	return { info, report, actions, foldersToRemove, options: { conflictStrategy, propagateDeletions, keepBackup } };
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
					if (keepBackup) await moveToTrash(target, trashRoot, action.path, stamp);
					else await fs.promises.rm(target, { force: true });
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
	for (const dir of plan.foldersToRemove ?? []) {
		if (await removeEmptyDir(toNative(options.vaultRoot, dir))) result.foldersRemoved++;
	}

	// 认祖归宗 + 世代对齐
	const state = await loadState(options.stateFile);
	state.lineage = plan.info.header.lineage;
	state.generation = plan.info.header.targetGeneration;
	state.lastBundleId = plan.info.header.bundleId;

	// 基准的正确含义是**"两边上次达成一致的样子"**，所以只能记两边都见过的东西：
	// - 包里有的 → 真的写成了包里的样子才记（冲突没写成的、失败的都不记）
	// - 包里点名删的 → 划掉
	// - 其余（我独有的、对方从没见过的文件）→ **保持原样**，绝不能记进去
	//
	// 以前这里图省事写成"当前仓库的完整清单"，于是把我独有的文件也记进了基准；
	// 下次一应用，它们就成了"基准里有、包里没有" → 被当成"对方删过它"而删掉。
	// （用户的报障：第一次不删、第二次才删。）
	const baseline: Record<string, FileRecord> = { ...(state.bundle?.files ?? {}) };
	for (const entry of plan.info.header.entries) {
		const current = await statFile(toNative(options.vaultRoot, entry.path));
		const agreed = current
			&& current.size === entry.size
			&& Math.abs(current.mtime - entry.mtime) <= TOLERANCE;
		if (agreed) baseline[entry.path] = { size: entry.size, mtime: entry.mtime };
		else delete baseline[entry.path];
	}
	for (const item of plan.info.header.deleted) delete baseline[item.path];

	// 应用**完整包** ＝ 我这边也有了一个新基准（之后可以照着它往外导更新包），
	// 所以中间版本记录重置；应用更新包则保留
	const isFull = plan.info.header.mode === 'full';
	// 目录基准同理：只记**两边都见过**的目录（包里点了名的，且这次真的在本地）
	const keepDirs: string[] = [];
	for (const dir of dirsInBundle(plan.info.header)) {
		if (await dirExists(toNative(options.vaultRoot, dir))) keepDirs.push(dir);
	}
	keepDirs.sort();
	state.bundle = {
		lastExport: state.bundle?.lastExport ?? 0,
		files: baseline,
		fullFiles: isFull ? { ...baseline } : (state.bundle?.fullFiles ?? null),
		fullGeneration: isFull
			? plan.info.header.targetGeneration
			: (state.bundle?.fullGeneration ?? null),
		history: isFull ? {} : (state.bundle?.history ?? {}),
		dirs: keepDirs,
	};
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
	try {
		while (read < entry.size) {
			const want = Math.min(CHUNK, entry.size - read);
			const { bytesRead } = await source.read(buffer, 0, want, info.payloadOffset + entry.offset + read);
			if (bytesRead <= 0) break;
			await destination.write(buffer, 0, bytesRead);
			read += bytesRead;
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
