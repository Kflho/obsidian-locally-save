import { randomUUID } from 'node:crypto';
import { readJsonFile, writeJsonAtomic } from './disk';
import type { LastSyncRecord } from './summary';
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
	/**
	 * 上次同步后**两边都有的目录**。
	 *
	 * 与文件同一个用途：判断"目录是被删了还是新出现的"。老状态文件里没有这一项，
	 * 于是升级后的第一轮不删任何目录（等于旧行为），第二轮起删除才正常传播。
	 */
	dirs?: string[];
}

export interface BundleBaseline {
	/** 上次导出同步包的时间戳 */
	lastExport: number;
	/** 上次导出时仓库的样子（用来算"自上次以来变了什么"） */
	files: Record<string, FileRecord>;
	/**
	 * 上次导出**完整包**时仓库的样子 —— 更新包以它为基准累积。
	 *
	 * 为什么要有它：如果更新包只是"相对上次导出"的差集，接收方漏掉任何一个，
	 * 那部分内容就永久缺失。改成"相对上次完整包累积"之后，
	 * **永远只需要应用最新的那一个**。代价是包会越滚越大，
	 * 所以"导一次完整包就清零"是这套方案能成立的关键。
	 *
	 * null ＝ 还没导过完整包，这时不给导更新包（没有基准）。
	 */
	fullFiles: Record<string, FileRecord> | null;
	/**
	 * 上次导出完整包时到达的世代 —— 更新包的"基准世代"。
	 *
	 * 接收方只要**应用过那个完整包**（世代 ≥ 基准世代）就能收更新包，
	 * 不必逐个按顺序应用。
	 */
	fullGeneration: number | null;
	/**
	 * 我这份**基准的指纹**（`bundle/baseline.ts`）—— 两台机器互相发更新包时的"共同祖先令牌"。
	 *
	 * 导出一份完整副本、或应用了别人的完整副本之后写入；之后自己导的更新包都带上它，
	 * 接收方一比就知道两边是不是接着同一份基准（世代号不够用：两边各自 +1 会碰号、
	 * 内容对不上时也看不出来）。null ＝ 旧状态文件（升级上来的）或还没立过基准。
	 */
	fullHash: string | null;
	/**
	 * 我这份基准对应的**包文件名**（不含目录）—— 界面上"我现在站在哪份完整副本上"要写出来，
	 * 光有世代和指纹用户对不上号。null ＝ 旧状态文件（升级上来的）。
	 */
	fullFile: string | null;
	/**
	 * 自上次完整包以来，每个文件经历过的版本（不含最新那一版）。
	 *
	 * 接收方靠它认出"我手里这份是你以前发过的中间版本，不是我自己改的"，
	 * 于是跳过一两个包也不会满屏冲突副本。导完整包时整个清空。
	 */
	history: Record<string, FileRecord[]>;
	/**
	 * 上次导出 / 应用时两边都有的目录（含空文件夹）。
	 *
	 * 应用同步包时靠它区分"这个空目录是对方删掉了"（基准里有、包里没有 → 跟着删）
	 * 与"这个空目录是我独有的"（基准里没有 → 一律保留）。
	 * 老状态文件里没有这一项：那一轮一个目录都不删，之后补上。
	 */
	dirs?: string[];
	/**
	 * 上次提醒"更新包太大了，要不要换基准"时**那条提醒线**（字节）。
	 *
	 * 记它是为了别每轮同步都弹：用户点过「跳过这次导出」之后，提醒线按原上限整数倍往上抬
	 * （200MB → 400MB → 600MB，见 `size-warn.ts` 的 `advanceWarnThreshold`）；
	 * 换过一次基准就清零，回到 1 倍。
	 */
	warnedThreshold?: number;
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
	 * 世代号：每导出一个同步包 +1，应用一个包则跳到包里的 targetGeneration ——
	 * 但**只增不减**（应用一个更老的包不会把它拨回去，见 bundle/apply.ts）。
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
	/**
	 * 上一次同步的结果。
	 *
	 * 存下来是为了**重启之后状态栏还能显示上次同步干了什么** ——
	 * 以前这个只活在内存里，一重启就变回"尚未同步"。
	 */
	lastSync: LastSyncRecord | null;
	/** 仓库相对路径 → 内容指纹（懒算，见 hash-cache.ts） */
	hashes: Record<string, HashRecord>;
	/**
	 * **同步包更新记录**（像 git log 那样）：每次导出 / 应用同步包都追加一条。
	 *
	 * 为什么要有：状态文件只记"现在什么样"，用户看不出"我是从哪份完整副本开始的、
	 * 中间收发过哪些更新包、现在离基准有多远" —— 两台机器来回搬时这些正是最想知道的。
	 * 只留最近 `BUNDLE_LOG_LIMIT` 条（见 bundle/log.ts），别把状态文件撑大。
	 */
	bundleLog: BundleLogEntry[];
	/**
	 * **欠对方一个回传**（暂存）。
	 *
	 * 应用了别人的包之后，我这边可能还有"对方没有"的改动要送回去。**不能立刻生成回礼包**：
	 * 对方收到又会生成一个，两边互相套娃、没完没了（用户报过："无限套娃"）。
	 * 所以只记一笔账：下次**导出更新包时一起带上**（更新包本来就是"自基准累积"的，
	 * 天然包含我这半 + 对方那半的回声），导完就清掉。没有这个账也不影响正确性，
	 * 纯粹是让界面上说得清"我还欠一次回传"。
	 */
	pendingReturn: {
		at: number;
		/** 收到的那个包的 ID / 文件名 / 来自哪个仓库 */
		bundleId: string;
		file?: string;
		vault?: string;
		/** 我这边还有多少改动没发出去 */
		changes: number;
		deletes: number;
	} | null;
}

