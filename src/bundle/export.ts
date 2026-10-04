import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BUNDLE_EXT, BUNDLE_FORMAT, BUNDLE_VERSION, readBundleInfo, writeBundle } from './format';
import type { BundleDeletedEntry, BundleHeader, BundleSource } from './format';
import { bundleDirForMode } from './paths';
import { DEFAULT_MTIME_TOLERANCE_MS, sameRecord } from '../sync/diff';
import { listFiles, removeFile, scanTree, statFile } from '../sync/disk';
import { excludePatterns } from '../sync/runner';
import { fingerprint } from '../sync/hash-cache';
import { VAULT_TRASH_DIR } from '../sync/runner';
import { cachedHash, copyRef, loadState, pruneHashes, saveState } from '../sync/state';
import type { Inventory, FileRecord } from '../sync/types';
import { formatStamp } from '../utils/format';
import type { Logger } from '../utils/log';
import { toNative, dirnameRel } from '../utils/paths';
import type { PluginSettings } from '../settings/model';

/**
 * 导出同步包。
 *
 * 「仅改动」模式靠状态文件里记的**上次导出时的样子**算差集：
 * 变过的文件进包，没了的文件进 `deleted` 列表（并带上它们的 base，
 * 让接收方能判断"我这边是不是也动过它"，动过就不删）。
 *
 * 只有包真正写完才推进世代与基准 —— 中途失败不能留下"已经导出过"的假记录，
 * 否则下一次「仅改动」会漏掉这批文件。
 */

export interface ExportOptions {
	settings: PluginSettings;
	log: Logger;
	vaultRoot: string;
	vaultName: string;
	stateFile: string;
	/**
	 * 导哪种包：`full` 完整副本 / `changes` 更新包。
	 *
	 * 从前是从设置里读一个"默认类型"下拉框，但那是**互斥**的语义 ——
	 * 用户要的是"完整包和更新包各是一个独立选项，可以都要"。
	 * 所以改成由调用方明确指定，一次调用导一种，要两种就调两次。
	 */
	mode: 'full' | 'changes';
	/** 同步包文件夹；实际会写进它的 `full` / `changes` 子目录 */
	outDir: string;
	/** 配置目录名（运行时才知道，用户可能改过） */
	configDir?: string;
	/**
	 * 已经扫好的仓库清单。
	 * 同步刚扫完的话直接传进来复用 —— 少一次全库遍历，自动留包就几乎不花时间。
	 */
	inventory?: Inventory;
	/**
	 * 一次导出多个包时，把**先导出来的那些**填进来（"先更新包、后完整包"的调用方用）。
	 *
	 * 完整包会清掉被它取代的旧更新包；不排除同一次刚导出的那个的话，
	 * 用户明明两个都勾了，最后只剩完整包一个。
	 */
	keepPaths?: string[];
	onProgress?: (done: number, total: number, file: string) => void;
}

export interface ExportOutcome {
	/** null ＝ 没有内容可导出（仅改动模式下没有任何变化） */
	file: string | null;
	reason?: string;
	entryCount: number;
	deletedCount: number;
	/** 包里一共有多少个文件夹（含空文件夹） */
	dirCount: number;
	/** 其中空文件夹几个（这些是"不记就传不过去"的那些） */
	emptyDirCount: number;
	payloadBytes: number;
	durationMs: number;
	header: BundleHeader | null;
	/** 上一个包的 ID：界面上用来提示"对方该接的是这个" */
	parentBundleId: string | null;
	/** 实际写到磁盘上的文件大小（弹"该换基准了"看的是它） */
	fileBytes: number;
	/** 是不是"以完整包为基准累积"的更新包 */
	cumulative: boolean;
	/** 这次顺手删掉了哪些被取代的旧更新包（文件名，已排序） */
	superseded: string[];
}

/** 文件名里不能有的字符换成下划线（仓库名可能含 : / 之类） */
function safeName(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'vault';
}

