/**
 * **自动接链**：本机站在某一份完整副本上，文件夹里躺着后面几环 —— 认出整条链、按顺序接到末端，
 * 同时**保住本机自己的改动**。
 *
 * ## 0.14 起的新模型（权威说明：`docs/只有完整包才算基准点-实施计划.md`）
 *
 * **只有完整包才算"基准点"** —— `state.bundle.fullFiles / fullGeneration / fullHash / fullFile`
 * 表示"我站的那一份完整副本"。更新包只剩两种形态：
 *
 * | 形态 | 起点 | 终点 | 内容取自 |
 * |---|---|---|---|
 * | **差量包** | 一份完整包 | **另一份完整包** | 终点那份包的负载（`targetFullBundle: true`） |
 * | **普通更新包** | 一份完整包 | **最新状态** | 当前仓库（没有 `targetFullBundle`） |
 *
 * **点只在三种时候前进**：导出完整包、应用完整包、应用差量包。
 * **导出 / 应用普通更新包都不动它** —— 所以同一份完整副本之下可以连着导好几份更新包，
 * 它们的 `baselineHash` 全都等于那份完整副本的指纹（不是上一份的落点）。
 *
 * ### 0.13 及以前有、**0.14 起这些概念不存在了**（这个文件从前守着它们，现在删掉）
 *
 * - `src/bundle/points.ts`（"链条上的中间点"）与 `listPointRefsSync` / `materializePointSync`：
 *   更新包不再落出一个能当起点的新点，"从链条中间的某个点往外导"这条路没有了；
 * - `anchor.ts` 的 `planAutoStart` / `AutoStartPlan`（"自动接线头"）：起点默认就是**我站的那一份完整包**；
 * - `ExportStartInfo` 的 `head` / `problem` 两个字段与 `'auto'` 这个取值；
 * - `state.bundle.pointConfirmed`（"这个点是我导的、还是对方确认过的"）；
 * - **两份普通更新包首尾相接**：普通更新包的落点不再是基准点，两份包现在共享同一个起点
 *   （都是那份完整副本），所以"1→2、2→3"那种写法已经不成立。
 *   能首尾相接的链**只可能是差量包串起来的**：`F0 →(差量包)→ F1 →(差量包或"F1 → 最新")→ F2`，
 *   中间那一环必须**真的是一份完整副本** —— 这就是这个文件的 fixture 必须
 *   "先在中间导一份完整包、再导差量包"的原因。
 *
 * "本机站在链条中间某个点"这类断言也跟着改成**"本机站在某一份完整副本上"**（应用一份差量包之后
 * 就站到它的终点那份完整副本上），语义没削弱：认链、判本机在不在链上、按顺序接、接不上如实说。
 *
 * ### 这个文件守的不变量
 *
 * ① 更新包的起点必须与本机站的基准**严格相等**（`baselineMatch === 'match'`），
 *    对不上就拒收，并把出路说清（让对方按本机指纹重导 / 让对方导一份完整副本）；
 * ② 严格镜像：应用完**仓库 == 包**（状态编号当场一致）；
 * ③ 本机独有的改动 / 本机改过的文件**不丢**（`planChain.extraFiles` / `edits`，`runChain` 放回去）；
 * ④ 状态编号一致 / 收敛；
 * ⑤ 差量包导出**不推进本机**状态；
 * ⑥ **基准点只在"完整包 × 3 种动作"上动**：导出 / 应用普通更新包之后
 *    `fullHash` / `fullGeneration` / `fullFiles` / `fullFile` 一个都没变。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeBundlePlan, planBundleApply } from '../src/bundle/apply';
import type { ApplyOptions } from '../src/bundle/apply';
import { listingHashOfFiles } from '../src/bundle/baseline';
import { planChain, runChain } from '../src/bundle/chain';
import { exportBundle } from '../src/bundle/export';
import type { ExportOptions } from '../src/bundle/export';
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

/** 跑一个**应该被拒收**的操作，返回错误信息（没报错就记一项失败） */
async function expectReject(name: string, run: () => Promise<unknown>): Promise<string> {
	checks++;
	try {
		await run();
		failures.push(`[应该拒收] ${name}\n  实际没有报错`);
		return '';
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

// -------------------------------------------------------------------- 环境
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lsave-chain-'));
const SCRATCH = path.join(ROOT, 'scratch');
fs.mkdirSync(SCRATCH, { recursive: true });

/** 一台机器 ＝ 一个仓库目录 ＋ 一个状态文件（各记各的，跟真机一样） */
function machine(name: string): { root: string; state: string } {
	const root = path.join(ROOT, name);
	fs.mkdirSync(root, { recursive: true });
	return { root, state: path.join(ROOT, `state-${name}.json`) };
}

/** 导出侧：更新包不产生新点（同一份完整副本下连着导两份） */
const EXP = machine('exp');
/** 链条的源头：F0 → F1 → F2 三份完整副本 ＋ 两份差量包 */
const CH = machine('chain');
/** 站在链条起点 F0 上，接完整条链 */
const B = machine('b');
/** 站在链条中间那份完整副本 F1 上 */
const MID = machine('mid');
/** 站在 F0 上，用来验"起点必须严格相等" */
const OFF = machine('off');
/** 严格镜像 ＋ 普通更新包不推进基准 */
const SX = machine('strict');
/** 包里没提到的本地改动留在原地 */
const SX2 = machine('strict2');

const OUT_EXP = path.join(ROOT, 'transfer-exp');
const OUT_CHAIN = path.join(ROOT, 'transfer-chain');
for (const dir of [OUT_EXP, OUT_CHAIN]) fs.mkdirSync(dir, { recursive: true });

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

const exportOptions = (
	root: string,
	stateFile: string,
	mode: 'full' | 'changes',
	outDir: string,
): ExportOptions => ({ settings: settings(), log, vaultRoot: root, vaultName: '我的笔记', stateFile, mode, outDir });
const applyOptions = (root: string, stateFile: string, file: string): ApplyOptions =>
	({ settings: settings(), log, vaultRoot: root, stateFile, file });

/** 把一份完整副本应用过去（完整副本一律严格镜像，不用选档） */
async function applyFull(root: string, stateFile: string, file: string): Promise<void> {
	await executeBundlePlan(
		await planBundleApply(applyOptions(root, stateFile, file)),
		applyOptions(root, stateFile, file),
	);
}

/** 基准那三件（含 `fullFile`）的指纹：判断"点动没动"就照它比 */
const pointFingerprint = async (stateFile: string): Promise<string> => {
	const state = await loadState(stateFile);
	return [
		state.bundle?.fullHash ?? '(无)',
		String(state.bundle?.fullGeneration ?? '(无)'),
		state.bundle?.fullFile ?? '(无)',
		listingHashOfFiles(state.bundle?.fullFiles ?? {}),
	].join(' · ');
};

/** 回收目录里某个文件的备份内容（严格档下被覆盖 / 挪走的那一份都在这儿） */
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

// ═════════════════════════════════════════════ 1. 导出侧：普通更新包不产生新点
//
// 新模型最容易写错的一条：**导出更新包不再把点往前推**。所以同一份完整副本之下
// 可以连着导好几份更新包，它们的 `baselineHash` 全都等于**那份完整副本**的指纹。
const T_EXP = Date.now() - 3_600_000;
write(EXP.root, 'a.md', 'A1', T_EXP);
write(EXP.root, 'b.md', 'B1', T_EXP);
const expFull = await exportBundle(exportOptions(EXP.root, EXP.state, 'full', OUT_EXP));
checkTrue('（前置）导出完整副本', expFull.file !== null, expFull.reason ?? '（没给原因）');
const expFullHeader = (await readBundleInfo(expFull.file as string)).header;
const pExp = expFullHeader.baselineHash as string;
const expAtPoint = await pointFingerprint(EXP.state);
/** 基准清单的指纹（点动没动，"清单"这一半照它比 —— 比对象顺序无关） */
const expFullFilesHash = listingHashOfFiles((await loadState(EXP.state)).bundle?.fullFiles ?? {});
check('（前置）导完完整副本就站在它上面', (await loadState(EXP.state)).bundle?.fullHash, pExp);

// ① 第一份普通更新包：自这份完整副本累积到"最新状态"
write(EXP.root, 'a.md', 'A2 改长一点', T_EXP + 60_000);
const expU1 = await exportBundle(exportOptions(EXP.root, EXP.state, 'changes', OUT_EXP));
const expU1Header = (await readBundleInfo(expU1.file as string)).header;
check('普通更新包仍是"从那份完整副本往外算"', expU1Header.baselineHash, pExp);
check('普通更新包不标「送到的是完整副本」', expU1Header.targetFullBundle, undefined);
checkTrue(
	'普通更新包的落点是"最新状态"的清单指纹（不是基准点）',
	expU1Header.targetBaselineHash !== undefined && expU1Header.targetBaselineHash !== pExp,
	String(expU1Header.targetBaselineHash),
);

const expAfterU1 = await loadState(EXP.state);
check('**导出普通更新包：基准指纹没变**', expAfterU1.bundle?.fullHash, pExp);
check('**基准世代没变**', expAfterU1.bundle?.fullGeneration, expFullHeader.targetGeneration);
check(
	'**基准清单没变（还是那份完整副本）**',
	listingHashOfFiles(expAfterU1.bundle?.fullFiles ?? {}),
	expFullFilesHash,
);
check('也不动「我站的是哪一份包」', expAfterU1.bundle?.fullFile, path.basename(expFull.file as string));
check('内容那一半照旧前进：世代采纳包头部报的那一代', expAfterU1.generation, expU1Header.targetGeneration);
checkTrue('世代确实往前走了', expAfterU1.generation > expFullHeader.targetGeneration, `${expFullHeader.targetGeneration} → ${expAfterU1.generation}`);
check('状态编号跟着内容走', expAfterU1.stateId?.id, expU1Header.stateId?.id);
checkTrue(
	'状态编号与导完整副本时不同',
	expAfterU1.stateId?.id !== expFullHeader.stateId?.id,
	`${expFullHeader.stateId?.id} → ${expAfterU1.stateId?.id}`,
);

// ② 第二份普通更新包：起点**仍是那份完整副本**（不是第一份的落点）
write(EXP.root, 'b.md', 'B2 也改过', T_EXP + 120_000);
const expU2 = await exportBundle(exportOptions(EXP.root, EXP.state, 'changes', OUT_EXP));
const expU2Header = (await readBundleInfo(expU2.file as string)).header;
check('**第二份更新包的起点仍是那份完整副本的指纹**（不是第一份的落点）', expU2Header.baselineHash, pExp);
checkTrue(
	'两份包的落点不一样（后一份内容更多）',
	expU2Header.targetBaselineHash !== expU1Header.targetBaselineHash,
	`${expU1Header.targetBaselineHash} / ${expU2Header.targetBaselineHash}`,
);
check('新模型下更新包自那份完整副本累积（a、b 两个都在）', expU2Header.entries.map(entry => entry.path).sort(), ['a.md', 'b.md']);
check('第二份照样不动基准', await pointFingerprint(EXP.state), expAtPoint);
check('世代走到第二份报的那一代', (await loadState(EXP.state)).generation, expU2Header.targetGeneration);

// 清理规则：**同一份起点 ＋ 同一形态 ＋ 同一台机器导的** → 旧的被新的取代（别的机器导的要留着，
// 那装的是它那一半改动 —— 见 `bundle/export.ts` 的 `removeSupersededChanges`）
check('旧的被新的取代（报告里如实列出来）', expU2.superseded, [path.basename(expU1.file as string)]);
check('旧的那份确实从磁盘上挪走了', fs.existsSync(expU1.file as string), false);

// ═════════════════════════════════════════════ 2. 链条 fixture：差量包把两份完整副本串起来
//
// 从前那段"两次 `cpExport('changes')` 造出 1→2、2→3"的写法已经不成立：普通更新包的落点
// 不再是基准点，两份包现在共享同一个起点。要造出真正的链，**中间那一份必须是一份完整副本**：
// 先在 CH 改动 → 导一份完整包（推进基准）→ 再改动 → 导一份"从那份到这份新的"差量包。
const T_CH = Date.now() - 1_200_000;
write(CH.root, 'a.md', 'A1', T_CH);
write(CH.root, 'b.md', 'B1', T_CH);
const chF0 = await exportBundle(exportOptions(CH.root, CH.state, 'full', OUT_CHAIN));
write(CH.root, 'a.md', 'A2 改长一点', T_CH + 60_000);
const chF1 = await exportBundle(exportOptions(CH.root, CH.state, 'full', OUT_CHAIN));
write(CH.root, 'b.md', 'B2 也改过', T_CH + 120_000);
const chF2 = await exportBundle(exportOptions(CH.root, CH.state, 'full', OUT_CHAIN));
checkTrue(
	'（前置）三份完整副本都导出来了',
	chF0.file !== null && chF1.file !== null && chF2.file !== null,
	`${chF0.file} / ${chF1.file} / ${chF2.file}`,
);

const chF0Header = (await readBundleInfo(chF0.file as string)).header;
const chF1Header = (await readBundleInfo(chF1.file as string)).header;
const chF2Header = (await readBundleInfo(chF2.file as string)).header;
const p0 = chF0Header.baselineHash as string;
const p1 = chF1Header.baselineHash as string;
const p2 = chF2Header.baselineHash as string;
checkTrue('三份完整副本各是一个点', p0 !== p1 && p1 !== p2 && p0 !== p2, `${p0} / ${p1} / ${p2}`);
check('（前置）最后站在 F2 那份完整副本上', (await loadState(CH.state)).bundle?.fullHash, p2);

// 差量包：F0 → F1、F1 → F2（终点都是**另一份完整副本**）
const chAtPoint = await pointFingerprint(CH.state);
const chD1 = await exportBundle({
	...exportOptions(CH.root, CH.state, 'changes', OUT_CHAIN), baseFingerprint: p0, toFingerprint: p1,
});
const chD2 = await exportBundle({
	...exportOptions(CH.root, CH.state, 'changes', OUT_CHAIN), baseFingerprint: p1, toFingerprint: p2,
});
const chD1Header = (await readBundleInfo(chD1.file as string)).header;
const chD2Header = (await readBundleInfo(chD2.file as string)).header;
checkTrue('两份差量包都导出来了', chD1.file !== null && chD2.file !== null, `${chD1.file} / ${chD2.file}`);
check('差量包 D1：从 F0 到 F1', [chD1Header.baselineHash, chD1Header.targetBaselineHash], [p0, p1]);
check('差量包 D2：从 F1 到 F2', [chD2Header.baselineHash, chD2Header.targetBaselineHash], [p1, p2]);
check('差量包标明「送到的是另一份完整副本」', [chD1Header.targetFullBundle, chD2Header.targetFullBundle], [true, true]);
check(
	'差量包的终点世代就是那份完整副本的世代',
	[chD1Header.targetGeneration, chD2Header.targetGeneration],
	[chF1Header.targetGeneration, chF2Header.targetGeneration],
);
check('D1 只装 F0 → F1 之间变过的那个文件', chD1Header.entries.map(entry => entry.path), ['a.md']);
check('**导差量包：本机站的那一点完全不动**', await pointFingerprint(CH.state), chAtPoint);
check('也不推进世代', (await loadState(CH.state)).generation, chF2Header.targetGeneration);
check('也不动状态编号', (await loadState(CH.state)).stateId?.id, chF2Header.stateId?.id);

// 同一份差量包不重复生成（内容由两份完整副本决定，重导只是白写一遍）
const chD1Again = await exportBundle({
	...exportOptions(CH.root, CH.state, 'changes', OUT_CHAIN), baseFingerprint: p0, toFingerprint: p1,
});
check('已经导过 → 不重复生成', chD1Again.file, null);
checkTrue('并说清是哪一份', (chD1Again.reason ?? '').includes(path.basename(chD1.file as string)), String(chD1Again.reason));

// ═════════════════════════════════════════════ 3. 认链 & 接链：本机站在链条起点那份完整副本上
await applyFull(B.root, B.state, chF0.file as string);
check('（前置）B 站在 F0 那份完整副本上', (await loadState(B.state)).bundle?.fullHash, p0);
write(B.root, 'mine.md', 'MINE', T_CH + 30_000);
write(B.root, 'b.md', 'B1 我这边改的', T_CH + 30_000);

const planB = await planChain(applyOptions(B.root, B.state, chF0.file as string), OUT_CHAIN);
check('认得出链条后面的两环', planB.steps.map(step => path.basename(step.file)), [
	path.basename(chD1.file as string),
	path.basename(chD2.file as string),
]);
check('起点写清是"我站的那份完整副本"', path.basename(planB.from?.file ?? ''), path.basename(chF0.file as string));
check('接到了链条末端那一代', planB.endGeneration, chD2Header.targetGeneration);
check('链末落在一份完整副本上', path.basename(planB.endFull?.file ?? ''), path.basename(chF2.file as string));
check('能接（没有 problem）', planB.problem, null);
check('本机独有的文件会被放回去', planB.extraFiles, ['mine.md']);
check('本机改过的文件（相对基准）也在"要放回"的名单里', planB.edits.map(edit => edit.path), ['b.md']);

// 只关心"包含选中的那个包"：选中的那一环在链上 → 认（界面上是"选中某个包，认出它所在的整条链"）
const planOnly = await planChain(applyOptions(B.root, B.state, chD2.file as string), OUT_CHAIN, chD2.file as string);
check('选中链条上的某一环 → 认', planOnly.problem, null);
check('仍是同一条链、同一串步骤', planOnly.steps.map(step => path.basename(step.file)), [
	path.basename(chD1.file as string),
	path.basename(chD2.file as string),
]);

const outcome = await runChain(applyOptions(B.root, B.state, chF0.file as string), planB, SCRATCH);
check('两环都按顺序应用了', outcome.applied.map(item => item.name), [
	path.basename(chD1.file as string),
	path.basename(chD2.file as string),
]);
check('没有失败项', outcome.failed, []);
check('链条的内容接上了', read(B.root, 'a.md'), 'A2 改长一点');
check('**本机独有的文件保住了**', read(B.root, 'mine.md'), 'MINE');
check('**本机改过的文件也保住了**（本机那一版赢）', read(B.root, 'b.md'), 'B1 我这边改的');
check('两样都放回去了', outcome.restored, 2);

const bState = await loadState(B.state);
check('**应用差量包之后基准前进到终点那份完整副本**', bState.bundle?.fullHash, chD2Header.targetBaselineHash);
check('基准世代到终点那一代', bState.bundle?.fullGeneration, chD2Header.targetGeneration);
check('本机世代跟着端点（世代＝内容的版本号）', bState.generation, chD2Header.targetGeneration);

// 已经在链条末端：本机站的这一点**就是链末那份完整副本**（新模型下"末端"＝一份完整副本）
const planEnd = await planChain(applyOptions(B.root, B.state, chD2.file as string), OUT_CHAIN);
check('已在末端：没有可接的环', planEnd.steps.length, 0);
check('末端就是那份完整副本', path.basename(planEnd.endFull?.file ?? ''), path.basename(chF2.file as string));
check('末端世代也对得上', planEnd.endGeneration, chF2Header.targetGeneration);
check('已经站在一份完整副本上：不是"接不上"，所以不报 problem', planEnd.problem, null);

// ═════════════════════════════════════════════ 4. 本机站在链条中间那份完整副本上
//
// 新模型下"链条中间的点"＝**一份完整副本**：MID 应用了 D1 之后就站在 F1 上
// （差量包会让基准前进）。从前那种"自己导过一环之后的中间点"没有了 ——
// 导出更新包不再产生新点，中间的点只能是一份真的完整副本。
await applyFull(MID.root, MID.state, chF0.file as string);
await applyFull(MID.root, MID.state, chD1.file as string);
check('（前置）MID 应用差量包之后站在 F1 上', (await loadState(MID.state)).bundle?.fullHash, p1);

const planMid = await planChain(applyOptions(MID.root, MID.state, chD2.file as string), OUT_CHAIN, chD2.file as string);
check('站在中间那份完整副本上：只剩后面那一环', planMid.steps.map(step => path.basename(step.file)), [
	path.basename(chD2.file as string),
]);
check('也说得清"我是从哪一环落到这一份上的"', path.basename(planMid.from?.file ?? ''), path.basename(chD1.file as string));
check('只关心包含选中包的链：选中的那一环在链上 → 认', planMid.problem, null);
check('接到了链条末端那一代', planMid.endGeneration, chD2Header.targetGeneration);

const outcomeMid = await runChain(applyOptions(MID.root, MID.state, chD2.file as string), planMid, SCRATCH);
check('没有失败项', outcomeMid.failed, []);
check('内容就是链条末端那一版', [read(MID.root, 'a.md'), read(MID.root, 'b.md')], ['A2 改长一点', 'B2 也改过']);
check('本机站的这一点也到链条末端了', (await loadState(MID.state)).bundle?.fullHash, p2);
check('**状态编号与端点那份包完全一致**', (await loadState(MID.state)).stateId?.id, chF2Header.stateId?.id);

// ═════════════════════════════════════════════ 5. 更新包的起点必须与本机站的基准**严格相等**
await applyFull(OFF.root, OFF.state, chF0.file as string);
const offReject = await expectReject('站在 F0 上收"从 F1 到 F2"的差量包', () =>
	planBundleApply(applyOptions(OFF.root, OFF.state, chD2.file as string)));
checkTrue('拒收信息说清"不是同一份基准"', offReject.includes('不是同一份基准'), offReject);
checkTrue('拒收信息给出路①：让对方按本机这份基准重导', offReject.includes('重导一份更新包'), offReject);
checkTrue('拒收信息给出路②：让对方直接导一份完整副本', offReject.includes('完整副本'), offReject);
checkTrue('拒收信息报出本机站的指纹', offReject.includes(p0), offReject);
check('拒收之后本机什么都没动', read(OFF.root, 'a.md'), 'A1');
check('本机的基准也没动', (await loadState(OFF.state)).bundle?.fullHash, p0);

// 起点正好是本机站的这份完整副本 → 收下（这是常态那条路）
const offPlan = await planBundleApply(applyOptions(OFF.root, OFF.state, chD1.file as string));
check('起点匹配 → baselineMatch 是 match', offPlan.report.baselineMatch, 'match');
check('它不是"白跑一趟"（落点是另一份完整副本，不是本机站的这一点）', offPlan.report.targetIsMine, false);

// 例外：差量包要送到的地方**正好就是我站的这一点** → 放行，并说清这是白跑一趟
// （MID 在上一节已经站在 F2 上，D2 的终点正是 F2；从前这里只会看到一句"基准对不上"，看不出是白跑）
const midAgain = await planBundleApply(applyOptions(MID.root, MID.state, chD2.file as string));
check('落点正是本机的基准 → 放行（不是"基准对不上"）', midAgain.report.baselineMatch, 'mismatch');
check('并说清"包里点名的我全都有"（白跑一趟）', midAgain.report.targetIsMine, true);

// ═════════════════════════════════════════════ 6. 严格镜像（应用完仓库 == 包）＋ 普通更新包不动基准
const T_SX = T_EXP + 300_000;
await applyFull(SX.root, SX.state, expFull.file as string);
check('（前置）SX 站在那份完整副本上', (await loadState(SX.state)).bundle?.fullHash, pExp);
write(SX.root, 'a.md', 'A1 我改过', T_SX);
write(SX.root, 'mine.md', 'MINE', T_SX);

const sxOptions = { ...applyOptions(SX.root, SX.state, expU2.file as string), strictness: 'mirror' as const };
const sxPlan = await planBundleApply(sxOptions);
check('严格档：报告里 forced 成立、不降级', [sxPlan.report.strictness, sxPlan.report.forced], ['mirror', true]);
check('严格档：本地独有那个文件也要挪走', sxPlan.report.localExtras, 1);
const sxResult = await executeBundlePlan(sxPlan, sxOptions);
check('应用完 a.md 就是包里的那一版（哪怕我改过）', read(SX.root, 'a.md'), 'A2 改长一点');
check('包里点名的 b.md 也换上了包里的版本', read(SX.root, 'b.md'), 'B2 也改过');
check('本地独有的文件挪走了', read(SX.root, 'mine.md'), null);
checkTrue('它的内容还在回收目录里', findBackups(SX.root, 'mine.md').includes('MINE'), JSON.stringify(findBackups(SX.root, 'mine.md')));
checkTrue('我改过的那一版也留着（严格档必然先备份）', findBackups(SX.root, 'a.md').includes('A1 我改过'), JSON.stringify(findBackups(SX.root, 'a.md')));
check('**状态编号与包完全一致**（仓库 == 包送到的状态）', sxResult.stateIdCompare, 'match');

const sxAfter = await loadState(SX.state);
check('**应用普通更新包：基准指纹没变**', sxAfter.bundle?.fullHash, pExp);
check('**基准世代没变**', sxAfter.bundle?.fullGeneration, expFullHeader.targetGeneration);
check(
	'**基准清单没变（还是那份完整副本）**',
	listingHashOfFiles(sxAfter.bundle?.fullFiles ?? {}),
	listingHashOfFiles(expFullHeader.entries.reduce<Record<string, { size: number; mtime: number }>>((all, entry) => {
		all[entry.path] = { size: entry.size, mtime: entry.mtime };
		return all;
	}, {})),
);
check('也不动「我站的是哪一份包」', sxAfter.bundle?.fullFile, path.basename(expFull.file as string));
check('只有世代前进到包头部报的那一代', sxAfter.generation, expU2Header.targetGeneration);
check('只有状态编号前进到包头部记的那个', sxAfter.stateId?.id, expU2Header.stateId?.id);
checkTrue('状态编号确实与上一刻不同', sxAfter.stateId?.id !== expFullHeader.stateId?.id, `${expFullHeader.stateId?.id} → ${sxAfter.stateId?.id}`);

// 剩下的一种情况（诚实地说清）：**包没提到、而我又改过的文件** —— 差量包只有变过的那部分，
// 别的路径它一个字都没说；那些路径上的本地改动留在原地，编号这时还差一点，
// 等它随我下次导出的更新包过去，对方应用完两边才一致。
await applyFull(SX2.root, SX2.state, chF0.file as string);
write(SX2.root, 'b.md', 'B1 我改的（包没提到它）', T_CH + 300_000);
const sx2Options = { ...applyOptions(SX2.root, SX2.state, chD1.file as string), strictness: 'mirror' as const };
const sx2Plan = await planBundleApply(sx2Options);
const sx2Result = await executeBundlePlan(sx2Plan, sx2Options);
check('包里点名的那一个换成了包里那一版', read(SX2.root, 'a.md'), 'A2 改长一点');
check('包没提到的本地改动留在原地（包里没有它的字节）', read(SX2.root, 'b.md'), 'B1 我改的（包没提到它）');
check('所以编号这时还差一点，如实说出来', sx2Result.stateIdCompare, 'mismatch');
checkTrue(
	'报告里算得出「我这边还有几个改动没发出去」（下次导出更新包会带上）',
	(sx2Plan.report.pendingChanges ?? 0) >= 1,
	String(sx2Plan.report.pendingChanges),
);

console.log(`\n共 ${checks} 次检查，失败 ${failures.length} 项`);
for (const message of failures.slice(0, 10)) console.log("\n❌ " + message);
if (failures.length > 0) process.exitCode = 1;
