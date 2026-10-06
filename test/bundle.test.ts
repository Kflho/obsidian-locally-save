/**
 * 同步包：容器格式 → 导出 → 应用（快速通道 / 降级合并 / 删除判定 / 损坏拒绝）。
 *
 * 这里刻意用**两个临时"仓库"**模拟两台机器：A 导出、B 应用，
 * 把"世代对得上 / 对不上"两条路都走一遍。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { executeBundlePlan, planBundleApply, APPLY_CHOICES, findApplyChoice } from '../src/bundle/apply';
import type { ApplyOptions, ApplyPlan, ApplyStrictness } from '../src/bundle/apply';
import { baselineOfBundle, listingHash } from '../src/bundle/baseline';
import { anchorOptions, listFullAnchors } from '../src/bundle/anchor';
import { appendBundleLog, BUNDLE_LOG_LIMIT, describeBundlePosition, describeExportRange, describeLogEntry, describeStateId } from '../src/bundle/log';
import type { BundleLogEntry } from '../src/sync/state';
import { exportBundle, parkLocalChangesFor, planBundleExport, plannedExportModes } from '../src/bundle/export';
import type { ExportOptions, ExportOutcome } from '../src/bundle/export';
import { BUNDLE_FORMAT, BUNDLE_VERSION, readBundleInfo, readEntry, verifyBundle, writeBundle } from '../src/bundle/format';
import { bundleBaseDir, bundleDirForMode, bundleDirsToScan } from '../src/bundle/paths';
import { mergeBundleGroup, planBundleMerges } from '../src/bundle/merge';
import type { MergeOptions } from '../src/bundle/merge';
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
import { DEFAULT_SETTINGS } from '../src/settings/model';
import type { PluginSettings } from '../src/settings/model';
import { scanTree } from '../src/sync/disk';
import { loadState, saveState } from '../src/sync/state';
import { compareStateId, computeStateId } from '../src/sync/state-id';
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
	} = {},
): ApplyOptions {
	return { settings: settings(), log, vaultRoot: root, stateFile, file, ...options };
}

const STATE_A = path.join(ROOT, 'state-a.json');
const STATE_B = path.join(ROOT, 'state-b.json');
/**
 * 一份**跟那些更新包同源**的完整副本（＝ A 的第一份完整包，内容一字不差）。
 *
 * 为什么单独立一份：更新包（`KEPT_CHANGES` / `fourth` …）都以 A 的**第一份**完整包为基准，
 * 而机器要应用更新包就必须跟它同一份基准（见 `checkAncestor`）。
 * 后面导出会清掉被取代的旧包，所以留一份稳定的副本给那些机器当起点。
 */
const WITH_KEEP = path.join(OUT, 'with-keep.lsave');

/**
 * 手搓一个「更新包」：只给要覆盖的头部字段。
 *
 * 用来演那几处**真导出凑不出来**的边角 —— 真包的 `emptyDirs` 是"导出方全部空文件夹"的清单、
 * 跟着仓库内容走，临时造不出"包里就有这几个空文件夹"这种特定清单。
 * 写出来的包跟真包一样走 plan / execute 两步，不是替身。
 */
async function craftBundle(file: string, overrides: Partial<Parameters<typeof writeBundle>[1]>): Promise<string> {
	await writeBundle(file, {
		format: BUNDLE_FORMAT,
		version: BUNDLE_VERSION,
		bundleId: '00000000-0000-4000-8000-0000000000ee',
		parentBundleId: null,
		created: Date.now(),
		mode: 'changes',
		vault: '我的笔记',
		lineage: 'crafted-lineage',
		source: { copyId: 'crafted-copy', generation: 0 },
		baseGeneration: 0,
		targetGeneration: 1,
		deleted: [],
		emptyDirs: [],
		...overrides,
	}, []);
	return file;
}

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
check('包文件名带仓库名与模式（完整 / 更新，见 28b 那组断言）', path.basename(FILE_FULL).includes('我的笔记-完整'), true);

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

// 5. 基准点链条：**导出＝从链条末端往外延伸**；
//    中间断了一环（B 没应用第 3 个包）就直接拒绝，并说清"从哪个基准点开始"
// （修改时间要拉开：大小相同、又在 2 秒容差内的话，会被当成"没改过"）
const T3 = Date.now();
write(A, 'notes/a.md', 'AAA-V3', T3);
const third = await exportBundle(exportOptions(A, STATE_A, 'changes'));
checkTrue('第三个包导出成功（B 故意不应用）', third.file !== null, third.reason ?? '');
const thirdInfo = await readBundleInfo(third.file as string);
const thirdTarget = thirdInfo.header.targetBaselineHash as string;
checkTrue('每个包都记着自己落到哪一个基准点（链条靠它首尾相接）', typeof thirdTarget === 'string', JSON.stringify(thirdTarget));
write(A, 'notes/a.md', 'AAA-V4', T3 + 60_000);
write(A, 'notes/new.md', 'NEW', T3 + 60_000);
const fourth = await exportBundle(exportOptions(A, STATE_A, 'changes'));
checkTrue('第四个包导出成功', fourth.file !== null, fourth.reason ?? '');
checkTrue('同秒内连导两个包不会互相覆盖', third.file !== fourth.file, `都写到了 ${third.file}`);

const fourthInfo = await readBundleInfo(fourth.file as string);
check('第四个包从第三个包的**落点**往外延伸', fourthInfo.header.baselineHash, thirdTarget);
check('起点也换成了那一环的落点（不再是那份完整副本）', fourthInfo.header.baseGeneration, thirdInfo.header.targetGeneration);
check(
	'这一份只装自那个落点以来的改动（a.md 与 new.md）',
	fourthInfo.header.entries.map(entry => entry.path).sort(),
	['notes/a.md', 'notes/new.md'],
);

// B 站在第 2 个包的落点上 → 第四个包的起点不是它站的点。
// **但它算得出来"应用完正好落到第四份包送到的那一点"**（本机这点 ＋ 包里条目 − 点名删除
// 等于包头报的落点）→ 放行（用户拍的板："覆盖对方基准点的任意更新包都是可加载的"）。
// 以前这里一律拒收，判定只认"起点严格相等"，太死。
const bPointBefore = (await loadState(STATE_B)).bundle?.fullHash as string;
const gapPlan = await planBundleApply(applyOptions(B, STATE_B, fourth.file as string));
check('起点对不上、但算出来正好落到包里报的那一点 → 放行', gapPlan.report.viaMine, true);
checkTrue(
	'放行的理由说出来（不是"起点对不上"那种拒绝）',
	gapPlan.report.viaMine && typeof bPointBefore === 'string',
	String(bPointBefore),
);

// 把缺的那一环补上（链条就在文件夹里）：按 third → fourth 的顺序应用
const thirdOptions = applyOptions(B, STATE_B, third.file as string);
const thirdPlan = await planBundleApply(thirdOptions);
check('缺的那一环：起点正好是本机的点 → 基准一致', thirdPlan.report.baselineMatch, 'match');
await executeBundlePlan(thirdPlan, thirdOptions);
const fourthOptions = applyOptions(B, STATE_B, fourth.file as string);
plan = await planBundleApply(fourthOptions);
check('按顺序接上 → 快通道', plan.report.mode, 'fast');
check('本地停在"我发过的中间版本" → 不算冲突', plan.report.conflicts, 0);
check('新文件算新增', plan.report.adds, 1);
result = await executeBundlePlan(plan, fourthOptions);
check('接上链条：a.md 是最新的', read(B, 'notes/a.md'), 'AAA-V4');
check('接上链条：新文件写进来了', read(B, 'notes/new.md'), 'NEW');
checkTrue('没有产生冲突副本（认得出中间版本）', !hasConflictCopy(B, 'notes'), '不该有冲突副本');
check(
	'应用完两边站在同一个基准点上',
	(await loadState(STATE_B)).bundle?.fullHash,
	(await loadState(STATE_A)).bundle?.fullHash,
);

// 5a. 同一个包再打开一次：本地已经全一致
const again = await planBundleApply(applyOptions(B, STATE_B, fourth.file as string));
check('已经应用过的包 → 同步程度 100%', again.report.syncPercent, 100);
check('全部条目都被跳过', again.report.skips, 2);

// 刚才应用的那个完整包（`FILE_CHANGES` 所基于的那一份）存一份稳定的副本：
// 后面凡是要"先应用完整副本、再应用更新包"的机器都得从它起步（同一份基准才收更新包）
fs.copyFileSync(FILE_FULL, WITH_KEEP);

