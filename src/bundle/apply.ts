import fs from 'node:fs';
import path from 'node:path';
import { readBundleInfo, verifyBundle } from './format';
import type { BundleEntry, BundleInfo } from './format';
import { DEFAULT_MTIME_TOLERANCE_MS } from '../sync/diff';
import { ensureDir, moveToTrash, scanTree, statFile } from '../sync/disk';
import { VAULT_TRASH_DIR, excludePatterns } from '../sync/runner';
import { loadState, saveState } from '../sync/state';
import { formatStamp } from '../utils/format';
import type { Logger } from '../utils/log';
import { conflictName, toNative } from '../utils/paths';
import type { PluginSettings } from '../settings/model';

/**
 * 应用同步包 —— **先算后做**两步走。
 *
 * `planBundleApply()` 只读不写：把包和本地逐条比一遍，给出报告
 * （会新增几个、覆盖几个、跳过几个、冲突几个、要删哪些），
 * 接收方看过之后再 `executeBundlePlan()` 真正落盘。
 * 所以"打开包"这一步是安全的，可以随便点。
 *
 * 三种应用方式（在应用对话框里当场选，不藏在设置里）：
 *
 * | 模式 | 本地也改过的文件 | 本地多出来的文件 | 包里要求删的 |
 * |---|---|---|---|
 * | `keep-all` 所有都保留 | 留冲突副本，两份都在 | 保留 | 过基准检查才删 |
 * | `delete-old` 清老的 | 同上 | 只删比包旧的 | 同上 |
 * | `force` 强制应用 | 直接覆盖 | 全删，不管新旧 | 直接删 |
 *
 * **后两种只对完整副本开放**：改动包里没有的东西太多了，对着它清老的或镜像
 * 会把整个仓库清空。引擎这边直接拒绝，界面那边也会把选项灰掉。
 *
 * 被覆盖 / 被删掉的本地版本**先进回收目录**（`仓库/.trash/locally-save/时间戳/`），
 * 所以"强制一致"之后仍然捞得回来 —— 那个目录不参与同步，不影响一致性。
 */

const TOLERANCE = DEFAULT_MTIME_TOLERANCE_MS;
const CHUNK = 4 * 1024 * 1024;

export type ApplyMode = 'keep-all' | 'delete-old' | 'force';

/** 界面上给这三种模式的说法 */
export const APPLY_MODE_LABELS: Record<ApplyMode, string> = {
	'keep-all': '所有都保留：只应用包里有的，本地多出来的不动',
	'delete-old': '清老的：删掉本地那些比包旧的多余文件',
	force: '强制应用：让仓库与包完全一致（本地改动覆盖、多余文件全删）',
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
	/** 应用方式，默认 `keep-all`（最保守） */
	mode?: ApplyMode;
	/** 被覆盖 / 删掉的本地版本先进回收目录（默认跟随设置里的「删除前先备份」） */
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
	/** 本地落后几代（正数＝漏了包） */
	generationGap: number | null;
	bundle: {
		id: string;
		mode: 'full' | 'changes';
		vault: string;
		created: number;
		entryCount: number;
		deletedCount: number;
		payloadBytes: number;
	};
	/** 这次用的应用方式 */
	applyMode: ApplyMode;
	/** 被覆盖 / 删掉的本地版本会不会进回收目录 */
	keepBackup: boolean;
	/** 逐条分类 */
	adds: number;
	overwrites: number;
	skips: number;
	conflicts: number;
	/** 强制应用时：本地改过、但照样被覆盖掉的数量 */
	forcedOverwrites: number;
	/** 本地停在"我以前发过的中间版本"上（跳过了一两个更新包）、直接覆盖的数量 */
	historyMatches: number;
	/** 包里要求删除、且本地确实停在基准上的 */
	deletes: number;
	/** 包里要求删除、但本地改过所以不删的（强制应用时不会有） */
	keptDeletes: number;
	/** 本地多出来、这次要删的 */
	extraDeletes: number;
	/** 本地与包已经完全一致的条目数 */
	synchronized: number;
	/** 同步程度：已一致 / 总条目（0–100） */
	syncPercent: number;
}

