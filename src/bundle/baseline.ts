import { createHash } from 'node:crypto';
import type { BundleEntry, BundleHeader } from './format';
import type { FileRecord } from '../sync/types';

/**
 * 「完整副本基准」的指纹 —— 两台机器互相发更新包时的**共同祖先令牌**。
 *
 * 为什么非要有它：更新包的语义是"接着某一份完整副本往后累积的改动"（跟 git 的 base commit
 * 一个道理）。可原来判断"我们是不是站在同一份基准上"**只看世代号**，而世代号有两个毛病：
 * 1. 两台机器各自 +1，会碰号（A 的"第 4 代"和 B 的"第 4 代"根本不是同一个东西）；
 * 2. 内容对不上时看不出来 —— 世代可能"看着够"，基准其实不是同一份。
 * 结果就是用户说的"不确定更新状态"：工具自己都说不清两边是不是同一条线上的。
 *
 * 指纹 = 清单（路径 + 大小 + 修改时间）排序后取 sha256 前 16 位：
 * - **完整包**：指纹由它自己的条目算出来（谁都能重算，不需要信任头部里那个字段）；
 * - **更新包**：带上"我基于的那份完整副本"的指纹（它算不出来 —— 它手里只有变过的那部分）；
 * - 接收方应用时一比：一致＝确定接着同一份基准；不一致＝明确说出来（而不是静默降级合并）。
 */

/** 清单 → 短指纹。传进来的顺序无所谓，函数自己排序 */
export function listingHash(entries: Iterable<{ path: string; size: number; mtime: number }>): string {
	const list = [...entries].map(item => [item.path, item.size, Math.round(item.mtime)] as const);
	list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	const hash = createHash('sha256');
	for (const [path, size, mtime] of list) hash.update(`${path}\0${size}\0${mtime}\n`);
	return hash.digest('hex').slice(0, 16);
}

/** 仓库清单（path → 大小/时间）也能直接算：导出完整包时用 */
export function listingHashOfFiles(files: Iterable<[string, FileRecord]>): string {
	return listingHash([...files].map(([path, record]) => ({ path, size: record.size, mtime: record.mtime })));
}

/**
 * 一份**完整包**自带的基准指纹：由它自己的条目重算（头部里那个字段只是方便看，
 * 真正的判据是这个重算结果 —— 旧版本的包没有这个字段也能照样用）。
 */
export function baselineOfFullBundle(entries: Iterable<BundleEntry>): string {
	return listingHash(entries);
}

/** 这个包说它基于哪一份基准：完整包＝它自己；更新包＝头部里那个字段（旧包没有 → null） */
export function baselineOfBundle(header: BundleHeader): string | null {
	if (header.mode === 'full') return header.baselineHash ?? baselineOfFullBundle(header.entries);
	return header.baselineHash ?? null;
}

export type BaselineMatch =
	/** 跟这个包同一份完整副本：接着它往后应用是确定的 */
	| 'match'
	/** 两边基准不是同一份：这次只能逐文件合并，要彻底对齐得互导一次完整副本 */
	| 'mismatch'
	/** 说不清：包是旧版本导的（没记指纹），或者这台机器还没应用过完整副本 */
	| 'unknown';

/** 对比"我这边的基准指纹"与"这个包说的基准指纹" */
export function compareBaseline(mine: string | null, header: BundleHeader): BaselineMatch {
	// 完整包自带基准：应用它就是对齐，没什么可比的
	if (header.mode === 'full') return 'match';
	const theirs = baselineOfBundle(header);
	if (!mine || !theirs) return 'unknown';
	return mine === theirs ? 'match' : 'mismatch';
}
