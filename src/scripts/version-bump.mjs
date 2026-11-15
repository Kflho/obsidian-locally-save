import { readFileSync, writeFileSync } from "fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 本脚本在 `src/scripts/` 下；manifest.json / versions.json 都在项目根 */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = path.join(projectRoot, "manifest.json");
const versionsPath = path.join(projectRoot, "versions.json");

const targetVersion = process.env.npm_package_version;

// read minAppVersion from manifest.json and bump version to target version
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t"));

// update versions.json with target version and minAppVersion from manifest.json
// but only if the target version is not already in versions.json
// （判的是**版本号本身**有没有记过：minAppVersion 会连着好几个版本不变，
//   早先误判成"这个 minAppVersion 见过就不写"，结果 versions.json 一直漏记新版本。）
const versions = JSON.parse(readFileSync(versionsPath, 'utf8'));
if (!(targetVersion in versions)) {
    versions[targetVersion] = minAppVersion;
    writeFileSync(versionsPath, JSON.stringify(versions, null, '\t'));
}
