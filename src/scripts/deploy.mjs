/**
 * 把构建产物同步到 Obsidian 插件目录。
 *
 * 源码在仓库里，Obsidian 加载的是 vault 里的插件目录，那边只留运行用文件。
 * `npm run dev`（watch）与 `npm run build` 都在打包完成后自动调用本脚本；
 * 只改了 manifest 版本号、不想重新打包时直接 `npm run deploy`。
 *
 * 本脚本放在 `src/scripts/` 下，项目根取上两级：`manifest.json`、`bin/exports/`、
 * `deploy.local.json` 都相对项目根定位。
 *
 * 目标目录的取法，先到先用：
 *   1. 环境变量 `OBSIDIAN_PLUGIN_DIR`
 *   2. 仓库根的 `deploy.local.json`：`{ "pluginDir": "<vault>/.obsidian/plugins/<id>" }`
 *      （该文件在 `.gitignore` 里，模板见 `deploy.local.example.json`）
 * 两样都没配、或目录不存在（例如在 CI 上构建）时跳过并打印一行提示，不让构建失败。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** 项目根（本脚本在 `src/scripts/` 下）。 */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** 本机插件目录配置，不提交到版本库。 */
const LOCAL_CONFIG = path.join(projectRoot, "deploy.local.json");

/** 需要同步的运行用文件：main.js 来自交付包，manifest 在仓库根，styles 在 src。 */
const ARTIFACTS = [
	{ name: "main.js", from: "bin/exports/main.js" },
	{ name: "manifest.json", from: "manifest.json" },
	{ name: "styles.css", from: "src/styles.css" },
];

/** 读本机配置里的插件目录；没配、读不出来或不是字符串时返回空串。 */
function readLocalPluginDir() {
	try {
		const config = JSON.parse(fs.readFileSync(LOCAL_CONFIG, "utf8"));
		return typeof config.pluginDir === "string" ? config.pluginDir.trim() : "";
	} catch {
		return "";
	}
}

/** 目标插件目录：环境变量优先，其次本机的 deploy.local.json。 */
export function resolvePluginDir() {
	return process.env.OBSIDIAN_PLUGIN_DIR || readLocalPluginDir();
}

/**
 * 复制产物到插件目录，返回复制过去的文件名。没配目录或目录不存在时返回空数组。
 * 单个文件缺失或复制失败只警告，不抛出：构建已经成功，不该因同步失败报错。
 */
export function deployArtifacts({ quiet = false } = {}) {
	const target = resolvePluginDir();
	if (!target) {
		if (!quiet) {
			console.log(
				"[deploy] 跳过：没配插件目录。设环境变量 OBSIDIAN_PLUGIN_DIR，或在仓库根建 deploy.local.json（模板见 deploy.local.example.json）",
			);
		}
		return [];
	}
	if (!fs.existsSync(target)) {
		if (!quiet) console.log(`[deploy] 跳过：插件目录不存在 ${target}`);
		return [];
	}

	const copied = [];
	for (const artifact of ARTIFACTS) {
		const from = path.join(projectRoot, artifact.from);
		if (!fs.existsSync(from)) {
			console.warn(`[deploy] 缺少 ${artifact.name}，跳过`);
			continue;
		}
		try {
			fs.copyFileSync(from, path.join(target, artifact.name));
			copied.push(artifact.name);
		} catch (error) {
			console.warn(`[deploy] 复制 ${artifact.name} 失败：${error.message}`);
		}
	}

	if (!quiet && copied.length > 0) {
		console.log(`[deploy] 已同步到插件目录：${copied.join(", ")} → ${target}`);
	}
	return copied;
}

// 直接 `node src/scripts/deploy.mjs` 时执行一次；被 esbuild.config.mjs import 时不执行。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const copied = deployArtifacts();
	if (copied.length === 0) process.exitCode = 1;
}
