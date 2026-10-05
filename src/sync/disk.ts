import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { byDepthDesc, dirnameRel, toNative } from '../utils/paths';
import { YIELD_EVERY, yieldToUi } from '../utils/async';
import { isExcluded } from './exclude';
import type { FileRecord, Inventory } from './types';

/**
 * 磁盘访问层：同步引擎里**唯一**碰 node:fs 的地方。
 *
 * 为什么不走 Obsidian 的 vault API：同步目标是仓库之外的文件夹，vault API 出不了库；
 * 而且 fs.copyFile 走的是系统调用，几百 MB 也是一两秒的事 —— 这正是本插件存在的理由
 * （对比 Remotely Save 走网络的耗时）。代价是只能桌面端用，见 manifest 的 isDesktopOnly。
 */

export interface ScanOptions {
	/** 排除规则（见 exclude.ts） */
	exclude: string[];
	/** 顶层要整个跳过的目录名（状态目录、回收站这类，不该被同步） */
	skipTopLevelDirs?: string[];
}

/**
 * 回收目录里专门放"冲突输的那一份"的子文件夹。
 *
 * 为什么不留在原地：留在仓库里的冲突副本会**跟着同步传到对面去**，两边各滚一份、越滚越多。
 * 挪进回收目录之后它天然不参与同步（`.trash` / `.lsave` 本来就被排除），
 * 而且照样能捞回来。
 */
export const CONFLICT_TRASH_DIR = '冲突';

/** 递归扫描一个目录，返回「文件 → 大小 + 修改时间」与「见过的目录」 */
export async function scanTree(root: string, options: ScanOptions): Promise<Inventory> {
	const files = new Map<string, FileRecord>();
	const dirs = new Set<string>();
	const skip = new Set(options.skipTopLevelDirs ?? []);

	async function walk(relDir: string): Promise<void> {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(toNative(root, relDir), { withFileTypes: true });
		} catch {
			// 目录不存在或没权限：当作空的，不要把整次同步搞崩
			return;
		}

		for (const entry of entries) {
			const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
			// 符号链接一律跳过：可能绕成环，也可能指到仓库外面去
			if (entry.isSymbolicLink()) continue;

			if (entry.isDirectory()) {
				if (!relDir && skip.has(entry.name)) continue;
				if (isExcluded(rel, options.exclude)) continue;
				dirs.add(rel);
				await walk(rel);
				continue;
			}
			if (!entry.isFile()) continue;
			if (isExcluded(rel, options.exclude)) continue;

			const record = await statFile(toNative(root, rel));
			if (record) files.set(rel, record);
			// 一万个文件的全库遍历也要让界面喘气：每 N 个文件让一步
			if (files.size > 0 && files.size % YIELD_EVERY === 0) await yieldToUi();
		}
	}

	await walk('');
	return { files, dirs };
}

/**
 * 删掉一个**空**目录；非空 / 不存在都返回 false。
 *
 * 这是目录删除的唯一入口：用的是 `rmdir`，**非空目录必然失败** ——
 * 所以哪怕上游判断错了（比如某个文件被排除规则挡在清单外），
 * 最坏结果也只是"没删掉"，绝不会删掉还有内容的目录。
 */
export async function removeEmptyDir(absPath: string): Promise<boolean> {
	try {
		await fs.promises.rmdir(absPath);
		return true;
	} catch {
		return false;
	}
}

/**
 * 把一批路径**删空之后剩下的空目录**收拾掉。
 *
 * 传进来的是刚被删掉 / 挪走的路径：顺着它们的父目录往上走，能删就删
 * （`rmdir` 对非空目录会失败，所以只会删真空的，绝不会碰有内容的目录），
 * 到根为止。返回**真的删掉了哪些目录**（相对路径）。
 */
export async function pruneEmptyDirsDetailed(root: string, removedPaths: string[]): Promise<string[]> {
	const candidates = new Set<string>();
	for (const rel of removedPaths) {
		let dir = dirnameRel(rel);
		while (dir) {
			candidates.add(dir);
			dir = dirnameRel(dir);
		}
	}

	// 深的先删：父子都在名单里时，先删子目录，父目录才可能变空
	const ordered = [...candidates].sort((a, b) => b.split('/').length - a.split('/').length);
	const removed: string[] = [];
	for (const dir of ordered) {
		if (await removeEmptyDir(toNative(root, dir))) removed.push(dir);
	}
	return removed;
}

/** 同上，只要个数（调用方不关心是哪些） */
export async function pruneEmptyDirs(root: string, removedPaths: string[]): Promise<number> {
	return (await pruneEmptyDirsDetailed(root, removedPaths)).length;
}

/** 取一个文件的大小与修改时间；不存在 / 读不到返回 null */
export async function statFile(absPath: string): Promise<FileRecord | null> {
	try {
		const stat = await fs.promises.stat(absPath);
		if (!stat.isFile()) return null;
		return { size: stat.size, mtime: stat.mtimeMs };
	} catch {
		return null;
	}
}

export async function pathExists(absPath: string): Promise<boolean> {
	try {
		await fs.promises.access(absPath);
		return true;
	} catch {
		return false;
	}
}

/** 这个目录存不存在（用来把"路径写错了"和"里面没东西"分开说） */
export async function dirExists(absPath: string): Promise<boolean> {
	try {
		const stat = await fs.promises.stat(absPath);
		return stat.isDirectory();
	} catch {
		return false;
	}
}

