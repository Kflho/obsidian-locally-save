import { basename } from '../utils/paths';

/**
 * 排除规则：哪些文件不参与同步。
 *
 * 写法和 .gitignore 类似（但只支持子集，够用就行）：
 * - 一行一条；`#` 开头是注释，空行忽略
 * - 结尾带 `/` ＝ 整个目录（连同里面的东西）
 * - 带 `/` ＝ 从仓库根算起的路径；不带 `/` ＝ 匹配任意层级的同名文件 / 目录
 * - 支持 `*`（一层里的任意字符）、`**`（跨层）、`?`（一个字符）
 */

/** 默认排除：用户不动这一栏时的规则 */
export const DEFAULT_EXCLUDES = `# 默认不同步配置目录（插件、主题、快捷键各台机器往往不一样，同步过去容易打架）。
# 想让配置也跟着走，把下面这行删掉即可。
.obsidian/

# 本插件自己的同步状态与删除备份
.lsave/

# 系统垃圾文件
.DS_Store
Thumbs.db
desktop.ini`;

/** 把多行文本切成规则数组（去注释、去空行） */
export function parsePatterns(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(line => line !== '' && !line.startsWith('#'));
}

/** glob → 正则。`*` 不跨 `/`，`**` 跨，`?` 一个字符 */
function globToRegExp(pattern: string): RegExp {
	let source = '';
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern.charAt(i);
		if (char === '*') {
			if (pattern[i + 1] === '*') {
				source += '.*';
				i++;
			} else {
				source += '[^/]*';
			}
			continue;
		}
		if (char === '?') {
			source += '[^/]';
			continue;
		}
		source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	}
	return new RegExp(`^${source}$`);
}

/** 单条规则是否命中某个路径 */
export function matchesPattern(relPath: string, pattern: string): boolean {
	if (pattern.endsWith('/')) {
		// 目录规则：命中它自己，以及它下面的所有东西
		const dir = pattern.replace(/\/+$/, '');
		return relPath === dir || relPath.startsWith(`${dir}/`);
	}
	if (pattern.includes('/')) {
		// 带路径的规则：整条相对路径参与匹配
		return globToRegExp(pattern).test(relPath);
	}
	// 不带路径的规则：匹配任意层级的文件名（目录本身也用它判断，见 scanTree）
	return globToRegExp(pattern).test(basename(relPath));
}

/** 任意一条规则命中即算排除 */
export function isExcluded(relPath: string, patterns: string[]): boolean {
	return patterns.some(pattern => matchesPattern(relPath, pattern));
}
