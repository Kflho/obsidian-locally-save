import { getIconIds } from 'obsidian';

/**
 * 挑一个"这个版本的 Obsidian 真的装了"的图标。
 *
 * 类型上 `IconName = string`（见 obsidian.d.ts），写错名字**不会报错** ——
 * 只会静默渲染成一个空白方块。所以这里拿候选名去问 Obsidian 要一份清单，
 * 挑第一个确实存在的；一个都没有就用最后一个候选兜底（都是 Lucide 里的老名字，存活率最高）。
 *
 * 候选按"哪个更好看"排序：新名字排在前面，老名字垫底。
 */
export function pickIcon(candidates: string[]): string {
	if (candidates.length === 0) return 'file';
	const available = new Set(getIconIds());
	const found = candidates.find(name => available.has(name));
	return found ?? candidates[candidates.length - 1] ?? 'file';
}
