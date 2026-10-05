import path from 'node:path';
import { baselineOfBundle } from './baseline';
import { BUNDLE_EXT, readBundleInfoSync } from './format';
import type { BundleHeader } from './format';
import { bundleDirsToScan } from './paths';
import { listFilesSync } from '../sync/disk';
import type { StateIdInfo } from '../sync/state';
import type { FileRecord } from '../sync/types';

/**
 * **链条上的点**：把包目录里同一个血脉的包串成链，算出每一个基准点长什么样。
 *
 * 为什么需要它：导出对话框那两个下拉（从哪个状态 / 到哪个状态）原来只列**完整副本**。
 * 可链条模型里"状态"不止完整副本 —— **每份更新包都落出一个新点**，用户完全可能想
 * "从对方站的某个中间点导到另一个点"。这些点没有自己的包文件，但它们的身份（指纹）
 * 就写在包头部：完整包的是它自己的清单指纹，更新包的是 `targetBaselineHash`。
 *
 * **清单与内容都是沿链条叠加出来的**（只用头部 + 各包的负载偏移，不读文件内容）：
 *
 * ```
 * 点 P0（完整包）  清单 = 它的条目；内容 = 它的负载
 *      │  更新包 C1（baselineHash = P0，targetBaselineHash = P1）
 *      ▼
 * 点 P1           清单 = P0 清单 ＋ C1 的条目 − C1 点名的删除
 *                 内容 = 改过的那些从 C1 的负载取，其余仍从 P0 的负载取
 * ```
 *
 * 于是"从 P1 导到 P2"这种包也就做得出来了：起点清单拿 P1 的，内容逐文件沿链找
 * （哪个包里有点名它的条目就用哪个包的字节）。旧版更新包没记 `targetBaselineHash`，
 * 接不出落点 —— 那种包只能当接收方，不能当链条上的点，这里直接跳过。
 *
 * 这个文件不 import obsidian，全是同步的头部读取（设置面板是同步渲染的，等不了 await）。
 */

/** 一个点的"身份"：下拉框与报错信息只需要这几样，清单是重活，等真要用了再取 */
export interface PointRef {
	/** 落点指纹（`targetBaselineHash`；完整包 ＝ 它自己的清单指纹） */
	hash: string;
	generation: number;
	stateId: StateIdInfo | null;
	/** 从哪一点来（完整包 ＝ null） */
	from: string | null;
	/** 这一环基于的那一代（头部 `baseGeneration`）——起点那份包不在文件夹里时，区间还得靠它报出来 */
	baseGeneration: number | null;
	/** 落到这一点的那份包 */
	file: string;
	name: string;
	mtime: number;
}

/** 一个文件的字节在哪儿：哪份包、负载里的绝对偏移 */
export interface PointSource {
	file: string;
	offset: number;
	size: number;
	mtime: number;
	hash?: string;
}

/** 一个点的"全部"：清单 + 每个文件的字节位置 */
export interface ChainPoint extends PointRef {
	files: Record<string, FileRecord>;
	emptyDirs: string[];
	sources: Map<string, PointSource>;
}

/** 扫一遍包目录，把能读出头部的包拿出来（位置 + 头部 + 负载起点） */
function readBundlesSync(
	baseDir: string,
	lineage: string,
): { file: string; name: string; mtime: number; header: BundleHeader; payloadOffset: number }[] {
	if (!baseDir) return [];
	const out: { file: string; name: string; mtime: number; header: BundleHeader; payloadOffset: number }[] = [];
	for (const dir of bundleDirsToScan(baseDir)) {
		for (const item of listFilesSync(dir)) {
			if (!item.name.toLowerCase().endsWith(BUNDLE_EXT)) continue;
			const file = path.join(dir, item.name);
			try {
				const info = readBundleInfoSync(file);
				if (info.header.lineage !== lineage) continue;
				out.push({ file, name: item.name, mtime: item.mtime, header: info.header, payloadOffset: info.payloadOffset });
			} catch {
				// 读不出头部（不是我们的包 / 传坏了）：不当点用
			}
		}
	}
	return out;
}

/**
 * 链条上有哪些点（**轻**：只读头部，不动清单）。
 *
 * 同一个指纹只留一份（两台机器可能各导过一份一模一样的落点）：留最近写的那份。
 * 世代大的排前面 —— 下拉框里离"最新"近的先出现。
 */
