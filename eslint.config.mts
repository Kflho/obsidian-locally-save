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
				moment: "readonly",
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						"eslint.config.js",
						"eslint.config.mts",
						"manifest.json",
						"tools/*.mjs",
						"esbuild.config.mjs",
						"deploy.mjs",
						"version-bump.mjs",
					],
				},
				tsconfigRootDir: path.dirname(fileURLToPath(import.meta.url)),
				extraFileExtensions: [".json"],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// 插件源码：桌面端（manifest 里 isDesktopOnly），可以用 Node 模块
		files: ["src/**/*.ts"],
		rules: {
			"obsidianmd/no-nodejs-modules": "off",
		},
	},
	{
		// 构建脚本与工具是 Node 程序：允许 Node 全局、允许 console、允许 Node 模块
		files: ["tools/**/*.mjs", "esbuild.config.mjs", "deploy.mjs", "version-bump.mjs"],
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
		"versions.json",
		"main.js",
		// 构建产物：main.js 由 esbuild 生成，不进 lint
		"**/*.d.ts",
		// 本机草稿 / 临时输出（gitignored）
		"dev",
		"temp",
		"docs",
	]),
);
