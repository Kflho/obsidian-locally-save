import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BUNDLE_EXT, BUNDLE_FORMAT, BUNDLE_VERSION, writeBundle } from './format';
import type { BundleDeletedEntry, BundleHeader, BundleSource } from './format';
import { bundleDirForMode } from './paths';
import { DEFAULT_MTIME_TOLERANCE_MS, sameRecord } from '../sync/diff';
import { scanTree } from '../sync/disk';
import { excludePatterns } from '../sync/runner';
import { fingerprint } from '../sync/hash-cache';
import { VAULT_TRASH_DIR } from '../sync/runner';
import { cachedHash, copyRef, loadState, pruneHashes, saveState } from '../sync/state';
import type { Inventory, FileRecord } from '../sync/types';
import { formatStamp } from '../utils/format';
import type { Logger } from '../utils/log';
import { toNative } from '../utils/paths';
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
	/** 同步包文件夹；实际会写进它的 `full` / `changes` 子目录 */
	outDir: string;
	/** 配置目录名（运行时才知道，用户可能改过） */
	configDir?: string;
	/**
	 * 已经扫好的仓库清单。
	 * 同步刚扫完的话直接传进来复用 —— 少一次全库遍历，自动留包就几乎不花时间。
	 */
	inventory?: Inventory;
	onProgress?: (done: number, total: number, file: string) => void;
}

export interface ExportOutcome {
	/** null ＝ 没有内容可导出（仅改动模式下没有任何变化） */
	file: string | null;
	reason?: string;
	entryCount: number;
	deletedCount: number;
	payloadBytes: number;
	durationMs: number;
	header: BundleHeader | null;
	/** 上一个包的 ID：界面上用来提示"对方该接的是这个" */
	parentBundleId: string | null;
	/** 是不是"以完整包为基准累积"的更新包 */
	cumulative: boolean;
}

/** 文件名里不能有的字符换成下划线（仓库名可能含 : / 之类） */
function safeName(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'vault';
}

export async function exportBundle(options: ExportOptions): Promise<ExportOutcome> {
	const started = Date.now();
	const { settings } = options;
	const mode = settings.bundleMode;
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
			payloadBytes: 0,
			durationMs: Date.now() - started,
			header: null,
			parentBundleId: state.lastExportedBundleId,
			cumulative: true,
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
	};
	state.lastExportedBundleId = bundleId;
	state.generation = targetGeneration;
	pruneHashes(state, new Set(inventory.files.keys()));
	await saveState(options.stateFile, state);

	options.log.debug(
		`导出${mode === 'full' ? '完整' : '累积更新'}包：${file}（${sources.length} 个文件，${header.payloadBytes} 字节）`,
	);

	return {
		file,
		entryCount: sources.length,
		deletedCount: deleted.length,
		payloadBytes: header.payloadBytes,
		durationMs: Date.now() - started,
		header,
		parentBundleId: state.lastExportedBundleId,
		cumulative: mode === 'changes',
	};
}
