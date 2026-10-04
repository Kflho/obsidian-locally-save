import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;

// read minAppVersion from manifest.json and bump version to target version
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t"));

// update versions.json with target version and minAppVersion from manifest.json
// but only if the target version is not already in versions.json
// （判的是**版本号本身**有没有记过：minAppVersion 会连着好几个版本不变，
//   早先误判成"这个 minAppVersion 见过就不写"，结果 versions.json 一直漏记新版本。）
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
if (!(targetVersion in versions)) {
    versions[targetVersion] = minAppVersion;
    writeFileSync('versions.json', JSON.stringify(versions, null, '\t'));
}
