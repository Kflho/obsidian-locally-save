import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../sync/disk';
import { gitFailure, runGit } from './run';
import type { GitResult } from './run';

/**
 * "货架" ＝ 同步包文件夹（用户设置里的「同步包文件夹」）。
 *
 * 它有两种活法（0.16 起）：
 *
 * 1. **独立货架**：文件夹自己就是一个 git 仓库（老办法）。仓库根＝货架根，只放 `.lsave`；
 * 2. **仓库里的子目录**：货架是**另一个仓库**（比如 `kf-personal-data`）下的一个子目录，
 *    由那个仓库带着一起同步。这时插件只认自己那一段 —— 提交、状态、拉取都限定在
 *    货架子目录里，**绝不** `git add -A` 整仓、**绝不** rebase / abort 别人没做完的合并。
 *
 * 三条硬规矩（别把用户的库搅坏）：
 * - **不在别人的仓库里 init**：货架落在已有仓库里就用"子目录"那套，不写 `.git`；
 * - **不悄悄改远程地址**：远程里躺着的是整库内容，改错地址等于把笔记发到别处去；
 * - **只碰自己那一段**：过滤规则写在货架自己的 `.gitignore` 里，不动外层的
 *   `.git/info/exclude`（那是仓库级配置，会连别人的文件一起藏起来）。
 */

export interface ShelfOptions {
	/** 货架（同步包文件夹）的绝对路径 */
	dir: string;
	/** 远程地址：HTTPS / SSH / 本地裸仓库路径都行 */
	remote: string;
	/** 分支名（独立货架用它；子目录形态跟着外层仓库当前的分支走） */
	branch: string;
	/** 回收站目录（落在货架里面时必须排除；在外面传 null） */
	trashDir?: string | null;
	/** git 程序路径；留空 ＝ 从 PATH 里找 */
	gitPath?: string;
	/** 本地命令超时（默认 10 秒） */
	timeoutMs?: number;
	/** 网络命令超时（默认 60 秒） */
	networkTimeoutMs?: number;
	/** 额外环境变量（测试用） */
	env?: NodeJS.ProcessEnv;
	/** 长活走到哪一步了（状态栏显示"正在拉取…"）；引擎不关心界面，只回调 */
	onStage?: (stage: string) => void;
}

/**
 * 货架在磁盘上的身份：**独立仓库**，还是**某个仓库里的一个子目录**。
 *
 * `rel` 是货架相对仓库根的路径（正斜杠），独立货架是空串。
 */
export interface ShelfLayout {
	/** 货架目录（绝对路径） */
	dir: string;
	/** 真正的 git 仓库根（独立货架时等于 `dir`） */
	repo: string;
	/** 货架相对仓库根的路径；`''` ＝ 独立货架 */
	rel: string;
	/** 是不是"别人仓库里的子目录" */
	hosted: boolean;
	/** 这个仓库当前检出的分支；detached HEAD 时是空串 */
	branch: string;
}

/** 货架落在另一个 git 仓库里、但那个 `.git` 就是它自己那种怪情况：拒绝 */
export class ShelfNestedError extends Error {
	readonly outer: string;

	constructor(outer: string) {
		super(`这个文件夹在另一个 git 仓库里（${outer}）。换一个独立文件夹，别把同步包放进仓库。`);
		this.name = 'ShelfNestedError';
		this.outer = outer;
	}
}

/** 货架接的远程和设置里写的不是一个：不自动改，交给用户明确点一下 */
export class ShelfRemoteMismatchError extends Error {
	readonly current: string;
	readonly wanted: string;

	constructor(current: string, wanted: string) {
		super(`这个文件夹接的是 ${current}，设置里是 ${wanted}。地址不一样，插件不会自己改。`);
		this.name = 'ShelfRemoteMismatchError';
		this.current = current;
		this.wanted = wanted;
	}
}

/** 跑 git 的一个小包装（带默认超时）。cwd 一律是货架目录：子目录形态下 git 自己往上找仓库。 */
export type GitRunner = (args: string[], network?: boolean) => Promise<GitResult>;

export function gitRunner(options: ShelfOptions): GitRunner {
	const dir = path.resolve(options.dir);
	return (args, network = false) => runGit(args, {
		cwd: dir,
		...(options.gitPath ? { gitPath: options.gitPath } : {}),
		timeoutMs: network ? (options.networkTimeoutMs ?? 60_000) : (options.timeoutMs ?? 10_000),
		...(options.env ? { env: options.env } : {}),
	});
}

