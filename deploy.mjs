/**
 * 把构建产物同步到 Obsidian 插件目录。
 *
 * 源码在本仓库（projects/js_03），Obsidian 加载的是 vault 里的插件目录 —— 那边只留
 * 运行用文件（main.js / manifest.json / styles.css / data.json），源码一份都不放。
 * `npm run dev`（watch）与 `npm run build` 都会在打包完成后自动调用这里；
 * 改了 manifest.json 版本号又不想重新打包时，直接 `npm run deploy`。
 *
 * 目标目录的取法（先到先用）：
 *   1. 环境变量 OBSIDIAN_PLUGIN_DIR
 *   2. 下面的 DEFAULT_PLUGIN_DIR
 * 目录不存在（例如 CI 上跑 build）时就跳过，只打印一行提示 —— 绝不因此让构建失败。
 *
 * 这一份是从 projects/js_02（note-tidy）继承来的，只改了插件 ID。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** 本机 vault 里的插件目录，插件 ID 就是文件夹名（与 manifest.json 的 id 保持一致）。 */
const DEFAULT_PLUGIN_DIR =
	"D:\\data\\online\\software\\common\\obsidian\\.obsidian\\plugins\\new-plugin";

/** 需要同步过去的运行用文件；main.js 由 esbuild 产出，另两个是仓库里的源文件。 */
const ARTIFACTS = ["main.js", "manifest.json", "styles.css"];

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/** 目标插件目录；环境变量优先，方便换 vault 或换机器。 */
export function resolvePluginDir() {
	return process.env.OBSIDIAN_PLUGIN_DIR || DEFAULT_PLUGIN_DIR;
}

/**
 * 复制产物到插件目录。返回复制过去的文件名；目标目录不存在时返回空数组。
 * 出错只警告不抛 —— 构建本身已经成功了，不该因为同步失败就报失败。
 */
export function deployArtifacts({ quiet = false } = {}) {
	const target = resolvePluginDir();
	if (!fs.existsSync(target)) {
		if (!quiet) console.log(`[deploy] 跳过：插件目录不存在 ${target}`);
		return [];
	}

	const copied = [];
	for (const name of ARTIFACTS) {
		const from = path.join(projectRoot, name);
		if (!fs.existsSync(from)) {
			console.warn(`[deploy] 缺少 ${name}，跳过`);
			continue;
		}
		try {
			fs.copyFileSync(from, path.join(target, name));
			copied.push(name);
		} catch (error) {
			console.warn(`[deploy] 复制 ${name} 失败：${error.message}`);
		}
	}

	if (!quiet && copied.length > 0) {
		console.log(`[deploy] 已同步到插件目录：${copied.join(", ")} → ${target}`);
	}
	return copied;
}

// 直接 `node deploy.mjs` 时执行一次；被 esbuild.config.mjs import 时不执行。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const copied = deployArtifacts();
	if (copied.length === 0) process.exitCode = 1;
}
