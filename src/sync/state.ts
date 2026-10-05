import { randomUUID } from 'node:crypto';
import { readJsonFile, readJsonFileSync, writeJsonAtomic } from './disk';
import type { FileRecord } from './types';

/**
 * 插件自己的状态文件（`sync-state.json`，放在插件目录里）。
 *
 * 记四件事：
 * - **这份副本是谁**（copyId）与**第几代**（generation）—— 同步包靠它判断
 *   "你和我是不是同一条血脉"；
 * - **上次导出 / 应用同步包的样子** —— 「只导出改动」与漏包检测靠它；
 * - **内容指纹缓存** —— 降级合并时要用"内容"而不是"时间"来认文件，
 *   算过的按 size+mtime 缓存，没变过的下次直接复用；
 * - **更新记录与状态编号** —— 界面上"我站在哪、两边一不一样"靠它们。
 *
 * 0.8.0 砍掉「同步到本地副本」通道时，这里的 `targets`（每个同步目标的基准）
 * 与 `lastSync`（上次同步干了什么）一并删掉了：那条通道是它们唯一的读者。
 * 老状态文件里留着这两个字段不读即可（`loadState` 不会把它们带进内存）。
 */

export const STATE_FILE_NAME = 'sync-state.json';

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

/**
 * **状态编号**：整个仓库现在长什么样的短指纹（算法见 `sync/state-id.ts`）。
 *
 * 世代号回答不了"两边的文件一样吗"（它只是节奏号，两台各自 +1 会碰号），
 * 状态编号能：**编号相同 ＝ 文件内容一致**。导出时写进包头部，应用完跟自己的比一比，
 * 更新记录里每条都记着 —— 打开日志就能确定两边到底同不同步。
 */
export interface StateIdInfo {
	id: string;
	/** 参与编号的文件数 / 目录数（目录含空文件夹） */
	files: number;
	dirs: number;
	/** 其中内容没能核验（单个超过 64MB / 读失败）的文件数，按"大小 + 时间"顶上的 */
	unverified: number;
}

/** 存在状态文件里的状态编号（多一个"什么时候算的"） */
export interface StateIdRecord extends StateIdInfo {
	at: number;
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
	bundle: BundleBaseline | null;
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
	/**
	 * **我现在的状态编号**：上一次导出 / 应用之后算的那个（见 `sync/state-id.ts`）。
	 *
	 * 它就是"我这台机器现在的内容指纹"，跟包里那个一比就知道两边同不同步：
	 * 更新记录顶部显示它、每条记录也带着当时的值。老状态文件没有 → null，界面提示
	 * "下次导出 / 应用时会有"。
	 */
	stateId: StateIdRecord | null;
	/**
	 * **处理过的"收到的包"**（自动应用那条路走的账）。
	 *
	 * 为什么要有：不记的话，同一个包每隔 30 秒就会被重新看一眼 —— 已经应用过的还好
	 * （`bundleLog` 里有记录），**用户看过、决定先不应用的那些**会一直弹提示。
	 * 只留最近 `INCOMING_LIMIT` 笔，别把状态文件撑大。
	 */
	incoming: IncomingRecord[];
}

/** 「这个包我处理过了」的一笔记录（自动应用那条路用） */
export interface IncomingRecord {
	/** 包 ID */
	id: string;
	at: number;
	/** 处理结论：already（本地已有）/ applied（自己应用了）/ needs-review（要人看）/ failed */
	note: string;
	/** 包文件名（界面上对得上号） */
	file?: string;
}

/** `state.incoming` 最多留几笔 */
export const INCOMING_LIMIT = 30;

