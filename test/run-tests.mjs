/**
 * 测试运行器：用 esbuild 把 test/ 下的测试打包成 ESM 后在本进程内执行。
 * 这样测试无需任何测试框架，也不受 Node 版本对 TypeScript 支持程度的限制。
 *
 * 继承自 js_02（note-tidy）—— 加测试文件后记得登记到下面的 entryPoints。
 */
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const entryPoints = [
	"test/manifest.test.ts",
	"test/exclude.test.ts",
	"test/diff.test.ts",
	"test/bundle.test.ts",
	"test/auto-export.test.ts",
	"test/auto-apply.test.ts",
	"test/drop.test.ts",
	"test/protocol.test.ts",
	"test/settings.test.ts",
	"test/commands.test.ts",
];
const outdir = path.resolve("test/.build");

fs.rmSync(outdir, { recursive: true, force: true });

await esbuild.build({
	entryPoints,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node18",
	outdir,
	outExtension: { ".js": ".mjs" },
	// 源码里的 instanceof / 类继承需要真实的类，这里换成测试替身
	alias: { obsidian: path.resolve("test/obsidian-stub.mjs") },
	logLevel: "warning",
});

for (const entry of entryPoints) {
	const outfile = path.join(outdir, path.basename(entry).replace(/\.ts$/, ".mjs"));
	console.log(`\n──────── ${path.basename(entry)} ────────`);
	// eslint-disable-next-line no-unsanitized/method -- 路径由本文件的 entryPoints 常量拼出，不来自外部输入
	await import(pathToFileURL(outfile).href);
}
