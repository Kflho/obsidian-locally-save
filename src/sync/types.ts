/**
 * 同步引擎的类型。
 *
 * 这里没有任何 obsidian / node 依赖，diff.ts 与 exclude.ts 是**纯逻辑**，
 * 所以能直接跑测试（见 test/diff.test.ts）。
 */

/** 一个文件在某一侧的形态：够不够判断"变了没有"就靠这两样 */
export interface FileRecord {
	size: number;
	mtime: number;
}

/** 一次扫描的结果：仓库相对路径 → 形态 */
export interface Inventory {
	files: Map<string, FileRecord>;
	/**
	 * 这次扫描看到的**目录**（相对路径，不含根）。
	 *
	 * 为什么要单独记：只盯文件的话，**空文件夹永远不会被同步**，
	 * 而且删光一个文件夹里的文件之后，两边的空壳都会留着。
	 */
	dirs: Set<string>;
}

/**
 * 比对方向：双向 / 只往外写 / 只往里写。
 *
 * 0.8.0 砍掉「同步到本地副本」通道之后，**没有哪条通道再让用户选方向了**；
 * 这个类型留着是因为应用的 `normal` 档要借"仅下载"表示"包是只读的、别往回写"
 * （见 `DiffOptions.directionDecidesConflict`）。
 */
export type SyncDirection = 'both' | 'upload' | 'download';

/** 两边都改了怎么办 */
export type ConflictStrategy =
	/** 留两份：内容新的占原名，旧的存成「冲突副本」 */
	| 'keep-both'
	/** 一律以本地为准 */
	| 'local-wins'
	/** 一律以包里那一版为准 */
	| 'remote-wins';

export interface DiffOptions {
	direction: SyncDirection;
	/** 本地删了，对面也跟着删吗（关掉的话删掉的文件会被重新拉回来） */
	propagateDeletions: boolean;
	conflictStrategy: ConflictStrategy;
	/**
	 * 方向是否顺带决定冲突裁决。
	 *
	 * 同步包应用时传 **false** —— 它借"仅下载"这个方向只是为了**不产生写回包里的动作**
	 * （包是只读的），冲突该怎么裁决还是听设置的（`directionDecidesConflict` 的默认 true
	 * 是给"真正的双向"留的语义，现在没有调用方用默认值了）。
	 */
	directionDecidesConflict?: boolean;
	/**
	 * mtime 容差（毫秒）。
	 * 默认 2000：FAT/exFAT 这类文件系统只精确到 2 秒，U 盘来回拷会被误判成"改过"。
	 */
	mtimeToleranceMs?: number;
	/**
	 * 基准里记过的目录（上次同步时两边都有的）。
	 *
	 * 只用来判断"目录是被删了还是新出现的"：在基准里 ＋ 一侧没了 ＝ 删掉了 → 跟着删；
	 * 不在基准里 ＝ 新出现的 → 只建。老状态文件里没有这个字段，
	 * 于是升级后的第一轮谁都不删（等于旧行为），第二轮起才正常传播删除。
	 */
	baseDirs?: Set<string>;
}

export type SyncActionKind =
	/** 本地 → 副本 */
	| 'upload'
	/** 副本 → 本地 */
	| 'download'
	/** 删掉副本那边的文件（本地删了它） */
	| 'delete-remote'
	/** 删掉本地的文件（副本那边删了它） */
	| 'delete-local'
	/** 两边都改了：内容新的占原名，旧的那份留成「冲突副本」 */
	| 'conflict'
	/** 本地改名/移动了：副本那边直接改名（不重传内容） */
	| 'rename-remote'
	/** 副本改名/移动了：本地直接改名 */
	| 'rename-local';

/** 变更类型：比动作类型更贴近用户的说法（增加 / 修改 / 删除 / 移动 / 冲突） */
export type ChangeKind = 'add' | 'modify' | 'delete' | 'move' | 'conflict';

export interface SyncAction {
	kind: SyncActionKind;
	/** 这一条属于哪类变更，预览与统计用它 */
	change: ChangeKind;
	/** 目标路径（移动动作里是**新**路径） */
	path: string;
	/** 移动动作里的旧路径 */
	from?: string;
	/** 只有 conflict 用得上：留哪一边的内容占原名 */
	winner?: 'local' | 'remote';
	/** 给用户看的理由（预览窗口里逐条显示） */
	reason: string;
}

export interface SyncPlan {
	actions: SyncAction[];
	/** 两边一致、不用动的文件数 */
	unchanged: number;
	/** 各类变更的数量 */
	summary: Record<ChangeKind, number>;
	/** 认出来的移动数量（含在 summary.move 里，单独留一份便于说明） */
	moves: number;
	/**
	 * 要新建的目录。**空文件夹也要跟着走** —— 只同步文件的话，
	 * 一个空文件夹永远传不过去（它里面没有文件可复制）。
	 */
	folders: { path: string; side: 'local' | 'remote' }[];
	/**
	 * 要删掉的空目录（`side` ＝ 删哪一侧）。
	 *
	 * 与文件同一套规矩：**只有基准里记过的目录才敢删** ——
	 * 基准里有它 ＋ 一侧没了 ＝ 那一侧把它删掉了，才值得跟着删；
	 * 基准里没有 ＋ 一侧没有 ＝ 新出现的目录，只建不删。
	 * 执行时只走 `rmdir`（非空必然失败），所以判断错了也只会"没删掉"。
	 */
	removedFolders: { path: string; side: 'local' | 'remote' }[];
}

/** 动作类型的中文名，通知与预览窗口共用 */
export const ACTION_LABELS: Record<SyncActionKind, string> = {
	upload: '上传',
	download: '下载',
	'delete-remote': '删除副本',
	'delete-local': '删除本地',
	conflict: '冲突',
	'rename-remote': '副本改名',
	'rename-local': '本地改名',
};

/** 变更类型的中文名 */
export const CHANGE_LABELS: Record<ChangeKind, string> = {
	add: '新增',
	modify: '修改',
	delete: '删除',
	move: '移动',
	conflict: '冲突',
};
