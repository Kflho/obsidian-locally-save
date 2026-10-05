import path from 'node:path';
import { baselineOfBundle } from './baseline';
import { listBundles } from './manage';
import { BUNDLE_EXT, readBundleInfoSync } from './format';
import type { BundleHeader } from './format';
import { bundleDirsToScan } from './paths';
import { listFilesSync } from '../sync/disk';
import type { StateIdInfo } from '../sync/state';
import type { FileRecord } from '../sync/types';

/**
 * 「状态」＝**一份完整副本**（或者"最新"＝当前仓库）。
 *
 * 更新包本来就是"从某个状态到某个状态的差量"，两个端点在界面上都该能选：
 *
 * - **从**：对方手里那份完整副本 —— 默认是"我最新那份"，也可以指定硬盘上更老的那一份。
 *   为什么需要：我重立了基准（第 36 代那份），对方还站在第 32 代上，按最新基准导出来的
 *   更新包对它是"基于一份它没有的完整副本"（只能逐文件合并）。而**第 32 代那份完整包
 *   还在硬盘上**（完整副本是还原点，从来不会被清），指定它当起点，对方收到就是
 *   接着自己那份基准的确定性更新。
 * - **到**：默认"最新"（当前仓库，含你刚改的东西）；也可以指定另一份完整副本 ——
 *   那就导一份"从 a 到 b 那一刻"的差量包，内容取自 b 那份包本身（不是你现在的仓库）。
 *
 * 一句话对照 git：完整包 ＝ commit，更新包 ＝ "从某个 commit 到某个 commit 的 diff"。
 *
 * **世代号只是节奏号**（两台机器各自 +1 会碰号），所以认状态要靠**状态编号**：
 * 界面上每个状态都写成「第 N 代 · 状态 xxxx」。这个文件不 import obsidian。
 */

/** 一份可用于当"状态"的完整副本 */
export interface BundleAnchor {
	/** 它是第几代导出的（包头部 `targetGeneration`）—— 站在它的接收方手里的世代 */
	generation: number;
	/** 它的基准指纹（见 `baseline.ts`）：应用过它的机器，`fullHash` 就是这个 */
	hash: string | null;
	/** 它的完整清单（path → 大小 / 修改时间）：差量包按它挑"自它以来变过的文件" */
	files: Record<string, FileRecord>;
	/** 它记着的空文件夹（有文件的目录会随文件写入顺带建出来，空的只能靠这份清单） */
	emptyDirs: string[];
	/** 在界面 / 报告里显示的文件名（不含目录） */
	name: string;
	/** 包文件绝对路径（导 a→b 差量包时要读它的负载；空串 ＝ 状态里记着、磁盘上找不到） */
	file: string;
	/**
	 * 这份完整包记的**状态编号**（导出方导完那一刻的文件状态，见 `sync/state-id.ts`）。
	 *
	 * 存整份而不只是那个 id：导"到某一份完整副本"的差量包时，要把它原样写进新包的头部 ——
	 * 接收方应用完算一个自己的跟它比，**相同就说明正好落到了那一刻**。
	 */
	stateId: StateIdInfo | null;
	/** 包文件的修改时间：同一代有好几份时按它挑最新的那份 */
	mtime: number;
}

/** 一份完整包 → 一个状态（不是完整包就返回 null） */
export function anchorOfHeader(
	header: BundleHeader | null | undefined,
	file: string,
	name: string,
	mtime: number,
): BundleAnchor | null {
	if (!header || header.mode !== 'full') return null;
	const files: Record<string, FileRecord> = {};
	for (const entry of header.entries ?? []) files[entry.path] = { size: entry.size, mtime: entry.mtime };
	return {
		generation: header.targetGeneration,
		hash: baselineOfBundle(header),
		files,
		emptyDirs: [...(header.emptyDirs ?? [])],
		name,
		file,
		stateId: header.stateId ?? null,
		mtime,
	};
}

/**
 * 包里目录下所有**同一条血脉**的完整副本，世代大的排前面（同代按修改时间新的在前）。
 *
 * 为什么只认同一条血脉：别的机器独立立的基准跟我的"第几代"根本不是一回事
 * （世代号会碰号），拿它当起点算出来的更新包谁也不认识。
 */
export async function listFullAnchors(baseDir: string, lineage: string): Promise<BundleAnchor[]> {
	const out: BundleAnchor[] = [];
	for (const item of await listBundles(baseDir)) {
		const header = item.header;
		if (!header || header.mode !== 'full') continue;
		if (header.lineage !== lineage) continue;
		const anchor = anchorOfHeader(header, item.file, item.name, item.mtime);
		if (anchor) out.push(anchor);
	}
	return sortAnchors(out);
}

/**
 * 同步版：设置面板是**同步渲染**的，"从哪个状态 / 到哪个状态"两个下拉要在渲染那一刻
 * 就有选项，等不了 `await`。只看 `full/` 与根目录（完整包就放那儿，数量很少），
 * 读不出头部的包直接跳过 —— 选项里少一个，总比下拉框空着强。
 */
