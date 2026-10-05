import { createHash } from 'node:crypto';
import { yieldIfDue } from '../utils/async';
import { fingerprint } from './hash-cache';
import { HASH_KEEP } from './state';
import type { PluginState, StateIdInfo } from './state';
import type { FileRecord } from './types';

/**
 * 「状态编号」—— **整个仓库现在长什么样**的短指纹，回答"两边的文件到底一样吗"。
 *
 * 为什么还需要它（0.10.1 之后世代号已经能表示"谁更新"了）：世代号回答"这是第几版内容"、
 * 基准指纹回答"我们从哪一份完整副本分出来的"，而**"此刻两边的文件到底一样不一样"**
 * 只有把内容本身算一遍才答得准 —— 两台机器各自改过、又碰巧改成一样，世代号与基准都对不上，
 * 但内容确实一致（用户提的："需要一个编号让用户能确定当前文件状态，如哈希值，
 * 打开日志看到就能确定两边文件到底是否一致"）。状态编号把这件事变成一句能对的话：
 * **编号相同 ＝ 文件内容一样**（反过来：编号不同就一定还有差别）。
 *
 * 定义（sha256 前 16 位，跟基准指纹一个风格）：把下面两类行排序后逐行喂进 sha256
 * ```
 *   文件： f\0路径\0内容指纹
 *   目录： d\0路径            ← 空文件夹也算。只比文件的话，"只差一个空文件夹"两边会长得一样
 * ```
 * - 内容指纹走 `fingerprint()` 的缓存（按大小 + 修改时间失效），所以第一次之后只重读改过的文件；
 *   **编号里不掺 mtime** —— 跨机器搬过之后时间可能不同、内容却一样，那正是用户要的"一致"。
 * - 拿不到内容指纹的文件（单个超过 64MB、读文件失败）**不假装一致**：那一行退化成
 *   "大小 + 时间"，并把个数记进 `unverified`，界面上如实报出来。
 */
export async function computeStateId(options: {
	vaultRoot: string;
	state: PluginState;
	files: Iterable<[string, FileRecord]>;
	dirs: Iterable<string>;
	/**
	 * 路径 → 内容指纹，**覆盖"去仓库里读"**。
	 *
	 * 给"内容不在仓库里"的清单算编号用。最典型的是 `export.ts` 的 `parkLocalChangesFor`：
	 * 那一环送到的是「**新点 ＋ 我的东西**」—— 被对方那份包覆盖的路径上，落点用的是**对方那一版**
	 * （我仓库里现在还是改动前的旧版本），照仓库读会算出一个错的编号，接收方应用完一比就报
	 * "还差一点"（踩过）。
	 */
	hashes?: ReadonlyMap<string, string>;
}): Promise<StateIdInfo> {
	const dirs = [...options.dirs];
	const lines: string[] = [];
	let files = 0;
	let unverified = 0;
	let lastYieldAt = Date.now();
	for (const [path, record] of options.files) {
		files++;
		// 冷缓存时这一步要读一遍仓库（几个 GB 的话是好几秒）—— 按时间让帧，界面别僵住。
		// 它**不报进度**：导出进度只认"打进包里几个文件"，别把内部步骤编进那个数字。
		lastYieldAt = await yieldIfDue(lastYieldAt);
		const known = options.hashes?.get(path);
		const hash = known ?? await fingerprint(options.vaultRoot, options.state, path, record, true);
		if (hash) {
			// ⚠ 指纹缓存里存的是**截断**过的 16 位（`rememberHash` 的 HASH_KEEP），而现算出来的是完整
			// 64 位 —— 不统一长度的话，"缓存命中"和"刚算的"会喂进两种不同的行，同一个仓库算两次
			// 得到两个编号（踩过：应用完对不上，一查是缓存里 16 位、刚算的 64 位）。
			lines.push(`f\0${path}\0${hash.slice(0, HASH_KEEP)}`);
		} else {
			unverified++;
			lines.push(`f\0${path}\0${record.size}\0${Math.round(record.mtime)}`);
		}
	}
	for (const dir of dirs) lines.push(`d\0${dir}`);
	lines.sort();
	const digest = createHash('sha256');
	for (const line of lines) digest.update(line).update('\n');
	return {
		id: digest.digest('hex').slice(0, 16),
		files,
		dirs: dirs.length,
		unverified,
	};
}

/** 两份状态编号比出来的结论（应用别人的包之后算） */
export type StateIdCompare =
	/** 一模一样：**两边的文件内容一致**（这就是用户想要的那句话） */
	| 'match'
	/** 不一样：多半是"我这边还有对方没有的改动没发出去"，也可能是对方没收到我的 */
	| 'mismatch'
	/** 说不清：包是旧版本导的（头部没记编号），或者这边还没算过 */
	| 'unknown';

/** 比一比"我这边的状态编号"与"包头部里那个" */
export function compareStateId(mine: StateIdInfo | null, theirs: StateIdInfo | null): StateIdCompare {
	if (!mine || !theirs) return 'unknown';
	return mine.id === theirs.id ? 'match' : 'mismatch';
}
