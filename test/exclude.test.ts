import { parsePatterns, isExcluded, matchesPattern, DEFAULT_EXCLUDES } from "../src/sync/exclude";

// -------------------------------------------------------------------- 断言
let checks = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
	checks++;
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		failures.push(`[期望不符] ${name}\n  期望 ${JSON.stringify(expected)}\n  实际 ${JSON.stringify(actual)}`);
	}
}

const excluded = (path: string, pattern: string) => matchesPattern(path, pattern);

// -------------------------------------------------------------------- 用例
// 目录规则：结尾带 / 的命中它自己与里面的所有东西
check("目录规则命中目录本身", excluded('.obsidian', '.obsidian/'), true);
check("目录规则命中里面的文件", excluded('.obsidian/plugins/x/main.js', '.obsidian/'), true);
check("目录规则不误伤同名前缀", excluded('.obsidian-backup/a.md', '.obsidian/'), false);
check("目录规则不误伤别处", excluded('notes/.obsidian.md', '.obsidian/'), false);

// 不带斜杠的规则：匹配任意层级的同名文件
check("通配符匹配顶层", excluded('a.tmp', '*.tmp'), true);
check("通配符匹配深层", excluded('notes/sub/a.tmp', '*.tmp'), true);
check("通配符不跨层", excluded('notes/a.tmp/b.md', '*.tmp'), false);
check("问号匹配一个字符", excluded('a1.md', 'a?.md'), true);
check("问号不匹配两个字符", excluded('a12.md', 'a?.md'), false);

// 带斜杠的规则：从仓库根算起
check("路径规则命中", excluded('notes/a.md', 'notes/*.md'), true);
check("路径规则不命中别处", excluded('other/notes/a.md', 'notes/*.md'), false);
check("双星跨层", excluded('a/b/c.md', 'a/**/*.md'), true);
check("双星开头也能匹配根下的", excluded('c.md', '**/*.md'), true);
check("正则特殊字符被转义", excluded('a+b.md', 'a+b.md'), true);

check("任意一条命中即排除", isExcluded('notes/a.tmp', ['*.tmp', 'zzz']), true);
check("都不命中就不排除", isExcluded('notes/a.md', ['*.tmp', '.obsidian/']), false);

// 规则文本的解析
check("解析去掉注释与空行", parsePatterns('# 注释\n\n*.tmp\n  .obsidian/  '), ['*.tmp', '.obsidian/']);
check("默认规则排除配置目录", isExcluded('.obsidian/app.json', parsePatterns(DEFAULT_EXCLUDES)), true);
check("默认规则排除状态目录", isExcluded('.lsave/state.json', parsePatterns(DEFAULT_EXCLUDES)), true);
check("默认规则放过笔记", isExcluded('notes/a.md', parsePatterns(DEFAULT_EXCLUDES)), false);
check("默认规则排除系统垃圾", isExcluded('notes/.DS_Store', parsePatterns(DEFAULT_EXCLUDES)), true);

console.log(`\n共 ${checks} 次检查，失败 ${failures.length} 项`);
for (const message of failures.slice(0, 10)) console.log("\n❌ " + message);
if (failures.length > 0) process.exitCode = 1;
