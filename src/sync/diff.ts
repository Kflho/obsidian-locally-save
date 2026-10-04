import type { DiffOptions, FileRecord, Inventory, SyncAction, SyncPlan } from './types';
import { dirnameRel } from '../utils/paths';

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
 *
 * **移动**（改名 / 挪目录）单独认：它本质是"删一个 + 加一个"，但如果真按两步处理，
 * 关了删除传播时旧文件会被从另一边拉回来，两边各留一份变成重复文件。
 * 所以这里先按「大小 + 修改时间完全一致」把「新增」与「对侧删除」配对，
 * 配对成功就改成"在对侧直接改名"—— 数据不丢，也不用重传一遍。
 */

/** 两个记录算不算"同一个样子" */
export function sameRecord(a: FileRecord, b: FileRecord, toleranceMs: number): boolean {
	return a.size === b.size && Math.abs(a.mtime - b.mtime) <= toleranceMs;
}

export const DEFAULT_MTIME_TOLERANCE_MS = 2000;

/** 认移动时用的精确键：改名会原样保留大小与修改时间，所以这里不设容差 */
function exactKey(record: FileRecord): string {
	return `${record.size}:${Math.round(record.mtime)}`;
}

interface MovePair {
	/** 'local' ＝ 本地移动了（副本那边跟着改名）；'remote' ＝ 副本移动了（本地跟着改名） */
	direction: 'local' | 'remote';
	from: string;
	to: string;
}

/**
 * 找出可以对上号的移动。
 *
 * 成为一对的条件（以本地移动为例）：
 * - 新路径：本地有、副本没有、基准里也没有（确实是新出现的）
 * - 旧路径：副本有、本地没有、基准里有，且副本那份**自基准以来没被动过**
 * - 两份内容对得上：大小与修改时间完全一致（改名正是原样保留这两样）
 *
 * 只要有一条不成立就不配对，退回"删 + 加"处理 —— 慢一点，但不会错。
 */
function detectMoves(
	local: Inventory,
	remote: Inventory,
	state: Record<string, FileRecord>,
): MovePair[] {
	const pairs: MovePair[] = [];
	const consumed = new Set<string>();

	/** 把一侧的文件按「大小:修改时间」索引起来，配对时 O(1) 查 */
	const indexOf = (side: Inventory) => {
		const index = new Map<string, string[]>();
		for (const [path, record] of side.files) {
			if (consumed.has(path)) continue;
			const key = exactKey(record);
			const bucket = index.get(key);
			if (bucket) bucket.push(path);
			else index.set(key, [path]);
		}
		return index;
	};

	const match = (
		added: string,
		addedRecord: FileRecord,
		other: Inventory,
		otherIndex: Map<string, string[]>,
		from: string,
		direction: 'local' | 'remote',
	): boolean => {
		const base = state[from];
		if (!base) return false;
		if (local.files.has(from) && remote.files.has(from)) return false;
		if (direction === 'local' ? local.files.has(from) : remote.files.has(from)) return false;
		const otherRecord = other.files.get(from);
		if (!otherRecord) return false;
		// 对侧那份自基准以来动过 → 说明两边各改各的，别当移动
		if (!sameRecord(otherRecord, base, DEFAULT_MTIME_TOLERANCE_MS)) return false;
		if (exactKey(addedRecord) !== exactKey(otherRecord)) return false;
		pairs.push({ direction, from, to: added });
		consumed.add(from);
		consumed.add(added);
		return true;
	};

	// 本地移动：本地新出现 + 副本还留着旧文件
	const remoteIndex = indexOf(remote);
	for (const [to, record] of local.files) {
		if (consumed.has(to) || remote.files.has(to) || state[to]) continue;
		const candidates = remoteIndex.get(exactKey(record));
		if (!candidates) continue;
		for (const from of candidates) {
			if (consumed.has(from)) continue;
			if (state[from] && !local.files.has(from) && match(to, record, remote, remoteIndex, from, 'local')) break;
		}
	}

	// 副本移动：副本新出现 + 本地还留着旧文件
	const localIndex = indexOf(local);
	for (const [to, record] of remote.files) {
		if (consumed.has(to) || local.files.has(to) || state[to]) continue;
		const candidates = localIndex.get(exactKey(record));
		if (!candidates) continue;
		for (const from of candidates) {
			if (consumed.has(from)) continue;
			if (state[from] && !remote.files.has(from) && match(to, record, local, localIndex, from, 'remote')) break;
		}
	}

	return pairs;
}

