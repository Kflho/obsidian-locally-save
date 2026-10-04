/**
 * 同步包：容器格式 → 导出 → 应用（快速通道 / 降级合并 / 删除判定 / 损坏拒绝）。
 *
 * 这里刻意用**两个临时"仓库"**模拟两台机器：A 导出、B 应用，
 * 把"世代对得上 / 对不上"两条路都走一遍。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeBundlePlan, planBundleApply } from '../src/bundle/apply';
import type { ApplyOptions } from '../src/bundle/apply';
import { exportBundle } from '../src/bundle/export';
import type { ExportOptions } from '../src/bundle/export';
import { readBundleInfo, verifyBundle } from '../src/bundle/format';
import { bundleBaseDir, bundleDirForMode, bundleDirsToScan } from '../src/bundle/paths';
import { DEFAULT_SETTINGS } from '../src/settings/model';
import type { PluginSettings } from '../src/settings/model';
import { loadState } from '../src/sync/state';
import { createLogger } from '../src/utils/log';

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

// -------------------------------------------------------------------- 环境
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lsave-bundle-'));
const A = path.join(ROOT, 'machineA');
const B = path.join(ROOT, 'machineB');
const OUT = path.join(ROOT, 'transfer');
for (const dir of [A, B, OUT]) fs.mkdirSync(dir, { recursive: true });

const abs = (root: string, rel: string) => path.join(root, ...rel.split('/'));

function write(root: string, rel: string, content: string, mtime?: number): void {
	const target = abs(root, rel);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
	if (mtime !== undefined) fs.utimesSync(target, new Date(mtime), new Date(mtime));
}

function read(root: string, rel: string): string | null {
	try {
		return fs.readFileSync(abs(root, rel), 'utf8');
	} catch {
		return null;
	}
}

const exists = (root: string, rel: string) => fs.existsSync(abs(root, rel));

function hasConflictCopy(root: string, relDir: string): boolean {
	const dir = abs(root, relDir);
	if (!fs.existsSync(dir)) return false;
	return fs.readdirSync(dir).some(name => name.includes('冲突副本'));
}

const log = createLogger(() => 'silent');
const settings = (overrides: Partial<PluginSettings> = {}): PluginSettings =>
	({ ...DEFAULT_SETTINGS, ...overrides });

function exportOptions(root: string, stateFile: string, overrides: Partial<PluginSettings> = {}): ExportOptions {
	return {
		settings: settings(overrides),
		log,
		vaultRoot: root,
		vaultName: '我的笔记',
		stateFile,
		outDir: OUT,
	};
}

function applyOptions(root: string, stateFile: string, file: string, overrides: Partial<PluginSettings> = {}): ApplyOptions {
	return { settings: settings(overrides), log, vaultRoot: root, stateFile, file };
}

const STATE_A = path.join(ROOT, 'state-a.json');
const STATE_B = path.join(ROOT, 'state-b.json');

// -------------------------------------------------------------------- 用例
// 1. 导出完整包
write(A, 'notes/a.md', 'AAA');
write(A, 'notes/b.md', 'BBB');
let exported = await exportBundle(exportOptions(A, STATE_A));
checkTrue('导出成功', exported.file !== null, exported.reason ?? '没有导出文件');
const FILE_FULL = exported.file as string;
check('完整包两个文件', exported.entryCount, 2);
check('完整包不带基准世代（免校验）', exported.header?.baseGeneration, null);
check('应用后应达到第 1 代', exported.header?.targetGeneration, 1);

const info = await readBundleInfo(FILE_FULL);
check('容器格式标记', info.header.format, 'locally-save-bundle');
check('包类型', info.header.mode, 'full');
check('包里没有删除清单', info.header.deleted.length, 0);
check('负载校验和一致', await verifyBundle(FILE_FULL, info), true);
check('包文件名带仓库名与模式', path.basename(FILE_FULL).includes('我的笔记-full'), true);

// 2. 应用到 B（模拟另一台机器）
let plan = await planBundleApply(applyOptions(B, STATE_B, FILE_FULL));
check('报告：两个新增', [plan.report.adds, plan.report.overwrites], [2, 0]);
check('完整包不走世代校验', plan.report.sameGeneration, true);
check('B 原本与包完全不一致 → 同步程度 0%', plan.report.syncPercent, 0);
check('应用前 B 里没有文件（plan 只读不写）', exists(B, 'notes/a.md'), false);

let result = await executeBundlePlan(plan, applyOptions(B, STATE_B, FILE_FULL));
check('写入两个文件', result.written, 2);
check('B 的内容正确', read(B, 'notes/a.md'), 'AAA');
check('B 的子目录也建好了', read(B, 'notes/b.md'), 'BBB');

let stateB = await loadState(STATE_B);
check('应用后认祖：血脉跟导出方一致', stateB.lineage, exported.header?.lineage);
check('应用后世代对齐', stateB.generation, exported.header?.targetGeneration);
check('应用后记下了包 ID（用于漏包检测）', stateB.lastBundleId, exported.header?.bundleId);

// 3. A 改一个、删一个 → 导出「仅改动」
write(A, 'notes/a.md', 'AAA-CHANGED');
fs.rmSync(abs(A, 'notes/b.md'));
const changed = await exportBundle(exportOptions(A, STATE_A, { bundleMode: 'changes' }));
checkTrue('增量包导出成功', changed.file !== null, changed.reason ?? '没有导出文件');
const FILE_CHANGES = changed.file as string;
check('增量包只装改动过的文件', changed.entryCount, 1);
check('增量包带上删除清单', changed.deletedCount, 1);
check('增量包记了基准世代', changed.header?.baseGeneration, 1);
check('增量包指向第 2 代', changed.header?.targetGeneration, 2);

const changesInfo = await readBundleInfo(FILE_CHANGES);
check('增量包的文件带了 base（供接收方三方比对）', typeof changesInfo.header.entries[0]?.baseSize, 'number');
check('删除项也带了 base', typeof changesInfo.header.deleted[0]?.baseSize, 'number');

// 4. B 应用增量包：世代对得上 → 快速通道
plan = await planBundleApply(applyOptions(B, STATE_B, FILE_CHANGES));
check('血脉世代一致 → 快速通道', plan.report.mode, 'fast');
check('会覆盖 1 个、删除 1 个', [plan.report.overwrites, plan.report.deletes], [1, 1]);
result = await executeBundlePlan(plan, applyOptions(B, STATE_B, FILE_CHANGES));
check('B 的内容更新', read(B, 'notes/a.md'), 'AAA-CHANGED');
check('B 的删除也跟上了', exists(B, 'notes/b.md'), false);
check('删除进了回收目录', fs.existsSync(path.join(B, '.trash', 'locally-save')), true);

// 5. 漏包：B 没应用第 3 个包，A 又导出了第 4 个 → 降级合并
// （修改时间要拉开：大小相同、又在 2 秒容差内的话，会被当成"没改过"）
const T3 = Date.now();
write(A, 'notes/a.md', 'AAA-V3', T3);
const third = await exportBundle(exportOptions(A, STATE_A, { bundleMode: 'changes' }));
checkTrue('第三个包导出成功（B 故意不应用）', third.file !== null, third.reason ?? '');
write(A, 'notes/a.md', 'AAA-V4', T3 + 60_000);
write(A, 'notes/new.md', 'NEW', T3 + 60_000);
const fourth = await exportBundle(exportOptions(A, STATE_A, { bundleMode: 'changes' }));
checkTrue('第四个包导出成功', fourth.file !== null, fourth.reason ?? '');
checkTrue('同秒内连导两个包不会互相覆盖', third.file !== fourth.file, `都写到了 ${third.file}`);

plan = await planBundleApply(applyOptions(B, STATE_B, fourth.file as string));
check('漏了包 → 不拒绝服务，降级为逐文件合并', plan.report.mode, 'merge');
check('世代差 1（B 落后一代）', plan.report.generationGap, 1);
check('本地也改过的算冲突', plan.report.conflicts, 1);
check('新文件算新增', plan.report.adds, 1);
result = await executeBundlePlan(plan, applyOptions(B, STATE_B, fourth.file as string));
check('冲突的那份占原名', read(B, 'notes/a.md'), 'AAA-V4');
checkTrue('本地那份留成了冲突副本（没被静默覆盖）', hasConflictCopy(B, 'notes'), '没找到冲突副本');
check('新文件写进来了', read(B, 'notes/new.md'), 'NEW');

// 6. 同一个包再打开一次：同步程度 100%
plan = await planBundleApply(applyOptions(B, STATE_B, fourth.file as string));
check('已经应用过的包 → 同步程度 100%', plan.report.syncPercent, 100);
check('全部条目都被跳过', plan.report.skips, 2);

// 7. 损坏的包会被拒绝（U 盘 / 网盘传坏的典型情况）
const broken = path.join(OUT, 'broken.lsave');
fs.copyFileSync(FILE_CHANGES, broken);
const brokenInfo = await readBundleInfo(broken);
const handle = fs.openSync(broken, 'r+');
const byte = Buffer.alloc(1);
fs.readSync(handle, byte, 0, 1, brokenInfo.payloadOffset + 3);
fs.writeSync(handle, Buffer.from([(byte[0] ?? 0) ^ 0xff]), 0, 1, brokenInfo.payloadOffset + 3);
fs.closeSync(handle);
let thrown = '';
try {
	await planBundleApply(applyOptions(B, STATE_B, broken));
} catch (error) {
	thrown = error instanceof Error ? error.message : String(error);
}
checkTrue('损坏的包在计划阶段就被拒绝', thrown.includes('校验失败'), `实际：${thrown}`);

// 8. 完整包 + "删除多余文件"：只删比包旧的
const C = path.join(ROOT, 'machineC');
const STATE_C = path.join(ROOT, 'state-c.json');
fs.mkdirSync(C, { recursive: true });
write(A, 'only.md', 'ONLY');
const full = await exportBundle(exportOptions(A, STATE_A));
checkTrue('再导一个完整包', full.file !== null, full.reason ?? '');
const fullInfo = await readBundleInfo(full.file as string);
write(C, 'notes/a.md', 'AAA-V4'); // 内容与时间都跟包里不一样，但比包旧 → 会被覆盖
write(C, 'old-extra.md', 'OLD', fullInfo.header.created - 86_400_000);
write(C, 'new-extra.md', 'NEW', fullInfo.header.created + 60_000);

plan = await planBundleApply(applyOptions(C, STATE_C, full.file as string, { bundleDeleteMissing: true }));
check('完整包里的文件会新增', plan.report.adds > 0, true);
check('本地多出来的旧文件会被删', plan.report.extraDeletes, 1);
result = await executeBundlePlan(plan, applyOptions(C, STATE_C, full.file as string, { bundleDeleteMissing: true }));
check('比包旧的多余文件被删了', exists(C, 'old-extra.md'), false);
check('比包新的文件不动（那是这边刚写的）', exists(C, 'new-extra.md'), true);

// 9. 没开"删除多余文件"时，一个都不删
const D = path.join(ROOT, 'machineD');
const STATE_D = path.join(ROOT, 'state-d.json');
fs.mkdirSync(D, { recursive: true });
write(D, 'old-extra.md', 'OLD', fullInfo.header.created - 86_400_000);
plan = await planBundleApply(applyOptions(D, STATE_D, full.file as string));
check('没开删除时不多删文件', plan.report.extraDeletes, 0);

// 10. 复用同步扫好的清单：传进去的清单就是准的（自动留包靠它省一次全库遍历）
const E = path.join(ROOT, 'machineE');
const STATE_E = path.join(ROOT, 'state-e.json');
fs.mkdirSync(E, { recursive: true });
write(E, 'notes/a.md', 'AAA');
write(E, 'notes/invisible.md', 'SKIP');
const reused = await exportBundle({
	...exportOptions(E, STATE_E),
	// 故意造一份"没看见 invisible.md"的清单：如果导出真的复用了它，那个文件就不该进包
	inventory: {
		files: new Map([['notes/a.md', { size: 3, mtime: fs.statSync(abs(E, 'notes/a.md')).mtimeMs }]]),
	},
});
check('复用传入的清单：不在清单里的文件不进包', reused.entryCount, 1);
const reusedInfo = await readBundleInfo(reused.file as string);
check('包里只有清单里那一个', reusedInfo.header.entries.map(entry => entry.path), ['notes/a.md']);

// 11. 包目录的解析规则
const base = { ...DEFAULT_SETTINGS, bundleDir: '' };
check(
	'同步包文件夹留空 → 跟着同步目标走',
	bundleBaseDir(base, 'D:/vault-copy'),
	'D:/vault-copy/.lsave/bundles',
);
check(
	'填了同步包文件夹 → 用填的',
	bundleBaseDir({ ...base, bundleDir: 'D:/传输' }, 'D:/vault-copy'),
	'D:/传输',
);
check('目标文件夹也没填 → 空串（调用方要提示去填）', bundleBaseDir(base, ''), '');
check(
	'完整包与改动包分两个目录',
	[bundleDirForMode('D:/x', 'full'), bundleDirForMode('D:/x', 'changes')],
	['D:/x/full', 'D:/x/changes'],
);
check('找包时两个子目录都看（外加根目录，兼容早期直接放根目录的包）', bundleDirsToScan('D:/x').length, 3);
check('没填目录时不去找包', bundleDirsToScan(''), []);

// 12. 导出真的落到了对应的子目录里
const fullInfo2 = await readBundleInfo(FILE_FULL);
check('完整包落在 full 子目录', FILE_FULL.replace(/\\/g, '/').includes('/full/'), true);
check('改动包落在 changes 子目录', FILE_CHANGES.replace(/\\/g, '/').includes('/changes/'), true);
checkTrue('包文件名带上了包 ID 前几位', path.basename(FILE_FULL).endsWith('.lsave'), FILE_FULL);

console.log(`\n共 ${checks} 次检查，失败 ${failures.length} 项`);
for (const message of failures.slice(0, 10)) console.log("\n❌ " + message);
if (failures.length > 10) console.log(`\n…… 其余 ${failures.length - 10} 项失败已省略`);
if (failures.length > 0) process.exitCode = 1;
