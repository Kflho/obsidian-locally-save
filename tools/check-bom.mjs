/**
 * 一次性体检工具：扫出文件开头的 BOM 与残留的旧名字。
 *
 * 起因：早先批量改名时用过 PowerShell 的 Set-Content，它按带 BOM 的 UTF-8 写，
 * 于是 manifest.json 开头多了 \uFEFF —— Obsidian 用 JSON.parse 读 manifest，
 * 直接解析失败，插件**静默地**不出现在列表里（tsc / node 都容忍 BOM，所以测不出来）。
 *
 * 用法：
 *   node tools/check-bom.mjs          只报告
 *   node tools/check-bom.mjs --fix    顺手把 BOM 去掉、旧名改掉
 */
import fs from 'node:fs';
import path from 'node:path';

const FIX = process.argv.includes('--fix');
const SKIP = /(node_modules|[\\/]\.git|[\\/]\.build)/;
const SELF = path.resolve('tools/check-bom.mjs');
const EXTENSIONS = /\.(ts|mjs|json|css|md|yml|yaml|txt|editorconfig|npmrc|gitignore)$/;

/** 旧名字的残留（改名时漏掉的） */
const STALE = [['Localy Save', 'Locally Save'], ['LocalySave', 'LocallySave'], ['localy-save', 'locally-save']];

const withBom = [];
const stale = [];

function walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (SKIP.test(full)) continue;
		if (path.resolve(full) === SELF) continue; // 别把自己那张替换表也当成残留
		if (entry.isDirectory()) {
			walk(full);
			continue;
		}
		if (!EXTENSIONS.test(entry.name) && !entry.name.startsWith('.')) continue;

		const raw = fs.readFileSync(full);
		const text = raw.toString('utf8');
		let next = text;

		if (text.charCodeAt(0) === 0xfeff) {
			withBom.push(full);
			next = text.slice(1);
		}
		for (const [from, to] of STALE) {
			if (next.includes(from)) {
				stale.push(`${full}  ${from} → ${to}`);
				next = next.split(from).join(to);
			}
		}
		if (FIX && next !== text) fs.writeFileSync(full, next, 'utf8');
	}
}

walk('.');

console.log(withBom.length ? `带 BOM 的文件（${withBom.length}）：` : '带 BOM 的文件：无 ✓');
for (const file of withBom) console.log('  ' + file);
console.log(stale.length ? `\n残留旧名（${stale.length}）：` : '\n残留旧名：无 ✓');
for (const item of stale) console.log('  ' + item);

// JSON 文件必须能被 JSON.parse —— 这是 Obsidian 读 manifest 的方式
const jsonFiles = [];
(function collect(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (SKIP.test(full)) continue;
		if (entry.isDirectory()) collect(full);
		else if (entry.name.endsWith('.json')) jsonFiles.push(full);
	}
})('.');

const broken = [];
for (const file of jsonFiles) {
	try {
		JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (error) {
		broken.push(`${file}: ${error.message}`);
	}
}
console.log(broken.length ? `\nJSON 解析失败（${broken.length}）：` : '\nJSON 解析：全部正常 ✓');
for (const item of broken) console.log('  ' + item);

if (FIX) console.log('\n已修正。');