/** 记一笔"这个包处理过了"（自动应用那条路唯一需要写状态的地方） */
export function rememberIncoming(state: PluginState, record: IncomingRecord): void {
	const list = Array.isArray(state.incoming) ? state.incoming : [];
	list.push(record);
	state.incoming = list.slice(-INCOMING_LIMIT);
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
	/** 这一次导出 / 应用之后，我这边的状态编号（见 `sync/state-id.ts`）：两台机器的日志一比就知道同不同步 */
	stateId?: string;
	/**
	 * 这是一份**差量包**：从第 base 代**送到第 target 代那一刻**（而不是"到我现在的仓库"）。
	 *
	 * 导它的时候我这边什么都不推进（内容取自终点那份完整包），所以这一条里的 `stateId`
	 * 记的是**终点那一刻**的状态编号 —— 界面上要写明白，不然用户会以为"我现在就是这个状态"。
	 */
	checkpoint?: boolean;
}

export function emptyState(): PluginState {
	return {
		version: 1,
		copyId: randomUUID(),
		lineage: randomUUID(),
		generation: 0,
		lastBundleId: null,
		lastExportedBundleId: null,
		bundle: null,
		hashes: {},
		bundleLog: [],
		pendingReturn: null,
		stateId: null,
		incoming: [],
	};
}

/** 状态文件里的状态编号：字段类型不对（手改过、半截写入）就当没有，别让界面显示个假的 */
function normalizeStateId(raw: StateIdRecord | null | undefined): StateIdRecord | null {
	if (!raw || typeof raw.id !== 'string' || !raw.id) return null;
	return {
		id: raw.id,
		files: typeof raw.files === 'number' ? raw.files : 0,
		dirs: typeof raw.dirs === 'number' ? raw.dirs : 0,
		unverified: typeof raw.unverified === 'number' ? raw.unverified : 0,
		at: typeof raw.at === 'number' ? raw.at : 0,
	};
}

export async function loadState(absPath: string): Promise<PluginState> {
	return normalizeState(await readJsonFile<Partial<PluginState>>(absPath));
}

/**
 * 同步读状态：**只给设置面板那类同步渲染的地方用**（"更新包从哪个状态到哪个状态"
 * 的选项要当场列出来，等不了 await）。语义与 `loadState` 完全一样 —— 共用同一套收敛，
 * 所以手改坏的状态文件两条路读出来也一样。
 */
export function loadStateSync(absPath: string): PluginState {
	return normalizeState(readJsonFileSync<Partial<PluginState>>(absPath));
}

/** 读到的原始 JSON → 一份完整的状态（缺字段补默认、脏字段丢弃） */
function normalizeState(raw: Partial<PluginState> | null): PluginState {
	if (!raw || raw.version !== 1) return emptyState();
	return {
		version: 1,
		// 老状态文件里没有 copyId / lineage（升级上来的）：补一个
		copyId: typeof raw.copyId === 'string' && raw.copyId ? raw.copyId : randomUUID(),
		lineage: typeof raw.lineage === 'string' && raw.lineage ? raw.lineage : randomUUID(),
		generation: typeof raw.generation === 'number' ? raw.generation : 0,
		lastBundleId: raw.lastBundleId ?? null,
		lastExportedBundleId: raw.lastExportedBundleId ?? null,
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
		hashes: raw.hashes ?? {},
		bundleLog: Array.isArray(raw.bundleLog) ? raw.bundleLog : [],
		pendingReturn: raw.pendingReturn ?? null,
		// 老状态文件没有这一项 → null：界面提示"下次导出 / 应用时会算一个"
		stateId: normalizeStateId(raw.stateId),
		// 老状态文件没有这一项（那个年代还没有自动应用）：空表 ＝ 从头开始记
		incoming: Array.isArray(raw.incoming) ? raw.incoming : [],
	};
}

export async function saveState(absPath: string, state: PluginState): Promise<void> {
	await writeJsonAtomic(absPath, state);
}

/**
 * 世代号怎么走（**只在同步包这一条通道上**）：
 *
 * 导出一个包 +1、应用一个包跳到包里的 targetGeneration（但只增不减，见 `bundle/apply.ts`）。
 * 它不是版本号，只回答"你手上这份是不是我导出这个包时以为的那一份"。
 * 0.8.0 之前这里还写着"本地文件夹同步有自己的 per-target 基准、别混在一起" ——
 * 那条通道已经砍掉了，现在只有包这一条线在数世代。
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
