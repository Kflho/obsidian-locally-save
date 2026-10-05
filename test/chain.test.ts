/**
 * **自动接链**：本机站在链条上的某一点，文件夹里躺着后面几环 —— 认出整条链、按顺序接到末端，
 * 同时**保住本机自己的改动**。
 *
 * 链条模型（0.11 起）：每个包头部都记着"我从哪一点来"（`baselineHash`）与"我落到哪一点"
 * （`targetBaselineHash`），所以链是**从头部数据认出来**的，不靠人指。这个文件钉三件事：
 * 1. 认链：完整包 → 更新包 → 更新包 首尾相接；
 * 2. 本机的点落在链中间（自己导过一环之后的那种点）也认得出后面的环；
 * 3. 接不上的时候**如实说缺哪一份**，绝不猜着合。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeBundlePlan, planBundleApply } from '../src/bundle/apply';
import type { ApplyOptions } from '../src/bundle/apply';
import { planChain, runChain } from '../src/bundle/chain';
import { exportBundle } from '../src/bundle/export';
import type { ExportOutcome } from '../src/bundle/export';
import type { ExportOptions } from '../src/bundle/export';
import { listPointRefsSync, materializePointSync } from '../src/bundle/points';
import { readBundleInfo } from '../src/bundle/format';
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
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lsave-chain-'));
const A = path.join(ROOT, 'machineA');
const B = path.join(ROOT, 'machineB');
const OUT = path.join(ROOT, 'transfer');
for (const dir of [A, B, OUT]) fs.mkdirSync(dir, { recursive: true });

const STATE_A = path.join(ROOT, 'state-a.json');
const STATE_B = path.join(ROOT, 'state-b.json');
const SCRATCH = path.join(ROOT, 'scratch');
fs.mkdirSync(SCRATCH, { recursive: true });

const log = createLogger(() => 'silent');
const settings = (overrides: Partial<PluginSettings> = {}): PluginSettings => ({ ...DEFAULT_SETTINGS, ...overrides });
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

const exportOptions = (root: string, stateFile: string, mode: 'full' | 'changes'): ExportOptions =>
	({ settings: settings(), log, vaultRoot: root, vaultName: '我的笔记', stateFile, mode, outDir: OUT });
const applyOptions = (root: string, stateFile: string, file: string): ApplyOptions =>
	({ settings: settings(), log, vaultRoot: root, stateFile, file });

// -------------------------------------------------------------------- 用例
const T0 = Date.now() - 3_600_000;
write(A, 'a.md', 'A1', T0);
write(A, 'b.md', 'B1', T0);
const full = await exportBundle(exportOptions(A, STATE_A, 'full'));

// A 往后走两环：每一环都从上一环的落点往外延伸
write(A, 'a.md', 'A2 改过了', T0 + 60_000);
const linkOne = await exportBundle(exportOptions(A, STATE_A, 'changes'));
write(A, 'c.md', 'C1', T0 + 120_000);
const linkTwo = await exportBundle(exportOptions(A, STATE_A, 'changes'));
checkTrue('两环都导出来了', linkOne.file !== null && linkTwo.file !== null, `${linkOne.file} / ${linkTwo.file}`);

const fullHeader = (await readBundleInfo(full.file as string)).header;
const oneHeader = (await readBundleInfo(linkOne.file as string)).header;
const twoHeader = (await readBundleInfo(linkTwo.file as string)).header;
check('第一环从完整包那一点往外延伸', oneHeader.baselineHash, fullHeader.baselineHash);
check('第二环从第一环的落点往外延伸', twoHeader.baselineHash, oneHeader.targetBaselineHash);
check('A 导完站在链条末端那一点上', (await loadState(STATE_A)).bundle?.fullHash, twoHeader.targetBaselineHash);

// 1. B 站到同一条链的起点上，本机还有自己的一个文件
await executeBundlePlan(
	await planBundleApply(applyOptions(B, STATE_B, full.file as string)),
	applyOptions(B, STATE_B, full.file as string),
);
write(B, 'mine.md', 'MINE', T0 + 60_000);

const planB = await planChain(applyOptions(B, STATE_B, full.file as string), OUT);
check('认得出链条后面的两环', planB.steps.map(step => path.basename(step.file)), [
	path.basename(linkOne.file as string),
	path.basename(linkTwo.file as string),
]);
check('起点写清是从哪一份包来的', path.basename(planB.from?.file ?? ''), path.basename(full.file as string));
check('接到了链条末端那一代', planB.endGeneration, twoHeader.targetGeneration);
check('能接（没有 problem）', planB.problem, null);
check('本机独有的文件会被放回去', planB.extraFiles, ['mine.md']);

const outcome = await runChain(applyOptions(B, STATE_B, full.file as string), planB, SCRATCH);
check('两环都应用了', outcome.applied.length, 2);
check('没有失败项', outcome.failed, []);
check('内容接到了链条末端', [read(B, 'a.md'), read(B, 'c.md')], ['A2 改过了', 'C1']);
check('本机自己的文件保住了', read(B, 'mine.md'), 'MINE');
check('接完之后本机站在链条末端那一点上', (await loadState(STATE_B)).bundle?.fullHash, twoHeader.targetBaselineHash);

// 2. 已经站在末端：没有可接的环（如实说"已经在这条链的末端"）
const planEnd = await planChain(applyOptions(B, STATE_B, full.file as string), OUT);
check('已在末端：没有步骤', planEnd.steps.length, 0);
checkTrue('并说明已经在末端', (planEnd.problem ?? '').includes('末端'), String(planEnd.problem));

// 3. 本机站在**链条中间的点**上（自己导过一环之后就是这种点）：照样认得出后面那几环
const MID = path.join(ROOT, 'machineMid');
const STATE_MID = path.join(ROOT, 'state-mid.json');
fs.mkdirSync(MID, { recursive: true });
await executeBundlePlan(
	await planBundleApply(applyOptions(MID, STATE_MID, full.file as string)),
	applyOptions(MID, STATE_MID, full.file as string),
);
await executeBundlePlan(
	await planBundleApply(applyOptions(MID, STATE_MID, linkOne.file as string)),
	applyOptions(MID, STATE_MID, linkOne.file as string),
);
const planMid = await planChain(applyOptions(MID, STATE_MID, linkTwo.file as string), OUT);
check('站在中间的点：只剩后面那一环', planMid.steps.map(step => path.basename(step.file)), [path.basename(linkTwo.file as string)]);
check('中间的点也说得清是从哪份包来的', path.basename(planMid.from?.file ?? ''), path.basename(linkOne.file as string));
check('只关心包含选中包的链：选中的那一环在链上 → 认', planMid.problem, null);

// 4. 接不上：本机的点根本不在这个文件夹的链上 → 说清缺哪一份，不猜着合
const LONE = path.join(ROOT, 'machineLone');
const STATE_LONE = path.join(ROOT, 'state-lone.json');
const OUT_LONE = path.join(ROOT, 'transfer-lone');
fs.mkdirSync(LONE, { recursive: true });
fs.mkdirSync(OUT_LONE, { recursive: true });
// 它跟 A 同血脉（认了第一份完整副本），但**自己另走了一环**（导在别的目录里）：
// 于是它站在链外的一个点上，OUT 里那条链接不上它
await executeBundlePlan(
	await planBundleApply(applyOptions(LONE, STATE_LONE, full.file as string)),
	applyOptions(LONE, STATE_LONE, full.file as string),
);
write(LONE, 'solo.md', 'SOLO', T0 + 240_000);
await exportBundle({
	settings: settings(), log, vaultRoot: LONE, vaultName: '我的笔记',
	stateFile: STATE_LONE, mode: 'changes', outDir: OUT_LONE,
});
const lonePoint = (await loadState(STATE_LONE)).bundle?.fullHash ?? '';
checkTrue('（前置）本机这一点确实不在 OUT 那条链上', lonePoint !== twoHeader.targetBaselineHash, lonePoint);
const planLone = await planChain(applyOptions(LONE, STATE_LONE, full.file as string), OUT);
check('接不上：没有步骤', planLone.steps.length, 0);
checkTrue('接不上：说清本机这一点不在链上', (planLone.problem ?? '').includes(lonePoint), String(planLone.problem));

// 5. **从链条上的任意一点导出**：两个下拉列的是「完整副本 ＋ 链条上的每一个点」，
//    起点 / 终点都可以是中间点。终点是中间点时，内容要**沿链条逐文件取** ——
//    改过的在那一环的包里，没动过的还在起点那份包里（见 `bundle/points.ts`）
const CP_A = path.join(ROOT, 'chain-a');
const CP_B = path.join(ROOT, 'chain-b');
const CP_C = path.join(ROOT, 'chain-c');
const STATE_CP_A = path.join(ROOT, 'state-chain-a.json');
const STATE_CP_B = path.join(ROOT, 'state-chain-b.json');
const STATE_CP_C = path.join(ROOT, 'state-chain-c.json');
const OUT_CP = path.join(ROOT, 'transfer-chain');
for (const dir of [CP_A, CP_B, CP_C, OUT_CP]) fs.mkdirSync(dir, { recursive: true });

const T_CP = Date.now() - 1_200_000;
const cpExport = (mode: 'full' | 'changes', extra: Record<string, string> = {}): Promise<ExportOutcome> =>
	exportBundle({
		settings: settings(), log, vaultRoot: CP_A, vaultName: '我的笔记',
		stateFile: STATE_CP_A, mode, outDir: OUT_CP, ...extra,
	});
write(CP_A, 'a.md', 'A1', T_CP);
write(CP_A, 'b.md', 'B1', T_CP);
const cpFull = await cpExport('full');
checkTrue('（前置）链条机器的完整包导出成功', cpFull.file !== null, cpFull.reason ?? '（没给原因）');
write(CP_A, 'a.md', 'A2 改过', T_CP + 60_000);
const cpLink1 = await cpExport('changes');
write(CP_A, 'b.md', 'B2 也改过', T_CP + 120_000);
const cpLink2 = await cpExport('changes');

const lineage = (await readBundleInfo(cpFull.file as string)).header.lineage;
const p0 = (await readBundleInfo(cpFull.file as string)).header.baselineHash as string;
const p1 = (await readBundleInfo(cpLink1.file as string)).header.targetBaselineHash as string;
const p2 = (await readBundleInfo(cpLink2.file as string)).header.targetBaselineHash as string;

const refs = listPointRefsSync(OUT_CP, lineage);
check('链条上的三个点都列得出来（完整包 + 两环）', refs.map(ref => ref.hash).sort(), [p0, p1, p2].sort());
check('世代也跟着写出来', refs.map(ref => ref.generation).sort(), [1, 2, 3]);

const pointP1 = materializePointSync(OUT_CP, lineage, p1);
check(
	'P1 的清单沿链条算得出来：a 是改过的那版、b 还是老样子',
	[pointP1?.files['a.md']?.size, pointP1?.files['b.md']?.size],
	[Buffer.byteLength('A2 改过'), Buffer.byteLength('B1')],
);
const pointP2 = materializePointSync(OUT_CP, lineage, p2);
check(
	'P2 的清单：两个都改了',
	[pointP2?.files['a.md']?.size, pointP2?.files['b.md']?.size],
	[Buffer.byteLength('A2 改过'), Buffer.byteLength('B2 也改过')],
);
check('找不到的点就返回 null（不猜）', materializePointSync(OUT_CP, lineage, 'ffffffffffffffff'), null);

// B 站在 P1、C 站在 P0
for (const [root, stateFile, file] of [
	[CP_B, STATE_CP_B, cpFull.file as string],
	[CP_B, STATE_CP_B, cpLink1.file as string],
	[CP_C, STATE_CP_C, cpFull.file as string],
] as const) {
	await executeBundlePlan(await planBundleApply(applyOptions(root, stateFile, file)), applyOptions(root, stateFile, file));
}
check('（前置）B 站在 P1 上', (await loadState(STATE_CP_B)).bundle?.fullHash, p1);
check('（前置）C 站在 P0 上', (await loadState(STATE_CP_C)).bundle?.fullHash, p0);

// ① 「从 P1 导到 P2」：这一份跟链条上那一环（L2 就是 P1 → P2）**内容一模一样**
//    → 不重复生成，直接说清"已经有一份了"（省得文件夹里躺着两份同样的东西）
const cpOne = await cpExport('changes', { baseFingerprint: p1, toFingerprint: p2 });
check('从 P1 到 P2 已经有一份 → 不重复生成', cpOne.file, null);
checkTrue('并说清是哪一份', (cpOne.reason ?? '').includes(path.basename(cpLink2.file as string)), cpOne.reason ?? '');
const cpOneApply = applyOptions(CP_B, STATE_CP_B, cpLink2.file as string);
check('B 收得下链条上那一环（起点正是它站的 P1）', (await planBundleApply(cpOneApply)).report.baselineMatch, 'match');
await executeBundlePlan(await planBundleApply(cpOneApply), cpOneApply);
check('B 应用完落到 P2', (await loadState(STATE_CP_B)).bundle?.fullHash, p2);
check('B 的内容就是 P2 那一刻的', [read(CP_B, 'a.md'), read(CP_B, 'b.md')], ['A2 改过', 'B2 也改过']);

// ② 「从 P0 导到 P2」：链条上**没有**这样一份包（L1 是 P0→P1、L2 是 P1→P2）
//    → 现导一份，内容沿链条逐文件取：a 的字节在第一环的负载里、b 的在第二环的负载里
const cpTwo = await cpExport('changes', { baseFingerprint: p0, toFingerprint: p2 });
checkTrue('从 P0 到 P2 现导一份', cpTwo.file !== null, cpTwo.reason ?? '');
const cpTwoHeader = (await readBundleInfo(cpTwo.file as string)).header;
check('起点 P0、终点 P2', [cpTwoHeader.baselineHash, cpTwoHeader.targetBaselineHash], [p0, p2]);
check('终点世代也对上', cpTwoHeader.targetGeneration, 3);
check('它把两环的改动都装进来了', cpTwoHeader.entries.map(entry => entry.path).sort(), ['a.md', 'b.md']);
check('导差量包不推进本机（A 还站在 P2）', (await loadState(STATE_CP_A)).bundle?.fullHash, p2);

const cpTwoApply = applyOptions(CP_C, STATE_CP_C, cpTwo.file as string);
const cpTwoResult = await executeBundlePlan(await planBundleApply(cpTwoApply), cpTwoApply);
check('C 应用完落到 P2', (await loadState(STATE_CP_C)).bundle?.fullHash, p2);
check(
	'C 拿到的是 P2 那一刻的字节（两份包的负载各出一半）',
	[read(CP_C, 'a.md'), read(CP_C, 'b.md')],
	['A2 改过', 'B2 也改过'],
);
check('状态编号一致', cpTwoResult.stateIdCompare, 'match');
check(
	'两台机器最后站在同一点上',
	(await loadState(STATE_CP_B)).bundle?.fullHash,
	(await loadState(STATE_CP_C)).bundle?.fullHash,
);

console.log(`\n共 ${checks} 次检查，失败 ${failures.length} 项`);
for (const message of failures.slice(0, 10)) console.log("\n❌ " + message);
if (failures.length > 0) process.exitCode = 1;
