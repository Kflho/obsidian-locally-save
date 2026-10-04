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
 * （会新增几个、覆盖几个、跳过几个、冲突几个、要不要删文件），
 * 接收方看过之后再 `executeBundlePlan()` 真正落盘。
 * 所以"打开包"这一步是安全的，可以随便点。
 *
 * 两条路径：
 * - **快速通道**（血脉一致 + 世代对得上）：信任包的清单，逐条写入；
 * - **降级合并**（世代对不上 / 漏了包）：逐文件看本地是不是还停在包的 base 上，
 *   停在 base 上才敢覆盖；本地也改过的留成冲突副本。**不拒绝服务，也不静默丢数据**。
 *
 * 删除一律要过 base 检查（没有例外）：本地改过的文件不删，只登记为"保留"。
 */

const TOLERANCE = DEFAULT_MTIME_TOLERANCE_MS;
const CHUNK = 4 * 1024 * 1024;

export interface ApplyOptions {
	settings: PluginSettings;
	log: Logger;
	vaultRoot: string;
	stateFile: string;
	/** 要应用的 .lsave 文件 */
	file: string;
	/** 配置目录名（运行时才知道，用户可能改过） */
	configDir?: string;
	onProgress?: (done: number, total: number, file: string) => void;
}

/** 应用前的体检报告：接收方靠它判断"这次能同步到什么程度" */
export interface ApplyReport {
	/** 走哪条路 */
	mode: 'fast' | 'merge';
	sameLineage: boolean;
	sameGeneration: boolean;
	/** 包链对不上：对方上次导出的是别人 */
	parentMatches: boolean;
	/** 包的世代与本地差多少（漏了几个包） */
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
	/** 逐条分类 */
	adds: number;
	overwrites: number;
	skips: number;
	conflicts: number;
	/** 包里要求删除、且本地确实停在 base 上的 */
	deletes: number;
	/** 包里要求删除、但本地改过所以不删的 */
	keptDeletes: number;
	/** 完整包里没有、而且比包旧的本地文件（开了"删除多余文件"才会删） */
	extraDeletes: number;
	/** 本地与包已经完全一致的条目数 */
	synchronized: number;
	/** 同步程度：已一致 / 总条目（0–100） */
	syncPercent: number;
}

export interface ApplyPlan {
	info: BundleInfo;
	report: ApplyReport;
	entries: { entry: BundleEntry; action: 'write' | 'skip' | 'conflict' }[];
	deletes: { path: string; action: 'delete' | 'skip' }[];
	/** 完整包 + 开启删除时，本地多出来要删的文件 */
	extra: string[];
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
	if (entry.baseSize === undefined || entry.baseMtime === undefined) {
		// 包里没给基准（例如对方导出时这个文件还不存在）：认不出来，保守处理
		return false;
	}
	return local.size === entry.baseSize && Math.abs(local.mtime - entry.baseMtime) <= TOLERANCE;
}

