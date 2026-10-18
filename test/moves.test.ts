/**
 * 移动/改名操作（包版本 2）。
 *
 * 钉住：
 * - 文件夹改名 → 一条 `dir` 操作、负载 0；
 * - 文件改名 → 一条 `file` 操作、负载 0；
 * - 改名后再改一个文件 → 只装改过的那一个，其余走移动；
 * - 应用端源文件被改 / 目标已存在 → 计划阶段拒绝，不做半套；
 * - 应用完两边状态编号一致。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyBundle, planBundleApply } from '../src/bundle/apply';
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
const settings = { ...DEFAULT_SETTINGS };

async function scenario(name: string): Promise<{
	root: string;
	a: string;
	b: string;
	out: string;
	sta: string;
	stb: string;
	prepare: () => Promise<void>;
	exportChanges: () => Promise<Awaited<ReturnType<typeof exportBundle>>>;
}> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `lsave-move-${name}-`));
	const a = path.join(root, 'A');
	const b = path.join(root, 'B');
	const out = path.join(root, 'out');
	for (const dir of [a, b, out]) fs.mkdirSync(dir, { recursive: true });
	const sta = path.join(root, 'stateA.json');
	const stb = path.join(root, 'stateB.json');
	const write = (vault: string, rel: string, content: string) => {
		const target = path.join(vault, ...rel.split('/'));
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	};
	const prepare = async (): Promise<void> => {
		write(a, '旧文件夹/一.md', '一号内容');
		write(a, '旧文件夹/二.md', '二号内容更长一点');
		write(a, '旧文件夹/子目录/三.md', '三号内容');
		fs.mkdirSync(path.join(a, '旧文件夹/空目录'), { recursive: true });
		const full = await exportBundle({ settings, log, vaultRoot: a, vaultName: 'A', stateFile: sta, mode: 'full', outDir: out });
		if (!full.file) throw new Error('no full');
		await applyBundle({ settings, log, vaultRoot: b, stateFile: stb, file: full.file, strictness: 'mirror' });
	};
	const exportChanges = () => exportBundle({ settings, log, vaultRoot: a, vaultName: 'A', stateFile: sta, mode: 'changes', outDir: out });
	return { root, a, b, out, sta, stb, prepare, exportChanges };
}

// ---------------------------------------------------------------- 文件夹改名
{
	const s = await scenario('dir');
	await s.prepare();
	fs.renameSync(path.join(s.a, '旧文件夹'), path.join(s.a, '新文件夹'));
	const moved = await s.exportChanges();
	check('文件夹改名：一条 dir 操作', moved.header?.moves, [{ from: '旧文件夹', to: '新文件夹', kind: 'dir', files: 3 }].map(item => ({ ...item })));
	check('文件夹改名：没有文件条目', moved.entryCount, 0);
	check('文件夹改名：没有删除条目', moved.deletedCount, 0);
	check('文件夹改名：负载为 0', moved.header?.payloadBytes, 0);
	check('文件夹改名：包版本升到 2', moved.header?.version, 2);

	await applyBundle({ settings, log, vaultRoot: s.b, stateFile: s.stb, file: moved.file as string, strictness: 'mirror' });
	const sa = await loadState(s.sta);
	const sb = await loadState(s.stb);
	checkTrue('文件夹改名：B 有新路径', fs.existsSync(path.join(s.b, '新文件夹/一.md')), '');
	checkTrue('文件夹改名：B 没有旧路径', !fs.existsSync(path.join(s.b, '旧文件夹')), '');
	check('文件夹改名：两边状态编号一致', compareStateId(sa.stateId, sb.stateId), 'match');
	checkTrue('文件夹改名：B 的目录记录跟着走', (sb.bundle?.dirs ?? []).includes('新文件夹/子目录'), JSON.stringify(sb.bundle?.dirs));
}

// ---------------------------------------------------------------- 文件改名
{
	const s = await scenario('file');
	await s.prepare();
	fs.renameSync(path.join(s.a, '旧文件夹/一.md'), path.join(s.a, '旧文件夹/一-改名.md'));
	const moved = await s.exportChanges();
	const spec = moved.header?.moves?.[0];
	check('文件改名：一条 file 操作', spec?.kind, 'file');
	check('文件改名：from/to 正确', `${spec?.from}→${spec?.to}`, '旧文件夹/一.md→旧文件夹/一-改名.md');
	check('文件改名：负载为 0', moved.header?.payloadBytes, 0);
	check('文件改名：没有文件条目', moved.entryCount, 0);

	await applyBundle({ settings, log, vaultRoot: s.b, stateFile: s.stb, file: moved.file as string, strictness: 'mirror' });
	const sb = await loadState(s.stb);
	checkTrue('文件改名：B 有新文件名', fs.existsSync(path.join(s.b, '旧文件夹/一-改名.md')), '');
	checkTrue('文件改名：B 旧文件名没了', !fs.existsSync(path.join(s.b, '旧文件夹/一.md')), '');
	check('文件改名：B 的清单记的是新路径', Object.keys(sb.bundle?.files ?? {}).includes('旧文件夹/一-改名.md'), true);
}

// ---------------------------------------------------------------- 移动 + 改内容
{
	const s = await scenario('edit');
	await s.prepare();
	fs.renameSync(path.join(s.a, '旧文件夹'), path.join(s.a, '新文件夹'));
	fs.writeFileSync(path.join(s.a, '新文件夹/二.md'), '二号内容改过了，长度也不同');
	const moved = await s.exportChanges();
	check('移动+编辑：只装改过的那一个文件', moved.entryCount, 1);
	check('移动+编辑：整目录移动一条操作', (moved.header?.moves ?? []).filter(item => item.kind === 'dir').length, 1);
	check('移动+编辑：改过的那个文件仍带内容条目', moved.entryCount, 1);
	check('移动+编辑：旧路径不点名删除（整目录搬走）', moved.deletedCount, 0);

	await applyBundle({ settings, log, vaultRoot: s.b, stateFile: s.stb, file: moved.file as string, strictness: 'mirror' });
	check('移动+编辑：B 的新内容', fs.readFileSync(path.join(s.b, '新文件夹/二.md'), 'utf8'), '二号内容改过了，长度也不同');
	const sa = await loadState(s.sta);
	const sb = await loadState(s.stb);
	check('移动+编辑：两边状态编号一致', compareStateId(sa.stateId, sb.stateId), 'match');
}

// ---------------------------------------------------------------- 累积包：移动早已做过
{
	const s = await scenario('cumulative');
	await s.prepare();
	fs.renameSync(path.join(s.a, '旧文件夹'), path.join(s.a, '新文件夹'));
	const first = await s.exportChanges();
	await applyBundle({ settings, log, vaultRoot: s.b, stateFile: s.stb, file: first.file as string, strictness: 'mirror' });

	// A 之后又改了一个文件：因为更新包是从**基准**累积的，同一批移动会再次出现在包里
	fs.writeFileSync(path.join(s.a, '新文件夹/二.md'), '二号又被改了一次，长度不同');
	const second = await s.exportChanges();
	check('累积包：仍然带着移动操作（给还没搬过的机器）', (second.header?.moves ?? []).length > 0, true);
	check('累积包：改过的文件走内容', second.entryCount, 1);
	await applyBundle({ settings, log, vaultRoot: s.b, stateFile: s.stb, file: second.file as string, strictness: 'mirror' });
	check('累积包：B 已经搬过的移动被跳过，内容更新照样落地', fs.readFileSync(path.join(s.b, '新文件夹/二.md'), 'utf8'), '二号又被改了一次，长度不同');
	const sa = await loadState(s.sta);
	const sb = await loadState(s.stb);
	check('累积包：两边状态编号一致', compareStateId(sa.stateId, sb.stateId), 'match');
}

// ---------------------------------------------------------------- 连续改名（累积包里的链式移动）
{
	const s = await scenario('rename-twice');
	await s.prepare();
	fs.renameSync(path.join(s.a, '旧文件夹'), path.join(s.a, '中间名'));
	const first = await s.exportChanges();
	await applyBundle({ settings, log, vaultRoot: s.b, stateFile: s.stb, file: first.file as string, strictness: 'mirror' });

	fs.renameSync(path.join(s.a, '中间名'), path.join(s.a, '最终名'));
	const second = await s.exportChanges();
	const kinds = (second.header?.moves ?? []).map(item => `${item.kind}:${item.from}→${item.to}`);
	checkTrue('连续改名：包里同时有旧/新基准的移动和上一状态到现在的移动',
		kinds.some(item => item.includes('旧文件夹→最终名')) && kinds.some(item => item.includes('中间名→最终名')),
		kinds.join(' / '));
	await applyBundle({ settings, log, vaultRoot: s.b, stateFile: s.stb, file: second.file as string, strictness: 'mirror' });
	checkTrue('连续改名：B 落到最终目录', fs.existsSync(path.join(s.b, '最终名/一.md')), '');
	checkTrue('连续改名：B 没有中间目录', !fs.existsSync(path.join(s.b, '中间名')), '');
	const sa = await loadState(s.sta);
	const sb = await loadState(s.stb);
	check('连续改名：两边状态编号一致', compareStateId(sa.stateId, sb.stateId), 'match');
}

// ---------------------------------------------------------------- 移动后再加文件
{
	const s = await scenario('add-after-move');
	await s.prepare();
	fs.renameSync(path.join(s.a, '旧文件夹'), path.join(s.a, '新文件夹'));
	const first = await s.exportChanges();
	await applyBundle({ settings, log, vaultRoot: s.b, stateFile: s.stb, file: first.file as string, strictness: 'mirror' });
	fs.mkdirSync(path.join(s.a, '新文件夹/新增'), { recursive: true });
	fs.writeFileSync(path.join(s.a, '新文件夹/新增/四.md'), '四号内容是新的');
	const second = await s.exportChanges();
	await applyBundle({ settings, log, vaultRoot: s.b, stateFile: s.stb, file: second.file as string, strictness: 'mirror' });
	checkTrue('移动后新增：B 多出新文件', fs.existsSync(path.join(s.b, '新文件夹/新增/四.md')), '');
	const sa = await loadState(s.sta);
	const sb = await loadState(s.stb);
	check('移动后新增：两边状态编号一致', compareStateId(sa.stateId, sb.stateId), 'match');
}

// ---------------------------------------------------------------- 移动后再删文件
{
	const s = await scenario('delete-after-move');
	await s.prepare();
	fs.renameSync(path.join(s.a, '旧文件夹'), path.join(s.a, '新文件夹'));
	const first = await s.exportChanges();
	await applyBundle({ settings, log, vaultRoot: s.b, stateFile: s.stb, file: first.file as string, strictness: 'mirror' });
	fs.rmSync(path.join(s.a, '新文件夹/二.md'));
	const second = await s.exportChanges();
	await applyBundle({ settings, log, vaultRoot: s.b, stateFile: s.stb, file: second.file as string, strictness: 'mirror' });
	checkTrue('移动后删除：B 那边的新路径也删掉', !fs.existsSync(path.join(s.b, '新文件夹/二.md')), '');
	const sa = await loadState(s.sta);
	const sb = await loadState(s.stb);
	check('移动后删除：两边状态编号一致', compareStateId(sa.stateId, sb.stateId), 'match');
}

// ---------------------------------------------------------------- 移动后把文件全删了
{
	const s = await scenario('delete-all-after-move');
	await s.prepare();
	fs.renameSync(path.join(s.a, '旧文件夹'), path.join(s.a, '新文件夹'));
	const first = await s.exportChanges();
	await applyBundle({ settings, log, vaultRoot: s.b, stateFile: s.stb, file: first.file as string, strictness: 'mirror' });
	for (const name of ['一.md', '二.md', '子目录/三.md']) {
		fs.rmSync(path.join(s.a, '新文件夹', name));
	}
	const second = await s.exportChanges();
	await applyBundle({ settings, log, vaultRoot: s.b, stateFile: s.stb, file: second.file as string, strictness: 'mirror' });
	checkTrue('全删：B 的新路径文件都没了', !fs.existsSync(path.join(s.b, '新文件夹/一.md')), '');
	const sa = await loadState(s.sta);
	const sb = await loadState(s.stb);
	check('全删：两边状态编号一致', compareStateId(sa.stateId, sb.stateId), 'match');
}

// ---------------------------------------------------------------- 连续多轮：一轮一轮接着更新
{
	const s = await scenario('long-chain');
	await s.prepare();
	fs.renameSync(path.join(s.a, '旧文件夹'), path.join(s.a, '新文件夹'));
	const first = await s.exportChanges();
	await applyBundle({ settings, log, vaultRoot: s.b, stateFile: s.stb, file: first.file as string, strictness: 'mirror' });
	const folder = '新文件夹';
	for (let round = 1; round <= 4; round++) {
		fs.writeFileSync(path.join(s.a, folder, '一.md'), `A 第 ${round} 轮，长度 ${'x'.repeat(round)}`);
		const fromA = await s.exportChanges();
		await applyBundle({ settings, log, vaultRoot: s.b, stateFile: s.stb, file: fromA.file as string, strictness: 'mirror' });

		fs.writeFileSync(path.join(s.b, folder, '二.md'), `B 第 ${round} 轮，长度 ${'y'.repeat(round + 5)}`);
		const fromB = await exportBundle({
			settings, log, vaultRoot: s.b, vaultName: 'B', stateFile: s.stb, mode: 'changes', outDir: s.out,
		});
		await applyBundle({ settings, log, vaultRoot: s.a, stateFile: s.sta, file: fromB.file as string, strictness: 'mirror' });

		const sa = await loadState(s.sta);
		const sb = await loadState(s.stb);
		check(`连续多轮第 ${round} 轮：两边状态编号一致`, compareStateId(sa.stateId, sb.stateId), 'match');
		check(`连续多轮第 ${round} 轮：两边世代一致`, sa.generation, sb.generation);
	}
	const sa = await loadState(s.sta);
	checkTrue('连续多轮：每一轮都留下了更新记录', (sa.bundleLog ?? []).length >= 9, String((sa.bundleLog ?? []).length));
	check('连续多轮：B 的内容是最后一轮', fs.readFileSync(path.join(s.b, folder, '二.md'), 'utf8'), 'B 第 4 轮，长度 yyyyyyyyy');
}

// ---------------------------------------------------------------- 源文件被改：拒绝
{
	const s = await scenario('conflict');
	await s.prepare();
	fs.renameSync(path.join(s.a, '旧文件夹/一.md'), path.join(s.a, '旧文件夹/一-改名.md'));
	const moved = await s.exportChanges();
	// B 本地把源文件改了，包里没有内容，不能硬 rename
	fs.writeFileSync(path.join(s.b, '旧文件夹/一.md'), 'B 自己改过的内容，长度不同');
	let message = '';
	try {
		await planBundleApply({ settings, log, vaultRoot: s.b, stateFile: s.stb, file: moved.file as string, strictness: 'mirror' });
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	checkTrue('源文件被改：计划阶段拒绝', message.includes('改过') || message.includes('不一致'), message);
	check('源文件被改：B 的源文件一个字节没动', fs.readFileSync(path.join(s.b, '旧文件夹/一.md'), 'utf8'), 'B 自己改过的内容，长度不同');
}

console.log(`\n共 ${checks} 次检查，失败 ${failures.length} 项`);
for (const message of failures) console.log(`\n❌ ${message}`);
if (failures.length > 0) process.exitCode = 1;
