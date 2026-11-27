/**
 * 发版时同步版本号：把 npm 的版本号写进 `manifest.json` 与 `versions.json`。
 *
 * 由 `npm version <patch|minor|major>` 触发（package.json 的 `version` 脚本），
 * `npm_package_version` 是 npm 传进来的新版本号。
 *
 * 本脚本放在 `src/scripts/` 下，两个 JSON 都在项目根。
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 项目根（本脚本在 `src/scripts/` 下）。 */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = path.join(projectRoot, "manifest.json");
const versionsPath = path.join(projectRoot, "versions.json");

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
	console.error("[version] 没有 npm_package_version：用 `npm version patch` 调用，不要直接 node 执行");
	process.exitCode = 1;
} else {
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const { minAppVersion } = manifest;
	manifest.version = targetVersion;
	writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t"));

	// 判的是版本号本身有没有记过：minAppVersion 会连着几个版本不变，
	// 按 minAppVersion 去重会漏记新版本。
	const versions = JSON.parse(readFileSync(versionsPath, "utf8"));
	if (!(targetVersion in versions)) {
		versions[targetVersion] = minAppVersion;
		writeFileSync(versionsPath, JSON.stringify(versions, null, "\t"));
	}
}