export function listPointRefsSync(baseDir: string, lineage: string): PointRef[] {
	const byHash = new Map<string, PointRef>();
	for (const item of readBundlesSync(baseDir, lineage)) {
		const header = item.header;
		const hash = header.mode === 'full' ? baselineOfBundle(header) : (header.targetBaselineHash ?? null);
		if (!hash) continue; // 旧版更新包没记落点：接不出下一环，不能当点
		const ref: PointRef = {
			hash,
			generation: header.targetGeneration,
			stateId: header.stateId ?? null,
			from: header.mode === 'full' ? null : baselineOfBundle(header),
			baseGeneration: header.baseGeneration ?? null,
			file: item.file,
			name: item.name,
			mtime: item.mtime,
		};
		const old = byHash.get(hash);
		if (!old || ref.mtime >= old.mtime) byHash.set(hash, ref);
	}
	return [...byHash.values()].sort((a, b) => b.generation - a.generation || b.mtime - a.mtime);
}

/**
 * 把一个点**真正算出来**（清单 + 每个文件的字节位置）：沿链条从它的起点往前叠加。
 *
 * 只要需要的那一段（递归到起点那份完整包为止），不把整条链都算一遍。
 * 找不到（点不在这个文件夹里 / 链条断了）返回 null，调用方如实报错，别猜。
 */
export function materializePointSync(baseDir: string, lineage: string, hash: string): ChainPoint | null {
	const bundles = readBundlesSync(baseDir, lineage);
	return buildPoint(bundles, hash, new Set());
}

function buildPoint(
	bundles: { file: string; name: string; mtime: number; header: BundleHeader; payloadOffset: number }[],
	hash: string,
	seen: Set<string>,
): ChainPoint | null {
	if (seen.has(hash)) return null; // 防环（包被手工改坏时也不至于转不出来）
	seen.add(hash);

	// 完整包：它就是那一点，清单与内容都从它自己身上来
	const full = bundles.find(item => item.header.mode === 'full' && baselineOfBundle(item.header) === hash);
	if (full) {
		const files: Record<string, FileRecord> = {};
		const sources = new Map<string, PointSource>();
		for (const entry of full.header.entries ?? []) {
			files[entry.path] = { size: entry.size, mtime: entry.mtime };
			sources.set(entry.path, {
				file: full.file,
				offset: full.payloadOffset + entry.offset,
				size: entry.size,
				mtime: entry.mtime,
				...(entry.hash ? { hash: entry.hash } : {}),
			});
		}
		return {
			hash,
			generation: full.header.targetGeneration,
			stateId: full.header.stateId ?? null,
			from: null,
			baseGeneration: null,
			file: full.file,
			name: full.name,
			mtime: full.mtime,
			files,
			emptyDirs: [...(full.header.emptyDirs ?? [])],
			sources,
		};
	}

	// 更新包：起点 ＋ 它的条目 − 它点名的删除
	const link = bundles.find(item => item.header.mode === 'changes' && item.header.targetBaselineHash === hash);
	if (!link) return null;
	const baseHash = baselineOfBundle(link.header);
	if (!baseHash) return null;
	const base = buildPoint(bundles, baseHash, seen);
	if (!base) return null;

	const files: Record<string, FileRecord> = { ...base.files };
	const sources = new Map(base.sources);
	for (const entry of link.header.entries ?? []) {
		files[entry.path] = { size: entry.size, mtime: entry.mtime };
		sources.set(entry.path, {
			file: link.file,
			offset: link.payloadOffset + entry.offset,
			size: entry.size,
			mtime: entry.mtime,
			...(entry.hash ? { hash: entry.hash } : {}),
		});
	}
	for (const item of link.header.deleted ?? []) {
		delete files[item.path];
		sources.delete(item.path);
	}
	return {
		hash,
		generation: link.header.targetGeneration,
		stateId: link.header.stateId ?? null,
		from: baseHash,
		baseGeneration: link.header.baseGeneration ?? null,
		file: link.file,
		name: link.name,
		mtime: link.mtime,
		files,
		// 更新包记的是导出方**全部空文件夹**的清单（不是增量），所以直接用它
		emptyDirs: [...(link.header.emptyDirs ?? [])],
		sources,
	};
}
