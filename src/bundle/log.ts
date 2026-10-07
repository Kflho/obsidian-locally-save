import { formatTime } from '../utils/format';
import type { BundleLogEntry, PluginState, StateIdInfo } from '../sync/state';
import type { ExportOutcome } from './export';

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

/** 界面上一行要写的东西：方向、类型、包里几个文件、世代、状态编号、包名 */
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
	// 差量包：内容到 target 那一代**为止**，导它的时候我这边什么都没推进 —— 得说清楚，
	// 不然这一条里的状态编号会被当成"我现在的状态"
	if (entry.checkpoint) parts.push(`送到第 ${entry.target} 代那一刻的状态`);
	// 流程自己发起的那几次导出（应用前存的改动 / 差量包）：写清来路
	if (entry.note) parts.push(entry.note);
	// 状态编号：两台机器日志里最后一条一比，就知道两边到底同不同步（世代号做不到这件事）
	if (entry.stateId) parts.push(`状态 ${entry.stateId}`);
	if (entry.vault) parts.push(`来自「${entry.vault}」`);
	if (entry.file) parts.push(entry.file);
	return parts.join(' · ');
}

/**
 * 状态栏那一行：最近一次导出 / 应用干了什么。
 *
 * 0.8.0 之前这句话来自「上次同步到本地副本」的记录（`LastSyncRecord`）。
 * 副本通道砍掉之后改读**更新记录的最后一条** —— 只有一条真相来源：
 * 状态栏那句话就是它的简版，用户点开「更新记录…」看到的是详情。
 */
export function describeLastActivity(state: PluginState): string {
	const log = Array.isArray(state.bundleLog) ? state.bundleLog : [];
	const last = log[log.length - 1];
	if (!last) return '尚未留包';
	const verb = last.direction === 'export' ? '上次留包' : '上次应用';
	const kind = last.mode === 'full' ? '完整副本' : '更新包';
	const deleted = last.deleted > 0 ? `（含 ${last.deleted} 个删除）` : '';
	return `${verb} ${formatTime(last.at)} · ${kind} ${last.entries} 个文件${deleted}`;
}

/**
 * 状态编号怎么念：`3f9a2c1d（10378 个文件 · 4321 个文件夹）`。
 * 没能核验内容的文件必须写出来 —— 那种情况下编号不是完全的内容指纹。
 */
export function describeStateId(info: StateIdInfo | null | undefined): string {
	if (!info) return '没有（对方那个包是旧版本导的）';
	const scope = [`${info.files} 个文件`, ...(info.dirs > 0 ? [`${info.dirs} 个文件夹`] : [])].join(' · ');
	return `${info.id}（${scope}`
		+ `${info.unverified > 0 ? ` · 其中 ${info.unverified} 个没能校验内容` : ''}）`;
}

/**
 * 同步包界面上那一行「本机现在站在哪儿」——**世代与状态编号必须一起写**。
 *
 * 为什么不能只写世代号：它只说"内容走到第几版"，
 * 回答不了"两边文件一样吗"；状态编号才回答得了。用户专门提过要两个一起看。
 *
 * "站在哪一份完整副本上"也要写：0.14 起**只有完整包会改变这个位置**
 * （导出 / 应用更新包都不动它），互发更新包的两台机器认的就是它。
 */
export function describeLocalState(state: PluginState): string {
	const bundle = state.bundle;
	const anchor = bundle?.fullGeneration !== null && bundle?.fullGeneration !== undefined
		? `站在第 ${bundle.fullGeneration} 代那份完整副本上${bundle.fullFile ? `（${bundle.fullFile}）` : ''}`
		: '还没站上过完整副本（没导过、也没应用过）';
	const id = state.stateId ? `状态 ${state.stateId.id}` : '状态编号还没算过（下次导出 / 应用时会有）';
	return `本机：第 ${state.generation} 代 · ${anchor} · ${id}`;
}