/** 一条"收发过同步包"的记录（界面上按时间倒着列） */
export interface BundleLogEntry {
	at: number;
	/** 导出（我发出去的）还是应用（我收到的） */
	direction: 'export' | 'apply';
	mode: 'full' | 'changes';
	bundleId: string;
	/** 包文件名（不含目录）：想去找那个包时用得上 */
	file?: string;
	/** 包来自哪个仓库（应用别人的包时才有意义） */
	vault?: string;
	/** 这份包以第几代的完整副本为基准（完整包是 null） */
	base: number | null;
	/** 应用/导出之后到达的世代 */
	target: number;
	/** 包里装了几个文件 / 点名删了几个 */
	entries: number;
	deleted: number;
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
		lastSync: null,
		hashes: {},
		bundleLog: [],
		pendingReturn: null,
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
		bundle: raw.bundle
			? {
				lastExport: raw.bundle.lastExport ?? 0,
				files: raw.bundle.files ?? {},
				fullFiles: raw.bundle.fullFiles ?? null,
				fullGeneration: raw.bundle.fullGeneration ?? null,
				// 老状态文件没有这一项（升级上来的）：判成"说不清"，界面会说明只能逐文件合并
				fullHash: raw.bundle.fullHash ?? null,
				fullFile: raw.bundle.fullFile ?? null,
				history: raw.bundle.history ?? {},
				dirs: raw.bundle.dirs ?? [],
				warnedThreshold: typeof raw.bundle.warnedThreshold === 'number'
					? raw.bundle.warnedThreshold
					: undefined,
			}
			: null,
		lastSync: raw.lastSync ?? null,
		hashes: raw.hashes ?? {},
		bundleLog: Array.isArray(raw.bundleLog) ? raw.bundleLog : [],
		pendingReturn: raw.pendingReturn ?? null,
	};
}

export async function saveState(absPath: string, state: PluginState): Promise<void> {
	await writeJsonAtomic(absPath, state);
}

/** 取某个同步目标的基准（没有就返回空表＝当作第一次同步） */
export function targetBaseline(state: PluginState, targetDir: string): Record<string, FileRecord> {
	return state.targets[targetDir]?.files ?? {};
}

/** 取某个同步目标的目录基准（老状态文件没有这一项 → 空集＝这轮谁都不删） */
export function targetDirs(state: PluginState, targetDir: string): Set<string> {
	return new Set(state.targets[targetDir]?.dirs ?? []);
}

export function setTargetBaseline(
	state: PluginState,
	targetDir: string,
	files: Record<string, FileRecord>,
	time: number,
	dirs?: string[],
): PluginState {
	state.targets[targetDir] = { lastSync: time, files, dirs: dirs ?? [] };
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
	// 指纹缓存只用来**区分**文件，不做密码学用途，所以存 16 位（64 bit）就够：
	// 一万个文件的碰撞概率约 10⁻¹²，而状态文件能小一大截（用户的仓库一万个文件时省 1.4 MB）
	state.hashes[path] = { size: record.size, mtime: record.mtime, hash: hash.slice(0, HASH_KEEP) };
}

/** 指纹缓存里保留多少位十六进制字符 */
export const HASH_KEEP = 16;

/** 清掉已经不在仓库里的指纹，别让状态文件无限长大 */
export function pruneHashes(state: PluginState, present: Set<string>): void {
	for (const path of Object.keys(state.hashes)) {
		if (!present.has(path)) delete state.hashes[path];
	}
}
