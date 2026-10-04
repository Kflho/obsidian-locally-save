import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BUNDLE_EXT, BUNDLE_FORMAT, BUNDLE_VERSION, writeBundle } from './format';
import type { BundleDeletedEntry, BundleHeader, BundleSource } from './format';
import { DEFAULT_MTIME_TOLERANCE_MS, sameRecord } from '../sync/diff';
import { scanTree } from '../sync/disk';
import { excludePatterns } from '../sync/runner';
import { fingerprint } from '../sync/hash-cache';
import { VAULT_TRASH_DIR } from '../sync/runner';
import { cachedHash, copyRef, loadState, pruneHashes, saveState } from '../sync/state';
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
	/** 包放哪个目录（绝对路径） */
	outDir: string;
	/** 配置目录名（运行时才知道，用户可能改过） */
	configDir?: string;
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
	const inventory = await scanTree(options.vaultRoot, { exclude, skipTopLevelDirs: [VAULT_TRASH_DIR] });
	const previous = state.bundle?.files ?? {};

	// 挑出要装进包的文件
	const picked: string[] = [];
	const deleted: BundleDeletedEntry[] = [];
	if (mode === 'full') {
		picked.push(...inventory.files.keys());
	} else {
		for (const [file, record] of inventory.files) {
			const before = previous[file];
			if (!before || !sameRecord(record, before, DEFAULT_MTIME_TOLERANCE_MS)) picked.push(file);
		}
		for (const [file, record] of Object.entries(previous)) {
			if (inventory.files.has(file)) continue;
			const baseHash = cachedHash(state, file, record);
			deleted.push({
				path: file,
				baseSize: record.size,
				baseMtime: record.mtime,
				...(baseHash ? { baseHash } : {}),
			});
		}
	}
	picked.sort();

	if (mode === 'changes' && picked.length === 0 && deleted.length === 0) {
		options.log.debug('仅改动模式：自上次导出后没有任何变化');
		return {
			file: null,
			reason: '自上次导出后没有任何变化，不需要导出',
			entryCount: 0,
			deletedCount: 0,
			payloadBytes: 0,
			durationMs: Date.now() - started,
			header: null,
			parentBundleId: state.lastExportedBundleId,
		};
	}

	// 组装源文件清单（顺带给需要指纹的文件算指纹）
	const sources: BundleSource[] = [];
	let done = 0;
	for (const file of picked) {
		const record = inventory.files.get(file);
		if (!record) continue;
		options.onProgress?.(done++, picked.length, file);

		const hash = await fingerprint(options.vaultRoot, state, file, record, settings.rememberFingerprints);
		const before = previous[file];
		const baseHash = before ? cachedHash(state, file, before) : null;

		sources.push({
			path: file,
			abs: toNative(options.vaultRoot, file),
			size: record.size,
			mtime: record.mtime,
			...(hash ? { hash } : {}),
			// 增量包才需要 base：告诉接收方"我以为你应用前是这个样子"
			...(mode === 'changes' && before ? { baseSize: before.size, baseMtime: before.mtime } : {}),
			...(mode === 'changes' && baseHash ? { baseHash } : {}),
		});
	}

	const now = Date.now();
	const bundleId = randomUUID();
	// 文件名带上包 ID 的前几位：时间戳只精确到秒，同一秒内连导两个会互相覆盖
	const file = path.join(
		options.outDir,
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
			// 完整包免校验：baseGeneration 为 null
			baseGeneration: mode === 'changes' ? state.generation : null,
			targetGeneration: state.generation + 1,
			deleted,
		},
		sources,
	);

	// 包写成功了才推进世代与基准
	state.bundle = { lastExport: now, files: Object.fromEntries(inventory.files) };
	state.lastExportedBundleId = bundleId;
	state.generation += 1;
	pruneHashes(state, new Set(inventory.files.keys()));
	await saveState(options.stateFile, state);

	options.log.debug(`导出同步包：${file}（${sources.length} 个文件，${header.payloadBytes} 字节）`);

	return {
		file,
		entryCount: sources.length,
		deletedCount: deleted.length,
		payloadBytes: header.payloadBytes,
		durationMs: Date.now() - started,
		header,
		parentBundleId: state.lastExportedBundleId,
	};
}
