/**
 * 同步包：容器格式 → 导出 → 应用（快速通道 / 降级合并 / 删除判定 / 损坏拒绝）。
 *
 * 这里刻意用**两个临时"仓库"**模拟两台机器：A 导出、B 应用，
 * 把"世代对得上 / 对不上"两条路都走一遍。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeBundlePlan, planBundleApply, APPLY_CHOICES, findApplyChoice } from '../src/bundle/apply';
import type { ApplyOptions, ApplyPlan, ApplyStrictness } from '../src/bundle/apply';
import { baselineOfBundle, listingHash } from '../src/bundle/baseline';
import { appendBundleLog, BUNDLE_LOG_LIMIT, describeBundlePosition, describeLogEntry } from '../src/bundle/log';
import type { BundleLogEntry } from '../src/sync/state';
import { exportBundle, plannedExportModes } from '../src/bundle/export';
import type { ExportOptions, ExportOutcome } from '../src/bundle/export';
import { BUNDLE_FORMAT, BUNDLE_VERSION, readBundleInfo, verifyBundle, writeBundle } from '../src/bundle/format';
import { bundleBaseDir, bundleDirForMode, bundleDirsToScan } from '../src/bundle/paths';
import {
	bundleTrashRoot,
	deleteBundles,
	emptyBundleTrash,
	groupBundles,
	listBundles,
	readBundleTrash,
	trashBundles,
} from '../src/bundle/manage';
import type { ManagedBundle } from '../src/bundle/manage';
import { advanceWarnThreshold, parseSizeLimit, shouldOfferReset, warnThreshold } from '../src/bundle/size-warn';
import { DEFAULT_SETTINGS } from '../src/settings/model';
import type { PluginSettings } from '../src/settings/model';
import { scanTree } from '../src/sync/disk';
import { loadState, saveState } from '../src/sync/state';
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

/** 冲突输的那一份会不会留在原地（现在应该都不留了） */
function hasConflictCopy(root: string, relDir: string): boolean {
	const dir = abs(root, relDir);
	if (!fs.existsSync(dir)) return false;
	return fs.readdirSync(dir).some(name => name.includes('冲突') || name.includes('包里的版本'));
}

/** 从回收目录里读冲突输掉的那一份（不留在仓库里，所以要去 .trash 找） */
function readConflictCopy(root: string): string | null {
	const trash = path.join(root, '.trash', 'locally-save');
	if (!fs.existsSync(trash)) return null;
	const walk = (dir: string): string | null => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const next = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				const found = walk(next);
				if (found !== null) return found;
				continue;
			}
			return fs.readFileSync(next, 'utf8');
		}
		return null;
	};
	return walk(trash);
}

/**
 * 在回收目录里找**某个文件**的所有备份内容（时间戳那层目录名是执行时才知道的）。
 * 比 readConflictCopy 精确：一次应用里可能挪进去好几个文件 —— 按文件名收全。
 */
function findBackups(root: string, rel: string): string[] {
	const base = path.join(root, '.trash', 'locally-save');
	const wanted = rel.split('/').pop() as string;
	const out: string[] = [];
	const walk = (dir: string): void => {
		if (!fs.existsSync(dir)) return;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const next = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(next);
				continue;
			}
			if (entry.name === wanted) out.push(fs.readFileSync(next, 'utf8'));
		}
	};
	walk(base);
	return out;
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
	options: {
		conflictStrategy?: 'keep-both' | 'local-wins' | 'remote-wins';
		propagateDeletions?: boolean;
		keepBackup?: boolean;
		strictness?: ApplyStrictness;
		skipDeletions?: boolean;
	} = {},
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
// 留一份**稳定副本**：后面每导一个新更新包，都会把被它取代的旧包清掉（功能本身如此），
// 这些用例要用的是"那一份包"，不是"那个路径上现在还剩什么"
const KEPT_CHANGES = path.join(OUT, 'kept-changes.lsave');
fs.copyFileSync(FILE_CHANGES, KEPT_CHANGES);
check('增量包只装改动过的文件', changed.entryCount, 1);
check('增量包带上删除清单', changed.deletedCount, 1);
check('增量包记了基准世代', changed.header?.baseGeneration, 1);
check('增量包指向第 2 代', changed.header?.targetGeneration, 2);

const changesInfo = await readBundleInfo(KEPT_CHANGES);
check('增量包的文件带了 base（供接收方三方比对）', typeof changesInfo.header.entries[0]?.baseSize, 'number');
check('删除项也带了 base', typeof changesInfo.header.deleted[0]?.baseSize, 'number');

// 4. B 应用增量包：世代对得上 → 快速通道
plan = await planBundleApply(applyOptions(B, STATE_B, KEPT_CHANGES));
check('血脉世代一致 → 快速通道', plan.report.mode, 'fast');
check('会覆盖 1 个、删除 1 个', [plan.report.overwrites, plan.report.deletes], [1, 1]);
result = await executeBundlePlan(plan, applyOptions(B, STATE_B, KEPT_CHANGES));
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
checkTrue('本地那份挪走了（不留在原地）', !hasConflictCopy(B, 'notes'), '原地不该有冲突副本');
checkTrue('挪进了回收目录的「冲突」文件夹', hasConflictCopy(B, '.trash/locally-save'), '没找到');

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
fs.copyFileSync(KEPT_CHANGES, broken);
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
checkTrue('仓库里**不再**留下冲突副本', !hasConflictCopy(F, '.'), '留在原地的副本会跟着同步传出去');
checkTrue(
	'输的那份进了回收目录的「冲突」文件夹',
	hasConflictCopy(F, '.trash/locally-save'),
	'没找到冲突文件夹',
);
check('回收目录里存的是包里的内容', readConflictCopy(F), 'A 改的（更旧）');

// 10. 本地那份只是"旧副本"（包里没给基准）→ 直接覆盖，不该留冲突副本
const G = path.join(ROOT, 'machineG');
const STATE_G = path.join(ROOT, 'state-g.json');
fs.mkdirSync(G, { recursive: true });
const thirdFullInfo = await readBundleInfo(thirdFull.file as string);
write(G, 'brand-new.md', '很旧的副本', thirdFullInfo.header.created - 600_000);
plan = await planBundleApply(applyOptions(G, STATE_G, thirdFull.file as string));
check('比包旧的本地副本不算冲突', plan.report.conflicts, 0);
checkTrue('算作覆盖', plan.report.overwrites >= 1, `实际 ${plan.report.overwrites}`);

// 12. 应用两次同一个包：我独有的文件**不该**在第二次被删
// （基准只能记"两边上次一致的样子"，把我独有的文件记进去的话，第二次就会被当成"对方删过它"）
const J = path.join(ROOT, 'machineJ');
const STATE_J = path.join(ROOT, 'state-j.json');
fs.mkdirSync(J, { recursive: true });
write(J, 'only-mine-2.md', 'MINE'); // 应用**之前**就在，且包里没有它
await executeBundlePlan(
	await planBundleApply(applyOptions(J, STATE_J, second.file as string)),
	applyOptions(J, STATE_J, second.file as string),
);
checkTrue('第一次应用后它还在', exists(J, 'only-mine-2.md'), '不该在第一次就被删');

const appliedAgain = await planBundleApply(applyOptions(J, STATE_J, second.file as string));
check('第二次应用也不会删它（基准里没记它）', appliedAgain.report.deletes, 0);
await executeBundlePlan(appliedAgain, applyOptions(J, STATE_J, second.file as string));
checkTrue('第二次应用后它依然在', exists(J, 'only-mine-2.md'), '被当成"对方删过它"删掉了');

// 13. 强硬程度三档：默认 / 以包为准 / 完全镜像
//     场景：对方做过"颠覆性改动"（大删大改），这台机器要跟包一模一样
//     （下面会从 A 删掉 notes/new.md，test 11 还要用到它，所以用完再加回来）
write(A, 'notes/new.md', 'NEW');
const L = path.join(ROOT, 'machineL');
const STATE_L = path.join(ROOT, 'state-l.json');
fs.mkdirSync(L, { recursive: true });
// 先应用 second（里面有 only.md），再把 only.md 改掉 —— 造出"对方删了、我改了"
await executeBundlePlan(
	await planBundleApply(applyOptions(L, STATE_L, second.file as string)),
	applyOptions(L, STATE_L, second.file as string),
);
checkTrue('L 里有 notes/new.md', exists(L, 'notes/new.md'), '');
write(L, 'notes/new.md', '我改过它', Date.now() + 900_000);
write(L, 'mine-new.md', '本机新建的');

const hasDelete = (p: ApplyPlan, path: string) =>
	p.actions.some(action => action.kind === 'delete' && action.path === path);

// 对方把 notes/new.md 删掉，重导一个完整包（这个包里没有它）
fs.rmSync(abs(A, 'notes/new.md'));
const noNew = await exportBundle(exportOptions(A, STATE_A));
checkTrue('导出"没有 notes/new.md"的完整包', noNew.file !== null, noNew.reason ?? '');

const normalPlan = await planBundleApply(applyOptions(L, STATE_L, noNew.file as string, { strictness: 'normal' }));
const winsPlan = await planBundleApply(applyOptions(L, STATE_L, noNew.file as string, { strictness: 'bundle-wins' }));
const mirrorPlan = await planBundleApply(applyOptions(L, STATE_L, noNew.file as string, { strictness: 'mirror' }));

