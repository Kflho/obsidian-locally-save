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
	/** 上次导出 / 应用之后**两边都见过的那一份**（＝基准点的清单，与 `fullFiles` 同值） */
	files: Record<string, FileRecord>;
	/**
	 * **我站的这个基准点**长什么样（清单）。
	 *
	 * 链条模型（0.11 起）：**完整包**与**每份被应用的更新包**都会成为一个基准点，
	 * 点与点之间是严格镜像（包里点名什么就是什么），所以链条上每一个节点的内容都是确定的。
	 * 自己导出的更新包是"**可能的**基准点"（见 `pointConfirmed`），对方合并之后才算数。
	 *
	 * 用途有两个：
	 * 1. **两边对表**：导更新包时头部带上它的指纹（`fullHash`），对方站在同一个点上才收得下；
	 * 2. **算"我自基准点以来改了什么"**（`describeLocalChanges`），也就是"下一个更新包会装什么"。
	 *
	 * null ＝ 还没导过 / 应用过完整包，这时不给导更新包（没有起点）。
	 */
	fullFiles: Record<string, FileRecord> | null;
	/** 这个基准点的世代（接收方应用完到达的世代）；null ＝ 还没有基准点 */
	fullGeneration: number | null;
	/**
	 * 这个**基准点的指纹**（`bundle/baseline.ts`）—— 两台机器对表用的令牌。
	 *
	 * 应用任何包之后 ＝ 包送到的那一点；导出之后 ＝ 这次导到的那一点
	 * （导更新包时头部报的仍是**导出前**那一点：对方该站在那儿）。
	 * 世代号替代不了它：世代号只说"内容走到第几版"，说不清"我们是不是同一个点"。
	 * null ＝ 旧状态文件或还没有基准点。
	 */
	fullHash: string | null;
	/**
	 * 这个基准点是**从哪份包**来的（不含目录）：完整包是它自己，更新包就是那份更新包。
	 * 界面上"我现在站在哪一点上"要写出来，光有世代和指纹用户对不上号。
	 * null ＝ 旧状态文件（升级上来的）。
	 */
	fullFile: string | null;
	/**
	 * 这个基准点**对方确认了没有**。
	 *
	 * - `true`：两边都到过这一点（对方导出的包送到这儿、我应用了；或对方发来的包把我的点报成它的基准）；
	 * - `false`：只是**我这边**的点（自己导出后还没被对方合并）—— 链条上还不能算数；
	 * - `null` / 缺省：旧状态文件，说不清。
	 */
	pointConfirmed?: boolean | null;
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
 * 世代号回答"这是第几版内容"、基准指纹回答"从哪一份完整副本分出来的"，
 * 而"此刻两边的文件到底一样吗"只有状态编号答得准：**编号相同 ＝ 文件内容一致**。
 * 导出时写进包头部，应用完跟自己的比一比，更新记录里每条都记着 ——
 * 打开日志就能确定两边到底同不同步。
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
	 * 之后两边才谈得上"同一个世代号指的是同一份内容"。设备自己另起一条血脉是没用的 ——
	 * 两边各数各的，号对不上，更新包也互不认识。
	 */
	lineage: string;
	/**
	 * **世代号 ＝ 内容在这个血脉里的版本号**（定义与三条落地规则见 `bundle/apply.ts`）。
	 *
	 * 一句话：**同一份内容，在任何机器、走任何路径，报出来的世代号都相同** ——
	 * 号更新就是内容更新，号相同就是同一版内容。所以：
	 * - 导更新包 `+1`；导完整副本时内容没动过就**沿用当前**、有真改动才 `+1`；
	 * - **应用任何包都直接采纳包说的那一代**（包括应用一份更老的完整副本时往回走 ——
	 *   内容退回去了，号就该退回去）。**别再写成"只增不减"**：那个旧定义
	 *   （"这份副本见过这条血脉的哪一段"）会让两台内容相同的机器报出不同的号，
	 *   "第几代"当场失去意义。
	 */
	generation: number;
	/**
	 * **高水位：这个血脉里已经发到第几号了**（只增不减）。
	 *
	 * 为什么单独记一个：`generation` 回答的是"**我的内容**站在哪一点" —— 应用一份更老的完整副本
	 * 回退时它会往回走（同一份内容同一个号，这是对的）。可"**新**内容该发第几号"问的是另一件事：
	 * 这个血脉里**已经用过**哪些号。
	 *
	 * 没有它时，回退到第 39 代再导出会发「39 → 40」—— 而 40 在历史上早被这条线用过
	 * （39→40→…→54），同一个号底下出现两份不同内容，更新顺序当场乱掉、还从 39 分出一条岔
	 * （用户报的："39-54-最新更新，回退到 39 之后应该导 54→55，现在却变成 39→40"）。
	 *
	 * 所以：**新内容一律发 `maxGeneration + 1`**；内容没动（沿用当前号）时不动它。
	 * 旧状态文件没有这一项 → 以 `generation` 当起点，之后只增不减。
	 */
	maxGeneration: number;
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
	 * 所以只记一笔账：下次**导出更新包时一起带上**（那一环本来就是"从当前基准点往外延伸"的，
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
	/**
	 * 这一条记录**为什么而来**（中文短语，写进「更新记录」）。
	 *
	 * 用在流程自己发起的那两次导出上：应用别人的包之前"先把我的改动存成包"、
	 * 应用成功之后"把那一环接到新基准点上"。不写说明的话，用户在更新记录里看到的是
	 * 两条来路不明的导出，会以为插件在乱写包（用户报过"我没看到改动的包"，
	 * 当时就是没法从记录里认出哪一条是它）。
	 */
	note?: string;
}

export function emptyState(): PluginState {
	return {
		version: 1,
		copyId: randomUUID(),
		lineage: randomUUID(),
		generation: 0,
		maxGeneration: 0,
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
		// 老状态文件没有高水位（升级上来的）：拿当前的号当起点，之后只增不减
		maxGeneration: typeof raw.maxGeneration === 'number' && raw.maxGeneration > 0
			? raw.maxGeneration
			: (typeof raw.generation === 'number' && raw.generation > 0 ? raw.generation : 0),
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
				// 老状态文件没有这一项（升级上来的）：说不清，界面不写这一句
				pointConfirmed: typeof raw.bundle.pointConfirmed === 'boolean' ? raw.bundle.pointConfirmed : null,
				history: raw.bundle.history ?? {},
				dirs: raw.bundle.dirs ?? [],
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

/**
 * 抬高**高水位**（只增不减）：把"发出过 / 见过"的世代号都过一遍。
 *
 * 两个调用点：**导出**写下某个号之后、**应用**别人的包采纳它报的号之后。
 * 它不参与"我站在哪一点"（那是 `generation`，回退时会往回走），
 * 只保证"这个血脉里发过的号不会被第二次发出去"（见 `maxGeneration` 那段）。
 */
export function raiseGeneration(state: PluginState, ...values: (number | null | undefined)[]): void {
	let highest = typeof state.maxGeneration === 'number' ? state.maxGeneration : 0;
	for (const value of values) {
		if (typeof value === 'number' && Number.isFinite(value) && value > highest) highest = value;
	}
	state.maxGeneration = highest;
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
