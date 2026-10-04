import type { DiffOptions, FileRecord, Inventory, SyncAction, SyncPlan } from './types';

/**
 * 同步计划的算法：**纯函数**，不碰磁盘，所以能用测试把每种组合都钉死。
 *
 * 判断一个文件"变了没有"要三方对比：
 *
 * ```
 *   上次同步记下的状态（state）  ← 基准
 *         ↙            ↘
 *   本地现在的样子    副本现在的样子
 * ```
 *
 * 只有跟基准不一样的那一侧才算"改过"。两边都改过 → 按冲突策略处理；
 * 一边没了、另一边没动 → 那就是删除，按「是否传播删除」处理。
 * 没有基准（第一次见到这个文件）时，谁有算谁新增。
 */

/** 两个记录算不算"同一个样子" */
export function sameRecord(a: FileRecord, b: FileRecord, toleranceMs: number): boolean {
	return a.size === b.size && Math.abs(a.mtime - b.mtime) <= toleranceMs;
}

export const DEFAULT_MTIME_TOLERANCE_MS = 2000;

export function planSync(
	local: Inventory,
	remote: Inventory,
	state: Record<string, FileRecord>,
	options: DiffOptions,
): SyncPlan {
	const tolerance = options.mtimeToleranceMs ?? DEFAULT_MTIME_TOLERANCE_MS;
	const actions: SyncAction[] = [];
	let unchanged = 0;

	// 方向会改变冲突的默认裁决：只上传时本地说了算，只下载时副本说了算
	const strategy = options.direction === 'upload'
		? 'local-wins'
		: options.direction === 'download'
			? 'remote-wins'
			: options.conflictStrategy;
	const allowsUpload = options.direction !== 'download';
	const allowsDownload = options.direction !== 'upload';

	/** 方向不允许的动作不算动作，但仍算"这次没动它" */
	const upload = (path: string, reason: string) => {
		if (allowsUpload) actions.push({ kind: 'upload', path, reason });
		else unchanged++;
	};
	const download = (path: string, reason: string) => {
		if (allowsDownload) actions.push({ kind: 'download', path, reason });
		else unchanged++;
	};
	const deleteRemote = (path: string, reason: string) => {
		if (allowsUpload) actions.push({ kind: 'delete-remote', path, reason });
		else unchanged++;
	};
	const deleteLocal = (path: string, reason: string) => {
		if (allowsDownload) actions.push({ kind: 'delete-local', path, reason });
		else unchanged++;
	};

	const paths = new Set<string>([
		...local.files.keys(),
		...remote.files.keys(),
		...Object.keys(state),
	]);

	for (const path of [...paths].sort()) {
		const here = local.files.get(path);
		const there = remote.files.get(path);
		const base = state[path];

		// 两边都没有：状态里那条记录作废（重建状态时自然会清掉）
		if (!here && !there) {
			unchanged++;
			continue;
		}

		const localChanged = base ? (here ? !sameRecord(here, base, tolerance) : true) : here !== undefined;
		const remoteChanged = base ? (there ? !sameRecord(there, base, tolerance) : true) : there !== undefined;

		// ---------------------------------------------------------- 两边都有
		if (here && there) {
			if (sameRecord(here, there, tolerance)) {
				// 内容形态已经一致（可能是各自改成了同一个结果）
				unchanged++;
				continue;
			}
			if (localChanged && !remoteChanged) {
				upload(path, '本地有改动');
				continue;
			}
			if (!localChanged && remoteChanged) {
				download(path, '副本有改动');
				continue;
			}
			if (!localChanged && !remoteChanged) {
				// 基准跟两边都不一样时才会走到这里（比如手动改过状态文件）：保守起见不动它
				unchanged++;
				continue;
			}
			// 两边都改了
			if (strategy === 'local-wins') {
				upload(path, '两边都改了，按设置保留本地');
			} else if (strategy === 'remote-wins') {
				download(path, '两边都改了，按设置保留副本');
			} else {
				actions.push({
					kind: 'conflict',
					path,
					winner: here.mtime >= there.mtime ? 'local' : 'remote',
					reason: '两边都有改动，留新的一份、旧的一份存成冲突副本',
				});
			}
			continue;
		}

		// ------------------------------------------------- 本地有、副本没有
		if (here && !there) {
			if (!base) {
				upload(path, '本地新增');
				continue;
			}
			if (!localChanged) {
				// 本地没动，副本那边没了 → 副本删除了它
				if (options.propagateDeletions) deleteLocal(path, '副本已删除');
				else upload(path, '副本已删除，但未开启删除传播，重新送回副本');
				continue;
			}
			// 本地改了，副本那边却没了
			if (strategy === 'remote-wins') deleteLocal(path, '本地有改动但副本已删除，按设置以副本为准');
			else upload(path, '本地改了、副本已删除，保留本地');
			continue;
		}

		// ------------------------------------------------- 副本有、本地没有
		{
			if (!base) {
				download(path, '副本新增');
				continue;
			}
			if (!remoteChanged) {
				if (options.propagateDeletions) deleteRemote(path, '本地已删除');
				else download(path, '本地已删除，但未开启删除传播，重新取回');
				continue;
			}
			if (strategy === 'local-wins') deleteRemote(path, '副本有改动但本地已删除，按设置以本地为准');
			else download(path, '副本改了、本地已删除，保留副本');
		}
	}

	return { actions, unchanged };
}

/**
 * 跑完一轮后重建同步状态：**只记两边已经一致的文件**。
 *
 * 这样比"照着计划改状态"稳：中途失败、被别的东西改了、复制到一半断电，
 * 下次同步都会重新看出来，不会留下"以为同步过了"的假记录。
 */
export function rebuildState(
	local: Inventory,
	remote: Inventory,
	toleranceMs = DEFAULT_MTIME_TOLERANCE_MS,
): Record<string, FileRecord> {
	const merged: Record<string, FileRecord> = {};
	for (const [path, here] of local.files) {
		const there = remote.files.get(path);
		if (there && sameRecord(here, there, toleranceMs)) merged[path] = { ...here };
	}
	return merged;
}