export interface ApplyPlan {
	info: BundleInfo;
	report: ApplyReport;
	entries: { entry: BundleEntry; action: 'write' | 'skip' | 'conflict'; backup: boolean }[];
	deletes: { path: string; action: 'delete' | 'skip' }[];
	/** 本地多出来、这次要删的文件 */
	extra: string[];
	/** 执行阶段照着做的几个策略 */
	options: { mode: ApplyMode; keepBackup: boolean };
}

export interface ApplyResult {
	written: number;
	skipped: number;
	conflicts: number;
	deleted: number;
	bytesWritten: number;
	failed: { path: string; error: string }[];
	conflictCopies: string[];
	durationMs: number;
}

function matchesBase(local: { size: number; mtime: number }, entry: BundleEntry): boolean {
	if (entry.baseSize === undefined || entry.baseMtime === undefined) return false;
	return local.size === entry.baseSize && Math.abs(local.mtime - entry.baseMtime) <= TOLERANCE;
}

/**
 * 本地这份是不是"我以前发过的中间版本"。
 *
 * 更新包是**以完整包为基准累积**的，所以接收方可能跳过了一两个包、手里停在中间某一版。
 * 那不是我改的，是我发过的 —— 直接覆盖，不该留冲突副本。
 */
function matchesHistory(local: { size: number; mtime: number }, entry: BundleEntry): boolean {
	return (entry.history ?? []).some(
		record => record.size === local.size && Math.abs(record.mtime - local.mtime) <= TOLERANCE,
	);
}

function sameAsEntry(local: { size: number; mtime: number }, entry: BundleEntry): boolean {
	return local.size === entry.size && Math.abs(local.mtime - entry.mtime) <= TOLERANCE;
}

