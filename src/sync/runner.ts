import path from 'node:path';
import { formatStamp } from '../utils/format';
import type { Logger } from '../utils/log';
import type { PluginSettings } from '../settings/model';
import { DEFAULT_MTIME_TOLERANCE_MS, planSync, rebuildState } from './diff';
import { ensureDir, scanTree } from './disk';
import { parsePatterns } from './exclude';
import { executePlan } from './execute';
import type { ExecuteResult } from './execute';
import { loadState, saveState, setTargetBaseline, targetBaseline } from './state';
import type { SyncDirection, SyncPlan } from './types';

/**
 * 同步的总调度：扫描 → 比对 → 执行 → 重建基准。
 *
 * 依赖通过 `SyncHost` 注入而不是直接摸插件对象：
 * 这样引擎不 import obsidian，测试里可以拿临时目录当"仓库"直接跑（见 test/sync.test.ts）。
 */

export interface SyncHost {
	settings: PluginSettings;
	log: Logger;
	/** 仓库根的绝对路径；非桌面端会抛错 */
	vaultRoot(): string;
	/** 插件状态文件的绝对路径 */
	stateFile(): string;
	/**
	 * 配置目录名（通常是 `.obsidian`，但用户可以改）。
	 * 运行时拿真实值排除它 —— 光靠默认规则里写死的 `.obsidian/` 挡不住改过配置目录的用户。
	 */
	configDir(): string;
	/** 状态栏进度；null ＝ 收工 */
	reportProgress(progress: SyncProgress | null): void;
}

export interface SyncProgress {
	done: number;
	total: number;
	path: string;
}

export interface SyncRunOptions {
	/** 覆盖设置里的方向（命令「仅上传 / 仅下载」用） */
	direction?: SyncDirection;
	/** 只算不干：预览窗口用 */
	dryRun?: boolean;
}

export interface SyncOutcome {
	targetDir: string;
	plan: SyncPlan;
	/** dryRun 时为 null */
	result: ExecuteResult | null;
	scannedLocal: number;
	scannedRemote: number;
	durationMs: number;
	dryRun: boolean;
}

/** 仓库里的回收目录（Obsidian 的本地回收站位置） */
export const VAULT_TRASH_DIR = '.trash';
/** 副本里的状态目录：回收站与将来的元数据都放这儿，扫描时整个跳过 */
export const TARGET_STATE_DIR = '.lsave';

/**
 * 把「用户写的排除规则」与「运行时才知道的配置目录」合成一份排除清单。
 *
 * 配置目录默认叫 `.obsidian`，但用户可以在别处启动时改名 —— 只认默认值的话，
 * 这类用户的插件与快捷键会被整份同步出去，那不是他们想要的。
 */
export function excludePatterns(text: string, configDir?: string): string[] {
	const patterns = parsePatterns(text);
	const dir = (configDir ?? '').trim().replace(/^[/\\]+|[/\\]+$/g, '');
	if (!dir) return patterns;
	const rule = `${dir.replace(/\\/g, '/')}/`;
	return patterns.includes(rule) ? patterns : [...patterns, rule];
}

/** 目标目录不能跟仓库套娃，否则会自己同步自己 */
function assertNotNested(vaultRoot: string, targetDir: string): void {
	const vault = path.resolve(vaultRoot);
	const target = path.resolve(targetDir);
	if (vault === target) throw new Error('目标文件夹不能就是仓库本身');
	if (target.startsWith(vault + path.sep)) {
		throw new Error('目标文件夹不能在仓库里面：副本会被当成仓库内容再同步一遍。请换一个仓库之外的目录');
	}
	if (vault.startsWith(target + path.sep)) {
		throw new Error('目标文件夹不能是仓库的上级目录：那样会把整个仓库当成副本内容。请换一个与仓库平级的目录');
	}
}

export async function runSync(host: SyncHost, options: SyncRunOptions = {}): Promise<SyncOutcome> {
	const settings = host.settings;
	const targetDir = settings.targetDir.trim();
	if (!targetDir) {
		throw new Error('还没设置「目标文件夹」：设置 → Locally Save → 本地同步');
	}

	const vaultRoot = host.vaultRoot();
	assertNotNested(vaultRoot, targetDir);

	const exclude = excludePatterns(settings.excludePatterns, host.configDir());
	const direction = options.direction ?? settings.syncDirection;
	const started = Date.now();

	// 第一次用不必手动建目录
	await ensureDir(targetDir);

	const local = await scanTree(vaultRoot, { exclude, skipTopLevelDirs: [VAULT_TRASH_DIR] });
	const remote = await scanTree(targetDir, { exclude, skipTopLevelDirs: [TARGET_STATE_DIR] });

	const stateFile = host.stateFile();
	const state = await loadState(stateFile);
	const planned = planSync(local, remote, targetBaseline(state, targetDir), {
		direction,
		propagateDeletions: settings.propagateDeletions,
		conflictStrategy: settings.conflictStrategy,
		mtimeToleranceMs: DEFAULT_MTIME_TOLERANCE_MS,
	});

	host.log.debug(
		`比对完成：本地 ${local.files.size} 个文件、副本 ${remote.files.size} 个，` +
		`待处理 ${planned.actions.length} 项，未变 ${planned.unchanged} 项`,
	);

	if (options.dryRun) {
		return {
			targetDir,
			plan: planned,
			result: null,
			scannedLocal: local.files.size,
			scannedRemote: remote.files.size,
			durationMs: Date.now() - started,
			dryRun: true,
		};
	}

	let result: ExecuteResult | null = null;
	let localAfter = local;
	let remoteAfter = remote;

	if (planned.actions.length > 0) {
		result = await executePlan(planned, {
			vaultRoot,
			targetRoot: targetDir,
			useTrash: settings.deletedToTrash,
			stamp: formatStamp(Date.now()),
			onProgress: (done, total, file) => host.reportProgress({ done, total, path: file }),
		});
		host.reportProgress(null);

		// 重新扫一遍再重建基准：中途失败 / 被别的程序改了，都能如实反映，
		// 不会留下"以为同步过了"的假记录
		localAfter = await scanTree(vaultRoot, { exclude, skipTopLevelDirs: [VAULT_TRASH_DIR] });
		remoteAfter = await scanTree(targetDir, { exclude, skipTopLevelDirs: [TARGET_STATE_DIR] });
	}

	setTargetBaseline(
		state,
		targetDir,
		rebuildState(localAfter, remoteAfter, DEFAULT_MTIME_TOLERANCE_MS),
		Date.now(),
	);
	await saveState(stateFile, state);

	return {
		targetDir,
		plan: planned,
		result,
		scannedLocal: local.files.size,
		scannedRemote: remote.files.size,
		durationMs: Date.now() - started,
		dryRun: false,
	};
}
