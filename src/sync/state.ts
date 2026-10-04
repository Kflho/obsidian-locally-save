import { randomUUID } from 'node:crypto';
import { readJsonFile, writeJsonAtomic } from './disk';
import type { FileRecord } from './types';

/**
 * 插件自己的状态文件（`sync-state.json`，放在插件目录里）。
 *
 * 记四件事：
 * - **这份副本是谁**（copyId）与**第几代**（generation）—— 同步包靠它判断
 *   "你和我是不是同一条血脉"；
 * - **每个同步目标上次同步后的样子** —— 三方比对的基准，没有它就分不清
 *   "本地改了"和"副本改了"；
 * - **上次导出/应用同步包的样子** —— 「只导出改动」与漏包检测靠它；
 * - **内容指纹缓存** —— 降级合并时要用"内容"而不是"时间"来认文件，
 *   算过的按 size+mtime 缓存，没变过的下次直接复用。
 *
 * 状态放在插件目录而不是副本目录里：同一个副本（比如一块 U 盘）可能被两台机器用，
 * 各自的基准必须分开记，否则会互相覆盖。
 */

export const STATE_FILE_NAME = 'sync-state.json';

export interface TargetState {
	/** 上次同步完成的时间戳 */
	lastSync: number;
	/** 上次同步后两边一致的文件 */
	files: Record<string, FileRecord>;
}

export interface BundleBaseline {
	/** 上次导出同步包的时间戳 */
	lastExport: number;
	/** 上次导出时仓库的样子 */
	files: Record<string, FileRecord>;
}

/** 内容指纹缓存的一条 */
export interface HashRecord {
	size: number;
	mtime: number;
	hash: string;
}

export interface PluginState {
	version: 1;
	/** 这份副本的身份：第一次建状态时生成，之后不变（只用于排查问题） */
	copyId: string;
	/**
	 * 血脉：标识"这是同一份内容家族"。
	 *
	 * 换机器搬同步包时，接收方应用完整包会**认祖**（把自己的血脉改成包里的），
	 * 之后两边才谈得上"世代对得上"。设备自己数世代是没用的 —— 两台机器各数各的，
	 * 永远对不上，快速通道就永远走不通。
	 */
	lineage: string;
	/**
	 * 世代号：每导出一个同步包 +1，应用一个包则直接跳到包里的 targetGeneration。
	 * 它不是版本号，只回答"你手上这份是不是我导出这个包时以为的那一份"。
	 */
	generation: number;
	/** 上一次应用的同步包 ID：用来发现漏包 */
	lastBundleId: string | null;
	/** 上一次导出的同步包 ID：下一个包会把它记成 parentBundleId */
	lastExportedBundleId: string | null;
	/** 同步目标路径 → 该目标的基准 */
	targets: Record<string, TargetState>;
	bundle: BundleBaseline | null;
	/** 仓库相对路径 → 内容指纹（懒算，见 hash-cache.ts） */
	hashes: Record<string, HashRecord>;
}

export function emptyState(): PluginState {
	return {
		version: 1,
		copyId: randomUUID(),
		lineage: randomUUID(),
		generation: 0,
		lastBundleId: null,
		lastExportedBundleId: null,
		targets: {},
		bundle: null,
		hashes: {},
	};
}

export async function loadState(absPath: string): Promise<PluginState> {
	const raw = await readJsonFile<Partial<PluginState>>(absPath);
	if (!raw || raw.version !== 1) return emptyState();
	return {
		version: 1,
		// 老状态文件里没有 copyId / lineage（升级上来的）：补一个
		copyId: typeof raw.copyId === 'string' && raw.copyId ? raw.copyId : randomUUID(),
		lineage: typeof raw.lineage === 'string' && raw.lineage ? raw.lineage : randomUUID(),
		generation: typeof raw.generation === 'number' ? raw.generation : 0,
		lastBundleId: raw.lastBundleId ?? null,
		lastExportedBundleId: raw.lastExportedBundleId ?? null,
		targets: raw.targets ?? {},
		bundle: raw.bundle ?? null,
		hashes: raw.hashes ?? {},
	};
}

export async function saveState(absPath: string, state: PluginState): Promise<void> {
	await writeJsonAtomic(absPath, state);
}

/** 取某个同步目标的基准（没有就返回空表＝当作第一次同步） */
export function targetBaseline(state: PluginState, targetDir: string): Record<string, FileRecord> {
	return state.targets[targetDir]?.files ?? {};
}

export function setTargetBaseline(
	state: PluginState,
	targetDir: string,
	files: Record<string, FileRecord>,
	time: number,
): PluginState {
	state.targets[targetDir] = { lastSync: time, files };
	return state;
}

/**
 * 一轮同步结束后推进世代？
 *
 * **不推**。世代只跟"同步包"这条传输通道有关：本地文件夹同步有自己的 per-target 基准，
 * 两件事混在一个计数器里只会互相干扰。世代只在导出包时 +1（见 bundle/export.ts）。
 */

/** 这份副本在同步包里的身份 */
export function copyRef(state: PluginState): { copyId: string; generation: number } {
	return { copyId: state.copyId, generation: state.generation };
}

/** 指纹缓存的键：路径 + 形态，形态变了缓存就作废 */
export function cachedHash(state: PluginState, path: string, record: FileRecord): string | null {
	const entry = state.hashes[path];
	if (!entry) return null;
	return entry.size === record.size && entry.mtime === record.mtime ? entry.hash : null;
}

export function rememberHash(state: PluginState, path: string, record: FileRecord, hash: string): void {
	state.hashes[path] = { size: record.size, mtime: record.mtime, hash };
}

/** 清掉已经不在仓库里的指纹，别让状态文件无限长大 */
export function pruneHashes(state: PluginState, present: Set<string>): void {
	for (const path of Object.keys(state.hashes)) {
		if (!present.has(path)) delete state.hashes[path];
	}
}
