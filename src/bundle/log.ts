import { formatTime } from '../utils/format';
import type { BundleLogEntry, PluginState } from '../sync/state';

/**
 * 同步包更新记录：**像 git log 那样，把"收发过哪些包"摊开**。
 *
 * 为什么需要：状态文件只记"现在什么样"（基准是哪一代、指纹是什么），用户看不出
 * "我是从哪份完整副本开始的、中间收过谁的更新包、现在离基准有多远、有哪些还没发出去"。
 * 两台机器来回搬的时候，这些恰恰是最想知道的（用户提的："类似 git 的更新记录"）。
 *
 * 记录只追加、只留最近若干条：状态文件是每次同步都要读写的，不能越滚越大。
 */

/** 记录最多留多少条（够看清最近的来龙去脉就行） */
export const BUNDLE_LOG_LIMIT = 100;

/** 追加一条记录（超过上限就从最老的开始丢） */
export function appendBundleLog(state: PluginState, entry: BundleLogEntry): void {
	const log = Array.isArray(state.bundleLog) ? state.bundleLog : [];
	log.push(entry);
	state.bundleLog = log.slice(-BUNDLE_LOG_LIMIT);
}

/** 界面上一行要写的东西：方向、类型、包里几个文件、世代、包名 */
export function describeLogEntry(entry: BundleLogEntry): string {
	const parts: string[] = [];
	parts.push(entry.direction === 'export' ? '→ 导出' : '← 应用');
	parts.push(entry.mode === 'full' ? '完整副本' : '更新包');
	parts.push(`${entry.entries} 个文件${entry.deleted > 0 ? `（含 ${entry.deleted} 个删除）` : ''}`);
	parts.push(
		entry.mode === 'full'
			? `第 ${entry.target} 代 · 立基准`
			: `第 ${entry.base ?? '?'} → ${entry.target} 代`,
	);
	if (entry.vault) parts.push(`来自「${entry.vault}」`);
	if (entry.file) parts.push(entry.file);
	return parts.join(' · ');
}

/**
 * 顶部那句"我现在站在哪儿"：
 * - 基准是哪份完整副本（文件名 + 世代 + 指纹）
 * - 之后应用过几个更新包、导出过几个，最近一次是什么时候
 */
export function describeBundlePosition(state: PluginState): string[] {
	const lines: string[] = [];
	const bundle = state.bundle;
	if (!bundle) {
		lines.push('还没有立过基准：先导出一份完整副本，或者应用对方发来的完整副本。');
		return lines;
	}
	const name = bundle.fullFile ?? '（不知道是哪份包，旧版本留下的记录）';
	lines.push(
		`基准：第 ${bundle.fullGeneration ?? '?'} 代 · 指纹 ${bundle.fullHash ?? '未知'} · ${name}`,
	);
	const log = Array.isArray(state.bundleLog) ? state.bundleLog : [];
	const applied = log.filter(item => item.direction === 'apply' && item.mode === 'changes').length;
	const exported = log.filter(item => item.direction === 'export' && item.mode === 'changes').length;
	const last = log[log.length - 1];
	lines.push(
		`这之后：应用过 ${applied} 个更新包、导出过 ${exported} 个`
		+ (last ? `；最近一次是 ${formatTime(last.at)} ${last.direction === 'export' ? '导出' : '应用'}的 ${last.file ?? last.bundleId.slice(0, 6)}` : ''),
	);
	// 欠账式回传：应用完不立刻生成回礼包（会互相套娃），改成记账 —— 这里把它说出来
	const owed = state.pendingReturn;
	if (owed) {
		lines.push(
			`⚠ 还欠一次回传：你这边有 ${owed.changes} 个改动`
			+ `${owed.deletes > 0 ? `、${owed.deletes} 个删除` : ''}`
			+ `是对方没有的 —— 下次导出更新包会一起带上（上次收到的是 ${owed.file ?? owed.bundleId.slice(0, 6)}）`,
		);
	}
	return lines;
}
