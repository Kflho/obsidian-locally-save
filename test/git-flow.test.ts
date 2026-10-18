/**
 * Git 货架 + 真实同步包的**端到端**验证：两个临时仓库、一个本地裸仓库当"远程"。
 *
 * 这一步要回答的是方案里最要紧的那句话 —— **"更新包能靠 git 搬，而且两边最后真的一样"**：
 *
 * 1. A 导一份完整副本（**不进 git**，太大）→ 手动拷给 B（模拟 U 盘）→ B 应用；
 * 2. 之后 A / B 各自改一段、导更新包、推上去；对面拉下来再应用；
 * 3. A 删一个文件 → 更新包点名删除 → B 应用完也删掉；
 * 4. 最后两边的**状态编号**与**货架上跟踪的包**都必须一模一样。
 *
 * 货架的删除传播也在这里再验一次：A 的新更新包会取代它自己那份旧的（`removeSupersededChanges`），
 * 那笔"撤下"要跟着 git 走到 B 那边，否则 B 的货架会永远多一个包。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyBundle } from '../src/bundle/apply';
import type { ApplyOptions } from '../src/bundle/apply';
import { exportBundle } from '../src/bundle/export';
import type { ExportOptions } from '../src/bundle/export';
import { runGit } from '../src/git/run';
import type { ShelfOptions } from '../src/git/shelf';
import { syncShelf } from '../src/git/sync';
import { DEFAULT_SETTINGS } from '../src/settings/model';
import type { PluginSettings } from '../src/settings/model';
import { scanTree } from '../src/sync/disk';
import { excludePatterns } from '../src/sync/vault';
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

function checkTrue(name: string, condition: boolean, detail = name): void {
	checks++;
	if (!condition) failures.push(`[断言失败] ${name}\n  ${detail}`);
}

// -------------------------------------------------------------------- 环境
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lsave-git-flow-'));
const REMOTE = path.join(ROOT, 'remote.git');
const VAULT_A = path.join(ROOT, 'vault-a');
const VAULT_B = path.join(ROOT, 'vault-b');
const SHELF_A = path.join(ROOT, 'shelf-a');
const SHELF_B = path.join(ROOT, 'shelf-b');
const STATE_A = path.join(ROOT, 'state-a.json');
const STATE_B = path.join(ROOT, 'state-b.json');

for (const dir of [VAULT_A, VAULT_B, SHELF_A, SHELF_B]) fs.mkdirSync(dir, { recursive: true });

const log = createLogger(() => 'silent');
const settings = (): PluginSettings => ({ ...DEFAULT_SETTINGS });

const at = (root: string, rel: string): string => path.join(root, ...rel.split('/'));

function write(root: string, rel: string, content: string): void {
	const target = at(root, rel);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
}

function read(root: string, rel: string): string | null {
	try {
		return fs.readFileSync(at(root, rel), 'utf8');
	} catch {
		return null;
	}
}

function exists(root: string, rel: string): boolean {
	return fs.existsSync(at(root, rel));
}

function exportOptions(vault: string, stateFile: string, shelf: string, mode: 'full' | 'changes'): ExportOptions {
	return { settings: settings(), log, vaultRoot: vault, vaultName: '我的笔记', stateFile, mode, outDir: shelf };
}

function applyOptions(vault: string, stateFile: string, file: string): ApplyOptions {
	return { settings: settings(), log, vaultRoot: vault, stateFile, file, strictness: 'mirror' };
}

function shelfOptions(dir: string): ShelfOptions {
	return {
		dir,
		remote: REMOTE,
		branch: 'main',
		trashDir: path.join(dir, '.lsave', 'bundles-trash'),
		timeoutMs: 20_000,
		networkTimeoutMs: 30_000,
	};
}

/** 远程里跟踪了哪些文件（分支还不存在时就是空的） */
async function remoteFiles(): Promise<string[]> {
	const branch = await runGit(['rev-parse', '--verify', '--quiet', 'main'], { cwd: REMOTE });
	if (branch.code !== 0) return [];
	const tree = await runGit(['-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', 'main'], { cwd: REMOTE });
	return tree.stdout.trim() === '' ? [] : tree.stdout.trim().split('\n').sort();
}