/**
 * 这个目录里**真的**没有东西吗？
 *
 * 与"扫描清单里这个目录下没有文件"不是一回事：被排除规则挡住的东西
 * （`*.lsave`、`desktop.ini`、`.DS_Store`…）在清单里根本看不见，
 * 但 `rmdir` 照样会失败。所以计划"要删哪些空目录"之前得按磁盘问一次 ——
 * 否则会出现"清单里几十个、实际只删掉十几个，而且每轮都这样"。
 */
export async function isEmptyDir(absPath: string): Promise<boolean> {
	try {
		const entries = await fs.promises.readdir(absPath);
		return entries.length === 0;
	} catch {
		// 不存在 / 读不到：当成"没什么可删的"，交给调用方按失败处理
		return false;
	}
}

/**
 * 从候选里挑出**真的能删掉**的空目录。
 *
 * 两个坑都要躲开：
 * 1. 被排除规则挡住的东西在清单里看不见，`rmdir` 却会失败（→ 按磁盘问一次）；
 * 2. 父目录要等子目录都没了才可能是空的 —— 所以**从深到浅**累计：
 *    一个目录算"能删"，要么它本来就空，要么它里面的东西**全都是**这次要删的子目录。
 *
 * 返回 `{ removable, kept }`：`kept` 是"想删但里面还有东西"的，界面要如实说清楚，
 * 不然就是"每轮都列着几十个、实际只删掉十几个"那种查不出的怪现象。
 */
export async function pickRemovableEmptyDirs(
	root: string,
	candidates: string[],
): Promise<{ removable: string[]; kept: string[] }> {
	const removable = new Set<string>();
	const kept: string[] = [];
	for (const dir of [...candidates].sort(byDepthDesc)) {
		let entries: string[];
		try {
			entries = await fs.promises.readdir(toNative(root, dir));
		} catch {
			kept.push(dir); // 读不到（不存在 / 没权限）：不硬来
			continue;
		}
		// 里面每一样都得是"这次也要删掉的子目录"，才轮得到它
		if (entries.every(name => removable.has(`${dir}/${name}`))) removable.add(dir);
		else kept.push(dir);
	}
	return { removable: [...removable].sort(byDepthDesc), kept: kept.sort(byDepthDesc) };
}

export async function ensureDir(absDir: string): Promise<void> {
	await fs.promises.mkdir(absDir, { recursive: true });
}

/** 删除文件；文件本来就不在也算成功（另一侧可能已经删过了） */
export async function removeFile(absPath: string): Promise<void> {
	try {
		await fs.promises.unlink(absPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
}

/**
 * 把文件挪进回收目录（而不是直接删）。
 * 同盘用 rename（瞬间完成）；跨盘会失败，退回「复制 + 删除」。
 */
export async function moveToTrash(absPath: string, trashRoot: string, relPath: string, stamp: string): Promise<void> {
	const target = toNative(trashRoot, `${stamp}/${relPath}`);
	await ensureDir(path.dirname(target));
	try {
		await fs.promises.rename(absPath, target);
	} catch {
		await fs.promises.copyFile(absPath, target);
		await fs.promises.unlink(absPath);
	}
}

/**
 * 递归删掉一整棵目录。
 *
 * 和上面那条"删目录只走 rmdir"的规矩**不冲突**：那条规矩保护的是用户的数据
 * （清单看漏了最多就是没删掉）；这里删的是插件自己建的回收站，
 * 里面的东西全部是用户点过"删除"、又明确点了"清空"的，所以用 rm -rf 语义。
 * 调用方必须只传自己算出来的回收站路径，绝不能拿它删仓库 / 副本里的目录。
 */
export async function removeDirRecursive(absDir: string): Promise<void> {
	await fs.promises.rm(absDir, { recursive: true, force: true });
}

export async function readJsonFile<T>(absPath: string): Promise<T | null> {
	try {
		const text = await fs.promises.readFile(absPath, 'utf8');
		return JSON.parse(text) as T;
	} catch {
		// 读不到或者文件被改坏了：当作没有，下次同步会重新建
		return null;
	}
}

/** 先写临时文件再改名：断电也不会留下半截的状态文件 */
export async function writeJsonAtomic(absPath: string, data: unknown): Promise<void> {
	await ensureDir(path.dirname(absPath));
	const temp = `${absPath}.tmp`;
	await fs.promises.writeFile(temp, JSON.stringify(data, null, '\t'), 'utf8');
	await fs.promises.rename(temp, absPath);
}

/** 一个文件的内容指纹（sha256，十六进制）。降级合并与完整性校验用 */
export async function hashFile(absPath: string): Promise<string> {
	const hash = createHash('sha256');
	const handle = await fs.promises.open(absPath, 'r');
	try {
		const buffer = Buffer.alloc(4 * 1024 * 1024);
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead <= 0) break;
			hash.update(buffer.subarray(0, bytesRead));
		}
		return hash.digest('hex');
	} finally {
		await handle.close();
	}
}

/** 列一个目录里的文件（同步包选择列表用），读不到就返回空 */
export async function listFiles(absDir: string): Promise<{ name: string; size: number; mtime: number }[]> {
	try {
		const entries = await fs.promises.readdir(absDir, { withFileTypes: true });
		const out: { name: string; size: number; mtime: number }[] = [];
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			const stat = await fs.promises.stat(path.join(absDir, entry.name));
			out.push({ name: entry.name, size: stat.size, mtime: stat.mtimeMs });
		}
		return out;
	} catch {
		return [];
	}
}
