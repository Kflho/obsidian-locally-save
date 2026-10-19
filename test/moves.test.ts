/**
 * 移动/改名操作（包版本 2）。
 *
 * 钉住：
 * - 文件夹改名 → 一条 `dir` 操作、负载 0；
 * - 文件改名 → 一条 `file` 操作、负载 0；
 * - 改名后再改一个文件 → 只装改过的那一个，其余走移动；
 * - 应用端源文件被改 / 目标已存在 → 计划阶段拒绝，不做半套；
 * - 应用完两边状态编号一致。
 * - **本机手工把文件夹改过名 / 搬过文件之后再应用累积包**：目标那边的东西一个都不能删
 *   （严格镜像按"送到的点"判，不按"我上次记下的样子"判）；
 * - **改名执行失败不许把状态里的记录划掉**：下一份累积包会按"点上没有它"把它删掉；
 * - 目标目录已存在时**按文件并进去**，不整棵替换（整棵替换会扫掉目标里已经在该在的东西）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyBundle, executeBundlePlan, planBundleApply } from '../src/bundle/apply';
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

// ---------------------------------------------------------------- 漏掉中间那份移动包：接收方停在基准上
// 用户报的现场：对面站在第 100 代基准上，应用最新累积包时报「包里要把 X 改名成 Y，
// 但本地两个路径都不在」。原因是链式移动有两条（旧 → 中间、中间 → 新），接收方手里只有"旧"：
// 第一条把它搬到"中间"之后，计划阶段必须**按顺序演一遍**才能让第二条看见那个中间路径。
{
	const s = await scenario('skip-middle-file');
	await s.prepare();
	fs.renameSync(path.join(s.a, '旧文件夹/一.md'), path.join(s.a, '旧文件夹/一-改名.md'));
	const first = await s.exportChanges();
	checkTrue('漏掉中间包（文件）：第一份移动包有内容', first.file !== null, '第一份没导出');
	// **B 不应用第一份**，仍停在基准上
	fs.mkdirSync(path.join(s.a, '新文件夹'), { recursive: true });
	fs.renameSync(path.join(s.a, '旧文件夹/一-改名.md'), path.join(s.a, '新文件夹/一-改名.md'));
	const second = await s.exportChanges();
	checkTrue('漏掉中间包（文件）：累积包带着两条移动', (second.header?.moves ?? []).length >= 2,
		JSON.stringify(second.header?.moves));
	let message = '';
	try {
		await applyBundle({ settings, log, vaultRoot: s.b, stateFile: s.stb, file: second.file as string, strictness: 'mirror' });
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	check('漏掉中间包（文件）：停在基准上也能应用', message, '');
	checkTrue('漏掉中间包（文件）：落到最终路径', fs.existsSync(path.join(s.b, '新文件夹/一-改名.md')), '');
	checkTrue('漏掉中间包（文件）：旧路径没了', !fs.existsSync(path.join(s.b, '旧文件夹/一.md')), '');
	const sa = await loadState(s.sta);
	const sb = await loadState(s.stb);
	check('漏掉中间包（文件）：两边状态编号一致', compareStateId(sa.stateId, sb.stateId), 'match');
	checkTrue('漏掉中间包（文件）：状态记录里没有假路径',
		phantomRecords(s.b, sb.bundle?.files).length === 0, phantomRecords(s.b, sb.bundle?.files).join('、'));
}

// ---------------------------------------------------------------- 漏掉中间那份移动包：目录连改两次名
{
	const s = await scenario('skip-middle-dir');
	await s.prepare();
	fs.renameSync(path.join(s.a, '旧文件夹'), path.join(s.a, '中间名'));
	const first = await s.exportChanges();
	checkTrue('漏掉中间包（目录）：第一份移动包有内容', first.file !== null, '第一份没导出');
	// B 不应用第一份
	fs.renameSync(path.join(s.a, '中间名'), path.join(s.a, '最终名'));
	const second = await s.exportChanges();
	let message = '';
	try {
		await applyBundle({ settings, log, vaultRoot: s.b, stateFile: s.stb, file: second.file as string, strictness: 'mirror' });
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	check('漏掉中间包（目录）：停在基准上也能应用', message, '');
	checkTrue('漏掉中间包（目录）：落到最终目录', fs.existsSync(path.join(s.b, '最终名/一.md')), '');
	checkTrue('漏掉中间包（目录）：旧目录没了', !fs.existsSync(path.join(s.b, '旧文件夹')), '');
	const sa = await loadState(s.sta);
	const sb = await loadState(s.stb);
	check('漏掉中间包（目录）：两边状态编号一致', compareStateId(sa.stateId, sb.stateId), 'match');
}

// ---------------------------------------------------------------- 累积更新包里的移动：旧路径又被建了出来
//
// 用户稳定复现的现场：改名之后旧文件夹留了个空壳（Obsidian / 用户手建都可能），
// 更新包同时带着「移动 旧→新」和 `emptyDirs: 旧`。第一次应用：搬过去、再把空壳建回来，
// 两边都在（这正是包说的那一点）。第二次再应用同一份累积包时，旧版本只看"源在 + 目标在"
// 就报「本地目标已经存在」，整包拒绝 —— 而且之后的每一份累积包都会带着这条移动，
// 那台机器就永远卡住了。移动的幂等判据必须是**这个源还是不是我记录里的那一份**。
/** 状态记录里有没有"磁盘上已经不在"的路径（假记录会让下一份包算错落点） */
function phantomRecords(vault: string, files: Record<string, unknown> | undefined): string[] {
	return Object.keys(files ?? {}).filter(file => !fs.existsSync(path.join(vault, ...file.split('/'))));
}