export function planSync(
	local: Inventory,
	remote: Inventory,
	state: Record<string, FileRecord>,
	options: DiffOptions,
): SyncPlan {
	const tolerance = options.mtimeToleranceMs ?? DEFAULT_MTIME_TOLERANCE_MS;
	const actions: SyncAction[] = [];
	let unchanged = 0;

	// 先认移动：认出来的路径下面的主循环要跳过
	const moves = detectMoves(local, remote, state);
	const moveTargets = new Map(moves.map(pair => [pair.to, pair]));
	const moveSources = new Set(moves.map(pair => pair.from));

	// 方向会改变冲突的默认裁决：只上传时本地说了算，只下载时副本说了算。
	// 但同步包应用走的是"借用仅下载方向、裁决仍听设置"（见 DiffOptions.directionDecidesConflict）
	const decides = options.directionDecidesConflict !== false;
	const strategy = decides
		? (options.direction === 'upload'
			? 'local-wins'
			: options.direction === 'download'
				? 'remote-wins'
				: options.conflictStrategy)
		: options.conflictStrategy;
	const allowsUpload = options.direction !== 'download';
	const allowsDownload = options.direction !== 'upload';

	const push = (action: SyncAction) => {
		const allowed = action.kind === 'upload' || action.kind === 'delete-remote' || action.kind === 'rename-remote'
			? allowsUpload
			: allowsDownload;
		if (allowed) actions.push(action);
		else unchanged++;
	};

	const paths = new Set<string>([
		...local.files.keys(),
		...remote.files.keys(),
		...Object.keys(state),
		...moveSources,
	]);

	for (const path of [...paths].sort()) {
		// 移动的旧路径：已经并进移动动作里了，这里不再单独处理
		if (moveSources.has(path)) continue;

		const move = moveTargets.get(path);
		if (move) {
			const [from, to] = [move.from, move.to];
			push({
				kind: move.direction === 'local' ? 'rename-remote' : 'rename-local',
				change: 'move',
				path: to,
				from,
				reason: move.direction === 'local'
					? `本地把「${from}」改名/移动到这里`
					: `副本把「${from}」改名/移动到这里`,
			});
			continue;
		}

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
				push({ kind: 'upload', change: 'modify', path, reason: '本地有修改' });
				continue;
			}
			if (!localChanged && remoteChanged) {
				push({ kind: 'download', change: 'modify', path, reason: '副本有修改' });
				continue;
			}
			if (!localChanged && !remoteChanged) {
				// 基准跟两边都不一样时才会走到这里（比如手动改过状态文件）：保守起见不动它
				unchanged++;
				continue;
			}
			// 两边都改了
			if (strategy === 'local-wins') {
				push({ kind: 'upload', change: 'conflict', path, reason: '两边都改了，按设置保留本地' });
			} else if (strategy === 'remote-wins') {
				push({ kind: 'download', change: 'conflict', path, reason: '两边都改了，按设置保留副本' });
			} else {
				push({
					kind: 'conflict',
					change: 'conflict',
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
				push({ kind: 'upload', change: 'add', path, reason: '本地新增' });
				continue;
			}
			if (!localChanged) {
				// 本地没动，副本那边没了 → 副本删除了它
				if (options.propagateDeletions) push({ kind: 'delete-local', change: 'delete', path, reason: '副本已删除' });
				else push({ kind: 'upload', change: 'add', path, reason: '副本已删除，但未开启删除传播，重新送回副本' });
				continue;
			}
			// 本地改了，副本那边却没了
			if (strategy === 'remote-wins') push({ kind: 'delete-local', change: 'delete', path, reason: '本地有改动但副本已删除，按设置以副本为准' });
			else push({ kind: 'upload', change: 'modify', path, reason: '本地改了、副本已删除，保留本地' });
			continue;
		}

		// ------------------------------------------------- 副本有、本地没有
		{
			if (!base) {
				push({ kind: 'download', change: 'add', path, reason: '副本新增' });
				continue;
			}
			if (!remoteChanged) {
				if (options.propagateDeletions) push({ kind: 'delete-remote', change: 'delete', path, reason: '本地已删除' });
				else push({ kind: 'download', change: 'add', path, reason: '本地已删除，但未开启删除传播，重新取回' });
				continue;
			}
			if (strategy === 'local-wins') push({ kind: 'delete-remote', change: 'delete', path, reason: '副本有改动但本地已删除，按设置以本地为准' });
			else push({ kind: 'download', change: 'modify', path, reason: '副本改了、本地已删除，保留副本' });
		}
	}

	// 目录也要跟着走：只比文件的话，空文件夹永远传不过去（它里面没有文件可复制）。
	//
	// 目录**只建不删**，这是故意的：空目录留着不碍事，删错了却是整片内容消失；
	// 而且目录没有"大小 + 修改时间"能做基准检查，三方比对那套保护在目录上根本不成立。
	// 真正被删空 / 挪空的目录，由执行阶段顺着被删文件的父路径顺手收拾（pruneEmptyDirs）。
	const folders: { path: string; side: 'local' | 'remote' }[] = [];
	// 已经在往某侧写文件的目录会被顺带建出来（copyFilePreservingMtime 里有 ensureDir），
	// 不必再单独立一条 —— 否则界面上会把同一个目录报两遍
	const implied: Record<'local' | 'remote', Set<string>> = { local: new Set(), remote: new Set() };
	for (const action of actions) {
		const side = receivingSide(action);
		if (!side) continue;
		let dir = dirnameRel(action.path);
		while (dir) {
			if (implied[side].has(dir)) break;
			implied[side].add(dir);
			dir = dirnameRel(dir);
		}
	}
	for (const dir of local.dirs ?? []) {
		if (allowsUpload && !(remote.dirs ?? new Set<string>()).has(dir) && !implied.remote.has(dir)) {
			folders.push({ path: dir, side: 'remote' });
		}
	}
	for (const dir of remote.dirs ?? []) {
		if (allowsDownload && !(local.dirs ?? new Set<string>()).has(dir) && !implied.local.has(dir)) {
			folders.push({ path: dir, side: 'local' });
		}
	}
	folders.sort((a, b) => a.path.localeCompare(b.path));

	return { actions, unchanged, summary: summarize(actions), moves: moves.length, folders };
}

/** 这个动作往哪一侧写数据（建目录要跟着它走）；删除与不写数据的不算 */
function receivingSide(action: SyncAction): 'local' | 'remote' | null {
	switch (action.kind) {
		case 'upload':
		case 'rename-remote':
			return 'remote';
		case 'download':
		case 'rename-local':
			return 'local';
		case 'conflict':
			return action.winner === 'local' ? 'remote' : 'local';
		default:
			return null;
	}
}

/** 各类变更的数量：预览窗口、通知、同步包报告都用它说人话 */
export function summarize(actions: SyncAction[]): Record<ChangeKind, number> {
	const summary: Record<ChangeKind, number> = { add: 0, modify: 0, delete: 0, move: 0, conflict: 0 };
	for (const action of actions) summary[action.change]++;
	return summary;
}

/** 变更类型（比动作类型更贴近用户的说法） */
export type ChangeKind = 'add' | 'modify' | 'delete' | 'move' | 'conflict';

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
