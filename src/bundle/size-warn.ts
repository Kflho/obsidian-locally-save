/**
 * 「更新包攒得太大了」这件事的判定。
 *
 * 背景：更新包是自完整副本累积的，越攒越大；等它大到接近完整副本时，
 * 它唯一的好处（传得小）就没了。所以到某个体积就该换一次基准：重导一份完整副本，
 * 让更新包从零重新累积。
 *
 * 这里只放**纯判断**（好测），弹窗与执行在 ui 那边。
 */

/** 留空时用的上限 */
export const DEFAULT_SIZE_LIMIT = '200MB';

const UNITS = {
	B: 1,
	KB: 1024,
	MB: 1024 * 1024,
	GB: 1024 * 1024 * 1024,
} as const satisfies Record<string, number>;

/** 单个单位的字节数（认不出来按 MB 算） */
function unitBytes(unit: string): number {
	const key = unit.toUpperCase() as keyof typeof UNITS;
	return UNITS[key] ?? UNITS.MB;
}

/**
 * 把用户填的「多大」解析成字节数。
 *
 * 认这些写法：`200MB`、`500 KB`、`1gb`、`200`（不带单位按 MB 算）。
 * 特殊值：
 * - **留空** → `DEFAULT_SIZE_LIMIT`（默认 200MB）；
 * - **0** → `Infinity`（＝关掉这个提醒）；
 * - 认不出来 → 按默认值算（宁可提醒，也别因为填错就永远不提醒）。
 */
export function parseSizeLimit(text: string | null | undefined): number {
	const raw = (text ?? '').trim();
	if (raw === '') return parseSizeLimit(DEFAULT_SIZE_LIMIT);
	const match = /^([0-9]*\.?[0-9]+)\s*(b|kb|mb|gb)?$/i.exec(raw);
	if (!match) return parseSizeLimit(DEFAULT_SIZE_LIMIT);
	const amount = Number.parseFloat(match[1] ?? '');
	if (!Number.isFinite(amount) || amount <= 0) return Number.POSITIVE_INFINITY;
	return Math.floor(amount * unitBytes(match[2] ?? 'MB'));
}

/**
 * 现在这条"提醒线"是多少。
 *
 * 用户点过「跳过这次导出」之后，提醒线**按原来那个上限整数倍往上抬**：
 * 上限 200MB 的话就是 200 → 400 → 600…… 而不是"每次同步都弹"。
 * 换过一次基准（重导完整副本）之后这个倍数清零，回到 1 倍。
 */
export function warnThreshold(limitBytes: number, warnedAt?: number | null): number {
	if (!Number.isFinite(limitBytes)) return Number.POSITIVE_INFINITY;
	return typeof warnedAt === 'number' && warnedAt > 0 ? warnedAt : limitBytes;
}

/** 跳过一次之后，提醒线抬到哪儿（＋一个原上限） */
export function advanceWarnThreshold(limitBytes: number, warnedAt?: number | null): number {
	const current = warnThreshold(limitBytes, warnedAt);
	return Number.isFinite(current) ? current + limitBytes : current;
}

/**
 * 要不要弹「换基准」那个窗。
 *
 * - 上限是 Infinity（设置里填了 0）→ 永不弹；
 * - 包还没到**当前提醒线** → 不弹；
 * - 到线了就弹；用户跳过一次之后，线会抬高一倍原上限（见 `advanceWarnThreshold`）。
 */
export function shouldOfferReset(limitBytes: number, fileBytes: number, warnedAt?: number | null): boolean {
	if (!Number.isFinite(limitBytes)) return false;
	return fileBytes >= warnThreshold(limitBytes, warnedAt);
}

/** 上限的人话写法（弹窗里显示"你设的上限"用） */
export function describeLimit(limitBytes: number): string {
	if (!Number.isFinite(limitBytes)) return '（没设上限）';
	const scales: [string, number][] = [['GB', UNITS.GB], ['MB', UNITS.MB], ['KB', UNITS.KB]];
	for (const [unit, factor] of scales) {
		if (limitBytes >= factor) {
			const amount = limitBytes / factor;
			return `${Number.isInteger(amount) ? amount : amount.toFixed(1)} ${unit}`;
		}
	}
	return `${limitBytes} B`;
}