check('默认：我改过的、对方删了的 → 保留', hasDelete(normalPlan, 'notes/new.md'), false);
check('以包为准：删掉它', hasDelete(winsPlan, 'notes/new.md'), true);
check('默认：本机新建的保留', hasDelete(normalPlan, 'mine-new.md'), false);
check('以包为准：本机新建的也保留（它不属于"对方删过"）', hasDelete(winsPlan, 'mine-new.md'), false);
check('完全镜像：连本机新建的也删', hasDelete(mirrorPlan, 'mine-new.md'), true);
check('镜像档删得最多', mirrorPlan.report.deletes > winsPlan.report.deletes, true);

// 镜像档执行：仓库该与包一致（参与同步的那部分）
await executeBundlePlan(mirrorPlan, applyOptions(L, STATE_L, noNew.file as string, { strictness: 'mirror' }));
checkTrue('执行后：我改过的、对方删了的没了', !exists(L, 'notes/new.md'), '');
checkTrue('执行后：本机新建的也没了', !exists(L, 'mine-new.md'), '');
check('执行后：包里别的文件都在', read(L, 'brand-new.md'), 'A 改的（更旧）');
checkTrue(
	'被删的两份都进了回收目录（没真消失）',
	fs.existsSync(path.join(L, '.trash', 'locally-save')),
	'',
);
//（「同步删除」关掉时则取回来；与副本同步一致。12b 那个"我独有的"是另一回事，见 test 12）
// 11. 删除传播：两边都见过、对方又删了的文件 → 第一次就该跟着删
//（「同步删除」关掉时则取回来，与副本同步一致。test 13 删过 notes/new.md，这里先加回来）
write(A, 'notes/new.md', 'NEW');
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
		dirs: new Set(['notes']),
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

// 14. 边界：本地同路径是个**文件夹**，包里是个文件
const M = path.join(ROOT, 'machineM');
const STATE_M = path.join(ROOT, 'state-m.json');
fs.mkdirSync(M, { recursive: true });
const clash = 'brand-new.md';
fs.mkdirSync(abs(M, clash), { recursive: true });
fs.writeFileSync(path.join(abs(M, clash), 'inside.txt'), 'x');

const clashNormal = await planBundleApply(applyOptions(M, STATE_M, noNew.file as string));
const clashNormalResult = await executeBundlePlan(clashNormal, applyOptions(M, STATE_M, noNew.file as string));
checkTrue('默认档：目录挡路 → 记成失败而不是静默', clashNormalResult.failed.length >= 1, '没记失败');
checkTrue(
	'默认档：失败原因说得清',
	(clashNormalResult.failed[0]?.error ?? '').includes('文件夹'),
	clashNormalResult.failed[0]?.error ?? '',
);
checkTrue(
	'默认档：不会去动别人的文件夹',
	fs.existsSync(path.join(abs(M, clash), 'inside.txt')),
	'文件夹被动了',
);

const clashForce = await planBundleApply(applyOptions(M, STATE_M, noNew.file as string, { strictness: 'bundle-wins' }));
const clashForceResult = await executeBundlePlan(
	clashForce,
	applyOptions(M, STATE_M, noNew.file as string, { strictness: 'bundle-wins' }),
);
check('强制档：没有失败', clashForceResult.failed.length, 0);
checkTrue('强制档：文件就位（原来的文件夹被挪走了）', !fs.statSync(abs(M, clash)).isDirectory(), '还是目录');

// 15. 强制档必然先备份 —— 不给"不可恢复的批量删除"留口子
const N = path.join(ROOT, 'machineN');
const STATE_N = path.join(ROOT, 'state-n.json');
fs.mkdirSync(N, { recursive: true });
write(N, 'mine-keep.md', 'MINE');
const strictPlan = await planBundleApply(applyOptions(N, STATE_N, noNew.file as string, {
	strictness: 'mirror',
	keepBackup: false, // 用户想把回收目录关掉
}));
check('强制档下回收目录强制开', strictPlan.options.keepBackup, true);
check('默认档下照样听用户的', (await planBundleApply(applyOptions(N, STATE_N, noNew.file as string, {
	keepBackup: false,
}))).options.keepBackup, false);

// 16. 并发应用会被拦住（同步那边有串行锁，这边以前没有）
const P = path.join(ROOT, 'machineP');
const STATE_P = path.join(ROOT, 'state-p.json');
fs.mkdirSync(P, { recursive: true });
const concurrentPlan = await planBundleApply(applyOptions(P, STATE_P, noNew.file as string));
const running = executeBundlePlan(concurrentPlan, applyOptions(P, STATE_P, noNew.file as string));
let lockError = '';
try {
	await executeBundlePlan(concurrentPlan, applyOptions(P, STATE_P, noNew.file as string));
} catch (error) {
	lockError = error instanceof Error ? error.message : String(error);
}
await running;
checkTrue('第二次应用被拦住', lockError.includes('还在进行中'), lockError || '（没拦住）');

// 17. 空文件夹也要能过包传过去（只带文件的话，对面的空目录永远建不出来）
const Q = path.join(ROOT, 'machineQ');
const R = path.join(ROOT, 'machineR');
const STATE_Q = path.join(ROOT, 'state-q.json');
const STATE_R = path.join(ROOT, 'state-r.json');
fs.mkdirSync(Q, { recursive: true });
fs.mkdirSync(R, { recursive: true });
write(Q, 'notes/keep.md', 'KEEP');
fs.mkdirSync(abs(Q, '空目录/更深一层'), { recursive: true });
fs.mkdirSync(abs(Q, 'notes/子目录'), { recursive: true });

const qExport = await exportBundle(exportOptions(Q, STATE_Q));
checkTrue('有空文件夹也照样导得出来', qExport.file !== null, qExport.reason ?? '没有导出文件');
const qInfo = await readBundleInfo(qExport.file as string);
check('包里记下了空文件夹（含嵌套的）', qInfo.header.emptyDirs, ['notes/子目录', '空目录', '空目录/更深一层']);
check('有文件的目录不算「空文件夹」', (qInfo.header.emptyDirs ?? []).includes('notes'), false);

const R_FILE = qExport.file as string;
const qPlan = await planBundleApply(applyOptions(R, STATE_R, R_FILE));
check(
	'报告里说清了文件夹的情况（包里几个 / 要补建几个）',
	[qPlan.report.bundleDirCount, qPlan.report.bundle.emptyDirCount, qPlan.report.foldersToCreate],
	[4, 3, 4],
);
check('建文件夹不算文件条目', qPlan.report.adds, 1);
const qResult = await executeBundlePlan(qPlan, applyOptions(R, STATE_R, R_FILE));
check(
	'应用后空文件夹都在',
	[exists(R, '空目录'), exists(R, '空目录/更深一层'), exists(R, 'notes/子目录')],
	[true, true, true],
);
check('结果里记了建了几个目录', qResult.foldersCreated, 3);
check('应用过一次之后再打开这个包：不需要再补建', (await planBundleApply(
	applyOptions(R, STATE_R, R_FILE),
)).report.foldersToCreate, 0);

// 18. 空文件夹的位置上杵着个同名文件 → 如实报出来，不硬来
const S = path.join(ROOT, 'machineS');
const STATE_S = path.join(ROOT, 'state-s.json');
fs.mkdirSync(S, { recursive: true });
write(S, '空目录', 'I AM A FILE');
const sPlan = await planBundleApply(applyOptions(S, STATE_S, R_FILE));
const sResult = await executeBundlePlan(sPlan, applyOptions(S, STATE_S, R_FILE));
checkTrue(
	'同名文件挡路 → 记成失败（而不是把它删掉腾位置）',
	sResult.failed.some(item => item.error.includes('同名文件')),
	JSON.stringify(sResult.failed),
);
check('那个文件原样还在', read(S, '空目录'), 'I AM A FILE');
check('能建的目录照样建', exists(S, 'notes/子目录'), true);

// 19. 强制应用能不能让**文件夹**也完全一致？
// 造一台机器：先应用一次包拿到基准，再故意多出两个本地空目录 ——
// 一个"本机新建的"（基准里没有），一个"上一版包里有过、对方删了"（基准里有）。
const T2 = path.join(ROOT, 'machineT');
const STATE_T2 = path.join(ROOT, 'state-t.json');
fs.mkdirSync(T2, { recursive: true });
const t2First = await planBundleApply(applyOptions(T2, STATE_T2, R_FILE));
await executeBundlePlan(t2First, applyOptions(T2, STATE_T2, R_FILE));
fs.mkdirSync(abs(T2, '本机新建的'), { recursive: true });

const seeded = await loadState(STATE_T2);
seeded.bundle = {
	...seeded.bundle!,
	dirs: [...(seeded.bundle?.dirs ?? []), '对方删过的目录'],
};
await saveState(STATE_T2, seeded);
fs.mkdirSync(abs(T2, '对方删过的目录'), { recursive: true });