/**
 * 看一眼这个文件夹在 git 里是什么身份。**只读**：不 init、不改任何配置。
 *
 * - 不在任何仓库里 → `null`（还没接上）
 * - 仓库根就是它 → 独立货架（`hosted: false`）
 * - 仓库根在它上面 → 别人仓库里的子目录（`hosted: true`）
 */
export async function readShelfLayout(
	dir: string,
	options: Pick<ShelfOptions, 'gitPath' | 'timeoutMs'> = {},
): Promise<ShelfLayout | null> {
	const target = path.resolve(dir);
	const run = (args: string[]): Promise<GitResult> => runGit(args, {
		cwd: target,
		...(options.gitPath ? { gitPath: options.gitPath } : {}),
		timeoutMs: options.timeoutMs ?? 10_000,
	});

	const top = await run(['rev-parse', '--show-toplevel']);
	if (top.code !== 0 || top.stdout.trim() === '') return null;
	const repo = path.resolve(top.stdout.trim());
	const rel = relativeInside(repo, target);
	if (rel === null) return null;
	const branchResult = await run(['symbolic-ref', '--short', '-q', 'HEAD']);
	const branch = branchResult.code === 0 ? branchResult.stdout.trim() : '';
	return { dir: target, repo, rel, hosted: rel !== '', branch };
}

/** 这个文件夹接上 git 了没有（独立仓库，或者已经在别的仓库里） */
export async function isShelf(
	dir: string,
	options: Pick<ShelfOptions, 'gitPath' | 'timeoutMs'> = {},
): Promise<boolean> {
	return (await readShelfLayout(dir, options)) !== null;
}

/** 是不是"子目录形态"的货架（界面、状态栏用它决定怎么说） */
export async function isHostedShelf(
	dir: string,
	options: Pick<ShelfOptions, 'gitPath' | 'timeoutMs'> = {},
): Promise<boolean> {
	return (await readShelfLayout(dir, options))?.hosted === true;
}

export interface ShelfPrepared {
	/** 这一趟新建了独立的 `.git`（子目录形态永远是 false） */
	created: boolean;
	/** 货架是外层仓库的一个子目录 */
	hosted: boolean;
	layout: ShelfLayout;
}

/**
 * 把货架准备好（幂等：每次同步前都可以调）。
 *
 * - 已经在某个仓库里 → 只核对远程地址、写货架自己的 `.gitignore`，**不 init**；
 * - 不在仓库里、也没有 `.git` → 建一个独立仓库（老办法）；
 * - 有 `.git` 但仓库根不是它 → 拒绝（说不清提交到哪儿去）。
 *
 * **只有第一次**才写 config（每次同步都写会白起一堆进程），
 * 但货架自己的过滤规则每次都核对一遍内容（用户手改过也能纠正回来）。
 */
export async function prepareShelf(options: ShelfOptions): Promise<ShelfPrepared> {
	const dir = path.resolve(options.dir);
	const remote = options.remote.trim();
	if (remote === '') throw new Error('还没填远程地址：先建一个私有空仓库，把地址填进来');
	const branch = normalizeBranch(options.branch);

	await ensureDir(dir);
	const layout = await readShelfLayout(dir, options);

	if (layout?.hosted) {
		// 别人仓库里的子目录：不 init、不加远程，只核对 + 落过滤规则
		await verifyRemote(dir, remote, options.gitPath);
		await ensureIgnoreFile(dir, options.trashDir);
		if (layout.branch === '') {
			throw new Error('这个仓库现在不在任何分支上（detached HEAD）：先切回一个分支再同步');
		}
		return { created: false, hosted: true, layout };
	}

	const git = gitRunner(options);
	let created = false;

	if (!fs.existsSync(path.join(dir, '.git'))) {
		// 走到这里说明外层也没有仓库（有的话上面就是 hosted 了）
		const outer = await git(['rev-parse', '--show-toplevel']);
		if (outer.code === 0 && outer.stdout.trim() !== '') {
			throw new ShelfNestedError(outer.stdout.trim());
		}
		const init = await git(['init', '-b', branch]);
		if (init.code !== 0) {
			// 老版本 git 没有 `-b`
			const plain = await git(['init']);
			if (plain.code !== 0) throw gitFailure('初始化包仓库', plain);
			const head = await git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
			if (head.code !== 0) throw gitFailure('设置分支', head);
		}
		created = true;
	}

	// 自检：仓库根必须就是货架，不能是外层那个
	const top = await git(['rev-parse', '--show-toplevel']);
	if (top.code !== 0) throw new Error(`这个文件夹不是 git 仓库：${dir}`);
	if (!samePath(top.stdout.trim(), dir)) throw new ShelfNestedError(top.stdout.trim());

	await verifyRemote(dir, remote, options.gitPath);

	if (created) await configureShelf(git);
	await ensureInfoFile(path.join(dir, '.git', 'info', 'exclude'), excludeContent(dir, options.trashDir));
	await ensureInfoFile(path.join(dir, '.git', 'info', 'attributes'), ATTRIBUTES);
	const headRef = await git(['symbolic-ref', '--short', '-q', 'HEAD']);
	return {
		created,
		hosted: false,
		layout: {
			dir,
			repo: dir,
			rel: '',
			hosted: false,
			branch: headRef.code === 0 ? headRef.stdout.trim() : branch,
		},
	};
}