export async function exportBundle(options: ExportOptions): Promise<ExportOutcome> {
	const started = Date.now();
	const { settings, mode } = options;
	const exclude = excludePatterns(settings.excludePatterns, options.configDir);

	const state = await loadState(options.stateFile);
	const inventory = options.inventory
		?? await scanTree(options.vaultRoot, { exclude, skipTopLevelDirs: [VAULT_TRASH_DIR] });

	/** 上次导出（任何类型）时仓库的样子：用来当每个文件的 base —— 接收方最可能就是这个版本 */
	const previous = state.bundle?.files ?? {};
	/** 上次导出**完整包**时的样子：更新包以它为基准累积 */
	const anchor = state.bundle?.fullFiles ?? null;
	/** 自上次完整包以来各文件经历过的中间版本 */
	const history = state.bundle?.history ?? {};

	if (mode === 'changes' && !anchor) {
		throw new Error(
			'还没导出过完整副本：更新包是"以完整包为基准累积"的，没有基准就没法算。'
			+ '请先用「完整副本」导一次（对方也必须先应用它）',
		);
	}

	// ------------------------------------------------------ 挑出要装进包的文件
	const picked: string[] = [];
	const deleted: BundleDeletedEntry[] = [];
	if (mode === 'full') {
		picked.push(...inventory.files.keys());
	} else {
		// 成员：自**完整包**以来变过的（累积）—— 这样接收方永远只需要应用最新的那一个，
		// 漏掉中间几个也不会少内容
		for (const [file, record] of inventory.files) {
			const atAnchor = anchor?.[file];
			if (!atAnchor || !sameRecord(record, atAnchor, DEFAULT_MTIME_TOLERANCE_MS)) picked.push(file);
		}
		// 删除清单同理：自完整包以来"没了"的文件
		for (const [file, atAnchor] of Object.entries(anchor ?? {})) {
			if (inventory.files.has(file)) continue;
			// base 用上次导出的记录（更贴近接收方手里的版本），没有就用完整包时的
			const base = previous[file] ?? atAnchor;
			const baseHash = cachedHash(state, file, base);
			deleted.push({
				path: file,
				baseSize: base.size,
				baseMtime: base.mtime,
				...(baseHash ? { baseHash } : {}),
			});
		}
	}
	picked.sort();

	if (mode === 'changes' && picked.length === 0 && deleted.length === 0) {
		options.log.debug('更新包：自上次完整包以来没有任何变化');
		return {
			file: null,
			reason: '自上次完整副本以来没有任何变化，不需要导出',
			entryCount: 0,
			deletedCount: 0,
			dirCount: 0,
			emptyDirCount: 0,
			payloadBytes: 0,
			durationMs: Date.now() - started,
			header: null,
			parentBundleId: state.lastExportedBundleId,
			cumulative: true,
			fileBytes: 0,
			superseded: [],
		};
	}

	// ------------------------------------------------------ 组装源文件清单
	// 中间版本记录：只留还在仓库里的文件；导出时把它带进包，导完再把这一版的 base 记进去
	const nextHistory: Record<string, FileRecord[]> = {};
	for (const [file, records] of Object.entries(history)) {
		if (inventory.files.has(file)) nextHistory[file] = records;
	}

	const sources: BundleSource[] = [];
	let done = 0;
	for (const file of picked) {
		const record = inventory.files.get(file);
		if (!record) continue;
		options.onProgress?.(done++, picked.length, file);

		const hash = await fingerprint(options.vaultRoot, state, file, record, settings.rememberFingerprints);
		// base：上次导出时的版本（按顺序应用的人正好停在这儿）
		const base = previous[file];
		const baseHash = base ? cachedHash(state, file, base) : null;
		// 中间版本：更早的那些（跳过包的人停在其中一个）
		const carried = nextHistory[file] ?? [];

		sources.push({
			path: file,
			abs: toNative(options.vaultRoot, file),
			size: record.size,
			mtime: record.mtime,
			...(hash ? { hash } : {}),
			...(mode === 'changes' && base ? { baseSize: base.size, baseMtime: base.mtime } : {}),
			...(mode === 'changes' && baseHash ? { baseHash } : {}),
			...(mode === 'changes' && carried.length > 0 ? { history: carried.map(item => ({ ...item })) } : {}),
		});

		// 这一版导出去之后，它就成了"以前的版本"，记进历史供下一个包使用
		if (mode === 'changes' && base && !carried.some(item => sameRecord(item, base, DEFAULT_MTIME_TOLERANCE_MS))) {
			nextHistory[file] = [...carried, { ...base }];
		}
	}

	const now = Date.now();
	const bundleId = randomUUID();
	const targetGeneration = state.generation + 1;
	// 空目录：有文件的目录会随文件写入被顺带建出来，**空文件夹不记就永远传不过去**
	const covered = new Set<string>();
	for (const file of inventory.files.keys()) {
		let dir = dirnameRel(file);
		while (dir) {
			if (covered.has(dir)) break;
			covered.add(dir);
			dir = dirnameRel(dir);
		}
	}
	const emptyDirs = [...inventory.dirs].filter(dir => !covered.has(dir)).sort();
	// 文件名带上包 ID 的前几位：时间戳只精确到秒，同一秒内连导两个会互相覆盖
	const file = path.join(
		bundleDirForMode(options.outDir, mode),
		`${safeName(options.vaultName)}-${mode === 'full' ? 'full' : 'changes'}-${formatStamp(now)}-${bundleId.slice(0, 6)}${BUNDLE_EXT}`,
	);

	const { header } = await writeBundle(
		file,
		{
			format: BUNDLE_FORMAT,
			version: BUNDLE_VERSION,
			bundleId,
			parentBundleId: state.lastExportedBundleId,
			created: now,
			mode,
			vault: options.vaultName,
			lineage: state.lineage,
			source: copyRef(state),
			// 完整包免校验（baseGeneration 为 null）。
			// 更新包说"我以第几代的完整包为基准"：接收方只要**应用过那个完整包**
			// （也就是世代 ≥ 基准世代）就能收，不必逐个按顺序应用。
			baseGeneration: mode === 'changes' ? (state.bundle?.fullGeneration ?? state.generation) : null,
			targetGeneration,
			deleted,
			emptyDirs,
		},
		sources,
	);

	// 包写成功了才推进世代与基准
	state.bundle = {
		lastExport: now,
		files: Object.fromEntries(inventory.files),
		// 导完整包 ＝ 重新立基准：更新包的基准与中间版本记录一起清零
		// （这正是"包会越滚越大"的节制阀，所以完整包不是可有可无的）
		fullFiles: mode === 'full' ? Object.fromEntries(inventory.files) : anchor,
		fullGeneration: mode === 'full' ? targetGeneration : (state.bundle?.fullGeneration ?? null),
		history: mode === 'full' ? {} : nextHistory,
		// 目录基准：接收方靠它认出"这个空目录是对方删了"（基准里有、包里没有）还是"我独有的"（一律保留）
		dirs: [...inventory.dirs],
	};
	state.lastExportedBundleId = bundleId;
	state.generation = targetGeneration;
	pruneHashes(state, new Set(inventory.files.keys()));
	await saveState(options.stateFile, state);

	// 旧的更新包该退休了 —— 但必须**等新包写成功、状态也落盘之后**再动它们：
	// 旧包是"目前唯一的改动备份"，新包还没落地就先把旧的删了，导出一旦失败就什么都不剩
	const superseded = settings.pruneSupersededBundles
		? await removeSupersededChanges(options, header, file)
		: [];

	options.log.debug(
		`导出${mode === 'full' ? '完整' : '累积更新'}包：${file}（${sources.length} 个文件，${header.payloadBytes} 字节）`
		+ (superseded.length > 0 ? `；顺手清掉 ${superseded.length} 个被它取代的旧更新包` : ''),
	);

	return {
		file,
		entryCount: sources.length,
		deletedCount: deleted.length,
		fileBytes: (await statFile(file))?.size ?? header.payloadBytes,
		// 包里的目录 = 记着的空文件夹 ＋ 有文件那些目录（它们由文件写入顺带建出来）
		dirCount: covered.size + emptyDirs.length,
		emptyDirCount: emptyDirs.length,
		payloadBytes: header.payloadBytes,
		durationMs: Date.now() - started,
		header,
		parentBundleId: state.lastExportedBundleId,
		cumulative: mode === 'changes',
		superseded,
	};
}