function trashHas(vault: string, content: string): boolean {
	const root = path.join(vault, '.trash', 'locally-save');
	const walk = (dir: string): boolean => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return false;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (walk(full)) return true;
				continue;
			}
			try {
				if (fs.readFileSync(full, 'utf8') === content) return true;
			} catch {
				// 二进制 / 读不出：不是我们要找的那一份
			}
		}
		return false;
	};
	return walk(root);
}

async function applyCatching(
	vaultRoot: string,
	stateFile: string,
	file: string,
	options: { alignToPeer?: boolean } = {},
): Promise<{ error: string; deleted: number; moves: number }> {
	try {
		const applied = await applyBundle({
			settings, log, vaultRoot, stateFile, file, strictness: 'mirror',
			...(options.alignToPeer ? { alignToPeer: true } : {}),
		});
		return { error: '', deleted: applied.result.deleted, moves: applied.result.moved };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error), deleted: 0, moves: 0 };
	}
}

// 旧路径空壳：同一份包应用两次、之后每一份累积包都能接
{
	const s = await scenario('leftover-empty');
	await s.prepare();
	fs.renameSync(path.join(s.a, '旧文件夹'), path.join(s.a, '新文件夹'));
	fs.mkdirSync(path.join(s.a, '旧文件夹')); // 改名时留下的空壳（Obsidian 有可能这样）
	const first = await s.exportChanges();
	check('旧路径空壳：包里带着一条目录移动', first.header?.moves?.length, 1);
	checkTrue('旧路径空壳：旧路径也在空文件夹清单里（包说"它得存在"）',
		(first.header?.emptyDirs ?? []).includes('旧文件夹'), JSON.stringify(first.header?.emptyDirs));

	const one = await applyCatching(s.b, s.stb, first.file as string);
	check('旧路径空壳：第一次应用正常', one.error, '');
	checkTrue('旧路径空壳：第一次应用后新路径有内容', fs.existsSync(path.join(s.b, '新文件夹/一.md')), '');
	checkTrue('旧路径空壳：第一次应用后旧路径空壳也在（包就是这么说的）',
		fs.existsSync(path.join(s.b, '旧文件夹')), '');

	const again = await applyCatching(s.b, s.stb, first.file as string);
	check('旧路径空壳：同一份包第二次应用不再报「目标已经存在」', again.error, '');
	check('旧路径空壳：第二次应用一个文件都不动', again.deleted, 0);
	check('旧路径空壳：第二次应用不重复做移动', again.moves, 0);
	checkTrue('旧路径空壳：第二次应用后两边目录都在',
		fs.existsSync(path.join(s.b, '新文件夹/一.md')) && fs.existsSync(path.join(s.b, '旧文件夹')), '');

	// 再来一份累积包（这条移动仍会带着）—— 旧版本在这一步开始整包拒绝
	fs.writeFileSync(path.join(s.a, '新文件夹/二.md'), '二号又改了一次，长度不同');
	const second = await s.exportChanges();
	const next = await applyCatching(s.b, s.stb, second.file as string);
	check('旧路径空壳：下一份累积包也能应用', next.error, '');
	check('旧路径空壳：下一份累积包落地了内容',
		fs.readFileSync(path.join(s.b, '新文件夹/二.md'), 'utf8'), '二号又改了一次，长度不同');
	checkTrue('旧路径空壳：空壳还在（包里仍记着它）', fs.existsSync(path.join(s.b, '旧文件夹')), '');
	const sa = await loadState(s.sta);
	const sb = await loadState(s.stb);
	check('旧路径空壳：两次应用后状态编号一致', compareStateId(sa.stateId, sb.stateId), 'match');
}