async function tracked(dir: string): Promise<string[]> {
	const result = await runGit(['-c', 'core.quotepath=false', 'ls-files'], { cwd: dir });
	return result.stdout.trim() === '' ? [] : result.stdout.trim().split('\n').sort();
}

/** 从 `pulled` 的相对路径拼出本机文件的绝对路径 */
function pulledPath(shelf: string, rel: string): string {
	return path.join(shelf, ...rel.split('/'));
}

// -------------------------------------------------------------------- 用例
async function main(): Promise<void> {
	const probe = await runGit(['--version'], { cwd: ROOT }).catch(() => null);
	if (!probe || probe.code !== 0) {
		console.log('这台机器上没有 git，跳过端到端验证');
		return;
	}
	const bare = await runGit(['init', '--bare', REMOTE], { cwd: ROOT });
	if (bare.code !== 0) throw new Error(`建裸仓库失败：${bare.stderr}`);

	// ---------------------------------------------------------------- 1. A 立基准（完整包不进 git）
	write(VAULT_A, '笔记/a.md', 'A1');
	write(VAULT_A, '笔记/b.md', 'B1');
	// 一个**更新包碰不到**的目录：应用更新后它必须还在目录基准里，
	// 否则 hasChanges 会以为"仓库多了个目录"，把刚应用完的更新包再导一遍
	write(VAULT_A, '其他/c.md', 'C1');
	fs.mkdirSync(at(VAULT_A, '空文件夹'), { recursive: true });

	const full = await exportBundle(exportOptions(VAULT_A, STATE_A, SHELF_A, 'full'));
	if (!full.file) throw new Error('完整包没导出来');
	const aFirstSync = await syncShelf(shelfOptions(SHELF_A));
	check('完整包不往远程推（远程还是空的）', await remoteFiles(), []);
	check('这一趟也没有可推的提交', aFirstSync.pushed, false);

	// 手动搬：完整包拷到 B 的货架（U 盘那一步），B 应用
	const fullForB = path.join(SHELF_B, 'full', path.basename(full.file));
	fs.mkdirSync(path.dirname(fullForB), { recursive: true });
	fs.copyFileSync(full.file, fullForB);
	await applyBundle(applyOptions(VAULT_B, STATE_B, fullForB));
	check('B 的正文与 A 一致', read(VAULT_B, '笔记/a.md'), 'A1');
	check('B 也拿到了另一个文件', read(VAULT_B, '笔记/b.md'), 'B1');
	checkTrue('B 也建出了空文件夹', exists(VAULT_B, '空文件夹'));

	// ---------------------------------------------------------------- 2. A 改东西 → 更新包走 git
	// 注意：内容长度要变。同一秒里改同样长度的文件会被"大小 + 修改时间"判成没动过（2 秒容差）
	write(VAULT_A, '笔记/a.md', 'A2 改过了');
	const changesA = await exportBundle(exportOptions(VAULT_A, STATE_A, SHELF_A, 'changes'));
	if (!changesA.file) throw new Error('更新包没导出来');
	const aSync = await syncShelf(shelfOptions(SHELF_A));
	checkTrue('更新包推上去了', aSync.pushed);
	check('远程里只有更新包', (await remoteFiles()).length, 1);

	const bPull = await syncShelf(shelfOptions(SHELF_B));
	check('B 从远程收到一个包', bPull.pulled.length, 1);
	await applyBundle(applyOptions(VAULT_B, STATE_B, pulledPath(SHELF_B, bPull.pulled[0] ?? '')));
	check('A 的改动传到了 B', read(VAULT_B, '笔记/a.md'), 'A2 改过了');
	// 更新包只带了 笔记/a.md；其他/ 没被动过，也必须留在目录基准里
	// （否则下一次"立即同步"的 hasChanges 会判成有变化，把同一份 1→2 再导一遍）
	const stateAfterApply = await loadState(STATE_B);
	checkTrue(
		'应用更新后目录基准包含没变的目录',
		(stateAfterApply.bundle?.dirs ?? []).includes('其他'),
		JSON.stringify(stateAfterApply.bundle?.dirs),
	);
	// 目录集合必须和仓库里看到的一致：不一致的话下一次 hasChanges 会判成"有变化"，
	// 把刚应用完的同一份 1→2 再导一遍（用户报的"导出两次"）
	const inventoryAfterApply = await scanTree(VAULT_B, {
		exclude: excludePatterns(DEFAULT_SETTINGS.excludePatterns, '.obsidian'),
		skipTopLevelDirs: ['.trash'],
	});
	check(
		'应用后目录集合与仓库一致',
		[...inventoryAfterApply.dirs].sort(),
		[...(stateAfterApply.bundle?.dirs ?? [])].sort(),
	);

	// ---------------------------------------------------------------- 3. B 改东西 → 回传
	write(VAULT_B, '笔记/b.md', 'B2 也改过了');
	const changesB = await exportBundle(exportOptions(VAULT_B, STATE_B, SHELF_B, 'changes'));
	if (!changesB.file) throw new Error('B 的更新包没导出来');
	await syncShelf(shelfOptions(SHELF_B));

	const aPull = await syncShelf(shelfOptions(SHELF_A));
	check('A 收到 B 的更新包', aPull.pulled.length, 1);
	await applyBundle(applyOptions(VAULT_A, STATE_A, pulledPath(SHELF_A, aPull.pulled[0] ?? '')));
	check('B 的改动传到了 A', read(VAULT_A, '笔记/b.md'), 'B2 也改过了');

	// ---------------------------------------------------------------- 4. 删除也要传过去
	fs.unlinkSync(at(VAULT_A, '笔记/a.md'));
	const deleteA = await exportBundle(exportOptions(VAULT_A, STATE_A, SHELF_A, 'changes'));
	if (!deleteA.file) throw new Error('删除之后应该有更新包');
	check('更新包点名了一个删除', deleteA.deletedCount, 1);
	await syncShelf(shelfOptions(SHELF_A));

	const bPull2 = await syncShelf(shelfOptions(SHELF_B));
	check('B 收到了新的更新包', bPull2.pulled.length, 1);
	await applyBundle(applyOptions(VAULT_B, STATE_B, pulledPath(SHELF_B, bPull2.pulled[0] ?? '')));
	checkTrue('B 那边也删掉了', !exists(VAULT_B, '笔记/a.md'));

	// ---------------------------------------------------------------- 5. 单向对齐：以对面为准
	// 两边各改各的、谁也不让谁时，「让我和对面一致」走的这条路：
	// 目标状态 = 我站的基准 + 包里的条目 − 包点名的删除（**不是**"我的内容 + 对方的改动"），
	// 本机独有的文件进回收目录，做完状态编号必须与对面完全相同。
	write(VAULT_B, '笔记/b.md', 'B3 更长的一版');
	const bAgain = await exportBundle(exportOptions(VAULT_B, STATE_B, SHELF_B, 'changes'));
	if (!bAgain.file) throw new Error('B 的第二份更新包没导出来');
	await syncShelf(shelfOptions(SHELF_B));

	write(VAULT_A, '笔记/本机私货.md', '只在我这边');
	const aPull3 = await syncShelf(shelfOptions(SHELF_A));
	check('A 收到 B 的第二份包', aPull3.pulled.length, 1);
	const aligned = await applyBundle({
		...applyOptions(VAULT_A, STATE_A, pulledPath(SHELF_A, aPull3.pulled[0] ?? '')),
		alignToPeer: true,
	});
	check('对齐后状态编号与对面一致', aligned.result.stateIdCompare, 'match');
	check('对齐后的正文是对方那一版', read(VAULT_A, '笔记/b.md'), 'B3 更长的一版');
	checkTrue('本机独有文件被挪进回收目录', !exists(VAULT_A, '笔记/本机私货.md'));

	// ---------------------------------------------------------------- 6. 收尾：两边必须一模一样
	const stateA = await loadState(STATE_A);
	const stateB = await loadState(STATE_B);
	check('两边的状态编号一致（内容一样）', stateA.stateId?.id, stateB.stateId?.id);
	check('两边跟踪的包一模一样', await tracked(SHELF_A), await tracked(SHELF_B));
	check('远程里的包与货架一致', await remoteFiles(), await tracked(SHELF_A));

	console.log(`\n共 ${checks} 次检查，失败 ${failures.length} 项`);
	for (const message of failures.slice(0, 10)) console.log(`\n❌ ${message}`);
	if (failures.length > 0) process.exitCode = 1;
}

await main().catch(error => {
	console.error('测试自身炸了：', error);
	process.exitCode = 1;
});
