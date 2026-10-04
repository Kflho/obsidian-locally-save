import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default defineConfig(
	{
		languageOptions: {
			globals: {
				...globals.browser,
				moment: 'readonly',
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'eslint.config.mts',
						'manifest.json',
						'test/*.mjs'
					]
				},
				tsconfigRootDir: path.dirname(fileURLToPath(import.meta.url)),
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// 测试代码运行在 Node 环境，且需要用 console 输出测试结果
		files: ['test/**/*.ts', 'test/**/*.mjs'],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
		rules: {
			'no-console': 'off',
			// obsidianmd 0.4.2 起 no-console 改由这条规则代管（消息带 [no-console] 前缀）。
			// 测试跑在 Node 里，本来就要用 console 输出结果，这里一并关掉。
			'obsidianmd/rule-custom-message': 'off',
			// 测试没有 popout 窗口，Node 下的全局对象就是 globalThis
			'obsidianmd/no-global-this': 'off',
			// 测试与构建脚本本来就跑在 Node 里（esbuild 打包测试、读文件、写临时目录），
			// "移动端没有 Node API" 这条建议在这里不适用
			'obsidianmd/no-nodejs-modules': 'off',
		},
	},
	{
		// 本插件是**桌面端专属**（manifest 里 isDesktopOnly: true）：
		// 同步目标是仓库之外的文件夹，vault API 出不了库，只能用 Node 的 fs。
		// 所以"移动端没有 Node API"这条建议在这里是刻意的取舍，不是疏漏。
		files: ['src/**/*.ts'],
		rules: {
			'obsidianmd/no-nodejs-modules': 'off',
		},
	},
	{
		// 构建用的配置文件同理：它们只在 Node 下运行，不会进 main.js
		files: ['eslint.config.mts', 'esbuild.config.mjs', 'deploy.mjs', 'version-bump.mjs'],
		rules: {
			'obsidianmd/no-nodejs-modules': 'off',
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"deploy.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
		"test/.build",
	]),
);
