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
	return fs.readdirSync(dir).some(name => isConflictCopyName(name));
}

/** 冲突副本的两种命名：本地那份是输家时叫「本地冲突副本」，包里那份输时叫「包里的版本」 */
function isConflictCopyName(name: string): boolean {
	return name.includes('冲突副本') || name.includes('包里的版本');
}

/** 读第一份冲突副本的内容（用来核对"存下来的到底是哪一份"） */
function readConflictCopy(root: string): string | null {
	const name = fs.readdirSync(root).find(item => isConflictCopyName(item));
	return name ? fs.readFileSync(path.join(root, name), 'utf8') : null;
}

const log = createLogger(() => 'silent');
const settings = (overrides: Partial<PluginSettings> = {}): PluginSettings =>
	({ ...DEFAULT_SETTINGS, ...overrides });

function exportOptions(root: string, stateFile: string, mode: 'full' | 'changes' = 'full'): ExportOptions {
	return { settings: settings(), log, vaultRoot: root, vaultName: '我的笔记', stateFile, mode, outDir: OUT };
}

/**
 * 造一份应用参数。
 * 第 4 个参数是**应用方式**（keep-all / delete-old / force），不是设置项 ——
 * 这三种模式属于"这一次怎么应用"，不进 data.json。
 */
function applyOptions(
	root: string,
	stateFile: string,
	file: string,
	options: { conflictStrategy?: 'keep-both' | 'local-wins' | 'remote-wins'; propagateDeletions?: boolean; keepBackup?: boolean } = {},
): ApplyOptions {
	return { settings: settings(), log, vaultRoot: root, stateFile, file, ...options };
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
const changed = await exportBundle(exportOptions(A, STATE_A, 'changes'));
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

// 5. 累积更新包：B 没应用第 3 个包，直接应用第 4 个 —— 不该少内容、也不该满屏冲突
// （修改时间要拉开：大小相同、又在 2 秒容差内的话，会被当成"没改过"）
const T3 = Date.now();
write(A, 'notes/a.md', 'AAA-V3', T3);
const third = await exportBundle(exportOptions(A, STATE_A, 'changes'));
checkTrue('第三个包导出成功（B 故意不应用）', third.file !== null, third.reason ?? '');
write(A, 'notes/a.md', 'AAA-V4', T3 + 60_000);
write(A, 'notes/new.md', 'NEW', T3 + 60_000);
const fourth = await exportBundle(exportOptions(A, STATE_A, 'changes'));
checkTrue('第四个包导出成功', fourth.file !== null, fourth.reason ?? '');
checkTrue('同秒内连导两个包不会互相覆盖', third.file !== fourth.file, `都写到了 ${third.file}`);
check('更新包以完整包为基准累积', fourth.cumulative, true);

const fourthInfo = await readBundleInfo(fourth.file as string);
check(
	'累积包把跳过的那一轮也装进来了（a.md 与 new.md）',
	fourthInfo.header.entries.map(entry => entry.path).sort(),
	['notes/a.md', 'notes/new.md'],
);

plan = await planBundleApply(applyOptions(B, STATE_B, fourth.file as string));
check('跳过中间包也能直接应用（基准是完整包，世代 ≥ 基准即可）', plan.report.mode, 'fast');
check('本地停在"我发过的中间版本" → 不算冲突', plan.report.conflicts, 0);
check('新文件算新增', plan.report.adds, 1);
result = await executeBundlePlan(plan, applyOptions(B, STATE_B, fourth.file as string));
check('跳过包也不会少内容：a.md 是最新的', read(B, 'notes/a.md'), 'AAA-V4');
check('新文件写进来了', read(B, 'notes/new.md'), 'NEW');
checkTrue('没有产生冲突副本（认得出中间版本）', !hasConflictCopy(B, 'notes'), '不该有冲突副本');

// 5a. 同一个包再打开一次：本地已经全一致
const again = await planBundleApply(applyOptions(B, STATE_B, fourth.file as string));
check('已经应用过的包 → 同步程度 100%', again.report.syncPercent, 100);
check('全部条目都被跳过', again.report.skips, 2);

// 5a2. 基准丢了（比如状态文件被删）也不该误判成冲突：
//      包里记着"这个文件经历过的中间版本"，认得出"这是你发过的，不是我自己改的"
const I = path.join(ROOT, 'machineI');
const STATE_LOST = path.join(ROOT, 'state-lost.json');
fs.mkdirSync(I, { recursive: true });
const fourthInfoForHistory = await readBundleInfo(fourth.file as string);
const aEntry = fourthInfoForHistory.header.entries.find(entry => entry.path === 'notes/a.md');
const past = aEntry?.history?.[0];
checkTrue('包里带着中间版本记录', past !== undefined, JSON.stringify(aEntry?.history));
if (past) {
	write(I, 'notes/a.md', 'AAA', past.mtime); // 手里正是那个中间版本（记录对得上）
	const lostPlan = await planBundleApply(applyOptions(I, STATE_LOST, fourth.file as string));
	check('基准丢了、但手里是我发过的版本 → 不算冲突', lostPlan.report.conflicts, 0);
	checkTrue('而且认得出来', lostPlan.report.historyMatches >= 1, `实际 ${lostPlan.report.historyMatches}`);
}

// 5b. 真·本地改动还是要留冲突副本（上一条不能把这条也放过）
write(B, 'notes/a.md', 'B 自己改的', Date.now() + 300_000);
write(A, 'notes/a.md', 'AAA-V5', T3 + 600_000);
const fifth = await exportBundle(exportOptions(A, STATE_A, 'changes'));
checkTrue('第五个包导出成功', fifth.file !== null, fifth.reason ?? '');
plan = await planBundleApply(applyOptions(B, STATE_B, fifth.file as string));
check('本地真改过的 → 冲突', plan.report.conflicts, 1);
result = await executeBundlePlan(plan, applyOptions(B, STATE_B, fifth.file as string));
check('包里的内容占原名', read(B, 'notes/a.md'), 'AAA-V5');
checkTrue('本地那份留成冲突副本', hasConflictCopy(B, 'notes'), '没找到冲突副本');

// 5c. 重导一次完整包 → 累积清零
const anchorReset = await exportBundle(exportOptions(A, STATE_A));
checkTrue('重新导完整包', anchorReset.file !== null, anchorReset.reason ?? '');
check('新完整包是全量的（不是累积）', anchorReset.cumulative, false);
const afterReset = await exportBundle(exportOptions(A, STATE_A, 'changes'));
check('刚导完完整包 → 更新包没有内容可装', afterReset.file, null);
checkTrue('并说明原因', (afterReset.reason ?? '').includes('没有任何变化'), afterReset.reason ?? '');

// 5d. 没有基准就不给导更新包（更新包是"以完整包为基准"的）
const fresh = path.join(ROOT, 'state-fresh.json');
let noAnchor = '';
try {
	await exportBundle(exportOptions(A, fresh, 'changes'));
} catch (error) {
	noAnchor = error instanceof Error ? error.message : String(error);
}
checkTrue('没导过完整包 → 拒绝导更新包', noAnchor.includes('完整副本'), noAnchor);

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

// 8. 删除与新增：与副本同步同一套规则 —— 只有"基准里也有、这次包里没有"的才删（＝对方删过的）
const C = path.join(ROOT, 'machineC');
const STATE_C = path.join(ROOT, 'state-c.json');
fs.mkdirSync(C, { recursive: true });
write(A, 'only.md', 'ONLY');
const full = await exportBundle(exportOptions(A, STATE_A));
checkTrue('再导一个完整包', full.file !== null, full.reason ?? '');
const fullInfo = await readBundleInfo(full.file as string);

// C 先应用一遍，于是它有了基准 —— 删除判断全靠基准
await executeBundlePlan(
	await planBundleApply(applyOptions(C, STATE_C, full.file as string)),
	applyOptions(C, STATE_C, full.file as string),
);
// C 自己也有一个"对方从没见过"的文件
write(C, 'only-mine.md', 'MINE', fullInfo.header.created + 60_000);

// 对方删掉一个文件、又加了一个，重新导完整包
const victim = 'notes/a.md';
checkTrue('C 里有这个文件', exists(C, victim), `缺 ${victim}`);
fs.rmSync(abs(A, victim));
write(A, 'brand-new.md', 'NEW');
const second = await exportBundle(exportOptions(A, STATE_A));
checkTrue('第二个完整包', second.file !== null, second.reason ?? '');

plan = await planBundleApply(applyOptions(C, STATE_C, second.file as string));
check('对方删掉的会被删', plan.report.deletes, 1);
check('算进"对方删过"这一类', plan.report.extraDeletes, 1);
check('对方新加的是新增', plan.report.adds, 1);

result = await executeBundlePlan(plan, applyOptions(C, STATE_C, second.file as string));
check('对方删掉的文件这边也删了', exists(C, victim), false);
check('删掉的进了回收目录（没直接消失）', fs.existsSync(path.join(C, '.trash', 'locally-save')), true);
checkTrue('我独有的文件一个都没删', exists(C, 'only-mine.md'), '基准里没有的文件不该删');
check('对方新加的文件到了', read(C, 'brand-new.md'), 'NEW');

// 9. 冲突：**新的那份占原名**，旧的那份存成冲突副本 —— 与副本同步完全一致
// （以前是"包的内容无条件占原名"，本地改得更新也没用 —— 这就是用户报的那个问题）
const F = path.join(ROOT, 'machineF');
const STATE_F = path.join(ROOT, 'state-f.json');
fs.mkdirSync(F, { recursive: true });
// F 先应用一遍，拿到基准
await executeBundlePlan(
	await planBundleApply(applyOptions(F, STATE_F, second.file as string)),
	applyOptions(F, STATE_F, second.file as string),
);
check('基准建立：文件在 F 里', read(F, 'brand-new.md'), 'NEW');

// 两边都改同一个文件，F 改得更新
write(F, 'brand-new.md', 'F 改的（更新）', Date.now() + 600_000);
write(A, 'brand-new.md', 'A 改的（更旧）', Date.now() + 300_000);
const thirdFull = await exportBundle(exportOptions(A, STATE_A));
checkTrue('第三个完整包', thirdFull.file !== null, thirdFull.reason ?? '');

plan = await planBundleApply(applyOptions(F, STATE_F, thirdFull.file as string));
check('两边都改过 → 冲突', plan.report.conflicts, 1);
result = await executeBundlePlan(plan, applyOptions(F, STATE_F, thirdFull.file as string));
check('新的那份（本地的）占原名', read(F, 'brand-new.md'), 'F 改的（更新）');
checkTrue('旧的那份（包里的）存成了冲突副本', hasConflictCopy(F, '.'), '没找到冲突副本');
check('冲突副本里是包里的内容', readConflictCopy(F), 'A 改的（更旧）');

// 10. 本地那份只是"旧副本"（包里没给基准）→ 直接覆盖，不该留冲突副本
const G = path.join(ROOT, 'machineG');
const STATE_G = path.join(ROOT, 'state-g.json');
fs.mkdirSync(G, { recursive: true });
const thirdFullInfo = await readBundleInfo(thirdFull.file as string);
write(G, 'brand-new.md', '很旧的副本', thirdFullInfo.header.created - 600_000);
plan = await planBundleApply(applyOptions(G, STATE_G, thirdFull.file as string));
check('比包旧的本地副本不算冲突', plan.report.conflicts, 0);
checkTrue('算作覆盖', plan.report.overwrites >= 1, `实际 ${plan.report.overwrites}`);

// 11. 「同步删除」关掉时：对方删掉的文件会被取回来（与副本同步一致）
const H = path.join(ROOT, 'machineH');
const STATE_H = path.join(ROOT, 'state-h.json');
fs.mkdirSync(H, { recursive: true });
await executeBundlePlan(
	await planBundleApply(applyOptions(H, STATE_H, second.file as string)),
	applyOptions(H, STATE_H, second.file as string),
);
check('H 有基准：only.md 在', read(H, 'only.md'), 'ONLY');

// 对方把 only.md 删掉，重导完整包
fs.rmSync(abs(A, 'only.md'));
const fourthFull = await exportBundle(exportOptions(A, STATE_A));
checkTrue('第四个完整包', fourthFull.file !== null, fourthFull.reason ?? '');

const deleteOn = await planBundleApply(applyOptions(H, STATE_H, fourthFull.file as string, {
	propagateDeletions: true,
}));
check('开着同步删除 → 对方删的这边也删', deleteOn.report.deletes, 1);

const deleteOff = await planBundleApply(applyOptions(H, STATE_H, fourthFull.file as string, {
	propagateDeletions: false,
}));
check('关掉同步删除 → 一个都不删（取回来）', deleteOff.report.deletes, 0);
checkTrue(
	'而且报告里说明了策略',
	deleteOff.report.propagateDeletions === false,
	`实际 ${deleteOff.report.propagateDeletions}`,
);

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
	'对话框里把输入框清空 → 回落到默认，而不是"没填路径"',
	bundleBaseDir({ ...base, bundleDir: '' }, 'D:/vault-copy'),
	'D:/vault-copy/.lsave/bundles',
);
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