/** 只读地算一遍：包与本地差在哪儿、能同步到什么程度 */
export async function planBundleApply(options: ApplyOptions): Promise<ApplyPlan> {
	const info = await readBundleInfo(options.file);
	const header = info.header;
	const mode: ApplyMode = options.mode ?? 'keep-all';
	const keepBackup = options.keepBackup ?? options.settings.deletedToTrash;

	// 改动包里没有的东西太多了：对着它清老的 / 镜像 = 把仓库清空
	if (mode !== 'keep-all' && header.mode !== 'full') {
		throw new Error(
			`「${mode === 'force' ? '强制应用' : '清老的'}」只能用完整副本：`
			+ `改动包里只装了变过的文件，对着它清理会把仓库里其余的文件全删掉。`,
		);
	}

	if (options.settings.bundleVerify) {
		const ok = await verifyBundle(options.file, info);
		if (!ok) throw new Error('同步包校验失败：文件可能在传输中损坏了，请重新拷一份再试');
	}

	const state = await loadState(options.stateFile);
	const sameLineage = header.lineage === state.lineage;
	// 更新包是累积的：接收方只要**应用过基准那个完整包**（世代 ≥ 基准世代）就能收，
	// 不必逐个按顺序应用 —— 所以这里是 >=，不是 ==
	const sameGeneration = header.baseGeneration === null
		|| (sameLineage && state.generation >= header.baseGeneration);
	const fastPath = sameGeneration;

	const entries: ApplyPlan['entries'] = [];
	let adds = 0;
	let overwrites = 0;
	let skips = 0;
	let conflicts = 0;
	let forcedOverwrites = 0;
	let historyMatches = 0;

	for (const entry of header.entries) {
		const local = await statFile(toNative(options.vaultRoot, entry.path));

		// 本地没有 → 纯新增
		if (!local) {
			entries.push({ entry, action: 'write', backup: false });
			adds++;
			continue;
		}
		// 已经跟包里一样 → 什么都不用做
		if (sameAsEntry(local, entry)) {
			entries.push({ entry, action: 'skip', backup: false });
			skips++;
			continue;
		}

		// 包里给了基准：能判断"本地是不是还停在包以为的样子上"
		if (entry.baseSize !== undefined) {
			if (matchesBase(local, entry)) {
				// 本地没动过 → 覆盖不丢东西
				entries.push({ entry, action: 'write', backup: false });
				overwrites++;
				continue;
			}
			if (matchesHistory(local, entry)) {
				// 本地停在"我以前发过的中间版本"上（跳过了一两个包）→ 同样不丢东西
				entries.push({ entry, action: 'write', backup: false });
				overwrites++;
				historyMatches++;
				continue;
			}
			// 本地也改过
			if (mode === 'force') {
				entries.push({ entry, action: 'write', backup: keepBackup });
				forcedOverwrites++;
				continue;
			}
			entries.push({ entry, action: 'conflict', backup: false });
			conflicts++;
			continue;
		}

		// 包里没给基准（完整包就是这样，改动包里的新文件也是）
		//
		// 没有基准就没法三方比对，于是用「本地这份是不是比包还新」当判据：
		// 比包还新 → 多半是导出之后这边刚改的，得当本地改动处理；
		// 比包旧   → 那是旧副本，覆盖它不丢东西（第一次整份恢复靠的就是这条，
		//            否则每台机器的每个文件都会被判成"本地改过"，满天冲突副本）。
		const newerThanBundle = local.mtime > header.created + TOLERANCE;
		if (mode === 'force') {
			entries.push({ entry, action: 'write', backup: keepBackup });
			if (newerThanBundle) forcedOverwrites++;
			else overwrites++;
			continue;
		}
		if (newerThanBundle) {
			entries.push({ entry, action: 'conflict', backup: false });
			conflicts++;
			continue;
		}
		entries.push({ entry, action: 'write', backup: false });
		overwrites++;
	}

	// 包里要求删的
	const deletes: ApplyPlan['deletes'] = [];
	let keptDeletes = 0;
	for (const item of header.deleted) {
		const local = await statFile(toNative(options.vaultRoot, item.path));
		if (!local) continue; // 本地早就没有了

		// 强制应用：不看了，直接删（本地那份进回收目录）
		if (mode === 'force') {
			deletes.push({ path: item.path, action: 'delete' });
			continue;
		}

		const baseKnown = item.baseSize !== undefined && item.baseMtime !== undefined;
		const stillBase = baseKnown
			&& local.size === item.baseSize
			&& Math.abs(local.mtime - (item.baseMtime ?? 0)) <= TOLERANCE;
		if (stillBase) {
			deletes.push({ path: item.path, action: 'delete' });
		} else {
			// 本地改过它，或者包里没给基准：不删。删除是唯一不可逆的动作，宁可留着
			deletes.push({ path: item.path, action: 'skip' });
			keptDeletes++;
		}
	}

	// 本地多出来、包里没有的
	const extra: string[] = [];
	if (mode !== 'keep-all' && header.mode === 'full') {
		const known = new Set<string>([
			...header.entries.map(entry => entry.path),
			...header.deleted.map(item => item.path),
		]);
		const inventory = await scanTree(options.vaultRoot, {
			exclude: excludePatterns(options.settings.excludePatterns, options.configDir),
			skipTopLevelDirs: [VAULT_TRASH_DIR],
		});
		for (const [file, record] of inventory.files) {
			if (known.has(file)) continue;
			// 清老的：比包新的不动 —— 那多半是这边刚写的
			if (mode === 'delete-old' && record.mtime > header.created) continue;
			extra.push(file);
		}
		extra.sort();
	}

	const total = header.entries.length;
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
			payloadBytes: header.payloadBytes,
		},
		applyMode: mode,
		keepBackup,
		adds,
		overwrites,
		skips,
		conflicts,
		forcedOverwrites,
		historyMatches,
		deletes: deletes.filter(item => item.action === 'delete').length,
		keptDeletes,
		extraDeletes: extra.length,
		synchronized: skips,
		syncPercent: total === 0 ? 100 : Math.round((skips / total) * 100),
	};

	return { info, report, entries, deletes, extra, options: { mode, keepBackup } };
}

