import { formatBytes, formatDuration, formatTime } from '../utils/format';
import { CHANGE_LABELS } from './types';
import type { ChangeKind } from './types';
import type { SyncOutcome } from './runner';

/**
 * 「上次同步干了什么」的一份记录。
 *
 * 为什么要落盘：状态栏那句话以前只活在内存里，重启 Obsidian 就变回"尚未同步"，
 * 用户以为同步记录丢了。这里把结果存进状态文件，启动时读回来接着显示。
 *
 * 存的是**结构化数据**而不是拼好的字符串：显示文案将来会改，
 * 存字符串的话老状态文件里就会留下过时的措辞。
 */
export interface LastSyncRecord {
	at: number;
	/** 各类变更的数量 */
	changes: Record<ChangeKind, number>;
	/** 两边一致、没动的文件数 */
	unchanged: number;
	/** 计划里一共处理了几项 */
	actions: number;
	copiedBytes: number;
	failed: number;
	durationMs: number;
	/** 这一轮补建了几个文件夹（只有空文件夹才会单独冒出来，可缺省以兼容老状态文件） */
	foldersCreated?: number;
	/** 这一轮删掉了几个空文件夹（对面删了它，跟着删） */
	foldersRemoved?: number;
}

/** 从一轮同步的结果里抽出要记的那部分 */
export function recordFromOutcome(outcome: SyncOutcome): LastSyncRecord {
	return {
		at: Date.now(),
		changes: { ...outcome.plan.summary },
		unchanged: outcome.plan.unchanged,
		actions: outcome.plan.actions.length,
		copiedBytes: outcome.result?.bytesCopied ?? 0,
		failed: outcome.result?.failed.length ?? 0,
		durationMs: outcome.durationMs,
		foldersCreated: outcome.result?.foldersCreated ?? 0,
		foldersRemoved: outcome.result?.foldersRemoved ?? 0,
	};
}

/** 只讲"改了哪些"，给状态栏用 */
export function describeChanges(record: LastSyncRecord): string {
	const parts = (Object.keys(CHANGE_LABELS) as ChangeKind[])
		.filter(kind => record.changes[kind] > 0)
		.map(kind => `${CHANGE_LABELS[kind]} ${record.changes[kind]}`);
	// 文件夹是独立的一类：不写出来的话，只动了文件夹的那一轮会显示成"无事可做"
	if ((record.foldersCreated ?? 0) > 0) parts.push(`新建文件夹 ${record.foldersCreated}`);
	if ((record.foldersRemoved ?? 0) > 0) parts.push(`清理空文件夹 ${record.foldersRemoved}`);
	if (parts.length === 0) return record.unchanged > 0 ? '无改动' : '无事可做';
	return parts.join('、');
}

/** 完整一句话，给通知用 */
export function describeRecord(record: LastSyncRecord): string {
	const head = record.actions === 0
		? `已是最新：${record.unchanged} 个文件都一致`
		: describeChanges(record);
	const size = record.copiedBytes > 0 ? `，${formatBytes(record.copiedBytes)}` : '';
	const failed = record.failed > 0 ? `，失败 ${record.failed}` : '';
	return `${head}${size}${failed}（${formatDuration(record.durationMs)}）`;
}

/** 状态栏那一行（重启之后也照这个显示） */
export function statusBarText(record: LastSyncRecord): string {
	return `上次同步 ${formatTime(record.at)} · ${describeChanges(record)}`;
}