/** 远程地址：有 origin 就比对，绝不悄悄改；没有 origin 就补上（只对独立货架） */
async function verifyRemote(dir: string, remote: string, gitPath?: string): Promise<void> {
	const git = gitRunnerAt(dir, gitPath);
	const current = await git(['remote', 'get-url', 'origin']);
	if (current.code !== 0) {
		// 子目录形态下不给别人的仓库加远程：那是在改仓库配置
		const top = await git(['rev-parse', '--show-toplevel']);
		const hosted = top.code === 0 && !samePath(top.stdout.trim(), dir);
		if (hosted) {
			throw new Error(
				`这个仓库还没有远程地址：插件不会给你的仓库加远程。先在仓库里配好 origin，再回来同步。`,
			);
		}
		const add = await git(['remote', 'add', 'origin', remote]);
		if (add.code !== 0) throw gitFailure('设置远程地址', add);
		return;
	}
	if (current.stdout.trim() !== remote) {
		throw new ShelfRemoteMismatchError(current.stdout.trim(), remote);
	}
}

function gitRunnerAt(dir: string, gitPath?: string): GitRunner {
	return (args) => runGit(args, {
		cwd: path.resolve(dir),
		...(gitPath ? { gitPath } : {}),
		timeoutMs: 10_000,
	});
}

/**
 * 子目录形态的过滤规则：**写在货架自己的 `.gitignore` 里**，不动外层仓库的配置。
 *
 * 内容和独立货架的 `.git/info/exclude` 一个意思：仓库里只认包与对方状态，
 * 完整包（太大，用户手动搬）与回收站都不提交；`.gitignore` 自己也不提交。
 */
function hostedIgnoreContent(dir: string, trashDir?: string | null): string {
	const lines = [
		'# Locally Save 每次同步会重写这个文件：这个文件夹里只提交同步包，别的都不进仓库。',
		'*',
		'!*/',
		'!*.lsave',
		'# 每台机器的小状态（对表用：状态编号 / 站在哪份完整副本上；不带文件内容）。',
		'!/.lsave-peers/',
		'!/.lsave-peers/*.json',
		'# 完整包太大，不往远程推（留在本机，用 U 盘 / 网盘手动搬）。',
		'/full/',
		'# 回收站：撤下的包不进仓库。',
		'/.lsave/',
		'# 这个文件自己也不提交。',
		'/.gitignore',
	];
	const trash = insidePath(dir, trashDir);
	if (trash && !trash.startsWith('.lsave/')) {
		lines.push('# 回收站：撤下的包不进仓库。', `/${trash}/`);
	}
	return `${lines.join('\n')}\n`;
}

async function ensureIgnoreFile(dir: string, trashDir?: string | null): Promise<void> {
	await ensureInfoFile(path.join(dir, '.gitignore'), hostedIgnoreContent(dir, trashDir));
}

/**
 * 独立货架的过滤规则（`.git/info/exclude`）。
 *
 * 写法是 gitignore 那一套，顺序有讲究：
 * - `*` 先把所有东西挡掉，再用「`!` 开头、以斜杠结尾」的那条把目录放回来
 *   （不然子目录里的 `!*.lsave` 根本轮不到）；
 * - `!*.lsave` 放行任意层级的包（`changes/`、根目录里的老包都算）；
 * - `/full/` 再把完整包整个挡掉 —— 它太大，按用户的决定**不推**，由用户手动搬；
 * - 回收站如果落在货架里面，也挡掉（`git add -A` 会把它一起扫进去，实测过）。
 */