/** 真正落盘 */
export async function executeBundlePlan(plan: ApplyPlan, options: ApplyOptions): Promise<ApplyResult> {
	const started = Date.now();
	const stamp = formatStamp(Date.now());
	const trashRoot = `${options.vaultRoot}/.trash/locally-save`;
	const { mode, keepBackup } = plan.options;
	const result: ApplyResult = {
		written: 0,
		skipped: 0,
		conflicts: 0,
		deleted: 0,
		bytesWritten: 0,
		failed: [],
		conflictCopies: [],
		durationMs: 0,
	};

	const total = plan.entries.length + plan.deletes.length + plan.extra.length;
	let done = 0;

	for (const { entry, action, backup } of plan.entries) {
		options.onProgress?.(done++, total, entry.path);
		if (action === 'skip') {
			result.skipped++;
			continue;
		}
		try {
			const target = toNative(options.vaultRoot, entry.path);

			if (action === 'conflict') {
				// 本地那份留成冲突副本，包里的内容占原名 —— 两份都不丢
				const backupName = conflictName(entry.path, stamp, '本地冲突副本');
				const backupAbs = toNative(options.vaultRoot, backupName);
				await ensureDir(path.dirname(backupAbs));
				await fs.promises.copyFile(target, backupAbs);
				await fs.promises.utimes(backupAbs, new Date(), new Date());
				result.conflictCopies.push(backupName);
				result.conflicts++;
			} else if (backup && mode === 'force') {
				// 强制一致：本地那份不能留在原地（会破坏"与包完全相同"），挪进回收目录
				await moveToTrash(target, trashRoot, entry.path, stamp);
			}

			await extractEntry(options.file, plan.info, entry, target);
			result.written++;
			result.bytesWritten += entry.size;
		} catch (error) {
			result.failed.push({ path: entry.path, error: describe(error) });
		}
	}

	for (const item of plan.deletes) {
		options.onProgress?.(done++, total, item.path);
		if (item.action === 'skip') continue;
		try {
			const target = toNative(options.vaultRoot, item.path);
			if (keepBackup) await moveToTrash(target, trashRoot, item.path, stamp);
			else await fs.promises.rm(target, { force: true });
			result.deleted++;
		} catch (error) {
			result.failed.push({ path: item.path, error: describe(error) });
		}
	}

	for (const file of plan.extra) {
		options.onProgress?.(done++, total, file);
		try {
			const target = toNative(options.vaultRoot, file);
			if (keepBackup) await moveToTrash(target, trashRoot, file, stamp);
			else await fs.promises.rm(target, { force: true });
			result.deleted++;
		} catch (error) {
			result.failed.push({ path: file, error: describe(error) });
		}
	}

	options.onProgress?.(done, total, '');

	// 认祖归宗 + 世代对齐，并把"上次导出的样子"更新成当前仓库，
	// 这样紧接着导出「仅改动」时不会把刚同步来的内容又装一遍
	const state = await loadState(options.stateFile);
	state.lineage = plan.info.header.lineage;
	state.generation = plan.info.header.targetGeneration;
	state.lastBundleId = plan.info.header.bundleId;
	const inventory = await scanTree(options.vaultRoot, {
		exclude: excludePatterns(options.settings.excludePatterns, options.configDir),
		skipTopLevelDirs: [VAULT_TRASH_DIR],
	});
	// 应用**完整包** ＝ 我这边也有了一个新基准（之后可以照着它往外导更新包），
	// 所以基准与中间版本记录一起重置；应用更新包则保留原来的基准
	const isFull = plan.info.header.mode === 'full';
	state.bundle = {
		lastExport: state.bundle?.lastExport ?? 0,
		files: Object.fromEntries(inventory.files),
		fullFiles: isFull ? Object.fromEntries(inventory.files) : (state.bundle?.fullFiles ?? null),
		fullGeneration: isFull
			? plan.info.header.targetGeneration
			: (state.bundle?.fullGeneration ?? null),
		history: isFull ? {} : (state.bundle?.history ?? {}),
	};
	await saveState(options.stateFile, state);

	result.durationMs = Date.now() - started;
	options.log.debug(
		`应用同步包完成（${mode}）：写入 ${result.written}、跳过 ${result.skipped}、`
		+ `冲突 ${result.conflicts}、删除 ${result.deleted}`,
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
