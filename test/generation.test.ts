/**
 * 两台机器各自改东西时，**发号不能撞车**（用户报的"两边都出现第 101 代"）。
 *
 * 规则（0.15.1）：
 * - 导出时带 `generationFloor`（git 货架上已知的最高代），新包从它之后发；
 * - 应用完的内容如果只是"合并了本地改动"（状态编号 ≠ 包的目标），世代取**两者较大**，
 *   绝不回退 —— 否则 B 先导了 102、再应用 A 的 101，会把 B 的号拉回 101，
 *   A 应用 B 的 102 之后两边内容一样、代数却不同。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyBundle } from '../src/bundle/apply';
import { exportBundle } from '../src/bundle/export';
import { DEFAULT_SETTINGS } from '../src/settings/model';
import { compareStateId } from '../src/sync/state-id';
import { loadState } from '../src/sync/state';
import { createLogger } from '../src/utils/log';

let checks = 0;
const failures: string[] = [];
function check(name: string, actual: unknown, expected: unknown): void {
	checks++;
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		failures.push(`${name}\n  期望 ${JSON.stringify(expected)}\n  实际 ${JSON.stringify(actual)}`);
	}
}
function checkTrue(name: string, condition: boolean, detail: string): void {
	checks++;
	if (!condition) failures.push(`${name}\n  ${detail}`);
}

const log = createLogger(() => 'silent');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lsave-generation-'));
const A = path.join(ROOT, 'A');
const B = path.join(ROOT, 'B');
const OUT = path.join(ROOT, 'bundles');
for (const dir of [A, B, OUT]) fs.mkdirSync(dir, { recursive: true });
const STA = path.join(ROOT, 'stateA.json');
const STB = path.join(ROOT, 'stateB.json');
const at = (root: string, rel: string) => path.join(root, ...rel.split('/'));
const write = (root: string, rel: string, text: string) => {
	fs.mkdirSync(path.dirname(at(root, rel)), { recursive: true });
	fs.writeFileSync(at(root, rel), text);
};
const read = (root: string, rel: string) => fs.readFileSync(at(root, rel), 'utf8');
const settings = { ...DEFAULT_SETTINGS };

write(A, 'a.md', 'A0');
write(A, 'b.md', 'B0');
write(B, 'a.md', 'A0');
write(B, 'b.md', 'B0');
const full = await exportBundle({ settings, log, vaultRoot: A, vaultName: 'A', stateFile: STA, mode: 'full', outDir: OUT });
if (!full.file) throw new Error('no full');
await applyBundle({ settings, log, vaultRoot: B, stateFile: STB, file: full.file, strictness: 'mirror' });

// A 先导：第 2 代
write(A, 'a.md', 'A1 改过');
const pA = await exportBundle({ settings, log, vaultRoot: A, vaultName: 'A', stateFile: STA, mode: 'changes', outDir: OUT });
check('A 的更新包：第 2 代', pA.header?.targetGeneration, 2);

// B 导的时候已经知道 A 发到第 2 代了（git 同步之后）→ 必须从第 3 代发
write(B, 'b.md', 'B1 改过');
const pB = await exportBundle({
	settings,
	log,
	vaultRoot: B,
	vaultName: 'B',
	stateFile: STB,
	mode: 'changes',
	outDir: OUT,
	generationFloor: pA.header?.targetGeneration ?? 0,
});
check('B 的更新包：排在 A 后面，不是同一个号', pB.header?.targetGeneration, 3);
checkTrue(
	'两个包的世代不同',
	(pA.header?.targetGeneration ?? 0) !== (pB.header?.targetGeneration ?? 0),
	`A=${pA.header?.targetGeneration} B=${pB.header?.targetGeneration}`,
);

// B 应用 A 的那一份（合并了 B 自己的改动）→ 世代不能退回 2
await applyBundle({ settings, log, vaultRoot: B, stateFile: STB, file: pA.file as string, strictness: 'mirror' });
const bAfter = await loadState(STB);
check('B 应用 A 的包之后仍是第 3 代', bAfter.generation, 3);
check('B 同时拿到了两份改动', `${read(B, 'a.md')} / ${read(B, 'b.md')}`, 'A1 改过 / B1 改过');

// A 应用 B 的包 → 两边内容、世代、状态编号都一致
await applyBundle({ settings, log, vaultRoot: A, stateFile: STA, file: pB.file as string, strictness: 'mirror' });
const aAfter = await loadState(STA);
check('A 应用 B 的包之后也是第 3 代', aAfter.generation, 3);
check('两边状态编号一致', compareStateId(aAfter.stateId, bAfter.stateId), 'match');
check('两边内容一致', `${read(A, 'a.md')} / ${read(A, 'b.md')}`, 'A1 改过 / B1 改过');

console.log(`\n共 ${checks} 次检查，失败 ${failures.length} 项`);
for (const message of failures) console.log(`\n❌ ${message}`);
if (failures.length > 0) process.exitCode = 1;
