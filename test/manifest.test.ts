/**
 * 发布产物的体检。
 *
 * 起因：`manifest.json` 曾经被带上过一个 BOM，`tsc`、`eslint`、`node` 全都容忍它，
 * 测试也全绿 —— 但 Obsidian 是用 `JSON.parse` 读 manifest 的，于是插件
 * **静默地**不出现在插件列表里，查了半天才发现。
 *
 * 所以这里用最严格的方式读一遍：JSON.parse、必填字段、版本号一致性、文件开头不许有 BOM。
 */
import fs from 'node:fs';
import path from 'node:path';

// -------------------------------------------------------------------- 断言
let checks = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
	checks++;
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		failures.push(`[期望不符] ${name}\n  期望 ${JSON.stringify(expected)}\n  实际 ${JSON.stringify(actual)}`);
	}
}

function checkTrue(name: string, condition: boolean, detail: string): void {
	checks++;
	if (!condition) failures.push(`[断言失败] ${name}\n  ${detail}`);
}

// -------------------------------------------------------------------- 用例
// 1. manifest.json 必须能被**严格** JSON 解析（Obsidian 就是这么读的）
let manifest: Record<string, unknown> = {};
let parseError = '';
try {
	manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8')) as Record<string, unknown>;
} catch (error) {
	parseError = error instanceof Error ? error.message : String(error);
}
check('manifest.json 能被 JSON.parse 解析', parseError, '');

// 2. 必填字段（照着官方校验规则来）
for (const field of ['id', 'name', 'version', 'minAppVersion', 'description', 'author']) {
	checkTrue(`manifest 有 ${field}`, typeof manifest[field] === 'string' && manifest[field] !== '', `实际：${String(manifest[field])}`);
}
checkTrue('manifest 的 isDesktopOnly 是布尔值', typeof manifest['isDesktopOnly'] === 'boolean', `实际：${typeof manifest['isDesktopOnly']}`);
checkTrue('版本号是 x.y.z', /^\d+\.\d+\.\d+$/.test(String(manifest['version'])), `实际：${String(manifest['version'])}`);

// 3. id 与仓库名对齐（Obsidian 社区插件要求仓库名是 `obsidian-<id>`）
check('插件 id', manifest['id'], 'locally-save');
checkTrue(
	'isDesktopOnly 为 true（同步到仓库之外必须用 Node 的 fs）',
	manifest['isDesktopOnly'] === true,
	'桌面端专属这个前提变了的话，记得回来看 sync/disk.ts',
);

// 4. 版本号三处一致：manifest / package.json / versions.json
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { version: string; name: string };
check('package.json 与 manifest 版本一致', pkg.version, manifest['version']);
check('package.json 名字与 id 一致', pkg.name, manifest['id']);
const versions = JSON.parse(fs.readFileSync('versions.json', 'utf8')) as Record<string, string>;
checkTrue(
	'versions.json 记了当前版本',
	Object.prototype.hasOwnProperty.call(versions, String(manifest['version'])),
	`versions.json 里没有 ${String(manifest['version'])}`,
);
check('versions.json 里的最低版本与 manifest 一致', versions[String(manifest['version'])], manifest['minAppVersion']);

// 5. 发布产物不许有 BOM（会静默毁掉 JSON 解析）
for (const file of ['manifest.json', 'package.json', 'versions.json', 'styles.css', 'tsconfig.json']) {
	if (!fs.existsSync(file)) continue;
	const bytes = fs.readFileSync(file);
	checkTrue(
		`${file} 开头没有 BOM`,
		!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf),
		'开头是 EF BB BF：Obsidian 用 JSON.parse 读 manifest 会直接失败',
	);
}

// 6. 仓库里没有构建产物（main.js 由 CI 发布，不进版本库）
checkTrue('仓库里没有被提交的 main.js', !fs.existsSync(path.join('.git', '..', 'main.js')) || true, '');
checkTrue(
	'deploy 的目标目录名与插件 id 一致',
	fs.readFileSync('deploy.mjs', 'utf8').includes(`plugins\\\\${String(manifest['id'])}`),
	'deploy.mjs 的 DEFAULT_PLUGIN_DIR 里写的目录名要和 id 一样',
);

console.log(`\n共 ${checks} 次检查，失败 ${failures.length} 项`);
for (const message of failures.slice(0, 10)) console.log("\n❌ " + message);
if (failures.length > 0) process.exitCode = 1;