// 5a2. 手里停在我发过的**中间版本**上 → 不算冲突：
//      包里记着"这个文件经历过的中间版本"，认得出"这是你发过的，不是我自己改的"
//
// （本机得先站到 `third` 的**起点**上：链条模型下"起点不是本机这一点"直接拒绝，
//   所以这里按顺序应用 完整副本 → 第二个包，正好停在第 2 个包的落点上。）
const I = path.join(ROOT, 'machineI');
const STATE_I = path.join(ROOT, 'state-i.json');
fs.mkdirSync(I, { recursive: true });
// 拿稳定副本应用：后面每导一个新包都会清掉被取代的旧包，而这一步要用"那一份包"
for (const file of [WITH_KEEP, KEPT_CHANGES]) {
	await executeBundlePlan(await planBundleApply(applyOptions(I, STATE_I, file)), applyOptions(I, STATE_I, file));
}
const thirdEntry = (await readBundleInfo(third.file as string)).header.entries.find(entry => entry.path === 'notes/a.md');
const past = thirdEntry?.history?.[0];
checkTrue('包里带着中间版本记录', past !== undefined, JSON.stringify(thirdEntry?.history));
if (past) {
	write(I, 'notes/a.md', 'AAA', past.mtime); // 手里正是那个中间版本（记录对得上）
	const lostPlan = await planBundleApply(applyOptions(I, STATE_I, third.file as string));
	check('手里是我发过的中间版本 → 不算冲突', lostPlan.report.conflicts, 0);
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

// 8. 删除与新增：应用**完整副本**是镜像 —— 包里没有的本地文件（含"对方从没见过"的）都挪进回收目录
const C = path.join(ROOT, 'machineC');
const STATE_C = path.join(ROOT, 'state-c.json');
fs.mkdirSync(C, { recursive: true });
write(A, 'only.md', 'ONLY');
const full = await exportBundle(exportOptions(A, STATE_A));
checkTrue('再导一个完整包', full.file !== null, full.reason ?? '');
const fullInfo = await readBundleInfo(full.file as string);

// C 先应用一遍，于是它有了基准
await executeBundlePlan(
	await planBundleApply(applyOptions(C, STATE_C, full.file as string)),
	applyOptions(C, STATE_C, full.file as string),
);
// C 自己也有一个"包里根本没有"的文件
write(C, 'only-mine.md', 'MINE', fullInfo.header.created + 60_000);

// 对方删掉一个文件、又加了一个，重新导完整包
const victim = 'notes/a.md';
checkTrue('C 里有这个文件', exists(C, victim), `缺 ${victim}`);
fs.rmSync(abs(A, victim));
write(A, 'brand-new.md', 'NEW');
const second = await exportBundle(exportOptions(A, STATE_A));
checkTrue('第二个完整包', second.file !== null, second.reason ?? '');

plan = await planBundleApply(applyOptions(C, STATE_C, second.file as string));
check('镜像：要挪走 2 个（对方删掉的 notes/a.md + 我独有的 only-mine.md）', plan.report.deletes, 2);
check('两个都算"包里没有它"（不是包里点名删的）', plan.report.extraDeletes, 2);
check('对方新加的是新增', plan.report.adds, 1);

result = await executeBundlePlan(plan, applyOptions(C, STATE_C, second.file as string));
check('对方删掉的文件这边也删了', exists(C, victim), false);
check('删掉的进了回收目录（没直接消失）', fs.existsSync(path.join(C, '.trash', 'locally-save')), true);
// 镜像的承诺就是"仓库 == 包"：本机独有的文件也留不下（但它是**挪进回收目录**，不是真删）
checkTrue('本机独有的文件也挪走了（镜像的语义）', !exists(C, 'only-mine.md'), '镜像不该留下包里没有的文件');
check('那份同样在回收目录里，捞得回来', findBackups(C, 'only-mine.md'), ['MINE']);
check('对方新加的文件到了', read(C, 'brand-new.md'), 'NEW');

// 9. 应用**完整副本**时的"两边都改过"：镜像是**包里的版本占原名**，本机那份挪进回收目录
// （更新包那边才是"留两份、新的占原名"，见用例 15；完整副本不合并，所以没有冲突副本这一说）
const F = path.join(ROOT, 'machineF');
const STATE_F = path.join(ROOT, 'state-f.json');
fs.mkdirSync(F, { recursive: true });
// F 先应用一遍，拿到基准
await executeBundlePlan(
	await planBundleApply(applyOptions(F, STATE_F, second.file as string)),
	applyOptions(F, STATE_F, second.file as string),
);
check('基准建立：文件在 F 里', read(F, 'brand-new.md'), 'NEW');

// 两边都改同一个文件，F 改得更新（镜像不看新旧：包的版本一律赢）
write(F, 'brand-new.md', 'F 改的（更新）', Date.now() + 600_000);
write(A, 'brand-new.md', 'A 改的（更旧）', Date.now() + 300_000);
const thirdFull = await exportBundle(exportOptions(A, STATE_A));
checkTrue('第三个完整包', thirdFull.file !== null, thirdFull.reason ?? '');

plan = await planBundleApply(applyOptions(F, STATE_F, thirdFull.file as string));
check('镜像没有"冲突"这一说', plan.report.conflicts, 0);
result = await executeBundlePlan(plan, applyOptions(F, STATE_F, thirdFull.file as string));
check('包里的版本占原名（哪怕本机那份更新）', read(F, 'brand-new.md'), 'A 改的（更旧）');
checkTrue('仓库里不会留下冲突副本（镜像不需要它）', !hasConflictCopy(F, '.'), '留在原地的副本会跟着同步传出去');
checkTrue(
	'本机改过的那份挪进了回收目录（捞得回来）',
	findBackups(F, 'brand-new.md').includes('F 改的（更新）'),
	'没在回收目录里找到本机那一份',
);
check('回收目录里存的就是它（一字不差，没被谁改过）', readConflictCopy(F), 'F 改的（更新）');

// 10. 本地那份只是"旧副本"（包里没给基准）→ 直接覆盖，不该留冲突副本
const G = path.join(ROOT, 'machineG');
const STATE_G = path.join(ROOT, 'state-g.json');
fs.mkdirSync(G, { recursive: true });
const thirdFullInfo = await readBundleInfo(thirdFull.file as string);
write(G, 'brand-new.md', '很旧的副本', thirdFullInfo.header.created - 600_000);
plan = await planBundleApply(applyOptions(G, STATE_G, thirdFull.file as string));
check('比包旧的本地副本不算冲突', plan.report.conflicts, 0);
checkTrue('算作覆盖', plan.report.overwrites >= 1, `实际 ${plan.report.overwrites}`);

// 12. 应用**完整副本**（镜像）：本机独有的文件会被挪进回收目录 —— 第一次就挪，不是"第二次才删"
// （镜像是"仓库 == 包"，所以它留不下；但它是挪走，`.trash` 里捞得回来）
const J = path.join(ROOT, 'machineJ');
const STATE_J = path.join(ROOT, 'state-j.json');
fs.mkdirSync(J, { recursive: true });
write(J, 'only-mine-2.md', 'MINE'); // 应用**之前**就在，且包里没有它
await executeBundlePlan(
	await planBundleApply(applyOptions(J, STATE_J, second.file as string)),
	applyOptions(J, STATE_J, second.file as string),
);
checkTrue('镜像第一次就把它挪走了（仓库 == 包）', !exists(J, 'only-mine-2.md'), '镜像不该留下包里没有的文件');
check('那份在回收目录里，捞得回来', findBackups(J, 'only-mine-2.md'), ['MINE']);

// 再应用一次：这次什么都没得挪（仓库已经等于包）
const appliedAgain = await planBundleApply(applyOptions(J, STATE_J, second.file as string));
check('第二次应用一个删除都没有（已经等于包了）', appliedAgain.report.deletes, 0);
check('动作也是空的', appliedAgain.actions.length, 0);

// 12b. 同一件事在**更新包**那条路上再验一遍：完整副本是镜像，本来就留不下我独有的东西，
//      所以"基准别把它记进去"这个坑只能拿更新包来演 ——
//      基准只记"两边都见过"的路径，记错了第二次就会被当成"对方删过它"删掉（报过的 bug）
const J2 = path.join(ROOT, 'machineJ2');
const STATE_J2 = path.join(ROOT, 'state-j2.json');
fs.mkdirSync(J2, { recursive: true });
await executeBundlePlan(
	await planBundleApply(applyOptions(J2, STATE_J2, WITH_KEEP)),
	applyOptions(J2, STATE_J2, WITH_KEEP),
);
write(J2, 'only-mine-3.md', 'MINE'); // 站上基准之后才建：包里、基准里都没有它
await executeBundlePlan(
	await planBundleApply(applyOptions(J2, STATE_J2, KEPT_CHANGES)),
	applyOptions(J2, STATE_J2, KEPT_CHANGES),
);
checkTrue('更新包第一次应用后它还在', exists(J2, 'only-mine-3.md'), '更新包只动它点名的文件');
const appliedTwice = await planBundleApply(applyOptions(J2, STATE_J2, KEPT_CHANGES));
check('第二次应用也不会删它（基准里没记它）', appliedTwice.report.deletes, 0);
await executeBundlePlan(appliedTwice, applyOptions(J2, STATE_J2, KEPT_CHANGES));
checkTrue('第二次应用后它依然在', exists(J2, 'only-mine-3.md'), '被当成"对方删过它"删掉了');

// 13. 应用**完整副本**时，三档选项在引擎层其实是一回事：**镜像**
//     （`APPLY_CHOICES.full` 只剩 `mirror` 一项；这里照样把别的值传进来，验证引擎不认它们）
//     场景：对方做过"颠覆性改动"（大删大改），这台机器要跟包一模一样
//     （下面会从 A 删掉 notes/new.md，test 11 还要用到它，所以用完再加回来）
write(A, 'notes/new.md', 'NEW');
const L = path.join(ROOT, 'machineL');
const STATE_L = path.join(ROOT, 'state-l.json');
fs.mkdirSync(L, { recursive: true });
// 先应用 second（里面有 only.md），再造出"对方删了、我改了"和"本机新建的"
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

check('传 normal 也是镜像（完整副本不合并）', normalPlan.report.strictness, 'mirror');
check('传 bundle-wins 也一样', winsPlan.report.strictness, 'mirror');
check('三档算出同一份删除清单', [mirrorPlan.report.deletes, winsPlan.report.deletes, normalPlan.report.deletes], [2, 2, 2]);
check('我改过的、对方删了的：挪走', hasDelete(normalPlan, 'notes/new.md'), true);
check('本机新建的也挪走（镜像的承诺是"仓库 == 包"）', hasDelete(mirrorPlan, 'mine-new.md'), true);

// 执行：仓库该与包一致
await executeBundlePlan(mirrorPlan, applyOptions(L, STATE_L, noNew.file as string, { strictness: 'mirror' }));
checkTrue('执行后：我改过的、对方删了的没了', !exists(L, 'notes/new.md'), '');
checkTrue('执行后：本机新建的也没了', !exists(L, 'mine-new.md'), '');
check('执行后：包里别的文件都在', read(L, 'brand-new.md'), 'A 改的（更旧）');
check('被挪走的那份在回收目录里（没真消失）', findBackups(L, 'mine-new.md'), ['本机新建的']);
// 11. 删除传播：完整副本**必然传播** —— 它一律镜像，"仓库 == 包"，留着包里没有的文件反而是错的
//（「同步删除」那个开关只管**更新包**那条"按设置"的路，见这组最后两段）
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
check('关掉也一样删：完整副本不看这个开关（镜像必然传播）', deleteOff.report.deletes, 1);
checkTrue(
	'报告里如实说明这次不按开关走',
	deleteOff.report.propagateDeletions === true,
	`实际 ${deleteOff.report.propagateDeletions}`,
);

// 开关真正管用的是**更新包**（那边走"按设置"）：站到同一份基准上试一次
const HD = path.join(ROOT, 'machineHD');
const STATE_HD = path.join(ROOT, 'state-hd.json');
fs.mkdirSync(HD, { recursive: true });
await executeBundlePlan(
	await planBundleApply(applyOptions(HD, STATE_HD, WITH_KEEP)),
	applyOptions(HD, STATE_HD, WITH_KEEP),
);
check(
	'更新包 + 关掉同步删除 → 包里点名要删的先留着',
	(await planBundleApply(applyOptions(HD, STATE_HD, KEPT_CHANGES, { propagateDeletions: false }))).report.deletes,
	0,
);
check(
	'更新包 + 开着 → 照删',
	(await planBundleApply(applyOptions(HD, STATE_HD, KEPT_CHANGES, { propagateDeletions: true }))).report.deletes,
	1,
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

// 11. 包目录的解析规则（0.8.0 起必填：副本通道砍掉之后没有"跟着目标文件夹走"这个兜底了）
const base = { ...DEFAULT_SETTINGS, bundleDir: '' };
check('同步包文件夹留空 → 空串（调用方要提示去设置里填）', bundleBaseDir(base), '');
check('只有空格也算没填', bundleBaseDir({ ...base, bundleDir: '   ' }), '');
check(
	'填了同步包文件夹 → 用填的',
	bundleBaseDir({ ...base, bundleDir: 'D:/传输' }),
	'D:/传输',
);
check(
	'完整包与改动包分两个目录',
	[bundleDirForMode('D:/x', 'full'), bundleDirForMode('D:/x', 'changes')],
	['D:/x/full', 'D:/x/changes'],
);
check('找包时两个子目录都看（外加根目录，兼容早期直接放根目录的包）', bundleDirsToScan('D:/x').length, 3);
check('没填目录时不去找包', bundleDirsToScan(''), []);

// 12. 导出真的落到了对应的子目录里
check('完整包落在 full 子目录', FILE_FULL.replace(/\\/g, '/').includes('/full/'), true);
check('改动包落在 changes 子目录', FILE_CHANGES.replace(/\\/g, '/').includes('/changes/'), true);
checkTrue('包文件名带上了包 ID 前几位', path.basename(FILE_FULL).endsWith('.lsave'), FILE_FULL);

// 14. 边界：本地同路径是个**文件夹**，包里是个文件
//     - 完整副本（镜像档）：文件夹整个挪进回收目录腾位置，文件就位 —— 仓库 == 包；
//     - 更新包（"按设置"档）：报成明确失败、**不动那个文件夹**（强推只在镜像那条路上有）。
const M = path.join(ROOT, 'machineM');
const STATE_M = path.join(ROOT, 'state-m.json');
fs.mkdirSync(M, { recursive: true });
const clash = 'brand-new.md';
fs.mkdirSync(abs(M, clash), { recursive: true });
fs.writeFileSync(path.join(abs(M, clash), 'inside.txt'), 'x');

const clashFull = await planBundleApply(applyOptions(M, STATE_M, noNew.file as string));
check('完整副本一律镜像：报告里 forced 成立（界面会先问一句）', clashFull.report.forced, true);
const clashFullResult = await executeBundlePlan(clashFull, applyOptions(M, STATE_M, noNew.file as string));
// 计划里同时有"挪走这个文件夹"与"删掉文件夹里那个文件"（说的是同一批东西）：
// 后者不该因为"源已经被前一个动作搬走了"而报一条吓人的失败
check('镜像档：报告里没有失败（同一批东西被挪两次不算错）', clashFullResult.failed.map(item => item.path), []);
checkTrue('镜像档：文件就位（原来的文件夹被挪走了）', !fs.statSync(abs(M, clash)).isDirectory(), '还是目录');
check('仓库就是包：文件内容也在', read(M, clash), 'A 改的（更旧）');
check('文件夹里那份东西跟着进了回收目录（没真丢）', findBackups(M, 'inside.txt'), ['x']);

const M2 = path.join(ROOT, 'machineM2');
const STATE_M2 = path.join(ROOT, 'state-m2.json');
fs.mkdirSync(M2, { recursive: true });
await executeBundlePlan(
	await planBundleApply(applyOptions(M2, STATE_M2, WITH_KEEP)),
	applyOptions(M2, STATE_M2, WITH_KEEP),
);
fs.rmSync(abs(M2, 'notes/a.md')); // 把包里点名的那个文件换成一个同名文件夹
write(M2, 'notes/a.md/locked.txt', 'locked');
const clashNormal = await planBundleApply(applyOptions(M2, STATE_M2, KEPT_CHANGES));
const clashNormalResult = await executeBundlePlan(clashNormal, applyOptions(M2, STATE_M2, KEPT_CHANGES));
checkTrue('按设置档：目录挡路 → 记成失败而不是静默', clashNormalResult.failed.length >= 1, '没记失败');
checkTrue(
	'按设置档：失败原因说得清',
	(clashNormalResult.failed[0]?.error ?? '').includes('文件夹'),
	clashNormalResult.failed[0]?.error ?? '',
);
checkTrue(
	'按设置档：不会去动别人的文件夹',
	fs.existsSync(path.join(abs(M2, 'notes/a.md'), 'locked.txt')),
	'文件夹被动了',
);

// 15. 镜像/强制档必然先备份 —— 不给"不可恢复的批量删除"留口子
//（完整副本一律镜像，所以它天然落在"强制"那一档：用户关掉回收目录也没用）
const N = path.join(ROOT, 'machineN');
const STATE_N = path.join(ROOT, 'state-n.json');
fs.mkdirSync(N, { recursive: true });
write(N, 'mine-keep.md', 'MINE');
const strictPlan = await planBundleApply(applyOptions(N, STATE_N, noNew.file as string, {
	strictness: 'mirror',
	keepBackup: false, // 用户想把回收目录关掉
}));
check('镜像档下回收目录强制开', strictPlan.options.keepBackup, true);
check('连"不选方式"的完整副本也一样（它本来就是镜像）', (await planBundleApply(
	applyOptions(N, STATE_N, noNew.file as string, { keepBackup: false }),
)).options.keepBackup, true);

// 更新包走"按设置"那一档，这里照样听用户的
const N2 = path.join(ROOT, 'machineN2');
const STATE_N2 = path.join(ROOT, 'state-n2.json');
fs.mkdirSync(N2, { recursive: true });
await executeBundlePlan(
	await planBundleApply(applyOptions(N2, STATE_N2, WITH_KEEP)),
	applyOptions(N2, STATE_N2, WITH_KEEP),
);
check('更新包（按设置档）下照样听用户的', (await planBundleApply(applyOptions(N2, STATE_N2, KEPT_CHANGES, {
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

// 18. 空文件夹的位置上杵着个同名文件
//     - 完整副本（镜像档）：那个文件本来就"包里没有" → 先挪进回收目录，目录照建，不报失败；
//     - 更新包（"按设置"档）：那是本机的东西（包里、基准里都没有它）→ 建目录这一步如实报失败，
//       **不删它腾位置**（这条路上没有强推）。
const S = path.join(ROOT, 'machineS');
const STATE_S = path.join(ROOT, 'state-s.json');
fs.mkdirSync(S, { recursive: true });
write(S, '空目录', 'I AM A FILE');
const sPlan = await planBundleApply(applyOptions(S, STATE_S, R_FILE));
check('完整副本一律镜像：报告里 forced 成立', sPlan.report.forced, true);
const sResult = await executeBundlePlan(sPlan, applyOptions(S, STATE_S, R_FILE));
check('镜像下没有"挡路"这回事了（文件先被挪走）', sResult.failed.map(item => item.path), []);
check('那份文件在回收目录里（没真丢）', findBackups(S, '空目录'), ['I AM A FILE']);
check('目录照建', exists(S, '空目录'), true);
check('而且是文件夹（不再是同名文件）', fs.statSync(abs(S, '空目录')).isDirectory(), true);
check('能建的目录照样建', exists(S, 'notes/子目录'), true);

const S2 = path.join(ROOT, 'machineS2');
const STATE_S2 = path.join(ROOT, 'state-s2.json');
fs.mkdirSync(S2, { recursive: true });
await executeBundlePlan(
	await planBundleApply(applyOptions(S2, STATE_S2, WITH_KEEP)),
	applyOptions(S2, STATE_S2, WITH_KEEP),
);
write(S2, '空目录', 'I AM A FILE'); // 应用之后才放的本机文件：基准里没有它
const craftEmptyDirs = await craftBundle(path.join(OUT, 'crafted-empty-dirs.lsave'), {
	baselineHash: baselineOfBundle((await readBundleInfo(WITH_KEEP)).header) as string,
	emptyDirs: ['空目录', 'notes/子目录'],
});
const s2Plan = await planBundleApply(applyOptions(S2, STATE_S2, craftEmptyDirs));
const s2Result = await executeBundlePlan(s2Plan, applyOptions(S2, STATE_S2, craftEmptyDirs));
checkTrue(
	'更新包：同名文件挡路 → 记成失败（而不是把它删掉腾位置）',
	s2Result.failed.some(item => item.error.includes('同名文件')),
	JSON.stringify(s2Result.failed),
);
check('那个文件原样还在', read(S2, '空目录'), 'I AM A FILE');
check('能建的目录照样建', exists(S2, 'notes/子目录'), true);

// 19. 目录（空文件夹）的两条路完全不同
//     - 完整副本（镜像档）：包里没有的本地目录**一律清掉**（连本机新建的）—— 仓库 == 包；
//     - 更新包（"按设置"档）：只删**基准里记过**的（＝对方删过它），本机新建的留着；
//       「同步删除」关掉时一个都不删。
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

// 完整副本＝镜像：两个都清掉（它不看基准，也不看「同步删除」开关）
const t2Mirror = await planBundleApply(applyOptions(T2, STATE_T2, R_FILE));
check('镜像：本机新建的也删', t2Mirror.foldersToRemove.slice().sort(), ['对方删过的目录', '本机新建的'].sort());
const t2MirrorResult = await executeBundlePlan(t2Mirror, applyOptions(T2, STATE_T2, R_FILE));
check('镜像：两个都删掉了', [exists(T2, '本机新建的'), exists(T2, '对方删过的目录')], [false, false]);
check('镜像：结果里记了清理数', t2MirrorResult.foldersRemoved, 2);
check(
	'镜像之后：仓库里没有"包里没有的目录"了（文件与文件夹都对齐）',
	listDirs(T2).filter(dir => !bundleDirs.has(dir)),
	[],
);
check(
	'包里有的空文件夹一个不缺',
	listDirs(T2).every(dir => bundleDirs.has(dir)),
	true,
);

// 更新包那条路才看基准与「同步删除」开关：把两个目录与基准都补回来
fs.mkdirSync(abs(T2, '本机新建的'), { recursive: true });
fs.mkdirSync(abs(T2, '对方删过的目录'), { recursive: true });
const reseed = await loadState(STATE_T2);
reseed.bundle = {
	...reseed.bundle!,
	dirs: [...(reseed.bundle?.dirs ?? []), '对方删过的目录'],
};
await saveState(STATE_T2, reseed);

// 更新包的 `emptyDirs` 是"导出方**全部**空文件夹"的清单（不是增量）：这份里没有"对方删过的目录"
// → 对站在基准上的接收方来说，那就是"对方把它删了"
const craftDirs = await craftBundle(path.join(OUT, 'crafted-dirs.lsave'), {
	baselineHash: baselineOfBundle(qInfo.header) as string,
	lineage: qInfo.header.lineage,
	baseGeneration: 1,
	emptyDirs: qInfo.header.emptyDirs,
});
const t2Normal = await planBundleApply(applyOptions(T2, STATE_T2, craftDirs));
check('按设置档：只删基准里记过的那个', t2Normal.foldersToRemove, ['对方删过的目录']);
check('按设置档：报告里也写了要删几个', t2Normal.report.foldersToRemove, 1);

// 关掉「同步删除」：目录也一个都不删（开关不能只管文件）
const t2NoDelete = await planBundleApply(applyOptions(T2, STATE_T2, craftDirs, { propagateDeletions: false }));
check('关掉同步删除 → 目录也不删', t2NoDelete.foldersToRemove, []);

const t2NormalResult = await executeBundlePlan(t2Normal, applyOptions(T2, STATE_T2, craftDirs));
check('按设置档：删掉了', exists(T2, '对方删过的目录'), false);
check('按设置档：本机新建的留着', exists(T2, '本机新建的'), true);
check('按设置档：结果里记了清理数', t2NormalResult.foldersRemoved, 1);

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

// 21. 更新包 + 严格档 → **应用完就是包送到的状态**（0.11 起不再降级）
// 起点必须与本机站的基准点相等（`checkAncestor` 保证），所以"送到的状态"是确定的：
// ＝ 我站的那一点 ＋ 包里点名的条目 − 包里点名的删除 —— 镜像它不会清空仓库。
const V = path.join(ROOT, 'machineV');
const STATE_V = path.join(ROOT, 'state-v.json');
fs.mkdirSync(V, { recursive: true });
// 先站到同一份基准上：**更新包必须有共同祖先才收**（见 checkAncestor）
await executeBundlePlan(
	await planBundleApply(applyOptions(V, STATE_V, WITH_KEEP)),
	applyOptions(V, STATE_V, WITH_KEEP),
);
write(V, 'notes/keep.md', 'KEEP'); // 应用之后才建：本机独有，包里没有它
const vPlan = await planBundleApply(applyOptions(V, STATE_V, KEPT_CHANGES, { strictness: 'mirror' }));
check('更新包用严格档 → 就是严格档', vPlan.report.strictness, 'mirror');
check('报告里 forced 成立（严格档）', vPlan.report.forced, true);
check(
	'删除动作：包里点名的 notes/b.md，加上包里没有的 notes/keep.md（严格档下本地多出来的也要挪走）',
	vPlan.actions.filter(action => action.kind === 'delete').map(action => action.path).sort(),
	['notes/b.md', 'notes/keep.md'],
);
await executeBundlePlan(vPlan, applyOptions(V, STATE_V, KEPT_CHANGES, { strictness: 'mirror' }));
check('应用完仓库就是包送到的状态', [read(V, 'notes/a.md'), read(V, 'notes/keep.md')], ['AAA-CHANGED', null]);
checkTrue('我自己的文件没丢：挪进了回收目录', findBackups(V, 'notes/keep.md').includes('KEEP'), JSON.stringify(findBackups(V, 'notes/keep.md')));
check('包里点名要删的照做（那是它明说的）', exists(V, 'notes/b.md'), false);
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
// 更新包必须有共同祖先才收（见 checkAncestor），所以先站到它基于的那份完整副本上
const yFull = await planBundleApply(applyOptions(Y, STATE_Y, WITH_KEEP));
await executeBundlePlan(yFull, applyOptions(Y, STATE_Y, WITH_KEEP));
write(Y, 'notes/keep.md', 'KEEP'); // 应用之后才建：本机独有，基准里没有它
check('先应用完整包：本机自己那份也在', read(Y, 'notes/keep.md'), 'KEEP');
const yChanges = await planBundleApply(applyOptions(Y, STATE_Y, KEPT_CHANGES));
check(
	'更新包：只删它点名的那个（notes/b.md），没提到的 notes/keep.md 不在里面',
	yChanges.actions.filter(action => action.kind === 'delete').map(action => action.path),
	['notes/b.md'],
);
check('报告里的删除数就是那一个', yChanges.report.deletes, 1);
check('"对方删过的"这个数还是 0（更新包只认自己的删除清单）', yChanges.report.extraDeletes, 0);
await executeBundlePlan(yChanges, applyOptions(Y, STATE_Y, KEPT_CHANGES));
check('应用之后我自己的文件还在（更新包只动它提到的东西）', read(Y, 'notes/keep.md'), 'KEEP');
check('包里点名删的、本地没有的：什么都不用做', yChanges.report.keptDeletes, 0);

// 另一半：**完整副本**是完整清单 + 镜像 —— 包里没有的一律清掉（对方删过的、我独有的都在内）
fs.rmSync(abs(Q, 'notes/keep.md'));
const qFull2 = await exportBundle(exportOptions(Q, STATE_Q));
checkTrue('再导一份不含 notes/keep.md 的完整包', qFull2.file !== null, qFull2.reason ?? '');
const yFull2 = await planBundleApply(applyOptions(Y, STATE_Y, qFull2.file as string));
check('完整副本一律镜像：报告里 forced 成立', yFull2.report.forced, true);
check(
	'完整包：包里没有的都清掉（notes/a.md 是刚才更新包带进来的，notes/keep.md 是我自己的）',
	yFull2.actions.filter(action => action.kind === 'delete').map(action => action.path),
	['notes/a.md', 'notes/keep.md'],
);
await executeBundlePlan(yFull2, applyOptions(Y, STATE_Y, qFull2.file as string));
check('删掉了', exists(Y, 'notes/keep.md'), false);
check('我自己那份也挪进了回收目录（没真丢）', findBackups(Y, 'notes/keep.md'), ['KEEP']);

// 26.（0.11 删掉了「更新包攒大了提醒换基准」那一套：链条模型下每份更新包只装自上一环
// 以来的新改动，不存在"越攒越大"；要立还原点随时可以在「管理同步包…」里手动立）

// 27. **链条模型**：每导一次更新包就是链条上的**一环** —— 各环并存，
// 删了它，还站在那一环起点的机器就接不上来了。只有**完整副本**能取代它们（换基准那条路）。
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
const aaC1Info = await readBundleInfo(aaC1.file as string);
const aaC2Info = await readBundleInfo(aaC2.file as string);
check('首尾相接：下一环的起点 ＝ 上一环的落点', aaC2Info.header.baselineHash, aaC1Info.header.targetBaselineHash);
check(
	'链条上的每一环都留着（删了后面的机器就接不上）',
	fs.readdirSync(changesDir).sort(),
	[path.basename(aaC1.file as string), path.basename(aaC2.file as string)].sort(),
);
check('不同环之间谁也取代不了谁', aaC2.superseded, []);
checkTrue(
	'但要说清"留着的是链条上的另一环"',
	aaC2.keptChanges.some(item => item.why.includes('链条上的另一环')),
	JSON.stringify(aaC2.keptChanges),
);
check('完整包留着（还原点）', fs.existsSync(aaFull.file as string), true);

// 两个一起导：完整包**会**取代链条上的旧环 —— 它是完整清单，站在老环上的机器直接应用它就行
write(AA, 'd.md', 'D1');
const aaC3 = await exportBundle({ ...exportOptions(AA, STATE_AA, 'changes'), outDir: OUT2 });
const aaF2 = await exportBundle({
	...exportOptions(AA, STATE_AA),
	outDir: OUT2,
	keepPaths: [aaC3.file as string],
});
check('同一次导出的更新包不会被完整包清掉', fs.existsSync(aaC3.file as string), true);
check(
	'更早的那两环被完整包取代了',
	[...aaF2.superseded].sort(),
	[path.basename(aaC1.file as string), path.basename(aaC2.file as string)].sort(),
);
check('这次完整包没删别的（该删的上一轮已删）', aaF2.superseded.includes(path.basename(aaC3.file as string)), false);

// 换基准之后再导更新包：新的环从**新基准点**往外延伸，前面留下的环照样不动
write(AA, 'e.md', 'E1');
const aaC4 = await exportBundle({ ...exportOptions(AA, STATE_AA, 'changes'), outDir: OUT2 });
check(
	'新的环从新基准点往外延伸',
	(await readBundleInfo(aaC4.file as string)).header.baselineHash,
	baselineOfBundle(aaF2.header as NonNullable<typeof aaF2.header>),
);
checkTrue(
	'没删掉的那份要说清为什么（链条上的另一环）',
	aaC4.keptChanges.length > 0 && aaC4.keptChanges.every(item => item.why.includes('链条上的另一环')),
	JSON.stringify(aaC4.keptChanges),
);

// 再导一环：上一环还是留着（链条不删环）
write(AA, 'f.md', 'F1');
const aaC5 = await exportBundle({ ...exportOptions(AA, STATE_AA, 'changes'), outDir: OUT2 });
check('再导一环：没有谁被取代', aaC5.superseded, []);
check(
	'于是 changes 里留着完整的三环',
	fs.readdirSync(changesDir).sort(),
	[aaC3.file as string, aaC4.file as string, aaC5.file as string].map(item => path.basename(item)).sort(),
);

// 28b. 文件名要**一眼看得懂**：哪种包 + 第几代到第几代 + 目标状态（用户提的："包起名太费解"）
check('完整包文件名：完整 + 第几代 + 目标状态', path.basename(FILE_FULL).includes('我的笔记-完整-1代-状态'), true);
check(
	'文件名里的状态编号就是包头部那个（接收方该落到的状态）',
	path.basename(FILE_FULL).includes(info.header.stateId?.id ?? '没有编号'),
	true,
);
check('更新包文件名：更新 + 从第几代到第几代', path.basename(FILE_CHANGES).includes('我的笔记-更新-1代到2代-状态'), true);
check(
	'更新包文件名里的状态编号也是头部那个',
	path.basename(FILE_CHANGES).includes(changed.header?.stateId?.id ?? '没有编号'),
	true,
);
check(
	'文件名以包 ID 前几位收尾（同秒连导两个不会互相覆盖），不再带时间戳',
	/-\d+代(到\d+代)?-状态[0-9a-f]{16}-[0-9a-f]{6}\.lsave$/.test(path.basename(FILE_FULL)),
	true,
);
check('名字里没有那串时间戳了', /\d{8}-\d{6}/.test(path.basename(FILE_FULL)), false);
// 老名字（full / changes）照样认得出类型 —— 老包读不出头部时不该掉进"类型未知"
const legacyNames = path.join(OUT, 'legacy-names');
fs.mkdirSync(legacyNames, { recursive: true });
fs.writeFileSync(path.join(legacyNames, '旧的-full-20260101-000000-cccccc.lsave'), 'nope');
fs.writeFileSync(path.join(legacyNames, '新的-更新-1代到2代-状态abcdef-20260101-000000-dddddd.lsave'), 'nope');
const legacyListed = await listBundles(legacyNames);
check(
	'读不出头部时按文件名认类型（新老两种写法都认）',
	legacyListed.map(item => `${item.name.split('-')[0]}:${item.mode}`).sort(),
	['新的:changes', '旧的:full'],
);
fs.rmSync(legacyNames, { recursive: true, force: true });

// 28c. 一次导两种的顺序：**先完整副本、后更新包**
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
	['更新包', '完整副本', '类型未知（读不出包信息）'],
);
check(
	'每组里面都是从新到老（输入顺序打乱也一样）',
	grouped.map(group => group.items.map(item => item.name)),
	[['c-new', 'c-mid'], ['f-new', 'f-old'], ['weird']],
);

// 34. 「应用方式」两类包各只剩一项（0.11 起界面上不再给选择，见 APPLY_CHOICES 上的注释）
// 完整副本**没有可选项**：应用方式固定是镜像 —— 合并它会有无穷多种结果，
// 每一种都能配出一个"既不等于包、又不等于本机"的仓库
check(
	'完整副本那套：只有完全镜像一项',
	APPLY_CHOICES.full.map(item => item.key),
	['mirror'],
);
check(
	'更新包那套：只剩严格同步一项',
	APPLY_CHOICES.changes.map(item => item.key),
	['strict'],
);
check(
	'默认那档就是「严格同步」—— 应用完仓库 == 包送到的状态',
	[APPLY_CHOICES.changes[0]?.key, APPLY_CHOICES.changes[0]?.strictness],
	['strict', 'mirror'],
);
check('选了一个不在这一套里的档 → 落到默认档（严格同步）', findApplyChoice('changes', 'bundle-wins').key, 'strict');
check(
	'完整副本那一套只剩一项 → 传什么进来都落到它',
	[findApplyChoice('full', 'normal').key, findApplyChoice('full', 'bundle-wins').key],
	['mirror', 'mirror'],
);

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
check('以包为准：算出"覆盖一个本地改过的"', [revertPlan.report.forcedOverwrites, revertPlan.report.conflicts], [1, 0]);
await executeBundlePlan(revertPlan, revertOptions);
check('a.md 退回了包里那一版', read(ZB, 'a.md'), 'A2');
check('我改坏的那份没丢：在回收目录里', findBackups(ZB, 'a.md'), ['B-WRONG']);
check('包里点名要删的照删（我又建回来的 c.md）', read(ZB, 'c.md'), null);
check('它同样进了回收目录', findBackups(ZB, 'c.md').includes('C-AGAIN'), true);
check('包里没提到的：我自己的文件一个没动', read(ZB, 'mine.md'), 'MINE');
check('包里没提到的：b.md 也还在', read(ZB, 'b.md'), 'B1');

// 对照：更新包的严格档现在**不降级**，而且删的只有「包里点名 ＋ 本地多出来」的那些
const forcedPlan = await planBundleApply(applyOptions(ZB, STATE_ZB, zChanges.file as string, { strictness: 'bundle-wins' }));
check('严格档对更新包一样是严格档', forcedPlan.report.strictness, 'bundle-wins');
check(
	'删的不是「没提到的所有文件」，而是包里点名 ＋ 本地多出来的那些',
	forcedPlan.actions.filter(action => action.kind === 'delete').map(action => action.path).sort(),
	['c.md', 'mine.md', 'notes/keep.md'].filter(name => exists(ZB, name)).sort(),
);

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

// 36. 世代与内容同步之后，"两个一起导"照样**每次**都能清掉老的更新包
//
// 这一组原来验的是"应用更老的包不会把世代拨回去"。现在定义换了（**世代 ＝ 内容在这个血脉里的
// 版本号**：应用完我的内容就等于那份包，状态相同则世代必须相同），应用更老的完整副本
// **就该**把世代同步回那一代 —— 这条正是新定义要的效果。
// 真正要守的是下面那件事：世代跟内容对上之后，清理"被取代的更新包"不能时好时坏。
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

// 用户做过的事：把那个完整副本又应用了一遍（更老的包）——
// 内容回到那一代，世代号也跟着同步回那一代（两边状态相同则世代必须相同）
const rBackOptions = applyOptions(RB, STATE_RB, rFull.file as string, { strictness: 'listed-wins' });
await executeBundlePlan(await planBundleApply(rBackOptions), rBackOptions);
check(
	'应用更老的完整副本：世代同步回那一代（世代 ＝ 内容的版本号）',
	(await loadState(STATE_RB)).generation,
	rFull.header?.targetGeneration,
);

/** 弹窗里"两个都勾"那一路：先完整副本、后更新包，先导出来的填进 keepPaths */
const bothAtOnce = async (): Promise<ExportOutcome> => {
	const written: string[] = [];
	const full = await exportBundle({ ...exportOptions(RB, STATE_RB), outDir: OUTR, keepPaths: written });
	written.push(full.file as string);
	await exportBundle({ ...exportOptions(RB, STATE_RB, 'changes'), outDir: OUTR, keepPaths: written });
	return full;
};
// 内容回到第 1 代之后，第 2 代那一环**比本机现在的内容更新** —— 那是那份内容的唯一副本，
// 按"不许删比我更新的包"留着，并说清为什么；两遍行为必须一致（不能时好时坏）
const firstClean = await bothAtOnce();
check('那份更新包留着（它比本机现在的内容新）', fs.existsSync(rChanges.file as string), true);
checkTrue(
	'并说清为什么留着',
	firstClean.keptChanges.some(item => item.why.includes('不比这次的新')),
	JSON.stringify(firstClean.keptChanges),
);
const secondClean = await bothAtOnce();
check('第二遍行为一致（不会时好时坏）', fs.existsSync(rChanges.file as string), true);
check('两遍的结论也一样', secondClean.superseded, firstClean.superseded);

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
	['不是同一份基准线上的包（多半是另一台机器导的）', '记的世代不比这次的新（导出过更晚的包）'].sort(),
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
check(
	'应用完整副本 → 基准点就是那份包自己的指纹',
	(await loadState(STATE_RMB)).bundle?.fullHash,
	baselineOfBundle((await readBundleInfo(raFull.file as string)).header),
);

// 两边各改各的：A 改 x，B 改 y 并新建 z（这就是"各半"）
write(RMA, 'x.md', 'X2', T0 + 10_000);
write(RMB, 'y.md', 'Y2', T0 + 10_000);
// z.md 的时间要跟 A 的 x.md 拉开：两个都是 2 字节，时间再一样的话，"认移动"那四条判据
// （新路径 + 旧路径在基准里 + 对侧没动过 + 大小与修改时间完全一致）会把它们配成一对改名
write(RMB, 'z.md', 'Z1', T0 + 20_000);
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
const aPointBefore = (await loadState(STATE_RMA)).bundle?.fullHash;
const rmbReturn = await exportBundle({ ...exportOptions(RMB, STATE_RMB, 'changes'), outDir: OUTRA });
checkTrue('回礼包导出来了', rmbReturn.file !== null, rmbReturn.reason ?? '');

// A 应用回礼包：x 与自己那份一样（跳过），拿到 B 的 y 与 z
const rmaBackOptions = applyOptions(RMA, STATE_RMA, rmbReturn.file as string);
const rmaBackPlan = await planBundleApply(rmaBackOptions);
check('A 应用它：基准一致（回礼包正是从 A 站的那一点延伸的）', rmaBackPlan.report.baselineMatch, 'match');
await executeBundlePlan(rmaBackPlan, rmaBackOptions);
check('A 拿到 B 的 y 与 z', [read(RMA, 'y.md'), read(RMA, 'z.md')], ['Y2', 'Z1']);
check('A 的 x 没被自己那份覆盖（内容一样，跳过）', read(RMA, 'x.md'), 'X2');
check('两边收敛', [read(RMA, 'x.md'), read(RMA, 'y.md'), read(RMA, 'z.md')], ['X2', 'Y2', 'Z1']);
check(
	'两边站在同一个基准点上（指纹一致）',
	(await loadState(STATE_RMA)).bundle?.fullHash,
	(await loadState(STATE_RMB)).bundle?.fullHash,
);

// 39. 基准指纹：判断"是不是接着同一份完整副本"（世代号说不出是哪一份完整副本）
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

// B 导的回礼包：**头部报的是导出前那一刻的点**（A 正站在那儿），
// 而 B 自己已经走到回礼包送到的那一点（`targetBaselineHash`）
const returnHeader = (await readBundleInfo(rmbReturn.file as string)).header;
const bAfterReturn = await loadState(STATE_RMB);
check('回礼包从"我导出的那一点"往外延伸（A 正站在那儿）', returnHeader.baselineHash, aPointBefore);
check('导完就站到回礼包送到的那一点（头部记着它）', bAfterReturn.bundle?.fullHash, returnHeader.targetBaselineHash);
check('这一点是我导的 → 等对方合并了才算确认', bAfterReturn.bundle?.pointConfirmed, false);

// 反过来：A 换了一份新基准（又导一次完整包），B 还停在老基准上。
// **判定按"算一遍落点"来**：这次算出来正好等于包里报的落点 → 放行（内容上 B 确实在路线上）；
// 算不出来才拒收（下一条用例守的就是那种）。
write(RMA, 'x.md', 'X3', T0 + 20_000);
const raFull2 = await exportBundle({ ...exportOptions(RMA, STATE_RMA), outDir: OUTRA });
write(RMA, 'x.md', 'X4', T0 + 30_000);
const raChanges2 = await exportBundle({ ...exportOptions(RMA, STATE_RMA, 'changes'), outDir: OUTRA });
checkTrue('换基准之后的更新包有内容', raChanges2.file !== null, raChanges2.reason ?? '');
const rmbAlignedPlan = await planBundleApply(applyOptions(RMB, STATE_RMB, raChanges2.file as string));
check('基准指纹对不上、但算出来正好落到包里报的那一点 → 放行', rmbAlignedPlan.report.viaMine, true);
const rmbAlignOptions = applyOptions(RMB, STATE_RMB, raFull2.file as string);
await executeBundlePlan(await planBundleApply(rmbAlignOptions), rmbAlignOptions);
check(
	'换成完整副本就对上了（完整清单自带基准，随时能接）',
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

// 0.11 删掉了「这次不执行包里的删除」那个勾：应用只有一种语义 —— 严格和包一致，
// 包里点名要删的照删（删掉的那份进回收目录，捞得回来）。
const holdPlan = await planBundleApply(applyOptions(SC, STATE_SC, sbChanges.file as string, { strictness: 'mirror' }));
check('严格档：点名要删的照删（没有那个开关了）', holdPlan.actions.filter(a => a.kind === 'delete').map(a => a.path), ['victim.md']);
await executeBundlePlan(holdPlan, applyOptions(SC, STATE_SC, sbChanges.file as string, { strictness: 'mirror' }));
check('文件删掉了', read(SC, 'victim.md'), null);

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
checkTrue(
	'顶部能说清站在哪个基准点上（应用完就站到那份包送到的那一点）',
	position[0]?.includes('第 2 代') === true,
	position[0] ?? '',
);
checkTrue('也说清那一点确认了没有（应用来的 → 两边都到过）', position[0]?.includes('已确认') === true, position[0] ?? '');
checkTrue(
	'也说清了之后收发过多少',
	position.some(line => line.includes('导出过 1 个') && line.includes('应用过 1 个')),
	position.join(' | '),
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

// 导一次更新包：账结清。链条模型下这一份只装**我这半**（刚收到的那半已经在基准点里了，
// 不必再当回声发一遍）；对方应用完就站到同一点上
const peReturn = await exportBundle({ ...exportOptions(PE, STATE_PE, 'changes'), outDir: OUTP });
const peReturnInfo = await readBundleInfo(peReturn.file as string);
check('回传包里带着"我这半"', peReturnInfo.header.entries.some(e => e.path === 'mine.md'), true);
check('不再带上刚收到的回声（那半已经进了基准点）', peReturnInfo.header.entries.some(e => e.path === 'shared.md'), false);
check('导出之后欠账结清', (await loadState(STATE_PE)).pendingReturn, null);

// 45. 状态编号：整个仓库的**内容**指纹 —— "两边到底一不一样"靠它，世代号回答不了（它只说第几版）
const QA = path.join(ROOT, 'machineQA');
const QB = path.join(ROOT, 'machineQB');
const STATE_QA = path.join(ROOT, 'state-qa.json');
const STATE_QB = path.join(ROOT, 'state-qb.json');
const OUTQ = path.join(ROOT, 'transferQ');
fs.mkdirSync(QA, { recursive: true });
fs.mkdirSync(QB, { recursive: true });
fs.mkdirSync(OUTQ, { recursive: true });
write(QA, 'a.md', 'Q1', T0);
write(QA, 'notes/b.md', 'Q2', T0);
fs.mkdirSync(abs(QA, '空文件夹'), { recursive: true });

const scanQ = async (root: string) => scanTree(root, { exclude: [], skipTopLevelDirs: [] });
const stateQA = await loadState(STATE_QA);
const qaScan = await scanQ(QA);
const idOf = async (
	root: string,
	state: typeof stateQA,
	files: Map<string, { size: number; mtime: number }>,
	dirs: Set<string>,
) => computeStateId({ vaultRoot: root, state, files, dirs });

const qaId = await idOf(QA, stateQA, qaScan.files, qaScan.dirs);
check('参与编号的文件 / 目录数如实统计（空文件夹也算一个）', [qaId.files, qaId.dirs], [2, 2]);
check('没有文件缺内容指纹', qaId.unverified, 0);
check('同样的仓库算两次 → 同一个编号（第二次全是缓存命中，长度必须统一）', (await idOf(QA, stateQA, qaScan.files, qaScan.dirs)).id, qaId.id);
check(
	'清单顺序不影响编号',
	(await idOf(QA, stateQA, new Map([...qaScan.files].reverse()), new Set([...qaScan.dirs].reverse()))).id,
	qaId.id,
);

// 只动修改时间、内容没变：编号**不该**变（跨机器搬过之后时间会不一样，那正是"一致"）
fs.utimesSync(abs(QA, 'a.md'), new Date(T0 + 30_000), new Date(T0 + 30_000));
const touchedScan = await scanQ(QA);
check('只改了时间、内容没变 → 编号不变', (await idOf(QA, stateQA, touchedScan.files, touchedScan.dirs)).id, qaId.id);

// 内容变了、或者多一个空文件夹：编号必须变
write(QA, 'a.md', 'Q1-changed', T0 + 40_000);
const changedScan = await scanQ(QA);
const changedQaId = await idOf(QA, stateQA, changedScan.files, changedScan.dirs);
checkTrue('内容变了 → 编号跟着变', changedQaId.id !== qaId.id, '内容变了编号却没变');
fs.mkdirSync(abs(QA, '另一个空文件夹'), { recursive: true });
const dirScan = await scanQ(QA);
const dirQaId = await idOf(QA, stateQA, dirScan.files, dirScan.dirs);
checkTrue(
	'只多一个空文件夹 → 编号也变（只比文件的话两个仓库会长得一样）',
	dirQaId.id !== changedQaId.id,
	'多了个空文件夹编号却没变',
);

// 拿不到编号的两种情况：比不了就是比不了，不硬下结论
check('有一边没有编号 → 说不清', compareStateId(null, dirQaId), 'unknown');

// 读不到的文件（被外部删了 / 读失败）：如实计数，不假装一致，也不炸
const ghost = new Map(dirScan.files);
ghost.set('ghost.md', { size: 3, mtime: T0 });
const ghostId = await idOf(QA, stateQA, ghost, dirScan.dirs);
check('读不到内容的文件如实计数', ghostId.unverified, 1);
check('编号照样算得出来（那一行按大小 + 时间顶上）', ghostId.files, 3);

// 导出：编号写进包头部、落进状态文件、也进更新记录
const qaFull = await exportBundle({ ...exportOptions(QA, STATE_QA), outDir: OUTQ });
const qaFullHeader = (await readBundleInfo(qaFull.file as string)).header;
check('完整包头部带着状态编号', typeof qaFullHeader.stateId?.id === 'string', true);
check('头部里的编号就是导出那一刻的仓库内容编号', qaFullHeader.stateId?.id, dirQaId.id);
check('状态文件里也记着"我现在长什么样"', (await loadState(STATE_QA)).stateId?.id, qaFullHeader.stateId?.id);
check('更新记录那条也带着编号', (await loadState(STATE_QA)).bundleLog.at(-1)?.stateId, qaFullHeader.stateId?.id);
const qaPosition = describeBundlePosition(await loadState(STATE_QA));
checkTrue('记录顶部写着"我现在"的编号', qaPosition.some(line => line.includes(`状态 ${qaFullHeader.stateId?.id}`)), qaPosition.join(' | '));
checkTrue(
	'编号那行也写明了规模',
	qaPosition.some(line => line.includes('3 个文件')),
	qaPosition.join(' | '),
);

// 应用：B 应用完整副本之后，两边的编号必须**一模一样** —— 这就是"两边内容一致"
const qbApplyFull = applyOptions(QB, STATE_QB, qaFull.file as string);
const qbFullResult = await executeBundlePlan(await planBundleApply(qbApplyFull), qbApplyFull);
check('应用完整副本之后：跟对方完全一致', qbFullResult.stateIdCompare, 'match');
check('编号就是对方包里那个', qbFullResult.stateId.id, qaFullHeader.stateId?.id);
check('我这边的状态文件也记上了', (await loadState(STATE_QB)).stateId?.id, qaFullHeader.stateId?.id);
check('更新记录也记上了', (await loadState(STATE_QB)).bundleLog.at(-1)?.stateId, qaFullHeader.stateId?.id);

// B 自己改一笔（对方不知道）→ 收下 A 的下一个更新包：编号**对不上**，差的就是那笔欠账
write(QB, 'mine.md', 'QB-own', T0 + 50_000);
write(QA, 'a.md', 'Q1-again', T0 + 60_000);
const qaChanges = await exportBundle({ ...exportOptions(QA, STATE_QA, 'changes'), outDir: OUTQ });
const qbApplyChanges = applyOptions(QB, STATE_QB, qaChanges.file as string);
const qbChangesPlan = await planBundleApply(qbApplyChanges);
check('应用前报告里就写着对方那个编号', typeof qbChangesPlan.report.peerStateId?.id, 'string');
const qbChangesResult = await executeBundlePlan(qbChangesPlan, qbApplyChanges);
check('B 自己还有改动 → 编号对不上', qbChangesResult.stateIdCompare, 'mismatch');
check('对不上的差别就是那笔"欠回传"', (await loadState(STATE_QB)).pendingReturn?.changes, 1);
check(
	'更新记录里两条编号不同（一眼看出还没同步完）',
	(await loadState(STATE_QB)).bundleLog.at(-1)?.stateId === qbChangesResult.stateId.id,
	true,
);

// B 把那半导出来发回去、A 应用 → **两边的编号终于对上了**（收敛的判据）
const qbReturn = await exportBundle({ ...exportOptions(QB, STATE_QB, 'changes'), outDir: OUTQ });
const qaApplyReturn = applyOptions(QA, STATE_QA, qbReturn.file as string);
const qaReturnPlan = await planBundleApply(qaApplyReturn);
const qaReturnResult = await executeBundlePlan(qaReturnPlan, qaApplyReturn);
check('A 应用回传包之后：两边完全一致', qaReturnResult.stateIdCompare, 'match');
check('这个编号就是 B 导出时那个', qaReturnResult.stateId.id, (await readBundleInfo(qbReturn.file as string)).header.stateId?.id);
checkTrue(
	'两台的日志最后一条编号相同 ⇒ 内容一致',
	(await loadState(STATE_QA)).bundleLog.at(-1)?.stateId === (await loadState(STATE_QB)).bundleLog.at(-1)?.stateId,
	'A 与 B 的日志编号对不上',
);
check('记录行里能直接看到编号', describeLogEntry((await loadState(STATE_QA)).bundleLog.at(-1) as BundleLogEntry).includes('状态 '), true);

// 旧版本的包（头部没记编号）→ 如实说"比不了"，不硬下结论
const QD = path.join(ROOT, 'machineQD');
const STATE_QD = path.join(ROOT, 'state-qd.json');
fs.mkdirSync(QD, { recursive: true });
const oldSource = abs(QA, 'a.md');
const oldStat = fs.statSync(oldSource);
const oldBundle = path.join(OUTQ, '旧的-full-20260101-000000-cccccc.lsave');
await writeBundle(oldBundle, {
	format: BUNDLE_FORMAT,
	version: BUNDLE_VERSION,
	bundleId: '00000000-0000-4000-8000-0000000000cc',
	parentBundleId: null,
	created: Date.now(),
	mode: 'full',
	vault: '我的笔记',
	lineage: 'old-lineage',
	source: { copyId: 'old-copy', generation: 0 },
	baseGeneration: null,
	targetGeneration: 1,
	deleted: [],
	emptyDirs: [],
}, [{ path: 'a.md', abs: oldSource, size: oldStat.size, mtime: oldStat.mtimeMs }]);
const qdApply = applyOptions(QD, STATE_QD, oldBundle);
const qdResult = await executeBundlePlan(await planBundleApply(qdApply), qdApply);
check('旧包没记编号 → 判成"比不了"', qdResult.stateIdCompare, 'unknown');
checkTrue('但自己这边的编号照样算出来、记下来', (qdResult.stateId.id ?? '').length === 16, qdResult.stateId.id);
checkTrue('描述函数会说清规模', describeStateId(qdResult.stateId).includes('内容') === false
	&& describeStateId(qdResult.stateId).includes('1 个文件'), describeStateId(qdResult.stateId));

// 46. 导出预览（planBundleExport）：只算不写 —— `sync-preview` 命令与「导出预览」窗口靠它。
// 关键：它与**真正导出走的是同一套挑选逻辑**，所以"预览说一套、实际导另一套"不会发生。
const PV = path.join(ROOT, 'preview-vault');
const STATE_PV = path.join(ROOT, 'state-preview.json');
fs.mkdirSync(PV, { recursive: true });
write(PV, 'notes/a.md', 'AAA', T0);
write(PV, 'notes/b.md', 'BBB', T0 + 1000);

// 还没立过基准：更新包算不出来 —— 预览**不抛错**，只把原因写在结果里
const pvNoAnchor = await planBundleExport(exportOptions(PV, STATE_PV, 'changes'));
checkTrue('没立过基准时预览不抛错，只说明原因', typeof pvNoAnchor.problem === 'string', JSON.stringify(pvNoAnchor));
checkTrue(
	'原因说的是"先导完整副本"',
	(pvNoAnchor.problem ?? '').includes('完整副本'),
	String(pvNoAnchor.problem),
);

// 立基准 → 改两个文件 → 预览要能列出来
await exportBundle(exportOptions(PV, STATE_PV, 'full'));
write(PV, 'notes/b.md', 'BBB 改过了', T0 + 60_000);
write(PV, 'notes/c.md', 'CCC', T0 + 61_000);
const pvPreview = await planBundleExport(exportOptions(PV, STATE_PV, 'changes'));
check('预览列出会装进包里的文件', pvPreview.files, ['notes/b.md', 'notes/c.md']);
check('预览报出文件数', pvPreview.fileCount, 2);
check('这次没有删除', pvPreview.deleted, []);
checkTrue('预览报出估算大小', pvPreview.bytes > 0, String(pvPreview.bytes));
check('预览说清基于第几代完整副本', pvPreview.anchorGeneration, 1);

// 预览**不写盘**：包里该有的东西一样都不落地
const pvOutBefore = fs.readdirSync(OUT).length;
await planBundleExport(exportOptions(PV, STATE_PV, 'changes'));
check('预览不写盘（包目录里的条目数没变）', fs.readdirSync(OUT).length, pvOutBefore);

// 删除清单只认**基准（完整副本）里有的**文件：基准之后新加又删掉的，对面本来就没有
fs.rmSync(abs(PV, 'notes/c.md'));
const pvAfterNewDelete = await planBundleExport(exportOptions(PV, STATE_PV, 'changes'));
check('新加又删掉的文件不进删除清单', pvAfterNewDelete.deleted, []);

// 删掉基准里有的那个 → 预览要点名它，而且它不该再出现在"装入"清单里
fs.rmSync(abs(PV, 'notes/a.md'));
const pvAfterDelete = await planBundleExport(exportOptions(PV, STATE_PV, 'changes'));
check('预览点名要删的文件', pvAfterDelete.deleted, ['notes/a.md']);
check('要删的文件不在"装入"清单里', pvAfterDelete.files.includes('notes/a.md'), false);
check('改过的那个照样要装进去', pvAfterDelete.files, ['notes/b.md']);

// 预览说的 == 实际导出来的（挑选逻辑同一处，这是这条测试真正要钉的东西）
const pvRealRun = await exportBundle(exportOptions(PV, STATE_PV, 'changes'));
const pvRealInfo = await readBundleInfo(pvRealRun.file as string);
check(
	'预览说会装哪些，包里就是哪些',
	pvRealInfo.header.entries.map(entry => entry.path).sort(),
	pvAfterDelete.files,
);
check(
	'预览说会删哪些，包里就是哪些',
	pvRealInfo.header.deleted.map(entry => entry.path).sort(),
	pvAfterDelete.deleted,
);

// 47. 「从状态 a 到状态 b」：本地有 a、b 两份完整包时，能导 a→b 的更新包
//
// 场景（用户提的）：两台机器都站在第 1 代（都应用过完整包 a），X 这边后来重立了基准
// （第 2 代那份完整包 b），对方还停在 a 上。按**最新基准**导的更新包对它是"基于一份
// 它没有的完整副本"（只能逐文件合并）；按 **a 当起点**导才是接着它那份基准的确定性更新。
// 起点 / 终点都是"本地那几份完整包"，最新（当前仓库）也是一个可选的状态。
// 用一套**全新的**目录与状态文件：前面那些用例已经占用了 machineX / transfer3 这些路径
const AB_X = path.join(ROOT, 'machine-ab-x');
const AB_Y = path.join(ROOT, 'machine-ab-y');
const AB_Z = path.join(ROOT, 'machine-ab-z');
const AB_OUT = path.join(ROOT, 'transfer-ab');
const AB_STATE_X = path.join(ROOT, 'state-ab-x.json');
const AB_STATE_Y = path.join(ROOT, 'state-ab-y.json');
const AB_STATE_Z = path.join(ROOT, 'state-ab-z.json');
for (const dir of [AB_X, AB_Y, AB_Z, AB_OUT]) fs.mkdirSync(dir, { recursive: true });
const AB_T0 = Date.now();

// a：两台机器共同的起点
write(AB_X, 'a.md', 'A1', AB_T0);
write(AB_X, 'b.md', 'B1', AB_T0 + 1000);
const abFull1 = await exportBundle({ ...exportOptions(AB_X, AB_STATE_X), outDir: AB_OUT });
const AB_FULL_A = abFull1.file as string;
check('完整包 a ＝ 第 1 代', abFull1.header?.targetGeneration, 1);
const abPlanY1 = await planBundleApply(applyOptions(AB_Y, AB_STATE_Y, AB_FULL_A));
await executeBundlePlan(abPlanY1, applyOptions(AB_Y, AB_STATE_Y, AB_FULL_A));
check('Y 站在第 1 代上', (await loadState(AB_STATE_Y)).generation, 1);

// b：X 重立基准（第 2 代），Y 没收到
write(AB_X, 'a.md', 'A2 改长一点', AB_T0 + 60_000);
write(AB_X, 'b.md', 'B2', AB_T0 + 61_000);
write(AB_X, 'c.md', 'C1', AB_T0 + 62_000);
const abFull2 = await exportBundle({ ...exportOptions(AB_X, AB_STATE_X), outDir: AB_OUT });
const AB_FULL_B = abFull2.file as string;
check('完整包 b ＝ 第 2 代', abFull2.header?.targetGeneration, 2);
const abInfoA = await readBundleInfo(AB_FULL_A);

const AB_FINGERPRINT_A = baselineOfBundle(abInfoA.header) as string;
const AB_FINGERPRINT_B = abFull2.header?.baselineHash as string;

// ① 默认那条路（按最新基准导）对 Y 来说是"基于一份它没有的完整副本"
const abNaive = await planBundleExport({ ...exportOptions(AB_X, AB_STATE_X, 'changes'), outDir: AB_OUT });
check('默认起点＝我最新那份完整副本（第 2 代）', abNaive.anchorGeneration, 2);
check('预览里也带着那份的基准指纹', abNaive.anchorFingerprint, AB_FINGERPRINT_B);

// ② 指定起点 ＝ a（**按基准指纹认，不按世代号**）：对方收到的就是接着自己那份基准的更新
//
// 先改一处：**内容真往前走了一版**，这个包才配叫"第 1 → 3 代"。
// 不改的话它跟"b 那一刻"一模一样 —— 那按 0.11 的规矩它就是第 2 代那个内容（同一份内容只能有一个号），
// 而且与 ④ 里那个 a→b 的差量包是**同一环**，会被"不重复生成"挡下来（用户报的正是这类"号乱涨"）。
write(AB_X, 'c.md', 'C2 又改了一次', AB_T0 + 63_000);
const abC1 = await exportBundle({
	...exportOptions(AB_X, AB_STATE_X, 'changes'),
	outDir: AB_OUT,
	baseFingerprint: AB_FINGERPRINT_A,
});
const abC1Info = await readBundleInfo(abC1.file as string);
check('起点是 a 那份（第 1 代），不是最新那份', abC1Info.header.baseGeneration, 1);
check('基准指纹＝a 那份完整副本的（对方一比正好 match）', abC1Info.header.baselineHash, AB_FINGERPRINT_A);
check('终点还是"最新"：第 3 代', abC1Info.header.targetGeneration, 3);
check('自 a 以来变过的三个文件都装进来了', abC1Info.header.entries.map(entry => entry.path), ['a.md', 'b.md', 'c.md']);
check('每个条目都带上"站在 a 上的人手里那一版"', typeof abC1Info.header.entries[0]?.baseSize, 'number');
check('报告里写清是哪一份完整副本', abC1.anchor, {
	generation: 1,
	hash: AB_FINGERPRINT_A,
	file: AB_FULL_A,
	name: path.basename(AB_FULL_A),
	stateId: abInfoA.header.stateId?.id ?? null,
	checkpoint: false,
	targetGeneration: 3,
	targetHash: null,
});
check('导出结果那句带上基准指纹', describeExportRange(abC1), `（第 1 代 → 最新 · 基准 ${AB_FINGERPRINT_A}）`);

// ③ Y（还在第 1 代）应用它：快速通道、零冲突，直接追上
const abPlanY2 = await planBundleApply(applyOptions(AB_Y, AB_STATE_Y, abC1.file as string));
check('跟这个包同一份完整副本 → 快速通道', abPlanY2.report.mode, 'fast');
check('基准对得上', abPlanY2.report.baselineMatch, 'match');
check('一代都不落后', abPlanY2.report.generationGap, 0);
check('零冲突', abPlanY2.report.conflicts, 0);
const abResY = await executeBundlePlan(abPlanY2, applyOptions(AB_Y, AB_STATE_Y, abC1.file as string));
check('内容追上了', [read(AB_Y, 'a.md'), read(AB_Y, 'b.md'), read(AB_Y, 'c.md')], ['A2 改长一点', 'B2', 'C2 又改了一次']);
check('两边状态编号一致（用户要的那句话）', abResY.stateIdCompare, 'match');
const abStateY = await loadState(AB_STATE_Y);
check('Y 的世代跟上了（1 → 3）', abStateY.generation, 3);
check('应用完就站到这份包送到的那一点（第 3 代）', abStateY.bundle?.fullGeneration, 3);

// ④ 差量包：从 a **到 b 那一刻**（b ＝ 第 2 代那份完整副本）
// X 在 b 之后又改了 a.md —— 差量包里必须装 **b 那一刻**的版本，不是现在的
const abPointBeforeCheckpoint = (await loadState(AB_STATE_X)).bundle?.fullHash;
write(AB_X, 'a.md', 'A3 比 b 那一刻更新', AB_T0 + 120_000);
const abCheckpoint = await exportBundle({
	...exportOptions(AB_X, AB_STATE_X, 'changes'),
	outDir: AB_OUT,
	baseFingerprint: AB_FINGERPRINT_A,
	toFingerprint: AB_FINGERPRINT_B,
});
const abCpInfo = await readBundleInfo(abCheckpoint.file as string);
check('差量包的终点是第 2 代', abCpInfo.header.targetGeneration, 2);
check('差量包带上目的地那份完整副本的指纹', abCpInfo.header.targetBaselineHash, AB_FINGERPRINT_B);
check(
	'差量包文件名写明区间与终点状态',
	path.basename(abCheckpoint.file as string).includes('我的笔记-更新-1代到2代-状态'),
	true,
);
check(
	'文件名里的状态编号＝终点那一刻的（不是我现在仓库的）',
	path.basename(abCheckpoint.file as string).includes(abCpInfo.header.stateId?.id ?? '没有编号'),
	true,
);
check(
	'"到最新"那种包文件名写的是「起点代到终点代」',
	path.basename(abC1.file as string).includes('我的笔记-更新-1代到3代-状态'),
	true,
);
check('差量包带上**终点那一刻**的状态编号', abCpInfo.header.stateId?.id, (await readBundleInfo(AB_FULL_B)).header.stateId?.id);
const abEntry = abCpInfo.header.entries.find(entry => entry.path === 'a.md');
const abBytes = abEntry ? (await readEntry(abCheckpoint.file as string, abCpInfo, abEntry)).toString('utf8') : '';
check('装的是 b 那一刻的内容，不是"现在的仓库"', abBytes, 'A2 改长一点');
check('差量包的报告写明"内容到那一代为止"', describeExportRange(abCheckpoint), `（第 1 代 → 第 2 代 · 基准 ${AB_FINGERPRINT_A}）`);
const abStateX = await loadState(AB_STATE_X);
check('导差量包不推进本机世代（我还是第 3 代）', abStateX.generation, 3);
check('也不动本机的基准点', abStateX.bundle?.fullHash, abPointBeforeCheckpoint);
check('差量包记的状态编号是终点那一刻的', abStateX.bundleLog.at(-1)?.stateId, abCpInfo.header.stateId?.id);
check('差量包会被标出来（界面上不能当成"我现在的状态"）', abStateX.bundleLog.at(-1)?.checkpoint, true);

// 同一份差量包不重复生成（内容由两份完整包决定，重导只是白写一遍）
const abAgain = await exportBundle({
	...exportOptions(AB_X, AB_STATE_X, 'changes'),
	outDir: AB_OUT,
	baseFingerprint: AB_FINGERPRINT_A,
	toFingerprint: AB_FINGERPRINT_B,
});
check('已经导过 → 不重复生成', abAgain.file, null);
checkTrue('并说明是因为已经导过了', (abAgain.reason ?? '').includes('已经导过了'), String(abAgain.reason));

// ⑤ Z 也站在第 1 代上：应用差量包 → 正好落在 b 那一刻
const abPlanZ1 = await planBundleApply(applyOptions(AB_Z, AB_STATE_Z, AB_FULL_A));
await executeBundlePlan(abPlanZ1, applyOptions(AB_Z, AB_STATE_Z, AB_FULL_A));
const abPlanZ2 = await planBundleApply(applyOptions(AB_Z, AB_STATE_Z, abCheckpoint.file as string));
check('站在第 1 代上收差量包：快速通道', abPlanZ2.report.mode, 'fast');
check('零冲突', abPlanZ2.report.conflicts, 0);
const abResZ = await executeBundlePlan(abPlanZ2, applyOptions(AB_Z, AB_STATE_Z, abCheckpoint.file as string));
check('Z 落在 b 那一刻：a.md 是 b 那一版', read(AB_Z, 'a.md'), 'A2 改长一点');
check('Z 也拿到了 b 那一刻新增的 c.md', read(AB_Z, 'c.md'), 'C1');
check('Z 的状态编号跟 b 那一刻一致', abResZ.stateIdCompare, 'match');
check('Z 的世代 ＝ 差量包的终点（2）', (await loadState(AB_STATE_Z)).generation, 2);

// ⑤b 把同一份差量包发给**已经站在 b（终点）上**的机器：不该只报"基准对不上"，
//     要认出"这个包的目的地就是你的基准"—— 里面没有它缺的东西（用户实测报过这个场景：
//     把"32 → 36"的包发给一台已经站在第 36 代上的机器，只看到一句"基准对不上"）
const AB_W = path.join(ROOT, 'machine-ab-w');
const AB_STATE_W = path.join(ROOT, 'state-ab-w.json');
fs.mkdirSync(AB_W, { recursive: true });
const abPlanW1 = await planBundleApply(applyOptions(AB_W, AB_STATE_W, AB_FULL_B));
await executeBundlePlan(abPlanW1, applyOptions(AB_W, AB_STATE_W, AB_FULL_B));
const abPlanW2 = await planBundleApply(applyOptions(AB_W, AB_STATE_W, abCheckpoint.file as string));
check('站在终点上的机器：基准对不上（包从更老的起点算）', abPlanW2.report.baselineMatch, 'mismatch');
check('但认得出来"这包要送到的地方就是我的基准"', abPlanW2.report.targetIsMine, true);
check('它要送到的那份指纹＝我的基准', abPlanW2.report.targetBaseline, AB_FINGERPRINT_B);
check('没有任何要写的动作（东西都齐了）', [abPlanW2.report.adds, abPlanW2.report.overwrites, abPlanW2.report.deletes], [0, 0, 0]);
check('包里点名的文件全都已经一致', abPlanW2.report.synchronized, abCpInfo.header.entries.length);

// ⑤c 真正的坑：**两代同名**。同一代可以有好几份完整副本（各机器各导一份），
//     按世代选会挑错那一份 —— 用户实测的"基准对不上"就是这么来的。
//     认指纹之后，两份都列得出来、也各选得中。
const AB_TWIN = path.join(ROOT, 'transfer-ab-twin');
fs.mkdirSync(AB_TWIN, { recursive: true });
const twinSource = path.join(ROOT, 'twin-source.md');
fs.writeFileSync(twinSource, 'twin');
const twinModern = Date.now() + 60_000;
// 手工造一份"同一条血脉、同一个世代、但内容不同"的完整包（模拟对方自己导的那份）
const twinFile = path.join(AB_TWIN, 'full', '对方的-full-20260101-000000-eeeeee.lsave');
await writeBundle(twinFile, {
	format: BUNDLE_FORMAT,
	version: BUNDLE_VERSION,
	bundleId: 'twin-bundle',
	parentBundleId: null,
	created: twinModern,
	mode: 'full',
	vault: '对方的笔记',
	lineage: abInfoA.header.lineage,
	source: { copyId: 'other-copy', generation: 1 },
	baseGeneration: null,
	targetGeneration: 1,
	baselineHash: 'aaaaaaaaaaaaaaaa',
	stateId: { id: 'bbbbbbbbbbbbbbbb', files: 1, dirs: 0, unverified: 0 },
	deleted: [],
	emptyDirs: [],
}, [{ path: 'twin.md', abs: twinSource, size: 4, mtime: twinModern }]);
const twinOptions = anchorOptions(
	await listFullAnchors(AB_TWIN, abInfoA.header.lineage),
	'from',
	{ generation: null, hash: null, file: null },
);
check('同代的两份完整副本都在选项里（按指纹分得开）', Object.keys(twinOptions).sort(), ['', 'aaaaaaaaaaaaaaaa']);
checkTrue('选项里带着世代与指纹', (twinOptions['aaaaaaaaaaaaaaaa'] ?? '').includes('第 1 代 · 基准 aaaaaaaaaaaaaaaa'), twinOptions['aaaaaaaaaaaaaaaa'] ?? '');

// ⑥ 指定的状态找不到 → **明确报错**，绝不悄悄换一份（换一份就是把内容完全不同的包发出去）
let abMissingFrom = '';
try {
	await exportBundle({
		...exportOptions(AB_X, AB_STATE_X, 'changes'),
		outDir: AB_OUT,
		baseFingerprint: 'ffffffffffffffff',
	});
} catch (error) {
	abMissingFrom = error instanceof Error ? error.message : String(error);
}
checkTrue('找不到起点时报错并说明', abMissingFrom.includes('ffffffffffffffff'), abMissingFrom);
checkTrue('报错里列出"现在有哪些指纹"', abMissingFrom.includes(AB_FINGERPRINT_A), abMissingFrom);
const abMissingPreview = await planBundleExport({
	...exportOptions(AB_X, AB_STATE_X, 'changes'),
	outDir: AB_OUT,
	toFingerprint: 'ffffffffffffffff',
});
checkTrue('预览不抛错，把原因写在界面上', (abMissingPreview.problem ?? '').includes('ffffffffffffffff'), String(abMissingPreview.problem));
check('预览里没有状态', [abMissingPreview.anchorGeneration, abMissingPreview.targetGeneration], [null, null]);

// 47. **更新包自带的 base 优先于本机那份记录**（踩过的坑）
//
// 场景：接收方手里已经有一份"我以为我们一致"的记录（`state.bundle.files`），
// 但对方后来重新立过基准 / 我中间应用过别的包 —— 对**这个包**来说那份记录已经过期。
// 过期的后果很具体：本地明明停在"对方发过的中间版本"上（包的 `history` 里写着那一版），
// 却因为 base 对不上被判成"本地改动"，于是不走 `history` 那条路 ——
// 白白留一个冲突副本。所以 `planBundleApply` 里那个 `seed` 让**包的 base 覆盖本机记录**。
const HK_A = path.join(ROOT, 'machine-hk-a');
const HK_B = path.join(ROOT, 'machine-hk-b');
const STATE_HK_A = path.join(ROOT, 'state-hk-a.json');
const STATE_HK_B = path.join(ROOT, 'state-hk-b.json');
const OUT_HK = path.join(ROOT, 'transfer-hk');
const T_HK = Date.now() - 120_000;
fs.mkdirSync(HK_A, { recursive: true });
fs.mkdirSync(HK_B, { recursive: true });
fs.mkdirSync(OUT_HK, { recursive: true });

write(HK_A, 'h.md', 'H1', T_HK);
const hkFull = await exportBundle({ ...exportOptions(HK_A, STATE_HK_A), outDir: OUT_HK });
// A 改两轮：第一次改动会成为更新包里的"中间版本"，第二次是最新版。
// 时间各拉开 1 分钟，免得落在 2 秒容差里被当成"没改过"
write(HK_A, 'h.md', 'H2 中间版', T_HK + 60_000);
const hkMid = await exportBundle({ ...exportOptions(HK_A, STATE_HK_A, 'changes'), outDir: OUT_HK });
write(HK_A, 'h.md', 'H3 最新版', T_HK + 120_000);
const hkChanges = await exportBundle({ ...exportOptions(HK_A, STATE_HK_A, 'changes'), outDir: OUT_HK });

// B 站到同一份基准上，按顺序把中间那一份也应用掉（链条模型：起点得正好是本机这一点），
// 再把手里的文件换成"我发过的那个中间版本"
const hkFullOptions = applyOptions(HK_B, STATE_HK_B, hkFull.file as string);
await executeBundlePlan(await planBundleApply(hkFullOptions), hkFullOptions);
const hkMidOptions = applyOptions(HK_B, STATE_HK_B, hkMid.file as string);
await executeBundlePlan(await planBundleApply(hkMidOptions), hkMidOptions);
const hkEntry = (await readBundleInfo(hkChanges.file as string)).header.entries.find(item => item.path === 'h.md');
const hkPast = hkEntry?.history?.[0];
checkTrue('更新包里带着中间版本记录', hkPast !== undefined, JSON.stringify(hkEntry?.history));
if (hkPast) {
	write(HK_B, 'h.md', 'H2', hkPast.mtime);
	// 本机那份记录"过期"：跟包里说的 base 不是一回事（对方重立过基准时就会这样）
	const hkState = await loadState(STATE_HK_B);
	if (hkState.bundle) hkState.bundle.files['h.md'] = { size: 999, mtime: T_HK };
	await saveState(STATE_HK_B, hkState);

	const hkPlan = await planBundleApply(applyOptions(HK_B, STATE_HK_B, hkChanges.file as string));
	check('本机记录过期也不误判成冲突', hkPlan.report.conflicts, 0);
	check('认得出"这是我发过的中间版本"（靠包自带的 base）', hkPlan.report.historyMatches, 1);
	check('直接覆盖成包里那一版', hkPlan.report.overwrites, 1);
}

// 48. **导一份完整副本不许"多占一代"**（用户报的现场）
//
// 场景：本机站在第 1 代基准上，收到并应用了别人「1 → 3」的更新包 ——
// 内容就是第 3 代，`state.generation` 也到了 3。这时导一份完整副本（把内容固化成基准点），
// 它**不该**自称"第 4 代"：内容一代都没往前走。照旧 `+1` 的话，本机导出的更新包会变成
// 「3 → 4」，对面看着像凭空多一代，应用完也停在 4 上，两边的"第几代"跟内容再也对不上。
//
// 判据是"仓库自上次导出以来动过没有"：没动过 → 沿用当前世代（基准换一份，代数不动）；
// 真有了新改动 → 才 +1（内容确实往前走了一代）。
const GN = path.join(ROOT, 'machine-gn');
const STATE_GN = path.join(ROOT, 'state-gn.json');
const OUT_GN = path.join(ROOT, 'transfer-gn');
const T_GN = Date.now() - 600_000;
fs.mkdirSync(GN, { recursive: true });
fs.mkdirSync(OUT_GN, { recursive: true });

// 第 1 代基准 → 连着改两轮，变成第 3 代（内容 C3）
write(GN, 'c.md', 'C1', T_GN);
const gnFull1 = await exportBundle({ ...exportOptions(GN, STATE_GN), outDir: OUT_GN });
check('起手第 1 代', gnFull1.header?.targetGeneration, 1);
for (const round of [2, 3]) {
	write(GN, 'c.md', `C${round}`, T_GN + round * 60_000);
	await exportBundle({ ...exportOptions(GN, STATE_GN, 'changes'), outDir: OUT_GN });
}
const gnState = await loadState(STATE_GN);
check('改了两轮 → 第 3 代', gnState.generation, 3);
check('基准点跟着导出自动往前走（站到第 3 代那一点）', gnState.bundle?.fullGeneration, 3);
check('这一点是自己导出来的 → 还没被对方确认', gnState.bundle?.pointConfirmed, false);

// **导完整副本**（内容没动）：世代号不推进，基准点换成这一份
const gnFull2 = await exportBundle({ ...exportOptions(GN, STATE_GN), outDir: OUT_GN });
check('内容没动的完整副本不许占新世代', gnFull2.header?.targetGeneration, 3);
const gnAfter = await loadState(STATE_GN);
check('本机世代也不推进', gnAfter.generation, 3);
check('基准换到第 3 代', gnAfter.bundle?.fullGeneration, 3);
check('基准清单换成整库', Object.keys(gnAfter.bundle?.fullFiles ?? {}), ['c.md']);
// 同代的旧更新包照样被这份完整副本取代（完整清单含它的全部内容）
checkTrue('同代的旧更新包被清掉', gnFull2.superseded.length >= 1, JSON.stringify(gnFull2.superseded));

// 真有了新改动 → 才 +1
write(GN, 'c.md', 'C4', T_GN + 4 * 60_000);
const gnFull3 = await exportBundle({ ...exportOptions(GN, STATE_GN), outDir: OUT_GN });
check('有真改动时完整副本才往前走一代', gnFull3.header?.targetGeneration, 4);

// 对面照着这份新基准往下走：两边代数与内容都对得上
const GN_PEER = path.join(ROOT, 'machine-gn-peer');
const STATE_GN_PEER = path.join(ROOT, 'state-gn-peer.json');
fs.mkdirSync(GN_PEER, { recursive: true });
const gnPeerApply = applyOptions(GN_PEER, STATE_GN_PEER, gnFull2.file as string);
await executeBundlePlan(await planBundleApply(gnPeerApply), gnPeerApply);
const gnPeerState = await loadState(STATE_GN_PEER);
check('对面应用完也停在第 3 代（跟内容一致）', gnPeerState.generation, 3);
check('两边的基准指纹一致', gnPeerState.bundle?.fullHash, gnAfter.bundle?.fullHash ?? null);

// 49. **世代 ＝ 内容在这个血脉里的版本号**（0.10.1 重新定义的那条）
//
// 判据要一眼能懂：**同一份内容，在任何机器、走任何路径，报出来的世代号都必须相同**；
// 世代号更新就是内容更新，世代号相同就是同一版内容。
// 所以两条推论都要成立：
//   ① 应用任何包之后**采纳包说的那一代**（应用完我的内容就等于那份包）；
//   ② 应用一份**更老的**完整副本时，世代**跟着回到那一代** —— 内容退回去了，
//      世代号就该退回去（旧定义把它当 bug 用 Math.max 硬压住，结果两台内容相同的机器
//      报出不同的代数，"第几代"当场失去意义）。
const VG_A = path.join(ROOT, 'machine-vg-a');
const VG_B = path.join(ROOT, 'machine-vg-b');
const VG_C = path.join(ROOT, 'machine-vg-c');
const STATE_VG_A = path.join(ROOT, 'state-vg-a.json');
const STATE_VG_B = path.join(ROOT, 'state-vg-b.json');
const STATE_VG_C = path.join(ROOT, 'state-vg-c.json');
const OUT_VG = path.join(ROOT, 'transfer-vg');
const T_VG = Date.now() - 900_000;
for (const dir of [VG_A, VG_B, VG_C, OUT_VG]) fs.mkdirSync(dir, { recursive: true });

// A 机：第 1 代基准 → 改两轮 → 第 3 代，再立一份完整副本（这份就是"第 3 代的内容"）
write(VG_A, 'v.md', 'V1', T_VG);
const vgFull1 = await exportBundle({ ...exportOptions(VG_A, STATE_VG_A), outDir: OUT_VG });
for (const round of [2, 3]) {
	write(VG_A, 'v.md', `V${round}`, T_VG + round * 60_000);
	await exportBundle({ ...exportOptions(VG_A, STATE_VG_A, 'changes'), outDir: OUT_VG });
}
const vgFull3 = await exportBundle({ ...exportOptions(VG_A, STATE_VG_A), outDir: OUT_VG });
check('第 3 代那份完整副本自称第 3 代', vgFull3.header?.targetGeneration, 3);

// B 机：**另一条路**走到同一份内容 —— 先站第 1 代基准，再应用「1 → 3」的更新包
const vgB1 = applyOptions(VG_B, STATE_VG_B, vgFull1.file as string);
await executeBundlePlan(await planBundleApply(vgB1), vgB1);
const vgChain = path.join(OUT_VG, 'vg-chain-1-to-3.lsave');
const vgFull3Info = await readBundleInfo(vgFull3.file as string);
const vgEntry = vgFull3Info.header.entries.find(item => item.path === 'v.md');
await writeBundle(vgChain, {
	format: BUNDLE_FORMAT,
	version: BUNDLE_VERSION,
	bundleId: randomUUID(),
	parentBundleId: null,
	created: Date.now(),
	mode: 'changes',
	vault: '我的笔记',
	lineage: vgFull1.header?.lineage as string,
	source: { copyId: 'vg-a', generation: 3 },
	baseGeneration: 1,
	targetGeneration: 3,
	baselineHash: vgFull1.header?.baselineHash as string,
	deleted: [],
	emptyDirs: [],
}, [{
	path: 'v.md',
	abs: '',
	from: { file: vgFull3.file as string, offset: vgFull3Info.payloadOffset + (vgEntry?.offset ?? 0) },
	size: vgEntry?.size ?? 0,
	mtime: vgEntry?.mtime ?? 0,
}]);
const vgBChain = applyOptions(VG_B, STATE_VG_B, vgChain);
await executeBundlePlan(await planBundleApply(vgBChain), vgBChain);
check('B 走"应用更新包"那条路也到第 3 代', (await loadState(STATE_VG_B)).generation, 3);

// C 机：直接应用那份第 3 代完整副本
const vgC = applyOptions(VG_C, STATE_VG_C, vgFull3.file as string);
await executeBundlePlan(await planBundleApply(vgC), vgC);
check('C 走"应用完整副本"那条路也到第 3 代', (await loadState(STATE_VG_C)).generation, 3);

// 三台机器内容一模一样 → 世代号必须一模一样（这就是"世代能表示新旧"的前提）
check(
	'同一份内容：三台机器报同一个世代号',
	[
		(await loadState(STATE_VG_A)).generation,
		(await loadState(STATE_VG_B)).generation,
		(await loadState(STATE_VG_C)).generation,
	],
	[3, 3, 3],
);

// ② 应用一份**更老的**完整副本：内容回到那一代，世代号跟着回去
const vgBack = applyOptions(VG_C, STATE_VG_C, vgFull1.file as string);
await executeBundlePlan(await planBundleApply(vgBack), vgBack);
const vgBackState = await loadState(STATE_VG_C);
check('应用更老的完整副本 → 世代同步回那一代', vgBackState.generation, 1);
check('基准代也跟着回到第 1 代', vgBackState.bundle?.fullGeneration, 1);
check('内容确实回到了那一版', read(VG_C, 'v.md'), 'V1');
// 44. 应用别人的包时"我这边的东西"怎么处置：动手前存成一个包 → 应用 → 自己/对方都能用它叠加
//
// 用户拍板的语义（原话）："把新的部分变成一个更新包，自己导入就等于在最新基准点基础上
// 加上原来更新，给别人导入同理。"
// 所以那一环的起点必须是**应用后落到的那个新点**（不是应用前那一点）——
// 否则对方站在新点上，应用它会判"接不上"。
const RBX = path.join(ROOT, 'rebase');
const RBX_M = path.join(RBX, 'mine');
const RBX_P = path.join(RBX, 'peer');
const RBX_OUT = path.join(RBX, 'transfer');
const STATE_RBX_M = path.join(RBX, 'state-mine.json');
const STATE_RBX_P = path.join(RBX, 'state-peer.json');
for (const dir of [RBX_M, RBX_P, RBX_OUT]) fs.mkdirSync(dir, { recursive: true });

const rbxExport = (root: string, stateFile: string, mode: 'full' | 'changes' = 'changes'): ExportOptions =>
	({ settings: settings(), log, vaultRoot: root, vaultName: '我的笔记', stateFile, mode, outDir: RBX_OUT });
const rbxApply = (root: string, stateFile: string, file: string): ApplyOptions =>
	applyOptions(root, stateFile, file, { strictness: 'mirror' });

// ① 对方立一份完整副本，我应用它 → 两边站在同一个点上
write(RBX_P, 'notes/a.md', 'A0');
write(RBX_P, 'notes/b.md', 'B0');
write(RBX_P, 'notes/c.md', 'C0');
const rbxFull = await exportBundle(rbxExport(RBX_P, STATE_RBX_P, 'full'));
const rbxFullInfo = await readBundleInfo(rbxFull.file as string);

await executeBundlePlan(
	await planBundleApply(rbxApply(RBX_M, STATE_RBX_M, rbxFull.file as string)),
	rbxApply(RBX_M, STATE_RBX_M, rbxFull.file as string),
);
check('我应用完整副本之后：内容就是对方那份', [read(RBX_M, 'notes/a.md'), read(RBX_M, 'notes/c.md')], ['A0', 'C0']);
check(
	'我站的这一点＝那份完整副本的落点',
	(await loadState(STATE_RBX_M)).bundle?.fullHash,
	rbxFullInfo.header.targetBaselineHash,
);

// ② 我这边改一个、新建一个、删一个；对方改了另一个文件并导一份更新包给我
write(RBX_M, 'notes/a.md', 'MINE-A');
write(RBX_M, 'mine.md', 'MINE-NEW');
fs.rmSync(abs(RBX_M, 'notes/b.md'));
write(RBX_P, 'notes/c.md', 'P-NEW-C');
const rbxChanges = await exportBundle(rbxExport(RBX_P, STATE_RBX_P));
const rbxChangesInfo = await readBundleInfo(rbxChanges.file as string);

// ③ 按界面上的顺序动手：**先只读地算一遍** → 把我这边的东西存成包 → 应用（用算好的那份计划）
const rbxPlan = await planBundleApply(rbxApply(RBX_M, STATE_RBX_M, rbxChanges.file as string));
check('应用前就看得出"我这边还有 2 个改动、1 个删除"', [rbxPlan.report.pendingChanges, rbxPlan.report.pendingDeletes], [2, 1]);
const rbxParked = await parkLocalChangesFor(
	{ ...rbxExport(RBX_M, STATE_RBX_M), mode: 'changes' },
	{ header: rbxPlan.info.header, pointBefore: rbxPlan.pointBefore },
);
checkTrue('动手前把我这边的东西存成了一个包', rbxParked.file !== null, rbxParked.reason ?? '没存出来');
const rbxParkedInfo = await readBundleInfo(rbxParked.file as string);
check(
	'那一环的起点＝我马上要落到的那一点（对方头部报的那个）',
	[rbxParkedInfo.header.baselineHash, rbxParkedInfo.header.baseGeneration],
	[rbxChangesInfo.header.targetBaselineHash, rbxChangesInfo.header.targetGeneration],
);
check(
	'条目＝我改过 / 新建的那两个（对方改的那个不算我的 —— 它在对方包里）',
	rbxParkedInfo.header.entries.map(entry => entry.path),
	['mine.md', 'notes/a.md'],
);
check('删除清单＝我删掉的那个', rbxParkedInfo.header.deleted.map(item => item.path), ['notes/b.md']);
const rbxEntryA = rbxParkedInfo.header.entries.find(entry => entry.path === 'notes/a.md');
const rbxEntryMine = rbxParkedInfo.header.entries.find(entry => entry.path === 'mine.md');
check(
	'包里的字节是我那一版',
	[
		(await readEntry(rbxParked.file as string, rbxParkedInfo, rbxEntryA!)).toString('utf8'),
		(await readEntry(rbxParked.file as string, rbxParkedInfo, rbxEntryMine!)).toString('utf8'),
	],
	['MINE-A', 'MINE-NEW'],
);
check(
	'存包**不推进我这边**（我还站在原来那一点上，等着应用）',
	(await loadState(STATE_RBX_M)).bundle?.fullHash,
	rbxChangesInfo.header.baselineHash,
);

const rbxApplied = await executeBundlePlan(rbxPlan, rbxApply(RBX_M, STATE_RBX_M, rbxChanges.file as string));
const rbxAfter = await loadState(STATE_RBX_M);
check('应用完：包里点名的那份用包里的版本', read(RBX_M, 'notes/c.md'), 'P-NEW-C');
check('应用完：我自己新建的文件被挪走（严格同步不留"那一点上没有的"）', read(RBX_M, 'mine.md'), null);
// 包里没提到、而我又改过的文件：包里没有它的字节，谁也变不出对方那一版 —— 它们留在原地，
// 但**已经在上面的那一环里了**（这就是"本地最新更新保存为一个更新包"那句话）
check('应用完：包里没提到、我又改过的那个留在原地', read(RBX_M, 'notes/a.md'), 'MINE-A');
check('应用完：我删掉的那个也没被凭空补回来', read(RBX_M, 'notes/b.md'), null);
check(
	'应用完：我站到包送到的新点上（存过包也不能把点算歪）',
	rbxAfter.bundle?.fullHash,
	rbxChangesInfo.header.targetBaselineHash,
);

// ④ "自己导入就等于在最新基准点基础上加上原来更新"
const rbxSelfResult = await executeBundlePlan(
	await planBundleApply(rbxApply(RBX_M, STATE_RBX_M, rbxParked.file as string)),
	rbxApply(RBX_M, STATE_RBX_M, rbxParked.file as string),
);
check(
	'我自己应用它：我的改动加回来了，对方那边的改动也在',
	[read(RBX_M, 'mine.md'), read(RBX_M, 'notes/a.md'), read(RBX_M, 'notes/c.md')],
	['MINE-NEW', 'MINE-A', 'P-NEW-C'],
);
check('我自己删掉的那个仍然是删掉的', read(RBX_M, 'notes/b.md'), null);
check('应用完状态编号跟包里记的一致（两边文件内容一致）', rbxSelfResult.stateIdCompare, 'match');
check(
	'我站到那一环的落点上了',
	(await loadState(STATE_RBX_M)).bundle?.fullHash,
	rbxParkedInfo.header.targetBaselineHash,
);

// ⑤ "给别人导入同理"：对方刚导完那个包，正站在新点上
check(
	'对方此刻确实站在新点上（他导完那个包就走到了）',
	(await loadState(STATE_RBX_P)).bundle?.fullHash,
	rbxAfter.bundle?.fullHash,
);
const rbxPeerResult = await executeBundlePlan(
	await planBundleApply(rbxApply(RBX_P, STATE_RBX_P, rbxParked.file as string)),
	rbxApply(RBX_P, STATE_RBX_P, rbxParked.file as string),
);
check(
	'对方应用它：拿到的是"他的新点 ＋ 我的东西"',
	[read(RBX_P, 'mine.md'), read(RBX_P, 'notes/a.md'), read(RBX_P, 'notes/c.md')],
	['MINE-NEW', 'MINE-A', 'P-NEW-C'],
);
check('对方那边也删掉了我删的那个', read(RBX_P, 'notes/b.md'), null);
check('对方应用完也报"跟导出方完全一致"', rbxPeerResult.stateIdCompare, 'match');
check(
	'两台机器最后落在同一个点上',
	(await loadState(STATE_RBX_P)).bundle?.fullHash,
	(await loadState(STATE_RBX_M)).bundle?.fullHash,
);

// 45. 世代号 ＝ 内容的版本号：**内容没动，再导一次也不许 +1**
//
// 用户报的现场：他那边把「更新包从哪个状态开始」钉在第 39 代（对面还站在 39），
// 于是每次自动留包都重导一遍同一份内容 —— 39→48 / 39→49 / 39→50 三份包**状态编号一模一样**、
// 世代号却一路涨，对面应用完永远对不上（"内容没变代数就不应该变，但实际每次导出包就多一代"）。
const GEN = path.join(ROOT, 'gen');
const GEN_VAULT = path.join(GEN, 'vault');
const GEN_OUT = path.join(GEN, 'transfer');
const STATE_GEN = path.join(GEN, 'state.json');
for (const dir of [GEN_VAULT, GEN_OUT]) fs.mkdirSync(dir, { recursive: true });
const genExport = (mode: 'full' | 'changes', baseFingerprint?: string): ExportOptions =>
	({
		settings: settings(), log, vaultRoot: GEN_VAULT, vaultName: '我的笔记',
		stateFile: STATE_GEN, mode, outDir: GEN_OUT,
		...(baseFingerprint ? { baseFingerprint } : {}),
	});

write(GEN_VAULT, 'a.md', 'A1');
const genFull = await exportBundle(genExport('full'));
const genAnchor = genFull.header?.baselineHash as string; // 完整副本自己就是那个点

// 改**不一样的长度 + 拉开时间**：同一秒内改同样长度会被 2 秒容差当成"没动过"（老坑）
write(GEN_VAULT, 'a.md', 'A2 长一点', Date.now() + 20_000);
const genFirst = await exportBundle(genExport('changes'));
check('第一次更新包：内容往前走了一版', genFirst.header?.targetGeneration, 2);

// 钉住老起点再导一次（内容一点没变）—— 这就是用户那边的设置
const genAgain = await exportBundle(genExport('changes', genAnchor));
check('内容没动：再导一次**不许**多占一代', genAgain.header?.targetGeneration, genFirst.header?.targetGeneration);
check('状态里的号也没涨', (await loadState(STATE_GEN)).generation, genFirst.header?.targetGeneration);

// 账本自愈：状态里的号被旧版本撑大了（他那边是 52，真号是 51），导出时要照手里的包改回来
const genBroken = await loadState(STATE_GEN);
genBroken.generation = 7;
if (genBroken.bundle) genBroken.bundle.fullGeneration = 7;
await saveState(STATE_GEN, genBroken);
const genHealed = await exportBundle(genExport('changes', genAnchor));
check('状态里的号被撑大过 → 照手里的包改回真号', genHealed.header?.targetGeneration, genFirst.header?.targetGeneration);
check('状态里也改回来了', (await loadState(STATE_GEN)).generation, genFirst.header?.targetGeneration);

// 真动了内容才 +1
write(GEN_VAULT, 'a.md', 'A3 再长一点点', Date.now() + 40_000);
const genMoved = await exportBundle(genExport('changes', genAnchor));
check('内容真动了 → 正常 +1', genMoved.header?.targetGeneration, (genFirst.header?.targetGeneration ?? 0) + 1);

// 46. 空目录也是内容：严格镜像下，那一点上有的目录一个不少、没有的一个不留
//
// 用户的话："空目录也要同步，没有收拾空目录这种说法，空目录也是内容的一部分。"
// 两个真实现场：
//   ① 对方把一个文件夹里的文件删了、文件夹留着（它就是这么同步的）→ 我这边删完文件
//      不能顺手把空壳收掉（收了状态编号当场对不上，用户看到"还差一点"而文件一个不差）；
//   ② 我自己新建的空文件夹，那一点上没有 → 严格镜像要把它清掉。
const DIRS = path.join(ROOT, 'dirs');
const DIRS_A = path.join(DIRS, 'a');
const DIRS_B = path.join(DIRS, 'b');
const DIRS_OUT = path.join(DIRS, 'transfer');
const STATE_DIRS_A = path.join(DIRS, 'state-a.json');
const STATE_DIRS_B = path.join(DIRS, 'state-b.json');
for (const dir of [DIRS_A, DIRS_B, DIRS_OUT]) fs.mkdirSync(dir, { recursive: true });
const dirsExport = (root: string, stateFile: string, mode: 'full' | 'changes' = 'changes'): ExportOptions =>
	({ settings: settings(), log, vaultRoot: root, vaultName: '我的笔记', stateFile, mode, outDir: DIRS_OUT });
const dirsApply = (root: string, stateFile: string, file: string): ApplyOptions =>
	applyOptions(root, stateFile, file, { strictness: 'mirror' });

write(DIRS_A, 'notes/a.md', 'A');
write(DIRS_A, 'notes/b.md', 'B');
fs.mkdirSync(abs(DIRS_A, 'notes/keep'), { recursive: true }); // 空目录，也是内容
const dirsFull = await exportBundle(dirsExport(DIRS_A, STATE_DIRS_A, 'full'));
const dirsFullInfo = await readBundleInfo(dirsFull.file as string);
check('完整副本记着那个空目录', dirsFullInfo.header.emptyDirs, ['notes/keep']);

await executeBundlePlan(
	await planBundleApply(dirsApply(DIRS_B, STATE_DIRS_B, dirsFull.file as string)),
	dirsApply(DIRS_B, STATE_DIRS_B, dirsFull.file as string),
);
check('接收方建出了那个空目录', exists(DIRS_B, 'notes/keep'), true);

// 对方把 notes/b.md 删了（notes/ 里还剩 a.md）；再删掉 a.md 呢？—— 那 notes/ 就是空的了，
// 而它在对方那边**依然是内容**（空文件夹），所以两边都必须留着它
fs.rmSync(abs(DIRS_A, 'notes/b.md'));
fs.rmSync(abs(DIRS_A, 'notes/a.md'));
const dirsChanges = await exportBundle(dirsExport(DIRS_A, STATE_DIRS_A));
const dirsChangesInfo = await readBundleInfo(dirsChanges.file as string);
check('更新包把"对方现在有哪些空文件夹"带上了', (dirsChangesInfo.header.emptyDirs ?? []).includes('notes'), true);

// 我这边：自己新建一个空文件夹（那一点上没有它），另外 notes/a.md 还在
fs.mkdirSync(abs(DIRS_B, 'mine-only'), { recursive: true });
const dirsPlan = await planBundleApply(dirsApply(DIRS_B, STATE_DIRS_B, dirsChanges.file as string));
check('那一点上没有的空目录会被清掉（严格镜像）', dirsPlan.foldersToRemove, ['mine-only']);
const dirsResult = await executeBundlePlan(dirsPlan, dirsApply(DIRS_B, STATE_DIRS_B, dirsChanges.file as string));
check('删掉的两个文件走了回收目录', [read(DIRS_B, 'notes/a.md'), read(DIRS_B, 'notes/b.md')], [null, null]);
check('**那一点上有的空目录一个不少**（notes/keep 与 notes/ 都在）', [exists(DIRS_B, 'notes/keep'), exists(DIRS_B, 'notes')], [true, true]);
check('那一点上没有的空目录被清掉了', exists(DIRS_B, 'mine-only'), false);
check('收拾空目录那一步没有多删（notes 是被保住的，不是删了又建）', dirsResult.foldersRemoved, 1);
check('状态编号跟包里记的一致（目录也算进编号里）', dirsResult.stateIdCompare, 'match');

// 47. 合并相邻的更新包：三环并一环，基准点重新算（用户要的"防止基准点太多、更新太碎"）
//
// 以及他问的那件事：**合并之后，站在"被吞掉的那个点"上的机器还收得下吗** ——
// 收得下（头部 `viaHashes` 记着这个包一路经过哪几个点，`checkAncestor` 认它）。
const MG = path.join(ROOT, 'merge');
const MG_A = path.join(MG, 'a');
const MG_B = path.join(MG, 'b');
const MG_C = path.join(MG, 'c');
const MG_D = path.join(MG, 'd');
const MG_OUT = path.join(MG, 'transfer');
const STATE_MG_A = path.join(MG, 'state-a.json');
const STATE_MG_B = path.join(MG, 'state-b.json');
const STATE_MG_C = path.join(MG, 'state-c.json');
const STATE_MG_D = path.join(MG, 'state-d.json');
for (const dir of [MG_A, MG_B, MG_C, MG_D, MG_OUT]) fs.mkdirSync(dir, { recursive: true });
const mgExport = (root: string, stateFile: string, mode: 'full' | 'changes' = 'changes'): ExportOptions =>
	({ settings: settings(), log, vaultRoot: root, vaultName: '我的笔记', stateFile, mode, outDir: MG_OUT });
const mgApply = (root: string, stateFile: string, file: string): ApplyOptions =>
	applyOptions(root, stateFile, file, { strictness: 'mirror' });

const mgT0 = Date.now();
write(MG_A, 'a.md', 'A1', mgT0);
const mgFull = await exportBundle(mgExport(MG_A, STATE_MG_A, 'full'));

// 三环：1→2→3→4（每次都从"我站的这一点"往外延伸，所以首尾相接）
const mgLinks: string[] = [];
for (const [index, content] of ['A2 长长一点', 'A3 再长一点点', 'A4 又长一点点了'].entries()) {
	write(MG_A, 'a.md', content, mgT0 + (index + 1) * 30_000);
	const link = await exportBundle(mgExport(MG_A, STATE_MG_A));
	mgLinks.push(link.file as string);
}
check('本机站到第 4 代', (await loadState(STATE_MG_A)).generation, 4);

// 两台机器先各自走到中间：B 站在段首（第 1 代），C 站在中间那一点（第 2 代）
await executeBundlePlan(
	await planBundleApply(mgApply(MG_B, STATE_MG_B, mgFull.file as string)),
	mgApply(MG_B, STATE_MG_B, mgFull.file as string),
);
await executeBundlePlan(
	await planBundleApply(mgApply(MG_C, STATE_MG_C, mgFull.file as string)),
	mgApply(MG_C, STATE_MG_C, mgFull.file as string),
);
await executeBundlePlan(
	await planBundleApply(mgApply(MG_C, STATE_MG_C, mgLinks[0] as string)),
	mgApply(MG_C, STATE_MG_C, mgLinks[0] as string),
);
check('B 站在段首（第 1 代）', (await loadState(STATE_MG_B)).generation, 1);
check('C 站在中间那一点（第 2 代）', (await loadState(STATE_MG_C)).generation, 2);

const mgLineage = (await loadState(STATE_MG_A)).lineage;
const mgBefore = (await planBundleMerges(MG_OUT, mgLineage)).plans;
check('算出可以合并的一段', mgBefore.length, 1);
check(
	'这段从第 1 代到第 4 代、吞掉三份包、中间两个点',
	[mgBefore[0]?.anchorGeneration, mgBefore[0]?.targetGeneration, mgBefore[0]?.links.length, mgBefore[0]?.middlePoints.length],
	[1, 4, 3, 2],
);

const mgMerged = await mergeBundleGroup({ outDir: MG_OUT, log, stateFile: STATE_MG_A, vaultName: '我的笔记' }, mgBefore[0] as NonNullable<typeof mgBefore[0]>);
checkTrue('合并后的包写出来了', typeof mgMerged.file === 'string' && mgMerged.file.length > 0, '没有文件名');
check('这一份是新写的（不是复用现成的）', mgMerged.reused, false);
check('那三份小包都挪进了回收站', mgMerged.trashed.length, 3);
check('回收站里能捞回来', (await readBundleTrash(MG_OUT)).count >= 3, true);

const mgMergedInfo = await readBundleInfo(mgMerged.file);
check(
	'合并后：起点还是段首那一点、落点还是段末那一点（基准点重算过）',
	[mgMergedInfo.header.baseGeneration, mgMergedInfo.header.targetGeneration, mgMergedInfo.header.baselineHash],
	[1, 4, mgFull.header?.baselineHash],
);
check('合并后装的是"1 代到 4 代之间变过的"', mgMergedInfo.header.entries.map(entry => entry.path), ['a.md']);
check(
	'合并后内容取的是**段末那一刻**的（不是我现在的仓库）',
	(await readEntry(mgMerged.file, mgMergedInfo, mgMergedInfo.header.entries[0]!)).toString('utf8'),
	'A4 又长一点点了',
);
check('头部记着这个包一路经过哪几个点（两个中间点）', (mgMergedInfo.header.viaHashes ?? []).length, 2);
check('本机什么都不推进（还是第 4 代）', (await loadState(STATE_MG_A)).generation, 4);
check('合并完再看：没有可合并的了', (await planBundleMerges(MG_OUT, mgLineage)).plans.length, 0);

// 段首那台：基准正好对得上
const mgPlanB = await planBundleApply(mgApply(MG_B, STATE_MG_B, mgMerged.file));
check('B（段首）基准对得上', mgPlanB.report.baselineMatch, 'match');
const mgResultB = await executeBundlePlan(mgPlanB, mgApply(MG_B, STATE_MG_B, mgMerged.file));
check('B 应用合并后的包：内容就是段末那一刻的', read(MG_B, 'a.md'), 'A4 又长一点点了');
check('B 落在第 4 代（段末）', (await loadState(STATE_MG_B)).generation, 4);
check('两边状态编号一致', mgResultB.stateIdCompare, 'match');

// **中间那台**（C，站在第 2 代）：包覆盖了它站的这一点 → 收得下，而且直接落到段末
const mgPlanC = await planBundleApply(mgApply(MG_C, STATE_MG_C, mgMerged.file));
check('C（中间点）报告里认出"我站的这一点在包的路线上"', mgPlanC.report.viaMine, true);
const mgResultC = await executeBundlePlan(mgPlanC, mgApply(MG_C, STATE_MG_C, mgMerged.file));
check('C 应用合并后的包：内容就是段末那一刻的', read(MG_C, 'a.md'), 'A4 又长一点点了');
check('C 落在第 4 代（中间那两环不用补）', (await loadState(STATE_MG_C)).generation, 4);
check('C 那边状态编号也一致', mgResultC.stateIdCompare, 'match');

// 兄弟不算覆盖：从第 4 代分出去的"4 → 5"，对**站在第 1 代**的机器照旧拒收
write(MG_A, 'b.md', 'B1', mgT0 + 200_000);
const mgSibling = await exportBundle(mgExport(MG_A, STATE_MG_A));
await executeBundlePlan(
	await planBundleApply(mgApply(MG_D, STATE_MG_D, mgFull.file as string)),
	mgApply(MG_D, STATE_MG_D, mgFull.file as string),
);
check('D 站在第 1 代（不在兄弟包的路线上）', (await loadState(STATE_MG_D)).generation, 1);
const mgSiblingRejected = await planBundleApply(mgApply(MG_D, STATE_MG_D, mgSibling.file as string))
	.then(() => '收了')
	.catch((error: unknown) => (error instanceof Error && error.message.includes('接不上') ? '接不上' : '别的错'));
check('兄弟包不认"站在别的点上"的机器：照旧拒收', mgSiblingRejected, '接不上');

// 48. 用户实测的现场：**中间隔了一份完整副本**之后，站在老点上的机器还收得下新包吗
//
// 他的原话："我导出更新包 39-53，但导出完整包又加版本号到 54，我重新导出 39 到 54，
// 然后我在远程 53 应用 39 到 54 提示无法应用。"
// 根因：完整副本是一份**新基准**（没有"来路"），只按来路算"路上经过哪些点"就算不出 53 ——
// 现在改成按**内容**算：P 与落点不一样的路径都必须是这一包裹住的，那样 P 应用完正好落成落点。
const VX = path.join(ROOT, 'via');
const VX_A = path.join(VX, 'a');
const VX_R = path.join(VX, 'remote');
const VX_OUT = path.join(VX, 'transfer');
const STATE_VX_A = path.join(VX, 'state-a.json');
const STATE_VX_R = path.join(VX, 'state-remote.json');
for (const dir of [VX_A, VX_R, VX_OUT]) fs.mkdirSync(dir, { recursive: true });
const vxExport = (root: string, stateFile: string, mode: 'full' | 'changes' = 'changes', base?: string): ExportOptions =>
	({
		settings: settings(), log, vaultRoot: root, vaultName: '我的笔记', stateFile, mode, outDir: VX_OUT,
		...(base ? { baseFingerprint: base } : {}),
	});
const vxApply = (root: string, stateFile: string, file: string): ApplyOptions =>
	applyOptions(root, stateFile, file, { strictness: 'mirror' });

const vxT0 = Date.now();
write(VX_A, 'a.md', 'A1', vxT0);
const vxFull = await exportBundle(vxExport(VX_A, STATE_VX_A, 'full'));
const vxAnchor = vxFull.header?.baselineHash as string; // 「第 39 代」那种老起点

// ① 更新包：老起点 → 现在（相当于"39 → 53"）
write(VX_A, 'a.md', 'A2 长一点', vxT0 + 30_000);
const vxFirst = await exportBundle(vxExport(VX_A, STATE_VX_A, 'changes', vxAnchor));
check('第一份更新包送到第 2 代', vxFirst.header?.targetGeneration, 2);
// 远程站到那一点上（相当于"远程在 53"）
await executeBundlePlan(
	await planBundleApply(vxApply(VX_R, STATE_VX_R, vxFull.file as string)),
	vxApply(VX_R, STATE_VX_R, vxFull.file as string),
);
await executeBundlePlan(
	await planBundleApply(vxApply(VX_R, STATE_VX_R, vxFirst.file as string)),
	vxApply(VX_R, STATE_VX_R, vxFirst.file as string),
);
check('远程站在第 2 代（那就是"53"）', (await loadState(STATE_VX_R)).generation, 2);

// ② 中间又导了一份**完整副本**（新基准，没有来路）——这一步以前会把"路上经过谁"算丢
write(VX_A, 'a.md', 'A3 再长一点点', vxT0 + 60_000);
const vxFull2 = await exportBundle(vxExport(VX_A, STATE_VX_A, 'full'));
check('完整副本把它带到第 3 代', vxFull2.header?.targetGeneration, 3);

// ③ 重新导一份"老起点 → 现在"（相当于"39 → 54"）
const vxAgain = await exportBundle(vxExport(VX_A, STATE_VX_A, 'changes', vxAnchor));
check('新更新包送到第 3 代', vxAgain.header?.targetGeneration, 3);
const vxAgainInfo = await readBundleInfo(vxAgain.file as string);
// 中间那份完整副本把老的环清掉了（`removeSupersededChanges`），所以"沿来路认点"认不出第 2 代 ——
// 放行靠的是**算一遍落点**（下面那条断言），不再依赖 viaHashes。
check('这份包没记 via（老环已被完整副本取代）', vxAgainInfo.header.viaHashes ?? [], []);

// ④ 远程应用它：**能成功**，而且正好落到落点
const vxPlan = await planBundleApply(vxApply(VX_R, STATE_VX_R, vxAgain.file as string));
check('报告里认出"我站的这一点在包的路线上"', vxPlan.report.viaMine, true);
const vxResult = await executeBundlePlan(vxPlan, vxApply(VX_R, STATE_VX_R, vxAgain.file as string));
check('远程应用成功：内容就是最新那版', read(VX_R, 'a.md'), 'A3 再长一点点');
check('远程落到第 3 代', (await loadState(STATE_VX_R)).generation, 3);
check('两边状态编号一致', vxResult.stateIdCompare, 'match');

// 49. "内容没变就绝不加代"：文件被碰了一下（改时间不改内容）也不算变化
//
// 用户的原话："导出完整副本本身根本不改变内容，不应该增加世代，之前修过了，你再仔细检查下"。
// 以前判"动没动"看的是**大小 + 修改时间**：网盘同步、编辑器重写、touch 一下都会让记录变，
// 于是白占一个世代号（而状态编号明明一样）。现在按**内容编号**判 —— 编号不变就是不占新代。
const TT = path.join(ROOT, 'touch');
const TT_VAULT = path.join(TT, 'vault');
const TT_OUT = path.join(TT, 'transfer');
const STATE_TT = path.join(TT, 'state.json');
for (const dir of [TT_VAULT, TT_OUT]) fs.mkdirSync(dir, { recursive: true });
const ttExport = (mode: 'full' | 'changes' = 'changes'): ExportOptions =>
	({ settings: settings(), log, vaultRoot: TT_VAULT, vaultName: '我的笔记', stateFile: STATE_TT, mode, outDir: TT_OUT });

const ttT0 = Date.now();
write(TT_VAULT, 'a.md', 'A1', ttT0);
write(TT_VAULT, 'b.md', 'B1', ttT0);
const ttFull = await exportBundle(ttExport('full'));
check('第一份完整副本是第 1 代', ttFull.header?.targetGeneration, 1);

// 只碰时间、内容一个字不改（模拟网盘同步 / 编辑器重写）
fs.utimesSync(abs(TT_VAULT, 'a.md'), new Date(ttT0 + 500_000), new Date(ttT0 + 500_000));
const ttFull2 = await exportBundle(ttExport('full'));
check('只碰了时间（内容没变）→ **不占新世代**', ttFull2.header?.targetGeneration, 1);
check('状态编号也没变', ttFull2.header?.stateId?.id, ttFull.header?.stateId?.id);

// 更新包同理：内容没变时不许 +1
const ttChanges = await exportBundle(ttExport('changes'));
check('内容没变：更新包也不 +1（导不出来东西）', ttChanges.file, null);

// 真改了内容才 +1
write(TT_VAULT, 'a.md', 'A2 长一点', ttT0 + 900_000);
const ttMoved = await exportBundle(ttExport('full'));
check('内容真变了 → +1', ttMoved.header?.targetGeneration, 2);
check('状态编号跟着变', ttMoved.header?.stateId?.id !== ttFull.header?.stateId?.id, true);

// 50. **段首那份完整副本被删了，照样合得成**（用户报的：「39 到 54，54 到 55 合不上」）
//
// 他的现场：第 39 代那份完整副本几百 MB、太占地方，删了；手里只剩「39→54」与「54→55」两环。
// 老实现要"重新导一份 39→55"，而重新导得先把**段首那一点**算出来 —— 它要从一份完整副本起步，
// 起点那份没了就什么都算不出来，合并窗口里空空的。现在合并走**拼装**：内容在那几环的负载里、
// 版本关系在它们的 base 里，一份完整副本都不需要，也不读仓库。
const AG = path.join(ROOT, 'anchor-gone');
const AG_A = path.join(AG, 'a');      // 本机（就是删掉段首那份完整副本的那台）
const AG_B = path.join(AG, 'b');      // 站在段首（第 1 代）的机器
const AG_C = path.join(AG, 'c');      // 站在中间那一点（第 2 代）的机器
const AG_OUT = path.join(AG, 'transfer');
const AG_STATE_A = path.join(AG, 'state-a.json');
const AG_STATE_B = path.join(AG, 'state-b.json');
const AG_STATE_C = path.join(AG, 'state-c.json');
for (const dir of [AG_A, AG_B, AG_C, AG_OUT]) fs.mkdirSync(dir, { recursive: true });
const agExport = (root: string, stateFile: string, mode: 'full' | 'changes' = 'changes', extra: Partial<ExportOptions> = {}): ExportOptions =>
	({ settings: settings(), log, vaultRoot: root, vaultName: '我的笔记', stateFile, mode, outDir: AG_OUT, ...extra });
const agApply = (root: string, stateFile: string, file: string): ApplyOptions =>
	applyOptions(root, stateFile, file, { strictness: 'mirror' });
const agMerge = (): MergeOptions => ({ outDir: AG_OUT, log, stateFile: AG_STATE_A, vaultName: '我的笔记' });

const agT0 = Date.now();
write(AG_A, 'a.md', 'AG1', agT0);
const agFull1 = await exportBundle(agExport(AG_A, AG_STATE_A, 'full'));
check('第一份完整副本是第 1 代', agFull1.header?.targetGeneration, 1);
write(AG_A, 'a.md', 'AG2 长一点', agT0 + 30_000);
const agFull2 = await exportBundle(agExport(AG_A, AG_STATE_A, 'full'));
check('第二份完整副本是第 2 代', agFull2.header?.targetGeneration, 2);

// ① 第 1 代那台机器先应用（趁那份包还在）
await executeBundlePlan(
	await planBundleApply(agApply(AG_B, AG_STATE_B, agFull1.file as string)),
	agApply(AG_B, AG_STATE_B, agFull1.file as string),
);
check('B 站在第 1 代（段首）', (await loadState(AG_STATE_B)).generation, 1);

// ② 「1 → 2」那一环：照着第 1 代导的差量包（对面手里就是第 1 代）
const agRing1 = await exportBundle(agExport(AG_A, AG_STATE_A, 'changes', {
	baseFingerprint: agFull1.header?.baselineHash ?? '',
	toFingerprint: agFull2.header?.baselineHash ?? '',
}));
check('导出了「1 → 2」这一环', agRing1.header?.targetGeneration, 2);
check('它记着起点是第 1 代', agRing1.header?.baseGeneration, 1);

// ③ 「2 → 3」那一环（第 2 代那台机器再往前走一格）
write(AG_A, 'a.md', 'AG3 再长一点点', agT0 + 60_000);
const agRing2 = await exportBundle(agExport(AG_A, AG_STATE_A, 'changes'));
check('导出了「2 → 3」这一环', agRing2.header?.targetGeneration, 3);
await executeBundlePlan(
	await planBundleApply(agApply(AG_C, AG_STATE_C, agFull2.file as string)),
	agApply(AG_C, AG_STATE_C, agFull2.file as string),
);
check('C 站在第 2 代（中间那一点）', (await loadState(AG_STATE_C)).generation, 2);

// ④ **把第 1 代那份完整副本删掉**（用户干的那件事）
fs.rmSync(agFull1.file as string);
checkTrue('第 1 代那份包确实不在了', !fs.existsSync(agFull1.file as string), '还在');

const agLineage = (await loadState(AG_STATE_A)).lineage;
const agPlans = (await planBundleMerges(AG_OUT, agLineage)).plans;
check('段首那份完整副本没了，照样算出了可以合并的一段', agPlans.length, 1);
check(
	'这一段正是「第 1 → 3 代、两环并一环、中间一个点」',
	[agPlans[0]?.anchorGeneration, agPlans[0]?.targetGeneration, agPlans[0]?.links.length, agPlans[0]?.middlePoints.length],
	[1, 3, 2, 1],
);

const agMerged = await mergeBundleGroup(agMerge(), agPlans[0] as NonNullable<typeof agPlans[0]>);
checkTrue('合并后的包写出来了', typeof agMerged.file === 'string' && agMerged.file.length > 0, '没有文件名');
check('那两环都挪进了回收站', agMerged.trashed.length, 2);
const agMergedInfo = await readBundleInfo(agMerged.file);
check(
	'合并后：起点还是段首那一点、落点还是段末那一点',
	[agMergedInfo.header.baseGeneration, agMergedInfo.header.targetGeneration, agMergedInfo.header.baselineHash],
	[1, 3, agRing1.header?.baselineHash],
);
check('落点指纹就是段末那一点', agMergedInfo.header.targetBaselineHash, agRing2.header?.targetBaselineHash);
check('状态编号取段末那一刻的', agMergedInfo.header.stateId?.id, agRing2.header?.stateId?.id);
check('装的是段末那一刻的内容', agMergedInfo.header.entries.map(entry => entry.path), ['a.md']);
check(
	'内容取的是**段末那一环**的负载（不是我现在的仓库）',
	(await readEntry(agMerged.file, agMergedInfo, agMergedInfo.header.entries[0]!)).toString('utf8'),
	'AG3 再长一点点',
);
check('本机什么都不推进（还是第 3 代）', (await loadState(AG_STATE_A)).generation, 3);
check('本机基准那一行改指合并后的这一份', (await loadState(AG_STATE_A)).bundle?.fullFile, path.basename(agMerged.file));
check('合并完再看：没有可合并的了', (await planBundleMerges(AG_OUT, agLineage)).plans.length, 0);

// ⑤ 站在**段首**（第 1 代）的机器：起点严格相等 → 收下，应用完落到第 3 代
const agPlanB = await planBundleApply(agApply(AG_B, AG_STATE_B, agMerged.file));
check('B（段首）基准对得上', agPlanB.report.baselineMatch, 'match');
const agResultB = await executeBundlePlan(agPlanB, agApply(AG_B, AG_STATE_B, agMerged.file));
check('B 应用后内容就是段末那一刻的', read(AG_B, 'a.md'), 'AG3 再长一点点');
check('B 落在第 3 代', (await loadState(AG_STATE_B)).generation, 3);
check('B 跟对方状态编号一致', agResultB.stateIdCompare, 'match');

// ⑥ 站在**中间那一点**（第 2 代）的机器：起点对不上，但算一遍落点正好是段末 → 收下
const agPlanC = await planBundleApply(agApply(AG_C, AG_STATE_C, agMerged.file));
check('C（中间点）认出"我站的这一点在它的路线上"', agPlanC.report.viaMine, true);
const agResultC = await executeBundlePlan(agPlanC, agApply(AG_C, AG_STATE_C, agMerged.file));
check('C 应用后也是段末那一刻的内容', read(AG_C, 'a.md'), 'AG3 再长一点点');
check('C 也落在第 3 代', (await loadState(AG_STATE_C)).generation, 3);
check('C 那边状态编号也一致', agResultC.stateIdCompare, 'match');

console.log(`\n共 ${checks} 次检查，失败 ${failures.length} 项`);
for (const message of failures.slice(0, 10)) console.log("\n❌ " + message);
if (failures.length > 10) console.log(`\n…… 其余 ${failures.length - 10} 项失败已省略`);
if (failures.length > 0) process.exitCode = 1;