/**
 * 一次导出结果里那句"从哪一份到哪一份"（通知与弹窗里用）。
 *
 * 两个号都写出来：**起点从哪一代、这一份落到第几代** —— 用户要的就是这个
 * （"54 → 55"）；回退之后再导出时，落点号从高水位往后发，这里一看就知道没撞号。
 * 差量包要点明**内容到那一刻为止**（它不代表你现在的仓库）；起点一律带上**基准指纹**——
 * 对方「更新记录」顶上写的就是它，对不上就是"基准对不上"（世代号说不出是哪一份完整副本，光看代认不出来）。
 */
export function describeExportRange(outcome: ExportOutcome): string {
	const anchor = outcome.anchor;
	if (!anchor) return '';
	const base = anchor.hash ? `基准 ${anchor.hash}` : '基准未知';
	return `（第 ${anchor.generation} 代 → 第 ${anchor.targetGeneration} 代 · ${base}）`;
}

/**
 * 起点的说明：导出对话框、导出预览、导出结果三处**共用这一句**（别各写一套）。
 *
 * 0.14 起起点只有两种来路（"自动接线头"那套随链条模型一起去掉了）：
 * - **你站的那一份完整副本**（默认，也是绝大多数情况）—— 这一句说明"这一份是从它算起的"，
 *   用户看着那个号就能跟对方手里的完整副本对上；
 * - **用户在下拉里指定的一份** / **调用方合成的起点**（应用前先存改动那一趟）——
 *   界面已经写着是从哪一份来的，这里不再重复。
 */
export function describeExportStart(
	start: {
		picked?: 'self' | 'explicit' | 'override';
		mine?: { generation: number } | null;
	} | null | undefined,
): string {
	// 起点那两个号就在同一行的 `describeExportRange` 里，这里只补一句"从哪儿算起"
	if (!start || start.picked !== 'self') return '';
	return '从你站的那份完整副本算起';
}

/**
 * 顶部那句"我现在站在哪儿"：
 * - 你站的是哪一份完整副本（文件名 + 世代 + 指纹）
 * - 之后应用过几个更新包、导出过几个，最近一次是什么时候
 */
export function describeBundlePosition(state: PluginState): string[] {
	const lines: string[] = [];
	const bundle = state.bundle;
	if (!bundle) {
		lines.push('还没有站上过完整副本：先导出一份完整副本，或者应用对方发来的完整副本。');
		return lines;
	}
	const name = bundle.fullFile ?? '（不知道是哪份包，旧版本留下的记录）';
	lines.push(
		`你站的那份完整副本：第 ${bundle.fullGeneration ?? '?'} 代 · 指纹 ${bundle.fullHash ?? '未知'} · ${name}`,
	);
	/**
	 * 「我现在长什么样」—— 用**状态编号**说，不用世代号。
	 *
	 * 世代号只说"内容走到第几版"（同一份内容必然同一个号），拿它判断"两边内容一样吗"
	 * 必然出错。编号是内容指纹：**跟对方日志里那个一样 ＝ 两边文件一致**。
	 * 它记的是"上次导出 / 应用那一刻"，之后又改过文件就要等下一次导出 / 应用才刷新 ——
	 * 所以把算它的时间也写出来。
	 */
	lines.push(
		state.stateId
			? `我现在：状态 ${describeStateId(state.stateId)} · ${formatTime(state.stateId.at)} 算的`
			: '我这边的状态编号还没有（旧状态文件）：下次导出 / 应用同步包时会算一个。',
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
			`⚠ 还有一笔改动没发出去：你这边有 ${owed.changes} 个改动`
			+ `${owed.deletes > 0 ? `、${owed.deletes} 个删除` : ''}`
			+ `是对方没有的 —— 下次导出更新包会一起带上（上次收到的是 ${owed.file ?? owed.bundleId.slice(0, 6)}）`,
		);
	}
	return lines;
}