function excludeContent(dir: string, trashDir?: string | null): string {
	const lines = [
		'# Locally Save 每次同步会重写这个文件：这个仓库里只放同步包，别的都不提交。',
		'*',
		'!*/',
		'!*.lsave',
		'# 每台机器的小状态（对表用：状态编号 / 站在哪份完整副本上；不带文件内容）。',
		'!/.lsave-peers/',
		'!/.lsave-peers/*.json',
		'# 回收站（以及旧版本留下的 .lsave 目录）：整块不进仓库。',
		'/.lsave/',
		'# 完整包太大，不往远程推（留在本机，用 U 盘 / 网盘手动搬）。',
		'# 远程里万一已经有它（老版本推上去的），拉下来仍然是 tracked，不影响收包。',
		'/full/',
	];
	const trash = insidePath(dir, trashDir);
	// 回收站通常就在 `/.lsave/` 里（上面已经挡掉了）；只有包文件夹本身指到 `.lsave` 时，
	// 回收站是它下面的 `bundles-trash/`，得单独一行
	if (trash && !trash.startsWith('.lsave/')) {
		lines.push('# 回收站：撤下的包不进仓库。', `/${trash}/`);
	}
	return `${lines.join('\n')}\n`;
}

/** 包是二进制：不做文本 diff / 合并 / 换行转换（本地文件，不版本化） */
const ATTRIBUTES = '*.lsave -text -diff -merge\n';

/** 第一次建仓时写死的几项：换行/权限位/签名都关掉，别让两台机器的差异变成假改动 */
async function configureShelf(git: GitRunner): Promise<void> {
	const settings: [string, string][] = [
		['core.autocrlf', 'false'],
		['core.filemode', 'false'],
		['core.quotepath', 'false'],
		['commit.gpgsign', 'false'],
		['advice.addIgnoredFile', 'false'],
	];
	for (const [key, value] of settings) {
		const result = await git(['config', '--local', key, value]);
		if (result.code !== 0) throw gitFailure(`设置 ${key}`, result);
	}
	// 没配过身份时兜底（否则第一笔提交直接失败）：只写本仓库，不动用户的全局配置
	if (!(await hasConfig(git, 'user.name'))) await git(['config', '--local', 'user.name', 'Locally Save']);
	if (!(await hasConfig(git, 'user.email'))) await git(['config', '--local', 'user.email', 'locally-save@localhost']);
}

async function hasConfig(git: GitRunner, key: string): Promise<boolean> {
	const result = await git(['config', '--get', key]);
	return result.code === 0 && result.stdout.trim() !== '';
}

/** 文件内容不一样才写（货架每 30 秒就可能被看一眼，别每次都改 mtime） */
async function ensureInfoFile(file: string, content: string): Promise<void> {
	try {
		if (fs.readFileSync(file, 'utf8') === content) return;
	} catch {
		// 没有这个文件：往下写
	}
	await ensureDir(path.dirname(file));
	fs.writeFileSync(file, content, 'utf8');
}

/** 分支名：shell 不参与，但值以 `-` 开头会被 git 当成选项，这里挡掉 */
function normalizeBranch(branch: string): string {
	const value = branch.trim() || 'main';
	if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.startsWith('-') || value.startsWith('/')) {
		throw new Error(`分支名不合法：${branch}`);
	}
	return value;
}

/** `target` 在 `repo` 里面时返回相对路径（正斜杠），否则 null；`target === repo` 时返回空串 */
function relativeInside(repo: string, target: string): string | null {
	const rel = path.relative(repo, target);
	if (rel === '') return '';
	if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
	return rel.split(path.sep).join('/');
}

/** `target` 在 `dir` 里面时返回相对路径（正斜杠），否则 null */
function insidePath(dir: string, target?: string | null): string | null {	if (!target) return null;
	const rel = path.relative(path.resolve(dir), path.resolve(target));
	if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
	return rel.split(path.sep).join('/');
}

/** 路径比较：Windows 上大小写不敏感，两边都取真实路径再比 */
function samePath(a: string, b: string): boolean {
	return normalizePath(a) === normalizePath(b);
}

function normalizePath(target: string): string {
	const resolved = path.resolve(target);
	let real = resolved;
	try {
		real = fs.realpathSync.native(resolved);
	} catch {
		// 路径不存在（还没建）：按字面比
	}
	return process.platform === 'win32' ? real.toLowerCase() : real;
}
