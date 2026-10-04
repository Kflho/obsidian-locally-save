import fs from 'node:fs';
import path from 'node:path';
import { toNative } from '../utils/paths';
import { CONFLICT_TRASH_DIR, copyFilePreservingMtime, ensureDir, moveToTrash, removeFile } from './disk';
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
	}

	options.onProgress?.(done, total, '');
	return result;
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