export function listFullAnchorsSync(baseDir: string, lineage: string): BundleAnchor[] {
	if (!baseDir) return [];
	const out: BundleAnchor[] = [];
	for (const dir of bundleDirsToScan(baseDir)) {
		// 更新包目录里不会有完整包，但真放了一份（用户手动挪的）也该列出来 —— 反正读头部很便宜
		for (const item of listFilesSync(dir)) {
			if (!item.name.toLowerCase().endsWith(BUNDLE_EXT)) continue;
			const file = path.join(dir, item.name);
			try {
				const header = readBundleInfoSync(file).header;
				if (header.mode !== 'full' || header.lineage !== lineage) continue;
				const anchor = anchorOfHeader(header, file, item.name, item.mtime);
				if (anchor) out.push(anchor);
			} catch {
				// 读不出头部（不是我们的包 / 传坏了）：不当状态用
			}
		}
	}
	return sortAnchors(out);
}

/** 世代大的在前；同代取最近写的那一份 */
function sortAnchors(anchors: BundleAnchor[]): BundleAnchor[] {
	return anchors.sort((a, b) => b.generation - a.generation || b.mtime - a.mtime);
}

/**
 * 按**基准指纹**找状态 —— 下拉框的键就是它（`''` ＝ 最新）。
 *
 * **为什么认指纹、不认世代号**：世代号是每台机器各数各的节奏号（导出一个包 +1），
 * 两边的"第 32 代"完全可能是**两份不同的完整副本**（一份是我导的、一份是它自己导的）。
 * 用户实测就踩了这个：按"第 32 代"选起点导出的更新包，对面报「基准对不上」——
 * 选中的那一份根本不是对方手里那份（对方报的指纹其实是本机**最新**那份的）。
 * 指纹是内容的直接证据，认它才认得出"同一份东西"。
 */
export function pickAnchor(anchors: BundleAnchor[], hash: string): BundleAnchor | null {
	return anchors.find(anchor => anchor.hash === hash) ?? null;
}

/** 按基准指纹找状态（自己去列目录） */
export async function findFullAnchor(
	baseDir: string,
	lineage: string,
	hash: string,
): Promise<BundleAnchor | null> {
	return pickAnchor(await listFullAnchors(baseDir, lineage), hash);
}

/**
 * 一个状态在界面上怎么念 —— **写对方报给你的那一项**：
 * - `from`（起点）：`第 32 代 · 基准 7a22d790635332a0` —— 对方「更新记录」顶上写着
 *   「基准：第 32 代 · 指纹 7a22d790635332a0」，照那个指纹选，别只看代；
 * - `to`（终点）：`第 32 代 · 状态 3f9a2c1d4e5f6a7b` —— 对方应用完的结论里写的是「状态 …」。
 *
 * **世代与编号必须一起写**：世代号只说明"接着谁往后数"（两台各自 +1 会碰号），
 * 指纹 / 状态编号才说明"这是哪一份东西"。只看世代会认错包（用户实测报过）。
 */
export function describeAnchor(anchor: BundleAnchor, end: 'from' | 'to' = 'from'): string {
	const id = end === 'from'
		? `基准 ${anchor.hash ?? '未记（旧版包）'}`
		: `状态 ${anchor.stateId?.id ?? '未记（旧版包）'}`;
	return `第 ${anchor.generation} 代 · ${id}`;
}

/** 「本地有几个完整包就有几个状态」—— 下拉框的键：`''` ＝ 最新，其余是基准指纹 */
export const LATEST_STATE = '';

export interface LatestInfo {
	/** 我最新那份完整副本是第几代（还没立过基准时为 null） */
	generation: number | null;
	/** 那份完整副本的基准指纹 */
	hash: string | null;
	/** 那份完整包的文件名 */
	file: string | null;
}

/**
 * 两个下拉（从哪个状态 / 到哪个状态）的选项。
 *
 * **键是基准指纹**（不是世代号）：同一代可能有好几份完整副本（两台机器各导过一份），
 * 按世代做键会把它们挤成一个选项、还默默挑一份（用户实测就是这么踩到"基准对不上"的）。
 * 同一份东西（指纹相同）只留一个选项。
 *
 * 「最新」在两端意思不一样，所以文案分开写：
 * - `from`：最新 ＝ **我最新那份完整副本**（默认；对方多半就站在它上面）；
 * - `to`：最新 ＝ **当前仓库**（现在这一刻，含你刚改的东西）—— 这也是默认。
 */
export function anchorOptions(
	anchors: BundleAnchor[],
	end: 'from' | 'to',
	latest: LatestInfo,
): Record<string, string> {
	const options: Record<string, string> = {};
	if (end === 'from') {
		const detail = latest.generation !== null
			? `第 ${latest.generation} 代${latest.hash ? ` · 基准 ${latest.hash}` : ''}`
			: '还没立过基准';
		options[LATEST_STATE] = `最新那份完整副本（${detail}）`;
	} else {
		options[LATEST_STATE] = '最新（当前仓库，现在这一刻）';
	}
	const seen = new Set<string>();
	for (const anchor of anchors) {
		const hash = anchor.hash;
		if (!hash || seen.has(hash)) continue;
		seen.add(hash);
		options[hash] = describeAnchor(anchor, end);
	}
	return options;
}

/**
 * 报错 / 界面提示里把"现在有哪些状态"列出来：`第 36 代 · 基准 7a22d790…（包名）`。
 * 照这一串去对方「更新记录」里找同一个指纹，就知道该选哪一个。
 */
export function describeAnchorList(anchors: BundleAnchor[]): string {
	if (anchors.length === 0) return '这个文件夹里一份同血脉的完整副本都没有';
	return `现在找得到的状态是：${anchors
		.map(anchor => `${describeAnchor(anchor, 'from')}（${anchor.name}）`)
		.join('、')}`;
}
