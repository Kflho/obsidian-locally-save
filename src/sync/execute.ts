import fs from 'node:fs';
import path from 'node:path';
import { toNative, byDepthDesc } from '../utils/paths';
import { YIELD_EVERY, yieldToUi } from '../utils/async';
import { CONFLICT_TRASH_DIR, copyFilePreservingMtime, ensureDir, moveToTrash, pruneEmptyDirs, removeEmptyDir, removeFile, statFile } from './disk';
import type { SyncAction, SyncPlan } from './types';

/**
 * 执行同步计划。
 *
 * 一个动作失败不影响其它动作（逐条 catch 收集错误）—— 同步几百个文件时，
 * 因为其中一个被别的程序占着就整轮放弃，是最让人恼火的体验。
 */

export interface ExecuteOptions {
	/** 仓库根的绝对路径 */
	vaultRoot: string;
	/** 同步目标的绝对路径 */
	targetRoot: string;
	/** 删除的文件先挪进回收目录（关掉就是直接删） */
	useTrash: boolean;
	/** 时间戳，用于冲突副本命名与回收目录分堆 */
	stamp: string;
	onProgress?: (done: number, total: number, path: string) => void;
}

export interface ExecuteResult {
	uploaded: number;
	downloaded: number;
	deletedLocal: number;
	deletedRemote: number;
	conflicts: number;
	moved: number;
	/** 新建的目录（空文件夹也要跟着走） */
	foldersCreated: number;
	/** 删空之后顺手收拾掉的空目录 */
	foldersRemoved: number;
	bytesCopied: number;
	failed: { path: string; error: string }[];
}

export function emptyResult(): ExecuteResult {
	return {
		uploaded: 0,
		downloaded: 0,
		deletedLocal: 0,
		deletedRemote: 0,
		conflicts: 0,
		moved: 0,
		foldersCreated: 0,
		foldersRemoved: 0,
		bytesCopied: 0,
		failed: [],
	};
}