// 旧路径被重新建出来、里面还有新笔记：那是新内容，别拿它去覆盖目标
{
	const s = await scenario('leftover-content');
	await s.prepare();
	fs.renameSync(path.join(s.a, '旧文件夹'), path.join(s.a, '新文件夹'));
	const first = await s.exportChanges();
	check('旧路径新内容：第一次应用', (await applyCatching(s.b, s.stb, first.file as string)).error, '');

	fs.mkdirSync(path.join(s.a, '旧文件夹'), { recursive: true });
	fs.writeFileSync(path.join(s.a, '旧文件夹/新笔记.md'), '这是改名之后在旧名字下写的新笔记，长度不一样');
	const second = await s.exportChanges();
	const applied = await applyCatching(s.b, s.stb, second.file as string);
	check('旧路径新内容：第二次应用不报错', applied.error, '');
	check('旧路径新内容：新笔记落到旧路径',
		fs.readFileSync(path.join(s.b, '旧文件夹/新笔记.md'), 'utf8'), '这是改名之后在旧名字下写的新笔记，长度不一样');
	checkTrue('旧路径新内容：新路径的内容没被新笔记顶掉', fs.existsSync(path.join(s.b, '新文件夹/一.md')), '');
	const again = await applyCatching(s.b, s.stb, second.file as string);
	check('旧路径新内容：再应用一次也不报错', again.error, '');
	const sa = await loadState(s.sta);
	const sb = await loadState(s.stb);
	check('旧路径新内容：状态编号一致', compareStateId(sa.stateId, sb.stateId), 'match');
}

// 文件移动：同一份包应用两次，旧路径后来又被建了一个同名文件
{
	const s = await scenario('file-leftover');
	await s.prepare();
	fs.renameSync(path.join(s.a, '旧文件夹/一.md'), path.join(s.a, '旧文件夹/一-改名.md'));
	const moved = await s.exportChanges();
	const first = await applyCatching(s.b, s.stb, moved.file as string);
	check('文件移动：第一次应用正常', first.error, '');
	fs.writeFileSync(path.join(s.b, '旧文件夹/一.md'), '改名之后又在旧名字下写了一篇新的，长度不同');
	const again = await applyCatching(s.b, s.stb, moved.file as string);
	check('文件移动：旧路径又被建出来也不报「目标已经存在」', again.error, '');
	check('文件移动：目标那份没被动', fs.readFileSync(path.join(s.b, '旧文件夹/一-改名.md'), 'utf8'), '一号内容');
	const sa = await loadState(s.sta);
	const sb = await loadState(s.stb);
	check('文件移动：应用完两边状态一致', compareStateId(sa.stateId, sb.stateId), 'match');
}

