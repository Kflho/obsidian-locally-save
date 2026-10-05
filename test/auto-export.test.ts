/**
 * 自动留包这条链路：**不依赖任何"副本"**。
 *
 * 0.8.0 砍掉「同步到本地副本」通道之前，留包是挂在"同步成功之后"的（没有目标文件夹
 * 就一步也跑不了）。现在它自己是一条完整的动作 —— 这个文件就是把那条链路端到端跑一遍。
 *
 * 为什么单独一个文件：它同时要用到**插件装配**（onload / 设置 / 状态栏 / 通知）与
 * **真实磁盘**（仓库目录、包目录）—— 前者在 commands.test.ts，后者在 bundle.test.ts，
 * 这条链路正好横跨两边。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { App, Notice } from 'obsidian';
import type { PluginManifest } from 'obsidian';
import LocallySavePlugin from '../src/main';
import { loadState } from '../src/sync/state';
import { exportBundlesNow } from '../src/ui/actions';

// -------------------------------------------------------------------- 断言
let checks = 0;
const failures: string[] = [];

function checkTrue(name: string, condition: boolean, detail: string): void {
	checks++;
	if (!condition) failures.push(`[断言失败] ${name}\n  ${detail}`);
}

function check(name: string, actual: unknown, expected: unknown): void {
	checks++;
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		failures.push(`[期望不符] ${name}\n  期望 ${JSON.stringify(expected)}\n  实际 ${JSON.stringify(actual)}`);
	}
}

// -------------------------------------------------------------------- 环境
const noticeLog = (Notice as unknown as { messages: string[] }).messages;

const MANIFEST = {
	id: 'locally-save',
	name: 'Locally Save',
	version: '0.1.0',
	minAppVersion: '1.7.0',
	description: 'test',
	author: 'test',
	dir: '.obsidian/plugins/locally-save',
} as PluginManifest;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lsave-auto-'));
const VAULT = path.join(ROOT, 'vault');
const OUT = path.join(ROOT, 'out');
fs.mkdirSync(path.join(VAULT, 'notes'), { recursive: true });
fs.writeFileSync(path.join(VAULT, 'notes', 'a.md'), 'AAA');

/** 造一个插件：仓库根指向临时目录（真实插件拿的是 FileSystemAdapter 的 basePath） */
function createPlugin(data: unknown): LocallySavePlugin {
	const plugin = new LocallySavePlugin(new App(), MANIFEST);
	(plugin as unknown as { stubData: unknown }).stubData = data;
	(plugin.app.vault.adapter as unknown as { basePath: string }).basePath = VAULT;
	return plugin;
}

/** 某个子目录里的 .lsave 文件（导出落盘的结果就看它） */
function bundleFiles(sub: string): string[] {
	try {
		return fs.readdirSync(path.join(OUT, sub)).filter(name => name.endsWith('.lsave')).sort();
	} catch {
		return [];
	}
}

/** 状态栏那一格现在写着什么 */
function barText(plugin: LocallySavePlugin): string {
	const items = (plugin as unknown as { statusBarItems: { text: string }[] }).statusBarItems;
	return items[0]?.text ?? '';
}

// -------------------------------------------------------------------- 用例
// 1. 只开「留更新包」、包目录也填了，但还没导过完整副本：
//    如实说清原因，不写空包、不抛异常（以前这一步根本没有入口）
noticeLog.length = 0;
const plugin = createPlugin({ logLevel: 'silent', autoExportChanges: true, bundleDir: OUT });
await plugin.onload();
await exportBundlesNow(plugin);
checkTrue('没立过基准时说清"先导完整副本"', noticeLog.some(m => m.includes('完整副本')), noticeLog.join(' / '));
check('这时候不该写出任何包', bundleFiles('changes'), []);

// 2. 打开「留完整包」：不需要任何"副本"设置就能把包写出来
plugin.settings.autoExportFull = true;
noticeLog.length = 0;
await exportBundlesNow(plugin);
check('完整包写出来了', bundleFiles('full').length, 1);
checkTrue('通知说清留了什么', noticeLog.some(m => m.includes('已留完整副本')), noticeLog.join(' / '));

const stateAfterFull = await loadState(plugin.stateFile());
check('状态文件里记了一笔（更新记录）', stateAfterFull.bundleLog.length, 1);
check('基准也跟着立起来了', stateAfterFull.bundle?.fullFiles !== null, true);
checkTrue('状态栏换成"上次留包"', barText(plugin).includes('上次留包'), barText(plugin));

// 3. 一点改动都没有：**一个包都不写**（完整包一写就是整库重写），只如实说一句
const fullBefore = bundleFiles('full');
noticeLog.length = 0;
await exportBundlesNow(plugin);
check('没有改动 → 没多出包', bundleFiles('full'), fullBefore);
checkTrue('并且如实说一句"没有变化"', noticeLog.some(m => m.includes('没有变化')), noticeLog.join(' / '));

// 3b. 自动触发是"安静"的：没有变化这种正常结果只在状态栏与日志里说，不弹通知
//     （否则每 5 分钟的定时留包都会在眼前闪一条）
noticeLog.length = 0;
await exportBundlesNow(plugin, '定时留包', { quiet: true });
check('自动触发 + 没有变化 → 不弹通知', noticeLog.length, 0);
checkTrue('状态栏照样写着上次的结果', barText(plugin).includes('上次留包'), barText(plugin));

// 4. 改一个文件（内容长度也变，免得落在 2 秒容差里被当成没动过）→ 留更新包
plugin.settings.autoExportFull = false;
fs.writeFileSync(path.join(VAULT, 'notes', 'a.md'), 'AAAA 改过了');
noticeLog.length = 0;
await exportBundlesNow(plugin);
check('更新包写出来了', bundleFiles('changes').length, 1);
checkTrue('通知说清留的是更新包', noticeLog.some(m => m.includes('已留更新包')), noticeLog.join(' / '));

// 5. 全程没有出现"目标文件夹"这类设置：字段本身已经随副本通道删掉了
checkTrue(
	'设置里已经没有 targetDir 这个字段',
	!('targetDir' in (plugin.settings as unknown as Record<string, unknown>)),
	Object.keys(plugin.settings).join(', '),
);

console.log(`\n共 ${checks} 次检查，失败 ${failures.length} 项`);
for (const message of failures.slice(0, 10)) console.log("\n❌ " + message);
if (failures.length > 10) console.log(`\n…… 其余 ${failures.length - 10} 项失败已省略`);
if (failures.length > 0) process.exitCode = 1;
