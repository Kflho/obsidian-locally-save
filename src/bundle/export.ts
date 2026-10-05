import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BUNDLE_EXT, BUNDLE_FORMAT, BUNDLE_VERSION, readBundleInfo, writeBundle } from './format';
import type { BundleDeletedEntry, BundleHeader, BundleSource } from './format';
import { bundleDirForMode } from './paths';
import type { BundleMode } from './paths';
import { listingHashOfFiles } from './baseline';
import { appendBundleLog } from './log';
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
import { yieldIfDue, yieldToUi } from '../utils/async';
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
	 * 一次导出多个包时，把**先导出来的那些**填进来。
	 *
	 * 完整包会清掉被它取代的旧更新包；万一哪个调用方反过来先导了更新包，
	 * 不把它排除掉的话，用户明明两个都勾了、最后却只剩完整包一个。
	 * 现在两条调用链都按 `plannedExportModes` 先导完整包，所以这是一道保险。
	 */
	keepPaths?: string[];
	/**
	 * 进度回调：`done / total` ＝ **已经打进包里的文件数 / 总文件数**，从 0 数到总数。
	 *
	 * 内部还有一步"算指纹"（给接收方做三方合并用），但那跟用户没关系、不占数字：
	 * 用户看到的就该是"这些文件打包了多少个"。
	 */
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
	/**
	 * 看着该被取代、却**留着没动**的更新包，以及为什么。
	 * 界面上要如实说明 —— 不然用户会以为"清理开关没生效"，或者当成偶发 bug（报过）。
	 */
	keptChanges: { name: string; why: string }[];
}

/** 清理被取代的旧更新包的结果：删了哪些、留了哪些（留的要说清原因） */
export interface SupersededReport {
	removed: string[];
	kept: { name: string; why: string }[];
}

/** 文件名里不能有的字符换成下划线（仓库名可能含 : / 之类） */
function safeName(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'vault';
}

/**
 * 一次要导两种时**先导哪个**：**先完整副本、后更新包**。
 *
 * 顺序曾经是反的（先更新、后完整），那样会演出一幕很怪的戏：先按老基准算出一个更新包
 * ——顺手把上一个更新包当成"被它取代的旧包"清掉——再导完整副本。用户看到的
 * 是"我那个老包没了，然后又生成了一个一模一样的"。
 *
 * 而完整副本一写完，它自己就是最新的基准：这时更新包按它算**必然是空的**。
 * 写一个谁都用不上的空包（接收方应用它什么也不会发生，还让人以为漏了什么），
 * 不如不写、并说清楚为什么。要"一个小文件传出去"就单独勾更新包，别同时勾完整副本。
 *
 * 两条调用链（手动导出弹窗 / 同步后的自动留包）都走这个函数，免得哪天又各写各的。
 */
