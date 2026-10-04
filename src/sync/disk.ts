import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { toNative } from '../utils/paths';
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

/** 递归扫描一个目录，返回「相对路径 → 大小 + 修改时间」 */
export async function scanTree(root: string, options: ScanOptions): Promise<Inventory> {
	const files = new Map<string, FileRecord>();
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
				await walk(rel);
				continue;
			}
			if (!entry.isFile()) continue;
			if (isExcluded(rel, options.exclude)) continue;

			const record = await statFile(toNative(root, rel));
			if (record) files.set(rel, record);
		}
	}

	await walk('');
	return { files };
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

export async function ensureDir(absDir: string): Promise<void> {
	await fs.promises.mkdir(absDir, { recursive: true });
}

/**
 * 复制文件并**把修改时间对齐到源文件**。
 *
 * 对齐 mtime 是整套机制的关键：比对靠"大小 + 修改时间"，
 * 复制后两边时间一致，下一轮才会认定"没变过"；否则每轮都会重传一遍。
 */
export async function copyFilePreservingMtime(fromAbs: string, toAbs: string): Promise<FileRecord> {
	const stat = await fs.promises.stat(fromAbs);
	await ensureDir(path.dirname(toAbs));
	await fs.promises.copyFile(fromAbs, toAbs);
	// 用"秒 + 小数"传时间（Date 只有毫秒精度，会把亚毫秒的部分截掉，
	// 两边就会差那么零点几毫秒 —— 虽然容差能兜住，但没必要留下这点偏差）
	await fs.promises.utimes(toAbs, stat.atimeMs / 1000, stat.mtimeMs / 1000);
	return { size: stat.size, mtime: stat.mtimeMs };
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
