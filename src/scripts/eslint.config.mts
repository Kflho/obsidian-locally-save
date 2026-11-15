import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

// npm 工程根就是 src/（本文件在 src/scripts/ 下），lint 的 cwd 也是 src/
const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default defineConfig(
	{
		languageOptions: {
			globals: {
				...globals.browser,
				moment: "readonly",
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						"scripts/eslint.config.mjs",
						"scripts/eslint.config.mts",
						"scripts/*.mjs",
					],
				},
				tsconfigRootDir: srcRoot,
				extraFileExtensions: [".json"],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// 插件源码：桌面端（manifest 里 isDesktopOnly），可以用 Node 模块
		files: ["**/*.ts"],
		rules: {
			"obsidianmd/no-nodejs-modules": "off",
		},
	},
	{
		// 构建脚本与工具是 Node 程序：允许 Node 全局、允许 console、允许 Node 模块
		files: ["scripts/**/*.mjs"],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
		rules: {
			"no-console": "off",
			"obsidianmd/rule-custom-message": "off",
			"obsidianmd/no-global-this": "off",
			"obsidianmd/no-nodejs-modules": "off",
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"eslint.config.js",
		// 构建产物：main.js 由 esbuild 生成，不进 lint
		"**/*.d.ts",
		// 本机草稿 / 临时输出（gitignored）
		"dev",
		"temp",
	]),
);