export function plannedExportModes(want: { changes: boolean; full: boolean }): BundleMode[] {
	const modes: BundleMode[] = [];
	if (want.full) modes.push('full');
	if (want.changes) modes.push('changes');
	return modes;
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
			keptChanges: [],
		};
	}

	// ------------------------------------------------------ 组装源文件清单
	// 中间版本记录：只留还在仓库里的文件；导出时把它带进包，导完再把这一版的 base 记进去
	const nextHistory: Record<string, FileRecord[]> = {};
	for (const [file, records] of Object.entries(history)) {
		if (inventory.files.has(file)) nextHistory[file] = records;
	}

	const sources: BundleSource[] = [];
	/** 进度的分母：**要打进包里的文件数**；分子是"已经打进去几个"，从 0 数到它 */
	const progressTotal = picked.length;
	// 开跑先报一次 0，并**强制让一帧**：数字得真的从 0 开始显示。
	// DOM 写进去要等浏览器拿到渲染机会才画得出来，不让这一帧就会被后面的循环挤掉。
	options.onProgress?.(0, progressTotal, picked[0] ?? '');
	await yieldToUi();
	let lastYieldAt = Date.now();
	for (const file of picked) {
		const record = inventory.files.get(file);
		if (!record) continue;
		// 这一步（算指纹）不报进度：数字只认"打进包里几个文件"，见 writeBundle 那边的回调。
		// 循环本身是纯 CPU 的（命中缓存时一个 I/O 都没有），按时间让一帧，界面别僵住。
		lastYieldAt = await yieldIfDue(lastYieldAt);

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

	/**
	 * 这一份包的**基准指纹**（见 `bundle/baseline.ts`）：
	 * - 导完整包 ＝ 立一份新基准 → 指纹由它自己的清单算出来（接收方也能重算，不用信任头部）；
	 * - 导更新包 → 带上"我基于的那份完整副本"的指纹（我手里只有变过的那部分，算不出来）；
	 *   旧状态文件没有这个令牌（升级上来的）就留空 → 对方判成"说不清"，界面会说明。
	 */
	const freshBaseline = mode === 'full' ? listingHashOfFiles(inventory.files) : null;
	const baselineHash = mode === 'full' ? freshBaseline : (state.bundle?.fullHash ?? null);

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
			...(baselineHash ? { baselineHash } : {}),
			deleted,
			emptyDirs,
		},
		sources,
		// 每打包完一个文件，数字 +1（0 → 文件数，就这么个数）
		(written, _total, writtenPath) => options.onProgress?.(written, progressTotal, writtenPath),
	);

	// 包写成功了才推进世代与基准
	state.bundle = {
		lastExport: now,
		files: Object.fromEntries(inventory.files),
		// 导完整包 ＝ 重新立基准：更新包的基准与中间版本记录一起清零
		// （这正是"包会越滚越大"的节制阀，所以完整包不是可有可无的）
		fullFiles: mode === 'full' ? Object.fromEntries(inventory.files) : anchor,
		fullGeneration: mode === 'full' ? targetGeneration : (state.bundle?.fullGeneration ?? null),
		// 基准令牌：导完整包 ＝ 换一份新基准（指纹换成新的）；导更新包不动它
		fullHash: mode === 'full' ? freshBaseline : (state.bundle?.fullHash ?? null),
		// 界面上要能说清"我站在哪份完整副本上"，所以文件名也记下来
		fullFile: mode === 'full' ? path.basename(file) : (state.bundle?.fullFile ?? null),
		history: mode === 'full' ? {} : nextHistory,
		// 目录基准：接收方靠它认出"这个空目录是对方删了"（基准里有、包里没有）还是"我独有的"（一律保留）
		dirs: [...inventory.dirs],
	};
	state.lastExportedBundleId = bundleId;
	state.generation = targetGeneration;
	pruneHashes(state, new Set(inventory.files.keys()));
	// 该发的都发出去了：欠对方的那笔回传结清（见 state.pendingReturn）
	state.pendingReturn = null;
	// 记一笔"我导出过什么"（界面上的「更新记录」）—— 只在包写成功、状态要落盘时才记
	appendBundleLog(state, {
		at: now,
		direction: 'export',
		mode,
		bundleId,
		file: path.basename(file),
		base: mode === 'changes' ? (state.bundle.fullGeneration ?? null) : null,
		target: targetGeneration,
		entries: sources.length,
		deleted: deleted.length,
	});
	await saveState(options.stateFile, state);

	// 旧的更新包该退休了 —— 但必须**等新包写成功、状态也落盘之后**再动它们：
	// 旧包是"目前唯一的改动备份"，新包还没落地就先把旧的删了，导出一旦失败就什么都不剩
	const prune = settings.pruneSupersededBundles
		? await removeSupersededChanges(options, header, file)
		: { removed: [], kept: [] };
	const superseded = prune.removed;

	options.log.debug(
		`导出${mode === 'full' ? '完整' : '累积更新'}包：${file}（${sources.length} 个文件，${header.payloadBytes} 字节）`
		+ (superseded.length > 0 ? `；顺手清掉 ${superseded.length} 个被它取代的旧更新包` : '')
		+ (prune.kept.length > 0 ? `；changes 里还有 ${prune.kept.length} 个更新包没动（${prune.kept.map(item => item.why).join('、')}）` : ''),
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
		keptChanges: prune.kept,
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
 *
 * **没删掉的要说明为什么**（`kept`）：悄悄留着会让人以为是"清理开关没生效"，
 * 或者以为是"偶发 bug"（用户报过：同一个操作第一遍没清、第二遍清了）。
 */
async function removeSupersededChanges(
	options: ExportOptions,
	header: BundleHeader,
	keep: string,
): Promise<SupersededReport> {
	const dir = bundleDirForMode(options.outDir, 'changes');
	const keepPaths = new Set((options.keepPaths ?? []).map(item => path.resolve(item)));
	keepPaths.add(path.resolve(keep));
	const removed: string[] = [];
	const kept: { name: string; why: string }[] = [];
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
		// 到这儿它就是一个"看着该被取代"的更新包了：没删就得说清为什么
		if (other.lineage !== header.lineage) {
			kept.push({ name: item.name, why: '不是同一条血脉（多半是另一台机器导的）' });
			continue;
		}
		if (other.targetGeneration >= header.targetGeneration) {
			kept.push({ name: item.name, why: '记的世代不比这次的新（导出过更晚的包）' });
			continue;
		}
		await removeFile(candidate);
		removed.push(item.name);
	}
	removed.sort();
	kept.sort((a, b) => a.name.localeCompare(b.name));
	return { removed, kept };
}