/** 只读地算一遍：包与本地差在哪儿、能同步到什么程度 */
export async function planBundleApply(options: ApplyOptions): Promise<ApplyPlan> {
	const info = await readBundleInfo(options.file);
	const header = info.header;

	if (options.settings.bundleVerify) {
		const ok = await verifyBundle(options.file, info);
		if (!ok) throw new Error('同步包校验失败：文件可能在传输中损坏了，请重新拷一份再试');
	}

	const state = await loadState(options.stateFile);
	const sameLineage = header.lineage === state.lineage;
	const sameGeneration = header.baseGeneration === null
		|| (sameLineage && state.generation === header.baseGeneration);
	const mode: 'fast' | 'merge' = sameGeneration ? 'fast' : 'merge';

	// 完整包免校验；增量包则看血脉与世代
	const entries: ApplyPlan['entries'] = [];
	let adds = 0;
	let overwrites = 0;
	let skips = 0;
	let conflicts = 0;

	for (const entry of header.entries) {
		const local = await statFile(toNative(options.vaultRoot, entry.path));
		if (!local) {
			entries.push({ entry, action: 'write' });
			adds++;
			continue;
		}
		if (local.size === entry.size && Math.abs(local.mtime - entry.mtime) <= TOLERANCE) {
			entries.push({ entry, action: 'skip' });
			skips++;
			continue;
		}
		if (mode === 'fast' || matchesBase(local, entry)) {
			entries.push({ entry, action: 'write' });
			overwrites++;
			continue;
		}
		// 本地也改过：留副本
		entries.push({ entry, action: 'conflict' });
		conflicts++;
	}

	const deletes: ApplyPlan['deletes'] = [];
	let keptDeletes = 0;
	for (const item of header.deleted) {
		const local = await statFile(toNative(options.vaultRoot, item.path));
		if (!local) continue; // 本地早就没有了
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

	// 完整包 + 开了"删除多余文件"：本地有、包里没有、且比包旧的才删
	const extra: string[] = [];
	if (header.mode === 'full' && options.settings.bundleDeleteMissing) {
		const known = new Set(header.entries.map(entry => entry.path));
		const inventory = await scanTree(options.vaultRoot, {
			exclude: excludePatterns(options.settings.excludePatterns, options.configDir),
			skipTopLevelDirs: [VAULT_TRASH_DIR],
		});
		for (const [file, record] of inventory.files) {
			if (known.has(file)) continue;
			if (record.mtime > header.created) continue; // 比包新：多半是这边刚写的
			extra.push(file);
		}
		extra.sort();
	}

	const synchronized = skips;
	const total = header.entries.length;
	const report: ApplyReport = {
		mode,
		sameLineage,
		sameGeneration,
		parentMatches: header.parentBundleId === null || header.parentBundleId === state.lastBundleId,
		// 正数＝本地落后了几代（漏了包）；null＝完整包或压根不是同一条血脉
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
		adds,
		overwrites,
		skips,
		conflicts,
		deletes: deletes.filter(item => item.action === 'delete').length,
		keptDeletes,
		extraDeletes: extra.length,
		synchronized,
		syncPercent: total === 0 ? 100 : Math.round((synchronized / total) * 100),
	};

	return { info, report, entries, deletes, extra };
}

/** 真正落盘 */
export async function executeBundlePlan(plan: ApplyPlan, options: ApplyOptions): Promise<ApplyResult> {
	const started = Date.now();
	const stamp = formatStamp(Date.now());
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

	for (const { entry, action } of plan.entries) {
		options.onProgress?.(done++, total, entry.path);
		if (action === 'skip') {
			result.skipped++;
			continue;
		}
		try {
			const target = toNative(options.vaultRoot, entry.path);
			if (action === 'conflict') {
				// 本地那份留成冲突副本，包里的内容占原名 —— 两份都不丢
				const backup = conflictName(entry.path, stamp, '本地冲突副本');
				const backupAbs = toNative(options.vaultRoot, backup);
				await ensureDir(path.dirname(backupAbs));
				await fs.promises.copyFile(target, backupAbs);
				await fs.promises.utimes(backupAbs, new Date(), new Date());
				result.conflictCopies.push(backup);
				result.conflicts++;
			}
			await extractEntry(options.file, plan.info, entry, target);
			result.written++;
			result.bytesWritten += entry.size;
		} catch (error) {
			result.failed.push({ path: entry.path, error: describe(error) });
		}
	}

	const trashRoot = `${options.vaultRoot}/.trash/locally-save`;
	for (const item of plan.deletes) {
		options.onProgress?.(done++, total, item.path);
		if (item.action === 'skip') continue;
		try {
			const target = toNative(options.vaultRoot, item.path);
			if (options.settings.deletedToTrash) await moveToTrash(target, trashRoot, item.path, stamp);
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
			if (options.settings.deletedToTrash) await moveToTrash(target, trashRoot, file, stamp);
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
	state.bundle = { lastExport: state.bundle?.lastExport ?? 0, files: Object.fromEntries(inventory.files) };
	await saveState(options.stateFile, state);

	result.durationMs = Date.now() - started;
	options.log.debug(`应用同步包完成：写入 ${result.written}、跳过 ${result.skipped}、冲突 ${result.conflicts}`);
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
