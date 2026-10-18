import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../sync/disk';
import { gitFailure, runGit } from './run';
import type { GitResult } from './run';

/**
 * "货架" ＝ 同步包文件夹，它本身就是一个 git 仓库的工作区。
 *
 * 这个模块只管**把货架摆成插件要的样子**：
 * 仓库根必须就是货架本身、远程地址不是别人写好的就别动、仓库里只放 `.lsave`。
 *
 * 两条硬规矩（别把用户的库搅坏）：
 * - **不在别人的仓库里 init**：货架如果落在用户库的 git 仓库里面（比如把包目录设进了库），
 *   在这里 init 会造出一个嵌套仓库，之后"提交"到底提交到哪儿就说不清了 —— 直接拒绝；
 * - **不悄悄改远程地址**：远程里躺着的是整库内容，改错地址等于把笔记发到别处去。
 */

export interface ShelfOptions {
	/** 货架（同步包文件夹）的绝对路径 */
	dir: string;
	/** 远程地址：HTTPS / SSH / 本地裸仓库路径都行 */
	remote: string;
	/** 分支名（默认由上层给 `main`） */
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

/** 货架落在另一个 git 仓库里：拒绝，并告诉用户那个仓库在哪 */
export class ShelfNestedError extends Error {
	readonly outer: string;

	constructor(outer: string) {
		super(`这个文件夹在另一个 git 仓库里（${outer}）：换一个独立文件夹，别把货架放进库仓库`);
		this.name = 'ShelfNestedError';
		this.outer = outer;
	}
}

/** 货架已经接了别的远程：不自动改，交给用户明确点一下 */
export class ShelfRemoteMismatchError extends Error {
	readonly current: string;
	readonly wanted: string;

	constructor(current: string, wanted: string) {
		super(`货架现在接的是 ${current}，设置里写的是 ${wanted}：地址不一样，插件不会自己改（改了就等于把包发到别处去）`);
		this.name = 'ShelfRemoteMismatchError';
		this.current = current;
		this.wanted = wanted;
	}
}

/** 跑 git 的一个小包装（带默认超时） */
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

/** 这个目录本身是不是货架（是 git 仓库，而且仓库根恰好是它） */
export async function isShelf(dir: string, options: Pick<ShelfOptions, 'gitPath' | 'timeoutMs'> = {}): Promise<boolean> {
	const target = path.resolve(dir);
	if (!fs.existsSync(path.join(target, '.git'))) return false;
	const top = await runGit(['rev-parse', '--show-toplevel'], {
		cwd: target,
		...(options.gitPath ? { gitPath: options.gitPath } : {}),
		timeoutMs: options.timeoutMs ?? 10_000,
	});
	return top.code === 0 && samePath(top.stdout.trim(), target);
}

/**
 * 把货架准备好（幂等：每次同步前都可以调）。
 *
 * - 没有 `.git` → 先看外层有没有仓库（有就拒绝），再 init；
 * - 有 `.git` → 自检"仓库根就是货架"，再比对远程地址；
 * - **只有第一次**才写 config（每次同步都写会白起一堆进程），
 *   但 `.git/info/exclude` 每次都对一遍内容（用户手改过也能纠正回来）。
 */
export async function prepareShelf(options: ShelfOptions): Promise<{ created: boolean }> {
	const dir = path.resolve(options.dir);
	const branch = normalizeBranch(options.branch);
	const remote = options.remote.trim();
	if (remote === '') throw new Error('还没填远程地址：先建一个私有空仓库，把地址填进来');

	await ensureDir(dir);
	const git = gitRunner(options);
	let created = false;

	if (!fs.existsSync(path.join(dir, '.git'))) {
		// 外层已经有仓库：在这里 init 会造出一个嵌套仓库，直接拒绝（用户的库仓库就是这么被搅坏的）
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

	// 远程地址：有 origin 就比对，绝不悄悄改
	const current = await git(['remote', 'get-url', 'origin']);
	if (current.code !== 0) {
		const add = await git(['remote', 'add', 'origin', remote]);
		if (add.code !== 0) throw gitFailure('设置远程地址', add);
	} else if (current.stdout.trim() !== remote) {
		throw new ShelfRemoteMismatchError(current.stdout.trim(), remote);
	}

	if (created) await configureShelf(git);
	await ensureInfoFile(path.join(dir, '.git', 'info', 'exclude'), excludeContent(dir, options.trashDir));
	await ensureInfoFile(path.join(dir, '.git', 'info', 'attributes'), ATTRIBUTES);
	return { created };
}

/**
 * 仓库里只允许包：其余一切（笔记、回收站、日志）都不进版本库。
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

/** `target` 在 `dir` 里面时返回相对路径（正斜杠），否则 null */
function insidePath(dir: string, target?: string | null): string | null {
	if (!target) return null;
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
