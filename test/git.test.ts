/**
 * Git 货架：把同步包文件夹当成一个 git 工作区，两台机器 + 一个远程对搬。
 *
 * 这套测试钉的是**方案里最危险的那几条假设**（写错一条就是丢包或者把用户的库搅坏）：
 * - 仓库里只进包：完整包（太大，不推）、回收站、笔记都不进；
 * - 两台机器各写各的、各推各的：合并只发生在"新增 / 删除整个文件"上，不会冲突；
 * - **撤下一个包会传到对面**（用户拍板：删包要同步，保证两边一致）；
 * - 货架落在别人的仓库里就拒绝（不造嵌套仓库）、远程地址变了也不悄悄改；
 * - 本地还没有提交、两边各自 init 过、被抢先推送要重试 —— 这三条都得能自己走通。
 *
 * 全程只用本地裸仓库，不碰网络。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitMissingError, runGit } from '../src/git/run';
import {
	ShelfNestedError,
	ShelfRemoteMismatchError,
	prepareShelf,
} from '../src/git/shelf';
import type { ShelfOptions } from '../src/git/shelf';
import { pushWithRetry, syncShelf } from '../src/git/sync';

// -------------------------------------------------------------------- 断言
let checks = 0;
const failures: string[] = [];

function checkTrue(name: string, condition: boolean, detail = name): void {
	checks++;
	if (!condition) failures.push(`[断言失败] ${name}\n  ${detail}`);
}

function check(name: string, actual: unknown, expected: unknown): void {
	checks++;
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		failures.push(`[期望不符] ${name}\n  期望 ${JSON.stringify(expected)}\n  实际 ${JSON.stringify(actual)}`);
	}
}

// -------------------------------------------------------------------- 小工具
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lsave-git-'));

function mkdir(...parts: string[]): string {
	const target = path.join(ROOT, ...parts);
	fs.mkdirSync(target, { recursive: true });
	return target;
}

function writeFile(file: string, content: string): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
}

function exists(file: string): boolean {
	return fs.existsSync(file);
}

function optionsFor(dir: string, remote: string, extra: Partial<ShelfOptions> = {}): ShelfOptions {
	return {
		dir,
		remote,
		branch: 'main',
		// 界面上的默认位置：用户自定义包目录时，回收站落在货架里面的 `.lsave/` 下
		trashDir: path.join(dir, '.lsave', 'bundles-trash'),
		timeoutMs: 20_000,
		networkTimeoutMs: 30_000,
		...extra,
	};
}

async function initBare(...parts: string[]): Promise<string> {
	const bare = path.join(ROOT, ...parts);
	const result = await runGit(['init', '--bare', bare], { cwd: ROOT });
	if (result.code !== 0) throw new Error(`建裸仓库失败：${result.stderr}`);
	return bare;
}

/** 远程里跟踪了哪些文件（按名字排序；中文名不转义） */
async function remoteTree(bare: string, branch = 'main'): Promise<string[]> {
	const result = await runGit(['-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', branch], { cwd: bare });
	return result.stdout.trim() === '' ? [] : result.stdout.trim().split('\n').sort();
}

async function tracked(dir: string): Promise<string[]> {
	const result = await runGit(['-c', 'core.quotepath=false', 'ls-files'], { cwd: dir });
	return result.stdout.trim() === '' ? [] : result.stdout.trim().split('\n').sort();
}

async function isClean(dir: string): Promise<boolean> {
	const result = await runGit(['status', '--porcelain'], { cwd: dir });
	return result.stdout.trim() === '';
}