/** 仓库里的目录清单（跳过 .trash 这类点开头的） */
function listDirs(root: string): string[] {
	const found: string[] = [];
	const walk = (rel: string) => {
		for (const entry of fs.readdirSync(abs(root, rel), { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
			const next = rel ? `${rel}/${entry.name}` : entry.name;
			found.push(next);
			walk(next);
		}
	};
	walk('');
	return found.sort();
}

const bundleDirs = new Set<string>(qInfo.header.emptyDirs ?? []);
for (const entry of qInfo.header.entries) {
	const parts = entry.path.split('/');
	for (let i = 1; i < parts.length; i++) bundleDirs.add(parts.slice(0, i).join('/'));
}

// 默认档：只删"对方删过的"（基准里有、包里没有），本机新建的一律留着
const t2Normal = await planBundleApply(applyOptions(T2, STATE_T2, R_FILE));
check('默认档：只删基准里记过的那个', t2Normal.foldersToRemove, ['对方删过的目录']);
check('默认档：报告里也写了要删几个', t2Normal.report.foldersToRemove, 1);
const t2NormalResult = await executeBundlePlan(t2Normal, applyOptions(T2, STATE_T2, R_FILE));
check('默认档：删掉了', exists(T2, '对方删过的目录'), false);
check('默认档：本机新建的留着', exists(T2, '本机新建的'), true);
check('默认档：结果里记了清理数', t2NormalResult.foldersRemoved, 1);

// 关掉「同步删除」：目录也一个都不删（开关不能只管文件）
fs.mkdirSync(abs(T2, '对方删过的目录'), { recursive: true });
const t2NoDelete = await planBundleApply(applyOptions(T2, STATE_T2, R_FILE, { propagateDeletions: false }));
check('关掉同步删除 → 目录也不删', t2NoDelete.foldersToRemove, []);

// 强制一致：本机新建的也删 —— 这一档的承诺就是"仓库和包完全一样"
const t2Mirror = await planBundleApply(applyOptions(T2, STATE_T2, R_FILE, { strictness: 'mirror' }));
check('强制一致：本机新建的也删', t2Mirror.foldersToRemove, ['对方删过的目录', '本机新建的']);
const t2MirrorResult = await executeBundlePlan(t2Mirror, applyOptions(T2, STATE_T2, R_FILE, { strictness: 'mirror' }));
check('强制一致：两个都删掉了', [exists(T2, '本机新建的'), exists(T2, '对方删过的目录')], [false, false]);
check('强制一致：结果里记了清理数', t2MirrorResult.foldersRemoved, 2);
check(
	'强制一致之后：仓库里没有"包里没有的目录"了（文件与文件夹都对齐）',
	listDirs(T2).filter(dir => !bundleDirs.has(dir)),
	[],
);
check(
	'包里有的空文件夹一个不缺',
	listDirs(T2).every(dir => bundleDirs.has(dir)),
	true,
);

// 20. 目录里还有文件时，目录规则不插手；非空的目录 rmdir 也删不动
const U = path.join(ROOT, 'machineU');
const STATE_U = path.join(ROOT, 'state-u.json');
fs.mkdirSync(U, { recursive: true });
write(U, 'notes/keep.md', 'KEEP');
fs.mkdirSync(abs(U, '自己的一摊'), { recursive: true });
write(U, '自己的一摊/mine.md', 'MINE');
const uMirror = await planBundleApply(applyOptions(U, STATE_U, R_FILE, { strictness: 'mirror' }));
check('里面有文件的目录不归目录规则管', uMirror.foldersToRemove, []);
const uResult = await executeBundlePlan(uMirror, applyOptions(U, STATE_U, R_FILE, { strictness: 'mirror' }));
check('强制一致：多余的文件被删掉', exists(U, '自己的一摊/mine.md'), false);
check('腾空的目录跟着收拾掉（不是靠目录规则删的）', exists(U, '自己的一摊'), false);
check('结果里也算进了清理数', uResult.foldersRemoved, 1);

// 21. 更新包 + 破坏性方式 → **引擎层直接降级**（不能只靠界面提示）
// 更新包里只装了变过的文件，拿它"清老的/强制应用"会把仓库里其余文件全当"该删"
const V = path.join(ROOT, 'machineV');
const STATE_V = path.join(ROOT, 'state-v.json');
fs.mkdirSync(V, { recursive: true });
write(V, 'notes/keep.md', 'KEEP'); // 更新包里没有它
const vPlan = await planBundleApply(applyOptions(V, STATE_V, KEPT_CHANGES, { strictness: 'mirror' }));
check('更新包用强制档 → 降级成默认档', vPlan.report.strictness, 'normal');
check('报告里标出"被降级了"（界面要说明白）', vPlan.report.strictnessDowngraded, true);
check('报告里 forced 也不再成立', vPlan.report.forced, false);
check(
	'没有把"包里没提到的文件"当成该删',
	vPlan.actions.filter(action => action.kind === 'delete').map(action => action.path),
	[],
);
await executeBundlePlan(vPlan, applyOptions(V, STATE_V, KEPT_CHANGES, { strictness: 'mirror' }));
check('仓库里那个文件还在（没被清空）', read(V, 'notes/keep.md'), 'KEEP');
check(
	'完整包不受影响：强制档照旧生效',
	(await planBundleApply(applyOptions(V, STATE_V, R_FILE, { strictness: 'mirror' }))).report.strictness,
	'mirror',
);

// 22. 嵌套的空目录：强制档**一轮就删干净**
// （父目录排在子目录前面时 rmdir 会被"非空"挡住，一轮只清掉最深的一层 —— 报过的 bug）
fs.mkdirSync(abs(V, '树/子/孙'), { recursive: true });
const vNested = await planBundleApply(applyOptions(V, STATE_V, R_FILE, { strictness: 'mirror' }));
check(
	'删除清单是深的排前面',
	vNested.foldersToRemove.filter(dir => dir.startsWith('树')),
	['树/子/孙', '树/子', '树'],
);
const vNestedResult = await executeBundlePlan(vNested, applyOptions(V, STATE_V, R_FILE, { strictness: 'mirror' }));
check('一轮就删干净', exists(V, '树'), false);
check('清理数对得上', vNestedResult.foldersRemoved, 3);
check(
	'再打开一次这个包：已经没有多余目录可删',
	(await planBundleApply(applyOptions(V, STATE_V, R_FILE, { strictness: 'mirror' }))).report.foldersToRemove,
	0,
);

// 23. 目录里只有被排除规则挡住的东西 → **不列进删除**，而是报成"留着"
// （清单里看不见 desktop.ini，rmdir 却会失败：不按磁盘复核的话就是"每轮都删但它就是不走"）
const W = path.join(ROOT, 'machineW');
const STATE_W = path.join(ROOT, 'state-w.json');
fs.mkdirSync(W, { recursive: true });
write(W, '有隐藏东西的/desktop.ini', 'x');
const wPlan = await planBundleApply(applyOptions(W, STATE_W, R_FILE, { strictness: 'mirror' }));
check('不列进"要删"', wPlan.foldersToRemove, []);
check('报成"留着"（界面会说明原因）', wPlan.report.foldersKept, 1);
check('报告里的文件夹总数也说得清', [wPlan.report.bundleDirCount, wPlan.report.localDirCount], [4, 1]);
const wResult = await executeBundlePlan(wPlan, applyOptions(W, STATE_W, R_FILE, { strictness: 'mirror' }));
check('被排除的文件没被删', read(W, '有隐藏东西的/desktop.ini'), 'x');
check('文件夹也还在', exists(W, '有隐藏东西的'), true);
check('而且不算失败', wResult.failed.map(item => item.path), []);

// 24. 旧版本导的包（头部没记空文件夹）→ 文件夹**只建不删**
// 它没法表达"我这边有哪些空文件夹"，拿它反推"本地多出来的都该删"会删错
const legacyFile = path.join(OUT, 'legacy.lsave');
const legacySource = path.join(ROOT, 'legacy-source.md');
fs.writeFileSync(legacySource, 'LEGACY');
const legacyStat = fs.statSync(legacySource);
await writeBundle(
	legacyFile,
	{
		format: BUNDLE_FORMAT,
		version: BUNDLE_VERSION,
		bundleId: '00000000-0000-4000-8000-000000000001',
		parentBundleId: null,
		created: Date.now(),
		mode: 'full',
		vault: '旧版仓库',
		lineage: 'legacy-lineage',
		source: { copyId: 'legacy-copy', generation: 0 },
		baseGeneration: null,
		targetGeneration: 1,
		deleted: [],
		// 故意**不写** emptyDirs：这就是旧版本导出来的样子
	},
	[{ path: 'legacy.md', abs: legacySource, size: legacyStat.size, mtime: legacyStat.mtimeMs }],
);

const X = path.join(ROOT, 'machineX');
const STATE_X = path.join(ROOT, 'state-x.json');
fs.mkdirSync(X, { recursive: true });
fs.mkdirSync(abs(X, '本机空目录'), { recursive: true });
const legacyPlan = await planBundleApply(applyOptions(X, STATE_X, legacyFile, { strictness: 'mirror' }));
check('认出来了：旧包没记空文件夹', legacyPlan.report.bundleDirsUnknown, true);
check('于是文件夹一个都不删（哪怕选了强制一致）', legacyPlan.foldersToRemove, []);
check('文件照旧写入', await (async () => {
	await executeBundlePlan(legacyPlan, applyOptions(X, STATE_X, legacyFile, { strictness: 'mirror' }));
	return read(X, 'legacy.md');
})(), 'LEGACY');
check('本机那个空目录还在', exists(X, '本机空目录'), true);
check('新版包不会被误判成旧包', (await planBundleApply(applyOptions(X, STATE_X, R_FILE))).report.bundleDirsUnknown, false);

// 25. 关键回归：**更新包不许删"它没提到的文件"**
// 更新包里只有变过的文件，"没提到"什么也不代表。曾经照着三方比对的结果翻译，
// 于是"1 万文件的仓库 + 只改了 1 个文件的更新包"算出了"删除 10203 个"（用户报过）。
const Y = path.join(ROOT, 'machineY');
const STATE_Y = path.join(ROOT, 'state-y.json');
fs.mkdirSync(Y, { recursive: true });
const yFull = await planBundleApply(applyOptions(Y, STATE_Y, R_FILE));
await executeBundlePlan(yFull, applyOptions(Y, STATE_Y, R_FILE));
check('先应用完整包：文件进基准', read(Y, 'notes/keep.md'), 'KEEP');

const yChanges = await planBundleApply(applyOptions(Y, STATE_Y, KEPT_CHANGES));
check(
	'更新包：没提到的文件不许当成"被删了"',
	yChanges.actions.filter(action => action.kind === 'delete').map(action => action.path),
	[],
);
check('报告里的删除数也是 0', yChanges.report.deletes, 0);
check('"对方删过的"这个数同样是 0', yChanges.report.extraDeletes, 0);
await executeBundlePlan(yChanges, applyOptions(Y, STATE_Y, KEPT_CHANGES));
check('应用之后那个文件还在（更新包只动它提到的东西）', read(Y, 'notes/keep.md'), 'KEEP');
check('包里点名删的、本地没有的：什么都不用做', yChanges.report.keptDeletes, 0);

// 另一半：**完整包**才是完整清单 —— 基准里有、包里没有 = 对方删过它 → 跟着删
fs.rmSync(abs(Q, 'notes/keep.md'));
const qFull2 = await exportBundle(exportOptions(Q, STATE_Q));
checkTrue('再导一份不含 notes/keep.md 的完整包', qFull2.file !== null, qFull2.reason ?? '');
const yFull2 = await planBundleApply(applyOptions(Y, STATE_Y, qFull2.file as string));
check(
	'完整包：对方删过的要跟着删（notes/a.md 是刚才更新包带进来的，这份完整包里也没有）',
	yFull2.actions.filter(action => action.kind === 'delete').map(action => action.path),
	['notes/a.md', 'notes/keep.md'],
);
await executeBundlePlan(yFull2, applyOptions(Y, STATE_Y, qFull2.file as string));
check('删掉了', exists(Y, 'notes/keep.md'), false);

// 26. 「更新包攒大了提醒换基准」那套判断（纯逻辑，先钉死）
check('留空 → 默认 200MB', parseSizeLimit(''), 200 * 1024 * 1024);
check('写 500KB', parseSizeLimit('500KB'), 500 * 1024);
check('写 1.5GB', parseSizeLimit('1.5 GB'), Math.floor(1.5 * 1024 * 1024 * 1024));
check('不带单位按 MB 算', parseSizeLimit('300'), 300 * 1024 * 1024);
check('大小写都认', parseSizeLimit('200mb'), 200 * 1024 * 1024);
check('填 0 → 关掉提醒（Infinity）', parseSizeLimit('0'), Number.POSITIVE_INFINITY);
check('乱填 → 回到默认（宁可提醒）', parseSizeLimit('随便写点什么'), 200 * 1024 * 1024);
const limit200 = 200 * 1024 * 1024;
check('没到线上 → 不弹', shouldOfferReset(limit200, 100 * 1024 * 1024), false);
check('到线了 → 弹', shouldOfferReset(limit200, 200 * 1024 * 1024), true);
check('关掉提醒（Infinity）→ 永不弹', shouldOfferReset(Number.POSITIVE_INFINITY, 10 ** 12), false);
check(
	'跳过一次之后：提醒线抬到 400MB，350MB 不再弹',
	[
		shouldOfferReset(limit200, 350 * 1024 * 1024, advanceWarnThreshold(limit200, null)),
		advanceWarnThreshold(limit200, null),
	],
	[false, 400 * 1024 * 1024],
);
check(
	'再跳一次：600MB（按原上限整数倍累进，不是按百分比）',
	advanceWarnThreshold(limit200, advanceWarnThreshold(limit200, null)),
	600 * 1024 * 1024,
);
check('到 400MB 了 → 再弹一次', shouldOfferReset(limit200, 400 * 1024 * 1024, advanceWarnThreshold(limit200, null)), true);
check('换过基准（提醒线清零）→ 回到 1 倍上限', warnThreshold(limit200, null), limit200);

// 27. 完整包会取代**所有**更早的更新包（换基准之后就它们没用了）
// 用一台新机器 + 一个新目录，免得干扰前面那些依赖具体包文件的用例
const OUT2 = path.join(ROOT, 'transfer2');
const AA = path.join(ROOT, 'machineAA');
const STATE_AA = path.join(ROOT, 'state-aa.json');
fs.mkdirSync(OUT2, { recursive: true });
fs.mkdirSync(AA, { recursive: true });
write(AA, 'a.md', 'A1');
const aaFull = await exportBundle({ ...exportOptions(AA, STATE_AA), outDir: OUT2 });
write(AA, 'b.md', 'B1');
const aaC1 = await exportBundle({ ...exportOptions(AA, STATE_AA, 'changes'), outDir: OUT2 });
write(AA, 'c.md', 'C1');
const aaC2 = await exportBundle({ ...exportOptions(AA, STATE_AA, 'changes'), outDir: OUT2 });
const changesDir = path.join(OUT2, 'changes');
check('导第二个更新包：旧的被它取代、只剩新的那个', fs.readdirSync(changesDir), [path.basename(aaC2.file as string)]);
check('清掉的名单也带出来', aaC2.superseded, [path.basename(aaC1.file as string)]);
check('完整包留着（还原点）', fs.existsSync(aaFull.file as string), true);

// 两个一起导：完整包不该把**同一次**刚导出的更新包也清掉
write(AA, 'd.md', 'D1');
const aaC3 = await exportBundle({ ...exportOptions(AA, STATE_AA, 'changes'), outDir: OUT2 });
const aaF2 = await exportBundle({
	...exportOptions(AA, STATE_AA),
	outDir: OUT2,
	keepPaths: [aaC3.file as string],
});
check('同一次导出的更新包不会被完整包清掉', fs.existsSync(aaC3.file as string), true);
check('但更早的更新包被完整包取代了', aaC3.superseded, [path.basename(aaC2.file as string)]);
check('这次完整包没删东西（该删的上一轮已删）', aaF2.superseded, []);

// 换基准之后再导更新包：之前的那些（属于老基准）也不留 —— changes 里永远只有一个
write(AA, 'e.md', 'E1');
const aaC4 = await exportBundle({ ...exportOptions(AA, STATE_AA, 'changes'), outDir: OUT2 });
check('新基准下的更新包只剩它一个', fs.readdirSync(changesDir), [path.basename(aaC4.file as string)]);

// 关掉开关就一个都不清
write(AA, 'f.md', 'F1');
const aaC5 = await exportBundle({
	...exportOptions(AA, STATE_AA, 'changes'),
	outDir: OUT2,
	settings: settings({ pruneSupersededBundles: false }),
});
check('关掉开关 → 不清理', aaC5.superseded, []);
check('于是 changes 里有两个', fs.readdirSync(changesDir).length, 2);

// 28. 一次导两种的顺序：**先完整副本、后更新包**
// 老顺序（先更新、后完整）会演出一幕很怪的戏：先把老更新包当"被取代的"清掉、
// 再生成一个内容一模一样的更新包，最后完整包又把新的那个取代一遍（用户报过）
check('两个都勾：先完整副本、后更新包', plannedExportModes({ changes: true, full: true }), ['full', 'changes']);
check('只勾更新包', plannedExportModes({ changes: true, full: false }), ['changes']);
check('只勾完整副本', plannedExportModes({ changes: false, full: true }), ['full']);
check('都没勾：一个都不导', plannedExportModes({ changes: false, full: false }), []);

// 29. 按新顺序走一遍"两个一起导"：更新包必然是空的 → 不生成文件
const OUT3 = path.join(ROOT, 'transfer3');
const FF = path.join(ROOT, 'machineFF');
const STATE_FF = path.join(ROOT, 'state-ff.json');
fs.mkdirSync(OUT3, { recursive: true });
fs.mkdirSync(FF, { recursive: true });
write(FF, 'a.md', 'A1');
await exportBundle({ ...exportOptions(FF, STATE_FF), outDir: OUT3 });
write(FF, 'b.md', 'B1');
const ffChanges = await exportBundle({ ...exportOptions(FF, STATE_FF, 'changes'), outDir: OUT3 });
checkTrue('先导出一个有内容的更新包', ffChanges.file !== null, ffChanges.reason ?? '');

const ffFull2 = await exportBundle({ ...exportOptions(FF, STATE_FF), outDir: OUT3 });
check('完整副本取代了刚才那个更新包', ffFull2.superseded, [path.basename(ffChanges.file as string)]);
const ffEmpty = await exportBundle({ ...exportOptions(FF, STATE_FF, 'changes'), outDir: OUT3 });
check('紧接着的更新包是空的：不生成文件', ffEmpty.file, null);
checkTrue(
	'理由说得清（自上次完整副本以来没有任何变化）',
	(ffEmpty.reason ?? '').includes('没有任何变化'),
	ffEmpty.reason ?? '',
);
check('changes 目录里一个包都不剩（旧的被取代，空包没写）', fs.readdirSync(path.join(OUT3, 'changes')), []);
check('完整副本留着（还原点）', fs.existsSync(ffFull2.file as string), true);

// 30. 进度就是**打包了多少个文件**：从 0 数到文件数，多一个含义都不许有
const ticks: { done: number; total: number; path: string }[] = [];
const OUT4 = path.join(ROOT, 'transfer4');
const PG = path.join(ROOT, 'machinePG');
const STATE_PG = path.join(ROOT, 'state-pg.json');
fs.mkdirSync(OUT4, { recursive: true });
fs.mkdirSync(PG, { recursive: true });
write(PG, 'a.md', 'A');
write(PG, 'b.md', 'BB');
write(PG, 'c.md', 'CCC');
await exportBundle({
	...exportOptions(PG, STATE_PG),
	outDir: OUT4,
	onProgress: (done, total, file) => ticks.push({ done, total, path: file }),
});
check('分母就是文件数', [...new Set(ticks.map(tick => tick.total))], [3]);
check('从 0 数起、一个文件一格、数到文件数为止', ticks.map(tick => tick.done), [0, 1, 2, 3]);
check('每一格对应一个真的打进包里的文件', ticks.slice(1).map(tick => tick.path), ['a.md', 'b.md', 'c.md']);

// 容器层也报一次：搬完一个文件报一个，供上面那半段进度用
const writeTicks: number[] = [];
const tickSource = path.join(ROOT, 'tick-source.md');
fs.writeFileSync(tickSource, 'TICK');
await writeBundle(
	path.join(OUT4, 'ticks.lsave'),
	{
		format: BUNDLE_FORMAT,
		version: BUNDLE_VERSION,
		bundleId: '00000000-0000-4000-8000-0000000000ff',
		parentBundleId: null,
		created: Date.now(),
		mode: 'full',
		vault: '进度仓库',
		lineage: 'tick-lineage',
		source: { copyId: 'tick-copy', generation: 0 },
		baseGeneration: null,
		targetGeneration: 1,
		deleted: [],
		emptyDirs: [],
	},
	[
		{ path: 'one.md', abs: tickSource, size: 4, mtime: Date.now() },
		{ path: 'two.md', abs: tickSource, size: 4, mtime: Date.now() },
	],
	(done, total) => writeTicks.push(done * 100 + total),
);
check('写包时每个文件报一次（done×100 + total）', writeTicks, [102, 202]);
fs.rmSync(path.join(OUT4, 'ticks.lsave'), { force: true });

// 31. 包管理：列出来 → 删除＝挪进回收站 → 清空回收站才是真删
const listed = await listBundles(OUT3);
check('完整包都列出来了', listed.length, 2);
check('类型是读头部认出来的（不是猜文件名）', [...new Set(listed.map(item => item.mode))], ['full']);
check(
	'每个包都带文件名 / 大小 / 时间',
	listed.every(item => item.name.endsWith('.lsave') && item.size > 0 && item.mtime > 0),
	true,
);

// 读不出头部的（不是我们的包 / 传坏了）也要列出来 —— 看得见才删得掉
const bogus = path.join(OUT3, 'changes', 'not-a-bundle.lsave');
fs.writeFileSync(bogus, 'nope');
const bogusItem = (await listBundles(OUT3)).find(item => item.name === 'not-a-bundle.lsave');
check('读不出头部的也列出来', bogusItem?.mode, null);
checkTrue('并且带上原因', (bogusItem?.error ?? '').includes('同步包'), bogusItem?.error ?? '');
fs.rmSync(bogus);

const trashedSize = listed.find(item => item.file === ffFull2.file)?.size ?? 0;
const removed = await trashBundles(OUT3, [ffFull2.file as string]);
check('删除＝挪走一个', removed.moved, [path.basename(ffFull2.file as string)]);
check('原处已经没有它了', fs.existsSync(ffFull2.file as string), false);
const inTrash = await scanTree(bundleTrashRoot(OUT3), { exclude: [] });
check(
	'回收站里躺着一个包（时间戳/文件名）',
	[...inTrash.files.keys()].map(rel => rel.split('/').pop()),
	[path.basename(ffFull2.file as string)],
);
check('回收站数得出来', await readBundleTrash(OUT3), { count: 1, bytes: trashedSize });

await emptyBundleTrash(OUT3);
check('清空之后回收站是空的', await readBundleTrash(OUT3), { count: 0, bytes: 0 });
check('回收站目录本身也没了', fs.existsSync(bundleTrashRoot(OUT3)), false);
check('别的包没被牵连', (await listBundles(OUT3)).length, 1);

// 31b. 「彻底删除」：不进回收站，直接没了（跟「挪进回收站」并排的两个按钮）
const doomed = (await listBundles(OUT3))[0];
checkTrue('删之前还剩一个包', doomed !== undefined, '列表是空的');
const deleted = await deleteBundles([doomed?.file as string]);
check('报告删掉了它', deleted.deleted, [doomed?.name]);
check('没有失败', deleted.failed, []);
check('文件真的没了', fs.existsSync(doomed?.file as string), false);
check('回收站里也不该多东西（不是挪走，是删掉）', await readBundleTrash(OUT3), { count: 0, bytes: 0 });
check('列表空了', (await listBundles(OUT3)).length, 0);
// 路径要用 path.join 拼（CI 跑 Linux：字面量 `Z:\x\y.lsave` 在那边根本不是路径，
// path.basename 会原样返回，测试就会红 —— 踩过一次）
check(
	'删一个本来就不在的：算成功，不报错（可能刚被别的操作挪走）',
	await deleteBundles([path.join(ROOT, 'definitely-missing', 'missing.lsave')]),
	{ deleted: ['missing.lsave'], failed: [] },
);

// 32. 回收站放哪儿：**跟 bundles 平级**，绝不在 bundles 里面再套一层 .lsave
// （默认布局下 base 本身就是 `.lsave/bundles`，塞进去会变成 `.lsave/bundles/.lsave/bundles-trash`：两层 .lsave，用户报过）
const defaultBase = path.join(ROOT, 'vault-copy', '.lsave', 'bundles');
const siblingTrash = path.join(ROOT, 'vault-copy', '.lsave', 'bundles-trash');
check('默认布局：回收站是 bundles 的邻居', bundleTrashRoot(defaultBase), siblingTrash);
check(
	'自定义文件夹（那儿没有 .lsave）：在它下面建一个',
	bundleTrashRoot(path.join(ROOT, 'transfer9')),
	path.join(ROOT, 'transfer9', '.lsave', 'bundles-trash'),
);
check(
	'包文件夹直接指到 .lsave：就放在它里面',
	bundleTrashRoot(path.join(ROOT, 'vault-copy', '.lsave')),
	siblingTrash,
);
check('没配同步包文件夹 → 空串', bundleTrashRoot(''), '');

// 按默认布局真的删一个包：文件落在 .lsave/bundles-trash 下，bundles 里面干干净净
const DL = path.join(ROOT, 'machineDL');
const STATE_DL = path.join(ROOT, 'state-dl.json');
const DL_BASE = path.join(ROOT, 'vault-copy', '.lsave', 'bundles');
fs.mkdirSync(DL, { recursive: true });
write(DL, 'a.md', 'DL');
const dlFull = await exportBundle({ ...exportOptions(DL, STATE_DL), outDir: DL_BASE });
const dlRemoved = await trashBundles(DL_BASE, [dlFull.file as string]);
check('落脚点是 bundles 的邻居', dlRemoved.target.startsWith(siblingTrash), true);
check('bundles 里面没有多出一层 .lsave', fs.existsSync(path.join(DL_BASE, '.lsave')), false);
check('回收站里数得到它', (await readBundleTrash(DL_BASE)).count, 1);

// 早期版本塞在 bundles 里面的那个回收站也要认：不然界面报"空的"、包却还躺在硬盘上
const legacyTrash = path.join(DL_BASE, '.lsave', 'bundles-trash', '20260101-000000');
fs.mkdirSync(legacyTrash, { recursive: true });
fs.writeFileSync(path.join(legacyTrash, 'old.lsave'), 'OLD');
check('老位置的回收站也算数', (await readBundleTrash(DL_BASE)).count, 2);
await emptyBundleTrash(DL_BASE);
check('清空会把两处一起清掉', [await readBundleTrash(DL_BASE), fs.existsSync(path.join(DL_BASE, '.lsave'))], [{ count: 0, bytes: 0 }, false]);

// 33. 列表分组：同一类排一起、组内**从新到老**（界面上就是这么一屏一屏看的）
const fakeBundle = (name: string, mode: 'full' | 'changes' | null, mtime: number): ManagedBundle =>
	({ file: name, name, dir: '', mode, header: null, size: 1, mtime });
const grouped = groupBundles([
	fakeBundle('f-old', 'full', 100),
	fakeBundle('c-mid', 'changes', 200),
	fakeBundle('weird', null, 150),
	fakeBundle('c-new', 'changes', 300),
	fakeBundle('f-new', 'full', 250),
]);
check(
	'组顺序：更新包 → 完整副本 → 类型未知',
	grouped.map(group => group.title),
	['更新包', '完整副本', '类型未知（读不出头部）'],
);
check(
	'每组里面都是从新到老（输入顺序打乱也一样）',
	grouped.map(group => group.items.map(item => item.name)),
	[['c-new', 'c-mid'], ['f-new', 'f-old'], ['weird']],
);

// 34. 「应用方式」两套选项：完整副本一套、更新包一套（不是把不合适的灰掉）
check(
	'完整副本那套：按设置 / 以包为准 / 完全镜像',
	APPLY_CHOICES.full.map(item => item.key),
	['normal', 'bundle-wins', 'mirror'],
);
check(
	'更新包那套：按设置 / 以包为准 / 两边都留 / 以我为准',
	APPLY_CHOICES.changes.map(item => item.key),
	['normal', 'listed-wins', 'keep-both', 'local-wins'],
);
check(
	'更新包那套里没有会清空仓库的两档（包里没有 ≠ 对方删了它）',
	APPLY_CHOICES.changes.some(item => item.strictness === 'bundle-wins' || item.strictness === 'mirror'),
	false,
);
check('换包类型后原来那档不在新一套里 → 回到这一套的默认档', findApplyChoice('changes', 'mirror').key, 'normal');
check('默认档就是第一项', findApplyChoice('full', 'normal').strictness, 'normal');

// 35. 「以包为准」：包里点名的文件一律用包里那一版，没提到的一个不动
// （用户报的场景：应用过更新包 → 自己又改了这个文件 → 想退回包里那一版，但更新包只有"按设置"，
//   本地改过的一律保留，这件事做不到）
const ZA = path.join(ROOT, 'machineZA');
const ZB = path.join(ROOT, 'machineZB');
const STATE_ZA = path.join(ROOT, 'state-za.json');
const STATE_ZB = path.join(ROOT, 'state-zb.json');
const OUTZ = path.join(ROOT, 'transferZ');
const T0 = Date.now() - 60_000;
fs.mkdirSync(ZA, { recursive: true });
fs.mkdirSync(ZB, { recursive: true });
fs.mkdirSync(OUTZ, { recursive: true });

write(ZA, 'a.md', 'A1', T0);
write(ZA, 'b.md', 'B1', T0);
write(ZA, 'c.md', 'C1', T0);
const zFull = await exportBundle({ ...exportOptions(ZA, STATE_ZA), outDir: OUTZ });
const zFullPlan = await planBundleApply(applyOptions(ZB, STATE_ZB, zFull.file as string));
await executeBundlePlan(zFullPlan, applyOptions(ZB, STATE_ZB, zFull.file as string));
check('先应用完整包', [read(ZB, 'a.md'), read(ZB, 'b.md'), read(ZB, 'c.md')], ['A1', 'B1', 'C1']);

// A 那边：改了 a.md、删了 c.md → 导一个更新包（条目里有 a.md，删除清单里点名 c.md）
write(ZA, 'a.md', 'A2', T0 + 10_000);
fs.rmSync(abs(ZA, 'c.md'));
const zChanges = await exportBundle({ ...exportOptions(ZA, STATE_ZA, 'changes'), outDir: OUTZ });
const zChangesOptions = applyOptions(ZB, STATE_ZB, zChanges.file as string);
await executeBundlePlan(await planBundleApply(zChangesOptions), zChangesOptions);
check('按设置应用更新包：a.md 更新、点名的 c.md 删掉', [read(ZB, 'a.md'), read(ZB, 'c.md')], ['A2', null]);

// B 自己又把 a.md 改坏了，还手贱把 c.md 建回来、另外多了个自己的文件
write(ZB, 'a.md', 'B-WRONG', T0 + 20_000);
write(ZB, 'c.md', 'C-AGAIN', T0 + 20_000);
write(ZB, 'mine.md', 'MINE', T0 + 20_000);

// 换「以包为准」再应用同一个更新包
const revertOptions = applyOptions(ZB, STATE_ZB, zChanges.file as string, { strictness: 'listed-wins' });
const revertPlan = await planBundleApply(revertOptions);
check('以包为准：更新包也能用（没被降级成"按设置"）', revertPlan.report.strictnessDowngraded, false);
check('以包为准：算出"覆盖一个本地改过的"', [revertPlan.report.forcedOverwrites, revertPlan.report.conflicts], [1, 0]);
await executeBundlePlan(revertPlan, revertOptions);
check('a.md 退回了包里那一版', read(ZB, 'a.md'), 'A2');
check('我改坏的那份没丢：在回收目录里', findBackups(ZB, 'a.md'), ['B-WRONG']);
check('包里点名要删的照删（我又建回来的 c.md）', read(ZB, 'c.md'), null);
check('它同样进了回收目录', findBackups(ZB, 'c.md').includes('C-AGAIN'), true);
check('包里没提到的：我自己的文件一个没动', read(ZB, 'mine.md'), 'MINE');
check('包里没提到的：b.md 也还在', read(ZB, 'b.md'), 'B1');

// 对照：会清空仓库的那两档对更新包仍然降级（引擎层兜底）
const forcedPlan = await planBundleApply(applyOptions(ZB, STATE_ZB, zChanges.file as string, { strictness: 'bundle-wins' }));
check('「以包为准 / 完全镜像」对更新包仍然降级', forcedPlan.report.strictnessDowngraded, true);

// 40. 同一个包**再应用一遍**：什么都不用做（不是失败）—— 界面上要能一眼看出"本地已经有了"
// （用户报过：拿到对方发来的包，打开一看报告是"写入 0、跳过 N"，以为没应用，其实早就是那一版）
const againPlan = await planBundleApply(applyOptions(ZB, STATE_ZB, zChanges.file as string));
check('重复应用：一个动作都没有', againPlan.actions.length, 0);
check('也没有要动的文件夹', againPlan.foldersToRemove.length, 0);
check(
	'报告里那个文件算"已一致"，既不是覆盖也不是冲突',
	[againPlan.report.synchronized, againPlan.report.overwrites, againPlan.report.conflicts],
	[1, 0, 0],
);

// 36. 世代回退之后再"两个一起导"，老的更新包**每次**都该被清掉
// （用户报的场景：第一遍没清、第二遍清了 —— 因为应用一个更老的包会把世代设回那个包的世代，
//   而清理守卫是"世代严格更小"，那一个包第一遍刚好卡在边界上）
const RB = path.join(ROOT, 'machineRB');
const STATE_RB = path.join(ROOT, 'state-rb.json');
const OUTR = path.join(ROOT, 'transferR');
fs.mkdirSync(RB, { recursive: true });
fs.mkdirSync(OUTR, { recursive: true });
write(RB, 'a.md', 'R1', T0);
const rFull = await exportBundle({ ...exportOptions(RB, STATE_RB), outDir: OUTR });
write(RB, 'b.md', 'R2', T0 + 10_000);
const rChanges = await exportBundle({ ...exportOptions(RB, STATE_RB, 'changes'), outDir: OUTR });
checkTrue('先有一个更新包', rChanges.file !== null, rChanges.reason ?? '');

// 用户做过的事：把那个完整包又应用了一遍（更老的包 —— 世代绝不能被它拨回去）
const rBackOptions = applyOptions(RB, STATE_RB, rFull.file as string, { strictness: 'listed-wins' });
await executeBundlePlan(await planBundleApply(rBackOptions), rBackOptions);
check(
	'应用更老的包不会把世代拨回去（拨回去会让"清老包"时好时坏）',
	(await loadState(STATE_RB)).generation,
	rChanges.header?.targetGeneration,
);

/** 弹窗里"两个都勾"那一路：先完整副本、后更新包，先导出来的填进 keepPaths */
const bothAtOnce = async (): Promise<ExportOutcome> => {
	const written: string[] = [];
	const full = await exportBundle({ ...exportOptions(RB, STATE_RB), outDir: OUTR, keepPaths: written });
	written.push(full.file as string);
	await exportBundle({ ...exportOptions(RB, STATE_RB, 'changes'), outDir: OUTR, keepPaths: written });
	return full;
};
await bothAtOnce();
check('第一遍：老的更新包被完整副本取代', fs.existsSync(rChanges.file as string), false);
await bothAtOnce();
check('第二遍也是（行为要一致）', fs.existsSync(rChanges.file as string), false);

// 37. 清不掉的更新包要**说清为什么**（"没清掉"和"没什么可清"是两回事）
const KD = path.join(ROOT, 'machineKD');
const STATE_KD = path.join(ROOT, 'state-kd.json');
const OUTK = path.join(ROOT, 'transferK');
fs.mkdirSync(KD, { recursive: true });
fs.mkdirSync(OUTK, { recursive: true });
write(KD, 'a.md', 'KA', T0);
await exportBundle({ ...exportOptions(KD, STATE_KD), outDir: OUTK });

const foreignSource = path.join(ROOT, 'foreign.md');
fs.writeFileSync(foreignSource, 'FOREIGN');
const foreignStat = fs.statSync(foreignSource);
/** 手搓一个包放进 changes/（头部字段自己给，用来模拟"别的机器导的"与"世代更大的"两种包） */
const craftChanges = async (
	id: string,
	name: string,
	overrides: Partial<Parameters<typeof writeBundle>[1]>,
): Promise<string> => {
	const file = path.join(OUTK, 'changes', name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	await writeBundle(file, {
		format: BUNDLE_FORMAT,
		version: BUNDLE_VERSION,
		bundleId: `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
		parentBundleId: null,
		created: Date.now(),
		mode: 'changes',
		vault: '别的仓库',
		lineage: 'other-lineage',
		source: { copyId: 'other-copy', generation: 0 },
		baseGeneration: 1,
		targetGeneration: 9,
		deleted: [],
		emptyDirs: [],
		...overrides,
	}, [{ path: 'foreign.md', abs: foreignSource, size: foreignStat.size, mtime: foreignStat.mtimeMs }]);
	return name;
};

const foreignName = await craftChanges('1', '别的机器-changes-20260101-000000-aaaaaa.lsave', {});
const kdState = await loadState(STATE_KD);
const futureName = await craftChanges('2', '我的笔记-changes-20990101-000000-bbbbbb.lsave', {
	vault: '我的笔记',
	lineage: kdState.lineage,
	// 同血脉、但世代比这次的新（状态文件被换过 / 装过更晚的包就会出现）
	targetGeneration: kdState.generation + 50,
});

write(KD, 'b.md', 'KB', T0 + 10_000);
const kdFull = await exportBundle({ ...exportOptions(KD, STATE_KD), outDir: OUTK });
check('别的血脉 / 世代更大的更新包：一个都不碰', kdFull.superseded, []);
check(
	'但要如实报出来（不然看着像清理开关没生效）',
	kdFull.keptChanges.map(item => item.name).sort(),
	[foreignName, futureName].sort(),
);
check(
	'理由分成两种：血脉 / 世代',
	[...new Set(kdFull.keptChanges.map(item => item.why))].sort(),
	['不是同一条血脉（多半是另一台机器导的）', '记的世代不比这次的新（导出过更晚的包）'].sort(),
);

// 38. 两台机器互相发更新包：应用后把"本机这半"导出来发回去，两边才收敛
// （用户问的："数据各半，有没有必要接收之后同步一下本地的更新包"）
const RMA = path.join(ROOT, 'machineRMA');
const RMB = path.join(ROOT, 'machineRMB');
const STATE_RMA = path.join(ROOT, 'state-rma.json');
const STATE_RMB = path.join(ROOT, 'state-rmb.json');
const OUTRA = path.join(ROOT, 'transferRA');
fs.mkdirSync(RMA, { recursive: true });
fs.mkdirSync(RMB, { recursive: true });
fs.mkdirSync(OUTRA, { recursive: true });

write(RMA, 'x.md', 'X1', T0);
write(RMA, 'y.md', 'Y1', T0);
const raFull = await exportBundle({ ...exportOptions(RMA, STATE_RMA), outDir: OUTRA });
const rmbFullOptions = applyOptions(RMB, STATE_RMB, raFull.file as string);
await executeBundlePlan(await planBundleApply(rmbFullOptions), rmbFullOptions);

// 两边各改各的：A 改 x，B 改 y 并新建 z（这就是"各半"）
write(RMA, 'x.md', 'X2', T0 + 10_000);
write(RMB, 'y.md', 'Y2', T0 + 10_000);
write(RMB, 'z.md', 'Z1', T0 + 10_000);
const raChanges = await exportBundle({ ...exportOptions(RMA, STATE_RMA, 'changes'), outDir: OUTRA });

// B 应用之前，报告就该告诉它"我这半还有两处对方没有的改动"
const rmbPlan = await planBundleApply(applyOptions(RMB, STATE_RMB, raChanges.file as string));
check(
	'报告里先把"我这半还剩多少"摊开',
	[rmbPlan.report.pendingChanges, rmbPlan.report.pendingDeletes],
	[2, 0],
);
await executeBundlePlan(rmbPlan, applyOptions(RMB, STATE_RMB, raChanges.file as string));
check('B 拿到了 A 的 x', read(RMB, 'x.md'), 'X2');
check('B 自己的 y / z 没被动', [read(RMB, 'y.md'), read(RMB, 'z.md')], ['Y2', 'Z1']);

// B 导"回礼包"（界面上就是勾着「应用后顺便导一个更新包」时自动做的那一步）
const rmbReturn = await exportBundle({ ...exportOptions(RMB, STATE_RMB, 'changes'), outDir: OUTRA });
checkTrue('回礼包导出来了', rmbReturn.file !== null, rmbReturn.reason ?? '');

// A 应用回礼包：x 与自己那份一样（跳过），拿到 B 的 y 与 z
const rmaBackOptions = applyOptions(RMA, STATE_RMA, rmbReturn.file as string);
await executeBundlePlan(await planBundleApply(rmaBackOptions), rmaBackOptions);
check('A 拿到 B 的 y 与 z', [read(RMA, 'y.md'), read(RMA, 'z.md')], ['Y2', 'Z1']);
check('A 的 x 没被自己那份覆盖（内容一样，跳过）', read(RMA, 'x.md'), 'X2');
check('两边收敛', [read(RMA, 'x.md'), read(RMA, 'y.md'), read(RMA, 'z.md')], ['X2', 'Y2', 'Z1']);
check(
	'两边站在同一份基准上（指纹一致）',
	(await loadState(STATE_RMA)).bundle?.fullHash,
	(await loadState(STATE_RMB)).bundle?.fullHash,
);

// 39. 基准指纹：判断"是不是接着同一份完整副本"（世代号不够用 —— 两边各自 +1 会碰号）
const hashA = listingHash([{ path: 'a.md', size: 1, mtime: 1000 }, { path: 'b.md', size: 2, mtime: 2000 }]);
const hashB = listingHash([{ path: 'b.md', size: 2, mtime: 2000 }, { path: 'a.md', size: 1, mtime: 1000 }]);
check('同样的清单（顺序不同）→ 同一个指纹', hashA, hashB);
checkTrue(
	'内容变了（大小/时间任一）→ 指纹就变',
	hashA !== listingHash([{ path: 'a.md', size: 9, mtime: 1000 }, { path: 'b.md', size: 2, mtime: 2000 }])
		&& hashA !== listingHash([{ path: 'a.md', size: 1, mtime: 1001 }, { path: 'b.md', size: 2, mtime: 2000 }]),
	'指纹没跟着内容变',
);
check('少一个文件也是另一份基准', hashA !== listingHash([{ path: 'a.md', size: 1, mtime: 1000 }]), true);

// 应用完整包之后，我这边记下的基准令牌 ＝ 包自己那份清单的指纹
const bState = await loadState(STATE_RMB);
const raFullHeader = (await readBundleInfo(raFull.file as string)).header;
check('令牌就是那份完整包自己的指纹', bState.bundle?.fullHash, baselineOfBundle(raFullHeader));

// B 导的回礼包说的是同一份基准；A 应用它 → 判成"基准一致"
const returnHeader = (await readBundleInfo(rmbReturn.file as string)).header;
check('更新包带着"我基于哪份基准"', returnHeader.baselineHash, bState.bundle?.fullHash);
check(
	'A 应用它：基准判定为一致（接着同一份完整副本）',
	(await planBundleApply(applyOptions(RMA, STATE_RMA, rmbReturn.file as string))).report.baselineMatch,
	'match',
);

// 反过来：A 换了一份新基准（又导一次完整包），B 还停在老基准上 → 明确判成"对不上"
write(RMA, 'x.md', 'X3', T0 + 20_000);
const raFull2 = await exportBundle({ ...exportOptions(RMA, STATE_RMA), outDir: OUTRA });
// 换完基准再改一笔：紧接着完整包导的更新包必然是空的（那条语义有专门用例）
write(RMA, 'x.md', 'X4', T0 + 30_000);
const raChanges2 = await exportBundle({ ...exportOptions(RMA, STATE_RMA, 'changes'), outDir: OUTRA });
checkTrue('换基准之后的更新包有内容', raChanges2.file !== null, raChanges2.reason ?? '');
const rmbMismatch = await planBundleApply(applyOptions(RMB, STATE_RMB, raChanges2.file as string));
check('A 换基准之后 B 仍能收下更新包（不拒绝服务）', rmbMismatch.report.baselineMatch, 'mismatch');
check(
	'两个指纹都报出来，便于对账',
	[typeof rmbMismatch.report.myBaseline, typeof rmbMismatch.report.bundleBaseline],
	['string', 'string'],
);
const rmbAlignOptions = applyOptions(RMB, STATE_RMB, raFull2.file as string);
await executeBundlePlan(await planBundleApply(rmbAlignOptions), rmbAlignOptions);
check(
	'应用新的完整副本 → 基准又对上了（这就是"对齐"那一步）',
	(await planBundleApply(applyOptions(RMB, STATE_RMB, raChanges2.file as string))).report.baselineMatch,
	'match',
);

// 41. 应用完整副本时，新基准**只从这个包自己的清单里建**
// （旧写法拿"我原来的基准"当底：我独有的、包里根本没有的文件会漏进基准 →
//   之后我一导更新包，它们就被当成"我删掉了它们"要求对方删 ——
//   用户报过的现场：对方那台机器的仓库比状态旧，凭空报出"删掉两个 schedule 文件"）
const BA = path.join(ROOT, 'machineBA');
const BB = path.join(ROOT, 'machineBB');
const STATE_BA = path.join(ROOT, 'state-ba.json');
const STATE_BB = path.join(ROOT, 'state-bb.json');
const OUTB = path.join(ROOT, 'transferB');
fs.mkdirSync(BA, { recursive: true });
fs.mkdirSync(BB, { recursive: true });
fs.mkdirSync(OUTB, { recursive: true });

// B 自己导过一份完整包（于是它的基准里记着 ghost.md），然后本地把 ghost.md 删了
write(BB, 'ghost.md', 'GHOST', T0);
write(BB, 'keep.md', 'K1', T0);
await exportBundle({ ...exportOptions(BB, STATE_BB), outDir: OUTB });
fs.rmSync(abs(BB, 'ghost.md'));
check('B 自己导的完整包基准里确实记着 ghost.md', (await loadState(STATE_BB)).bundle?.fullFiles?.['ghost.md'] !== undefined, true);

// A 导一份完整包（只有 keep.md），B 应用它 —— 新基准只该包含"这个包里有、且真写成一致"的
write(BA, 'keep.md', 'K1', T0);
const baFull = await exportBundle({ ...exportOptions(BA, STATE_BA), outDir: OUTB });
const bbApplyOptions = applyOptions(BB, STATE_BB, baFull.file as string);
await executeBundlePlan(await planBundleApply(bbApplyOptions), bbApplyOptions);
check(
	'应用完整副本之后，基准里没有"包外"的文件（ghost.md 不该在）',
	Object.keys((await loadState(STATE_BB)).bundle?.fullFiles ?? {}),
	['keep.md'],
);

// B 再导更新包：不会凭空报"我删了 ghost.md"
const bbChanges = await exportBundle({ ...exportOptions(BB, STATE_BB, 'changes'), outDir: OUTB });
check('不会凭空报删除（那会让对方把它本地还在的文件删掉）', bbChanges.file, null);

// 42. 「这次不执行包里的删除」：对方基准不对时的兜底（包里点名要删的一律留着）
const SB = path.join(ROOT, 'machineSB');
const SC = path.join(ROOT, 'machineSC');
const STATE_SB = path.join(ROOT, 'state-sb.json');
const STATE_SC = path.join(ROOT, 'state-sc.json');
const OUTS = path.join(ROOT, 'transferS');
fs.mkdirSync(SB, { recursive: true });
fs.mkdirSync(SC, { recursive: true });
fs.mkdirSync(OUTS, { recursive: true });
write(SB, 'victim.md', 'V1', T0);
write(SB, 'other.md', 'O1', T0);
const sbFull = await exportBundle({ ...exportOptions(SB, STATE_SB), outDir: OUTS });
const scFullOptions = applyOptions(SC, STATE_SC, sbFull.file as string);
await executeBundlePlan(await planBundleApply(scFullOptions), scFullOptions);
check('先同步过去', read(SC, 'victim.md'), 'V1');

fs.rmSync(abs(SB, 'victim.md'));
const sbChanges = await exportBundle({ ...exportOptions(SB, STATE_SB, 'changes'), outDir: OUTS });
const plainPlan = await planBundleApply(applyOptions(SC, STATE_SC, sbChanges.file as string));
check('默认：包里点名的删除会执行', plainPlan.actions.filter(a => a.kind === 'delete').map(a => a.path), ['victim.md']);

const holdPlan = await planBundleApply(applyOptions(SC, STATE_SC, sbChanges.file as string, { skipDeletions: true }));
check('勾了"这次不执行删除"：一个删除动作都没有', holdPlan.actions.filter(a => a.kind === 'delete').length, 0);
check('报告里如实写跳过了几个', holdPlan.report.deletesSkipped, 1);
await executeBundlePlan(holdPlan, applyOptions(SC, STATE_SC, sbChanges.file as string, { skipDeletions: true }));
check('文件确实还留着', read(SC, 'victim.md'), 'V1');

// 43. 更新记录（像 git log）：每次导出 / 应用都记一笔，界面靠它说清"从哪份完整副本开始"
const LOGD = path.join(ROOT, 'machineLOG');
const STATE_LOG = path.join(ROOT, 'state-log.json');
const OUTLOG = path.join(ROOT, 'transferLOG');
fs.mkdirSync(LOGD, { recursive: true });
fs.mkdirSync(OUTLOG, { recursive: true });
write(LOGD, 'a.md', 'L1', T0);
const logFull = await exportBundle({ ...exportOptions(LOGD, STATE_LOG), outDir: OUTLOG });
let logState = await loadState(STATE_LOG);
check('导出完整副本记了一笔', logState.bundleLog.length, 1);
check('记的是导出 / 完整副本 / 立基准', describeLogEntry(logState.bundleLog[0] as BundleLogEntry).includes('→ 导出 · 完整副本'), true);
check('基准包里也记着"我站在哪份包上"', logState.bundle?.fullFile, path.basename(logFull.file as string));

write(LOGD, 'a.md', 'L2', T0 + 10_000);
const logChanges = await exportBundle({ ...exportOptions(LOGD, STATE_LOG, 'changes'), outDir: OUTLOG });
const logApplyOptions = applyOptions(LOGD, STATE_LOG, logChanges.file as string);
await executeBundlePlan(await planBundleApply(logApplyOptions), logApplyOptions);
logState = await loadState(STATE_LOG);
check('应用更新包也记一笔', logState.bundleLog.length, 3);
check('应用那条记着来自哪个仓库', logState.bundleLog[2]?.vault, '我的笔记');
check(
	'应用那条的世代是"基准 → 目标"',
	[logState.bundleLog[2]?.base, (logState.bundleLog[2]?.target ?? 0) > (logState.bundleLog[2]?.base ?? 0)],
	[1, true],
);
const position = describeBundlePosition(logState);
checkTrue('顶部能说清站在哪份基准上', position[0]?.includes('第 1 代') === true, position[0] ?? '');
checkTrue(
	'也说清了之后收发过多少',
	position[1]?.includes('导出过 1 个') === true && position[1]?.includes('应用过 1 个') === true,
	position[1] ?? '',
);

// 记录是有上限的：不能把状态文件撑大
const capped = await loadState(STATE_LOG);
for (let index = 0; index < BUNDLE_LOG_LIMIT + 20; index++) {
	appendBundleLog(capped, {
		at: Date.now(), direction: 'export', mode: 'changes', bundleId: `id-${index}`,
		base: 1, target: 2, entries: 1, deleted: 0,
	});
}
check('记录最多留上限那么多条', capped.bundleLog.length, BUNDLE_LOG_LIMIT);
check('留下的是最近的', capped.bundleLog.at(-1)?.bundleId, `id-${BUNDLE_LOG_LIMIT + 19}`);

// 44. 欠账式回传：应用别人的包**不会立刻生成回礼包**（那会互相套娃），只记一笔账
const PD = path.join(ROOT, 'machinePD');
const PE = path.join(ROOT, 'machinePE');
const STATE_PD = path.join(ROOT, 'state-pd.json');
const STATE_PE = path.join(ROOT, 'state-pe.json');
const OUTP = path.join(ROOT, 'transferP');
fs.mkdirSync(PD, { recursive: true });
fs.mkdirSync(PE, { recursive: true });
fs.mkdirSync(OUTP, { recursive: true });
write(PD, 'shared.md', 'P1', T0);
const pdFull = await exportBundle({ ...exportOptions(PD, STATE_PD), outDir: OUTP });
const peApplyOptions = applyOptions(PE, STATE_PE, pdFull.file as string);
await executeBundlePlan(await planBundleApply(peApplyOptions), peApplyOptions);

// E 自己改了东西，PD 也改了东西：PD 的更新包发过来，E 应用
write(PD, 'shared.md', 'P2', T0 + 10_000);
write(PE, 'mine.md', 'M1', T0 + 10_000);
const pdChanges = await exportBundle({ ...exportOptions(PD, STATE_PD, 'changes'), outDir: OUTP });
const pePlan = await planBundleApply(applyOptions(PE, STATE_PE, pdChanges.file as string));
await executeBundlePlan(pePlan, applyOptions(PE, STATE_PE, pdChanges.file as string));
const peState = await loadState(STATE_PE);
check('应用完只记一笔"欠回传"的账', peState.pendingReturn?.changes, 1);
check('账里写着收到的是哪个包', peState.pendingReturn?.file, path.basename(pdChanges.file as string));
check('没有立刻生成回礼包（不会套娃）', fs.readdirSync(path.join(OUTP, 'changes')).length, 1);

// 导一次更新包：账结清，而且这一个包里两半都在（E 自己的 + 刚收到的回声）
const peReturn = await exportBundle({ ...exportOptions(PE, STATE_PE, 'changes'), outDir: OUTP });
const peReturnInfo = await readBundleInfo(peReturn.file as string);
check('回传包里带着"我这半"', peReturnInfo.header.entries.some(e => e.path === 'mine.md'), true);
check('也带着对方那半（累积语义，对方应用时会自动跳过）', peReturnInfo.header.entries.some(e => e.path === 'shared.md'), true);
check('导出之后欠账结清', (await loadState(STATE_PE)).pendingReturn, null);

console.log(`\n共 ${checks} 次检查，失败 ${failures.length} 项`);
for (const message of failures.slice(0, 10)) console.log("\n❌ " + message);
if (failures.length > 10) console.log(`\n…… 其余 ${failures.length - 10} 项失败已省略`);
if (failures.length > 0) process.exitCode = 1;
