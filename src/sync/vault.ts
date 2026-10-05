import { parsePatterns } from './exclude';

/**
 * 仓库侧的扫描约定：进包 / 不进包时都要遵守的那几条。
 *
 * 这里原来挂在 `sync/runner.ts` 上（副本同步的调度器）。副本通道砍掉之后，
 * 导出与应用两条通道还在用这两个东西，所以单独挪出来 —— 它们是"仓库长什么样"的约定，
 * 跟某一条通道没关系。
 */

/**
 * 仓库里的回收目录（Obsidian 的本地回收站位置）。
 *
 * 扫描仓库时整个跳过：里面的东西是"删掉的垃圾"，不是笔记 ——
 * 一旦被扫进包里，接收方会把它当成正常文件铺出来。
 */
export const VAULT_TRASH_DIR = '.trash';

/**
 * 把「用户写的排除规则」与「运行时才知道的配置目录」合成一份排除清单。
 *
 * 配置目录默认叫 `.obsidian`，但用户可以在别处启动时改名 —— 只认默认值的话，
 * 这类用户的插件与快捷键会被整份打进包里（或者被整份铺到别人的仓库里），那不是他们想要的。
 */
export function excludePatterns(text: string, configDir?: string): string[] {
	const patterns = parsePatterns(text);
	const dir = (configDir ?? '').trim().replace(/^[/\\]+|[/\\]+$/, '');
	if (!dir) return patterns;
	const rule = `${dir.replace(/\\/g, '/')}/`;
	return patterns.includes(rule) ? patterns : [...patterns, rule];
}