async function headOf(dir: string): Promise<string> {
	return (await runGit(['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
}

// -------------------------------------------------------------------- 用例
async function main(): Promise<void> {
	const probe = await runGit(['--version'], { cwd: ROOT }).catch(() => null);
	if (!probe || probe.code !== 0) {
		console.log('这台机器上没有 git，跳过（这些用例只在装了 git 的机器上跑）');
		return;
	}

	// ---------------------------------------------------------------- 0. 没装 git
	{
		const target = mkdir('no-git');
		const caught = await prepareShelf(optionsFor(target, path.join(ROOT, 'x.git'), {
			gitPath: path.join(ROOT, 'definitely-no-such-git'),
		})).catch((error: unknown) => error);
		checkTrue('没装 git 时报的是"没找到 git"（不是英文 ENOENT）', caught instanceof GitMissingError, String(caught));
	}

	// ---------------------------------------------------------------- 1. 第一次同步：只推包
	const bare1 = await initBare('remote1.git');
	const machineA = mkdir('A');
	writeFile(path.join(machineA, 'changes', 'a1.lsave'), 'A1');
	writeFile(path.join(machineA, 'full', 'f1.lsave'), 'F1');
	writeFile(path.join(machineA, '.lsave', 'bundles-trash', '20260101', 'a0.lsave'), 'A0');
	writeFile(path.join(machineA, 'notes.md'), 'hi');
	// 每台机器的状态文件（对表用）：它该进仓库，但回收站 / 笔记不该
	writeFile(path.join(machineA, '.lsave-peers', 'peer-1.json'), '{"format":"locally-save-peer"}');

	const first = await syncShelf(optionsFor(machineA, bare1));
	check('第一次同步提交的是包 + 对方状态文件', first.committed?.files, [
		'.lsave-peers/peer-1.json',
		'changes/a1.lsave',
	]);
	check('远程里只有包和对方状态', await remoteTree(bare1), [
		'.lsave-peers/peer-1.json',
		'changes/a1.lsave',
	]);
	checkTrue('完整包留在本机', exists(path.join(machineA, 'full', 'f1.lsave')));
	checkTrue('刚接上货架时报告是"新建"', first.createdShelf);
	checkTrue('货架上除了包以外的东西都不算改动', await isClean(machineA));

	// ---------------------------------------------------------------- 2. 第二台机器接上
	const machineB = mkdir('B');
	const second = await syncShelf(optionsFor(machineB, bare1));
	check('B 这一趟没有本地提交', second.committed, null);
	check('B 把包拉下来了', second.pulled, ['changes/a1.lsave']);
	checkTrue('B 的包文件夹里有了 a1', exists(path.join(machineB, 'changes', 'a1.lsave')));
	check('没有要推的东西时不会去推', second.pushed, false);

	// ---------------------------------------------------------------- 3. 两边各写各的
	writeFile(path.join(machineA, 'changes', 'a2.lsave'), 'A2');
	await syncShelf(optionsFor(machineA, bare1));
	writeFile(path.join(machineB, 'changes', 'b1.lsave'), 'B1');
	const bSync = await syncShelf(optionsFor(machineB, bare1));
	check('B 把 A 的新包拉了下来', bSync.pulled, ['changes/a2.lsave']);
	checkTrue('B 也把自己的包推了上去', bSync.pushed);
	check('远程这一趟之后是三个包', await remoteTree(bare1), [
		'.lsave-peers/peer-1.json',
		'changes/a1.lsave',
		'changes/a2.lsave',
		'changes/b1.lsave',
	]);

	// ---------------------------------------------------------------- 4. 撤下的包要传到对面
	fs.renameSync(
		path.join(machineA, 'changes', 'a2.lsave'),
		writeFile(path.join(machineA, '.lsave', 'bundles-trash', '20260102', 'a2.lsave'), 'A2'),
	);
	const removed = await syncShelf(optionsFor(machineA, bare1));
	check('撤下也是一笔提交', removed.committed?.files, ['changes/a2.lsave']);
	check('远程里也撤下了', await remoteTree(bare1), [
		'.lsave-peers/peer-1.json',
		'changes/a1.lsave',
		'changes/b1.lsave',
	]);
	await syncShelf(optionsFor(machineB, bare1));
	checkTrue('B 那边也撤下了（两边一致）', !exists(path.join(machineB, 'changes', 'a2.lsave')));
	check('两边跟踪的包一模一样', await tracked(machineA), await tracked(machineB));
	checkTrue('A 的工作区是干净的', await isClean(machineA));
	checkTrue('B 的工作区是干净的', await isClean(machineB));

	// ---------------------------------------------------------------- 5. 再同步一次是空转
	const headBefore = await headOf(machineA);
	const idle = await syncShelf(optionsFor(machineA, bare1));
	check('没有变化时不再提交', idle.committed, null);
	check('没有变化时也不推', idle.pushed, false);
	check('HEAD 没变', await headOf(machineA), headBefore);

	// ---------------------------------------------------------------- 6. 被抢先推送：自动拉一遍再推
	const bare2 = await initBare('remote2.git');
	const machineP = mkdir('P');
	writeFile(path.join(machineP, 'changes', 'p1.lsave'), 'P1');
	await syncShelf(optionsFor(machineP, bare2));
	const machineQ = mkdir('Q');
	await syncShelf(optionsFor(machineQ, bare2));
	writeFile(path.join(machineP, 'changes', 'p2.lsave'), 'P2');
	await syncShelf(optionsFor(machineP, bare2));
	// Q 没拉就自己提交了一个包，然后直接推 —— 正是"两台机器同时动手"那一刻
	writeFile(path.join(machineQ, 'changes', 'q1.lsave'), 'Q1');
	await runGit(['add', '-A'], { cwd: machineQ });
	await runGit(['commit', '-m', 'q1'], { cwd: machineQ });
	const retried = await pushWithRetry(optionsFor(machineQ, bare2));
	checkTrue('被拒之后自动重试推上去了', retried);
	check('远程三个包都在', await remoteTree(bare2), [
		'changes/p1.lsave',
		'changes/p2.lsave',
		'changes/q1.lsave',
	]);
	checkTrue('重试时顺带把 p2 拉了回来', exists(path.join(machineQ, 'changes', 'p2.lsave')));

	// ---------------------------------------------------------------- 7. 两边各自 init（没有共同祖先）
	const machineC = mkdir('C');
	await prepareShelf(optionsFor(machineC, bare1));
	writeFile(path.join(machineC, 'changes', 'c1.lsave'), 'C1');
	await runGit(['add', '-A'], { cwd: machineC });
	await runGit(['commit', '-m', 'c1'], { cwd: machineC });
	await syncShelf(optionsFor(machineC, bare1));
	checkTrue('C 拿到了远程的包', exists(path.join(machineC, 'changes', 'a1.lsave')));
	checkTrue('C 自己的包还在', exists(path.join(machineC, 'changes', 'c1.lsave')));
	checkTrue('远程里也有了 c1', (await remoteTree(bare1)).includes('changes/c1.lsave'));

	// ---------------------------------------------------------------- 8. 货架落在别人的仓库里：拒绝
	const outer = mkdir('outer');
	await runGit(['init', '-b', 'main'], { cwd: outer });
	const inner = mkdir('outer', 'bundles');
	const nested = await prepareShelf(optionsFor(inner, bare1)).catch((error: unknown) => error);
	checkTrue('拒绝在别人的仓库里建货架', nested instanceof ShelfNestedError, String(nested));
	checkTrue('没有真的建出 .git', !exists(path.join(inner, '.git')));

	// ---------------------------------------------------------------- 9. 远程地址变了：不悄悄改
	const bare3 = await initBare('remote3.git');
	const mismatch = await prepareShelf(optionsFor(machineA, bare3)).catch((error: unknown) => error);
	checkTrue('接了别的远程时拒绝', mismatch instanceof ShelfRemoteMismatchError, String(mismatch));
	check('原远程地址没被改掉', (await runGit(['remote', 'get-url', 'origin'], { cwd: machineA })).stdout.trim(), bare1);

	// ---------------------------------------------------------------- 10. 中文目录 + 中文包名
	const bare4 = await initBare('remote4.git');
	const zh = mkdir('中文 目录');
	const zhName = '我的笔记-更新-54代到55代-状态abc-1f2e3d.lsave';
	writeFile(path.join(zh, 'changes', zhName), 'ZH');
	await syncShelf(optionsFor(zh, bare4));
	check('中文包名能进仓库', await remoteTree(bare4), [`changes/${zhName}`]);

	// ---------------------------------------------------------------- 11. 回收站在货架外面
	const bare5 = await initBare('remote5.git');
	const shelf = mkdir('R11', '.lsave', 'bundles');
	const outsideTrash = mkdir('R11', '.lsave', 'bundles-trash');
	writeFile(path.join(shelf, 'changes', 'x1.lsave'), 'X1');
	writeFile(path.join(outsideTrash, 'old.lsave'), 'OLD');
	await syncShelf(optionsFor(shelf, bare5, { trashDir: outsideTrash }));
	check('货架外面的回收站不影响仓库内容', await remoteTree(bare5), ['changes/x1.lsave']);

	// ---------------------------------------------------------------- 12. 完整包被手动推进远程之后
	// 插件自己不推完整包（太大），但用户完全可能手动 git push 一份当"搬家包"。
	// 这时候它就是一个普通 tracked 文件：收得下、撤下也传得过去 —— 不能被 /full/ 的排除规则挡住。
	const bare6 = await initBare('remote6.git');
	const seed = mkdir('seed');
	await syncShelf(optionsFor(seed, bare6));
	writeFile(path.join(seed, 'full', 'big.lsave'), 'BIG');
	await runGit(['add', '-f', 'full/big.lsave'], { cwd: seed });
	await runGit(['commit', '-m', '手动放进来的完整包'], { cwd: seed });
	await runGit(['push', 'origin', 'HEAD:refs/heads/main'], { cwd: seed });

	const follower = mkdir('follower');
	await syncShelf(optionsFor(follower, bare6));
	checkTrue(
		'完整包能被收下来（tracked 文件不受 ignore 影响）',
		exists(path.join(follower, 'full', 'big.lsave')),
	);
	checkTrue('收下来之后工作区是干净的', await isClean(follower));

	// 撤下：删本地那份 → 提交 → 推送 → 对面也删（两边一致）
	fs.unlinkSync(path.join(follower, 'full', 'big.lsave'));
	await syncShelf(optionsFor(follower, bare6));
	check('远程里也撤下了完整包', await remoteTree(bare6), []);
	await syncShelf(optionsFor(seed, bare6));
	checkTrue('发起方那边也撤下了', !exists(path.join(seed, 'full', 'big.lsave')), '完整包的删除没有传回去');

	console.log(`\n共 ${checks} 次检查，失败 ${failures.length} 项`);
	for (const message of failures.slice(0, 10)) console.log(`\n❌ ${message}`);
	if (failures.length > 0) process.exitCode = 1;
}

await main().catch(error => {
	console.error('测试自身炸了：', error);
	process.exitCode = 1;
});