/**
 * 删掉被新包**完全取代**的旧更新包 —— 让 `changes/` 里最多只留**最新那一个**。
 *
 * 为什么可以这么干脆：更新包是"自完整副本累积"的，任何更新的更新包、
 * 或一份更新的完整副本，都包含旧更新包的全部内容（所以文档里才敢说
 * "永远只需要应用最新的一个"）。留着它们只有两个后果：占地方，
 * 以及让人以为"包越攒越多、是不是漏应用了什么"（用户报过这个疑问）。
 *
 * 只删**确定**能删的，条件缺一不可：
 * - 同一个 `changes` 目录里的 `.lsave`（别的目录不碰）；
 * - 是**更新包**（完整包不碰：那是你的还原点）；
 * - 同一条血脉（`lineage` 一致）—— 别的机器导的包不动；
 * - 世代**严格更小**；而且不是刚写出来的那个。
 *
 * `keepPaths` 是"同一次导出里刚生成的包"：两个都勾时先导更新包、再导完整包，
 * 不排除它的话，用户明明要了两个，最后只剩完整包一个。
 *
 * 内容安全性：新包（或与它同代的那份完整包）含有旧包的全部内容，删掉不丢东西；
 * 读不出头部、或者任何一条对不上的，一律留着（宁可多留，不可误删）。
 */
async function removeSupersededChanges(
	options: ExportOptions,
	header: BundleHeader,
	keep: string,
): Promise<string[]> {
	const dir = bundleDirForMode(options.outDir, 'changes');
	const keepPaths = new Set((options.keepPaths ?? []).map(item => path.resolve(item)));
	keepPaths.add(path.resolve(keep));
	const removed: string[] = [];
	for (const item of await listFiles(dir)) {
		if (!item.name.toLowerCase().endsWith(BUNDLE_EXT)) continue;
		const candidate = path.join(dir, item.name);
		if (keepPaths.has(path.resolve(candidate))) continue;
		let other: BundleHeader;
		try {
			other = (await readBundleInfo(candidate)).header;
		} catch {
			continue; // 读不出头部（不是我们的包 / 传坏了）：不动它
		}
		if (other.mode !== 'changes') continue;
		if (other.lineage !== header.lineage) continue;
		if (other.targetGeneration >= header.targetGeneration) continue;
		await removeFile(candidate);
		removed.push(item.name);
	}
	removed.sort();
	return removed;
}