export async function executePlan(plan: SyncPlan, options: ExecuteOptions): Promise<ExecuteResult> {
	const result = emptyResult();
	const total = plan.actions.length;
	let done = 0;

	for (const action of plan.actions) {
		options.onProgress?.(done, total, action.path);
		try {
			await runAction(action, options, result);
		} catch (error) {
			result.failed.push({
				path: action.path,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		done++;
		// 长循环里让一步：不然界面在同步几百个文件时完全不重绘（"卡住了"就是这么来的）
		if (done % YIELD_EVERY === 0) await yieldToUi();
	}

	// 目录：先把这次要新建的建出来（空文件夹就靠这一步传过去）
	for (const folder of plan.folders ?? []) {
		const root = folder.side === 'remote' ? options.targetRoot : options.vaultRoot;
		try {
			const abs = toNative(root, folder.path);
			// 要建文件夹的位置杵着一个同名文件：不删也不挪，如实报出来让人自己决定
			if (await statFile(abs)) {
				result.failed.push({ path: folder.path, error: '要建文件夹的位置是一个同名文件，没有动它' });
				continue;
			}
			await ensureDir(abs);
			result.foldersCreated++;
		} catch (error) {
			result.failed.push({ path: folder.path, error: describe(error) });
		}
	}

	// 收尾：把"被删空 / 挪空"的目录收拾掉，别留一串空壳
	const vacated = (kinds: string[]) => plan.actions.flatMap(action => {
		if (!kinds.includes(action.kind)) return [];
		if (action.kind === 'rename-local' || action.kind === 'rename-remote') {
			return action.from ? [action.from] : [];
		}
		return [action.path];
	});
	result.foldersRemoved += await pruneEmptyDirs(options.vaultRoot, vacated(['delete-local', 'rename-local']));
	result.foldersRemoved += await pruneEmptyDirs(options.targetRoot, vacated(['delete-remote', 'rename-remote']));

	// 对面把空目录删了 → 这边跟着删。只走 rmdir：目录里但凡有东西就删不动，
	// 所以这里不需要 base 之外的第二道保护（清单漏看的文件也伤不到）。
	// **深的先删**：父子都在清单里时，先删父目录会被"非空"挡住（这里再排一次，
	// 不依赖上游的顺序 —— 少删一轮就是用户看到的"删不干净"）
	for (const folder of [...(plan.removedFolders ?? [])].sort((a, b) => byDepthDesc(a.path, b.path))) {
		const root = folder.side === 'remote' ? options.targetRoot : options.vaultRoot;
		if (await removeEmptyDir(toNative(root, folder.path))) {
			result.foldersRemoved++;
			continue;
		}
		// 计划说它是空的、磁盘说它还有东西：多半是**被排除规则挡住的文件**
		// （*.lsave、desktop.ini…）在清单里看不见。如实报出来，
		// 不然就是"每轮都列着几十个、实际只删掉十几个"那种查不出的怪现象
		result.failed.push({
			path: folder.path,
			error: '这个文件夹里还有东西（多半是被排除规则挡住的文件），只删空的，没有动它',
		});
	}

	options.onProgress?.(done, total, '');
	return result;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function runAction(action: SyncAction, options: ExecuteOptions, result: ExecuteResult): Promise<void> {
	const { vaultRoot, targetRoot, useTrash, stamp } = options;
	const here = toNative(vaultRoot, action.path);
	const there = toNative(targetRoot, action.path);

	switch (action.kind) {
		case 'upload': {
			const record = await copyFilePreservingMtime(here, there);
			result.uploaded++;
			result.bytesCopied += record.size;
			return;
		}
		case 'download': {
			const record = await copyFilePreservingMtime(there, here);
			result.downloaded++;
			result.bytesCopied += record.size;
			return;
		}
		case 'delete-remote': {
			if (useTrash) await moveToTrash(there, `${targetRoot}/.lsave/trash`, action.path, stamp);
			else await removeFile(there);
			result.deletedRemote++;
			return;
		}
		case 'delete-local': {
			if (useTrash) await moveToTrash(here, `${vaultRoot}/.trash/locally-save`, action.path, stamp);
			else await removeFile(here);
			result.deletedLocal++;
			return;
		}
		case 'conflict': {
			// 输的那一份**挪进回收目录的「冲突」文件夹**，不留在原地 ——
			// 留在原地的冲突副本会跟着同步传到对面去，两边各滚一份、越滚越多
			if (action.winner === 'remote') {
				await moveToTrash(here, `${vaultRoot}/.trash/locally-save/${CONFLICT_TRASH_DIR}`, action.path, stamp);
				const record = await copyFilePreservingMtime(there, here);
				result.bytesCopied += record.size;
			} else {
				await moveToTrash(there, `${targetRoot}/.lsave/trash/${CONFLICT_TRASH_DIR}`, action.path, stamp);
				const record = await copyFilePreservingMtime(here, there);
				result.bytesCopied += record.size;
			}
			result.conflicts++;
			return;
		}
		case 'rename-remote': {
			// 本地改名了：副本那边跟着改名。同盘 rename 是瞬时的，不重传内容
			const from = toNative(targetRoot, requireFrom(action));
			await ensureDir(path.dirname(there));
			try {
				await fs.promises.rename(from, there);
			} catch {
				// 跨盘 / 权限问题：退回"把本地那份拷过去，再删掉副本里的旧文件"
				const record = await copyFilePreservingMtime(here, there);
				result.bytesCopied += record.size;
				await removeFile(from);
			}
			result.moved++;
			return;
		}
		case 'rename-local': {
			const from = toNative(vaultRoot, requireFrom(action));
			await ensureDir(path.dirname(here));
			try {
				await fs.promises.rename(from, here);
			} catch {
				const record = await copyFilePreservingMtime(there, here);
				result.bytesCopied += record.size;
				await removeFile(from);
			}
			result.moved++;
			return;
		}
	}
}

/** 移动动作必须有旧路径；没有就是引擎的 bug，宁可报错也别当成覆盖处理 */
function requireFrom(action: SyncAction): string {
	if (!action.from) throw new Error(`移动动作缺少旧路径：${action.path}`);
	return action.from;
}
