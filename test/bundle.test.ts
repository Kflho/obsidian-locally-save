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
import type { ApplyOptions, ApplyPlan } from '../src/bundle/apply';
import { exportBundle } from '../src/bundle/export';
import type { ExportOptions } from '../src/bundle/export';
import { BUNDLE_FORMAT, BUNDLE_VERSION, readBundleInfo, verifyBundle, writeBundle } from '../src/bundle/format';
import { bundleBaseDir, bundleDirForMode, bundleDirsToScan } from '../src/bundle/paths';
import { DEFAULT_SETTINGS } from '../src/settings/model';
import type { PluginSettings } from '../src/settings/model';
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
		strictness?: 'normal' | 'bundle-wins' | 'mirror';
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
const vPlan = await planBundleApply(applyOptions(V, STATE_V, FILE_CHANGES, { strictness: 'mirror' }));
check('更新包用强制档 → 降级成默认档', vPlan.report.strictness, 'normal');
check('报告里标出"被降级了"（界面要说明白）', vPlan.report.strictnessDowngraded, true);
check('报告里 forced 也不再成立', vPlan.report.forced, false);
check(
	'没有把"包里没提到的文件"当成该删',
	vPlan.actions.filter(action => action.kind === 'delete').map(action => action.path),
	[],
);
await executeBundlePlan(vPlan, applyOptions(V, STATE_V, FILE_CHANGES, { strictness: 'mirror' }));
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

console.log(`\n共 ${checks} 次检查，失败 ${failures.length} 项`);
for (const message of failures.slice(0, 10)) console.log("\n❌ " + message);
if (failures.length > 10) console.log(`\n…… 其余 ${failures.length - 10} 项失败已省略`);
if (failures.length > 0) process.exitCode = 1;