// 真冲突（源还是我记录里的那一份、目标也占着）：合并档仍然拒绝，不硬搬
{
	const s = await scenario('conflict-target');
	await s.prepare();
	fs.renameSync(path.join(s.a, '旧文件夹'), path.join(s.a, '新文件夹'));
	const moved = await s.exportChanges();
	fs.mkdirSync(path.join(s.b, '新文件夹'), { recursive: true });
	fs.writeFileSync(path.join(s.b, '新文件夹/我自己的.md'), 'B 自己建的同名文件夹');
	let message = '';
	try {
		await planBundleApply({ settings, log, vaultRoot: s.b, stateFile: s.stb, file: moved.file as string });
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	checkTrue('真冲突：合并档拒绝并说清原因', message.includes('目标已经存在'), message || '（没有拒绝）');
	checkTrue('真冲突：B 自己那份一个字节没动', fs.existsSync(path.join(s.b, '新文件夹/我自己的.md')), '');
}

// 严格档：目标已存在时以包为准 —— 目标那份先进回收目录，再整棵搬过去（这是"卡住的机器"的出路）
{
	const s = await scenario('replace-target');
	await s.prepare();
	fs.renameSync(path.join(s.a, '旧文件夹'), path.join(s.a, '新文件夹'));
	const moved = await s.exportChanges();
	fs.mkdirSync(path.join(s.b, '新文件夹'), { recursive: true });
	fs.writeFileSync(path.join(s.b, '新文件夹/一.md'), 'B 自己写的一号内容，长度不同');
	const applied = await applyBundle({
		settings, log, vaultRoot: s.b, stateFile: s.stb, file: moved.file as string, strictness: 'mirror',
	});
	check('严格档：认出来一处"目标已存在"的移动', applied.plan.report.moveReplacements, 1);
	check('严格档：包里的内容占了新路径',
		fs.readFileSync(path.join(s.b, '新文件夹/一.md'), 'utf8'), '一号内容');
	checkTrue('严格档：B 自己那份进了回收目录', trashHas(s.b, 'B 自己写的一号内容，长度不同'), '回收目录里找不到');
	const sa = await loadState(s.sta);
	const sb = await loadState(s.stb);
	check('严格档：应用完与包一致', compareStateId(sa.stateId, sb.stateId), 'match');
}

// 严格档 + 目标目录里已经有东西：**按文件并进去**，不整棵替换
// （整棵替换会把目标里"已经在该在"的文件一起扫进回收目录 —— 用户报的「application 里只剩 1111」）
{
	const s = await scenario('merge-target');
	await s.prepare();
	fs.renameSync(path.join(s.a, '旧文件夹'), path.join(s.a, '新文件夹'));
	fs.writeFileSync(path.join(s.a, '新文件夹/二.md'), '二号内容改过了，长度也不同');
	const moved = await s.exportChanges();
	check('目标里已有东西：包里带着改过的那个文件', moved.entryCount, 1);
	// B 在目标位置已经有一份**内容与条目一致**的文件（上一份包搬过去的），外加一个自己的文件
	fs.mkdirSync(path.join(s.b, '新文件夹/子目录'), { recursive: true });
	fs.writeFileSync(path.join(s.b, '新文件夹/二.md'), '二号内容改过了，长度也不同');
	// 上一份包搬过去的那一份：连修改时间都一致（导出/应用会保留 mtime）—— 这条移动对 B 已经做完了
	const movedSource = path.join(s.b, '旧文件夹/子目录/三.md');
	const movedTarget = path.join(s.b, '新文件夹/子目录/三.md');
	fs.copyFileSync(movedSource, movedTarget);
	const movedStat = fs.statSync(movedSource);
	fs.utimesSync(movedTarget, movedStat.atime, movedStat.mtime);
	fs.writeFileSync(path.join(s.b, '新文件夹/B 自己的.md'), '这是 B 自己写的东西，点上没有它');
	await applyBundle({
		settings, log, vaultRoot: s.b, stateFile: s.stb, file: moved.file as string, strictness: 'mirror',
	});
	check('目标里已有东西：条目那一版没被源里那份旧的顶掉',
		fs.readFileSync(path.join(s.b, '新文件夹/二.md'), 'utf8'), '二号内容改过了，长度也不同');
	check('目标里已有同一份文件的：内容原样留着',
		fs.readFileSync(path.join(s.b, '新文件夹/子目录/三.md'), 'utf8'), '三号内容');
	checkTrue('源里其余文件搬进目标', fs.existsSync(path.join(s.b, '新文件夹/一.md')), '');
	checkTrue('目标里"点上没有"的文件进回收目录（严格档）',
		!fs.existsSync(path.join(s.b, '新文件夹/B 自己的.md')) && trashHas(s.b, '这是 B 自己写的东西，点上没有它'), '');
	checkTrue('源目录搬空后不再留着', !fs.existsSync(path.join(s.b, '旧文件夹')), '');
	const sa = await loadState(s.sta);
	const sb = await loadState(s.stb);
	checkTrue('被删掉的文件不再留在状态记录里（假记录会让下一包算错落点）',
		!Object.keys(sb.bundle?.files ?? {}).includes('新文件夹/B 自己的.md'),
		JSON.stringify(Object.keys(sb.bundle?.files ?? {})));
	check('目标里已有东西：应用完与包一致', compareStateId(sa.stateId, sb.stateId), 'match');
}

// 只拉（alignToPeer）：同一份移动包连应用两次，第二次必须是彻底的空操作
// （旧版本会从基准完整副本把旧路径"恢复"回来、又删掉新路径的文件）
{
	const s = await scenario('align-twice');
	await s.prepare();
	fs.renameSync(path.join(s.a, '旧文件夹'), path.join(s.a, '新文件夹'));
	const moved = await s.exportChanges();
	const first = await applyCatching(s.b, s.stb, moved.file as string, { alignToPeer: true });
	check('只拉移动：第一次应用正常', first.error, '');
	const second = await applyCatching(s.b, s.stb, moved.file as string, { alignToPeer: true });
	check('只拉移动：第二次应用一个文件都不动', second.deleted, 0);
	check('只拉移动：第二次应用不重复做移动', second.moves, 0);
	checkTrue('只拉移动：新路径四个文件都在',
		fs.existsSync(path.join(s.b, '新文件夹/一.md'))
		&& fs.existsSync(path.join(s.b, '新文件夹/二.md'))
		&& fs.existsSync(path.join(s.b, '新文件夹/子目录/三.md')), '');
	checkTrue('只拉移动：旧路径没被"恢复"回来', !fs.existsSync(path.join(s.b, '旧文件夹')), '');
	check('只拉移动：没有任何东西被挪进回收目录', trashHas(s.b, '一号内容'), false);
	const sa = await loadState(s.sta);
	const sb = await loadState(s.stb);
	check('只拉移动：两次应用后编号一致', compareStateId(sa.stateId, sb.stateId), 'match');
}

// ---------------------------------------------------------------- 手工改名之后再同步
//
// 用户报的现场：旧版本改名失败，他在磁盘上**手工**把文件夹改成了新名字
// （implement → application、把 tasknote 挪进去、删掉旧文件夹），插件并不知道。
// 下一份累积包照样带着「implement → application」这条移动：源没了、目标在 → 跳过。
// 旧代码跳过时**没有把"送到的点"里的路径跟着换**，严格镜像于是把目标里那批文件
// 当成"本地多出来的"全删了 —— 用户看到的就是「application 里只剩 1111」。
{
	const s = await scenario('manual-rename');
	fs.writeFileSync(path.join(s.a, '根文件.md'), '根上的一个文件');
	await s.prepare();
	// A、B 都手工改名：旧文件夹 → 新文件夹，并把根上的文件挪进去
	for (const vault of [s.a, s.b]) {
		fs.renameSync(path.join(vault, '旧文件夹'), path.join(vault, '新文件夹'));
		fs.renameSync(path.join(vault, '根文件.md'), path.join(vault, '新文件夹/根文件.md'));
	}
	fs.writeFileSync(path.join(s.a, '新文件夹/新写的.md'), 'A 后来写的新文件，长度不一样');
	const changed = await s.exportChanges();
	checkTrue('手工改名：包里带着目录移动',
		(changed.header?.moves ?? []).some(item => item.kind === 'dir'), JSON.stringify(changed.header?.moves));

	const applied = await applyBundle({
		settings, log, vaultRoot: s.b, stateFile: s.stb, file: changed.file as string, strictness: 'mirror',
	});
	check('手工改名：目标里那批文件一个都不删', applied.result.deleted, 0);
	checkTrue('手工改名：手工搬过去的文件都还在',
		['一.md', '二.md', '子目录/三.md', '根文件.md'].every(name => fs.existsSync(path.join(s.b, '新文件夹', name))), '');
	checkTrue('手工改名：A 新写的文件也落地', fs.existsSync(path.join(s.b, '新文件夹/新写的.md')), '');
	checkTrue('手工改名：旧路径没被"恢复"回来', !fs.existsSync(path.join(s.b, '旧文件夹')), '');
	const sa = await loadState(s.sta);
	const sb = await loadState(s.stb);
	check('手工改名：应用完两边一致', compareStateId(sa.stateId, sb.stateId), 'match');
	checkTrue('手工改名：状态记录也跟到新路径',
		Object.keys(sb.bundle?.files ?? {}).every(file => !file.startsWith('旧文件夹/')),
		JSON.stringify(Object.keys(sb.bundle?.files ?? {})));
	// 记录里不能留下"磁盘上已经没了"的假路径：下一份包会拿它算"送到的点"，
	// 假路径会让一份明明接得上的包被判成"接不上"。
	const phantom = Object.keys(sb.bundle?.files ?? {})
		.filter(file => !fs.existsSync(path.join(s.b, ...file.split('/'))));
	checkTrue('手工改名：状态里没有假记录', phantom.length === 0, phantom.join('、'));
}

// 手工改名单个文件：同一类问题（源没了、目标在），以前会把这个文件当"多出来的"删掉
{
	const s = await scenario('manual-file-rename');
	await s.prepare();
	fs.renameSync(path.join(s.a, '旧文件夹/一.md'), path.join(s.a, '旧文件夹/一-改名.md'));
	fs.renameSync(path.join(s.b, '旧文件夹/一.md'), path.join(s.b, '旧文件夹/一-改名.md'));
	const moved = await s.exportChanges();
	const applied = await applyBundle({
		settings, log, vaultRoot: s.b, stateFile: s.stb, file: moved.file as string, strictness: 'mirror',
	});
	check('手工改名单个文件：不删那个文件', applied.result.deleted, 0);
	check('手工改名单个文件：内容还在',
		fs.readFileSync(path.join(s.b, '旧文件夹/一-改名.md'), 'utf8'), '一号内容');
	const sa = await loadState(s.sta);
	const sb = await loadState(s.stb);
	check('手工改名单个文件：应用完两边一致', compareStateId(sa.stateId, sb.stateId), 'match');
}

// ---------------------------------------------------------------- 改名执行失败
//
// 计划之后才把目标位置占住（模拟"rename 在 Windows 上失败"）：源还躺在旧路径上。
// 状态里绝不能把旧路径的记录划掉 —— 划掉之后，下一份累积包会按"点上没有它"
// 把还在磁盘上的文件挪进回收目录（用户报的「改名失败之后再同步，application 里只剩 1111」）。
{
	const s = await scenario('rename-fails');
	await s.prepare();
	// A 把整棵文件夹挪进一个新目录；包里的移动目标在 `收纳/旧文件夹`
	fs.mkdirSync(path.join(s.a, '收纳'));
	fs.renameSync(path.join(s.a, '旧文件夹'), path.join(s.a, '收纳/旧文件夹'));
	const moved = await s.exportChanges();
	const plan = await planBundleApply({
		settings, log, vaultRoot: s.b, stateFile: s.stb, file: moved.file as string, strictness: 'mirror',
	});
	// 计划之后才占住目标路径（`收纳` 位置放一个同名文件）：rename 建不出目录，必然失败
	const blocker = path.join(s.b, '收纳');
	fs.writeFileSync(blocker, '挡住改名的文件');
	const result = await executeBundlePlan(plan, {
		settings, log, vaultRoot: s.b, stateFile: s.stb, file: moved.file as string, strictness: 'mirror',
	});
	checkTrue('改名失败：报出来', result.failed.length > 0, JSON.stringify(result.failed));
	checkTrue('改名失败：源文件还在旧路径上', fs.existsSync(path.join(s.b, '旧文件夹/一.md')), '');
	const sb = await loadState(s.stb);
	checkTrue('改名失败：状态里还记着旧路径',
		Object.keys(sb.bundle?.files ?? {}).includes('旧文件夹/一.md'), JSON.stringify(Object.keys(sb.bundle?.files ?? {})));

	// 把挡路的东西挪走，再应用同一份包：整棵搬过去
	fs.rmSync(blocker);
	await applyBundle({ settings, log, vaultRoot: s.b, stateFile: s.stb, file: moved.file as string, strictness: 'mirror' });
	checkTrue('改名失败：再应用一次能落地', fs.existsSync(path.join(s.b, '收纳/旧文件夹/一.md')), '');
	const sa = await loadState(s.sta);
	const sb2 = await loadState(s.stb);
	check('改名失败：修好之后两边一致', compareStateId(sa.stateId, sb2.stateId), 'match');
}

console.log(`\n共 ${checks} 次检查，失败 ${failures.length} 项`);
for (const message of failures) console.log(`\n❌ ${message}`);
if (failures.length > 0) process.exitCode = 1;
