import fs from 'node:fs';
import path from 'node:path';
import { gitFailure } from './run';
import type { GitResult } from './run';
import { gitRunner, isShelf, prepareShelf } from './shelf';
import type { GitRunner, ShelfOptions } from './shelf';

/**
 * 一次"和远程对一遍"：**提交本机的包 → 拉下别人的包 → 推上去**。
 *
 * 只搬包，不搬库。git 在这里是货车：
 * - 谁站在哪一份基准上、这个包能不能收，仍然由包头部说了算（`bundle/` 那套），
 *   这里一行都不碰那些判断；
 * - 合并永远只发生在"新增一个整文件 / 删掉一个整文件"上 ——
 *   包的文件名带随机位、内容写下就不改，所以两台机器同时操作也不会撞车。
 *
 * 顺序不能换：**先提交再拉**。倒过来的话，本地刚写出来、还没提交的包会让 rebase 拒绝开工；
 * 而先提交的那一笔要是推送失败，下一次同步会原样再试（提交本身不联网，失败了也不丢东西）。
 */

export interface GitSyncReport {
	/** 这一趟提交了什么（没有变化就是 null） */
	committed: { commit: string; files: string[] } | null;
	/** 这一趟从远程新落下来的包（相对路径） */
	pulled: string[];
	/** 这一趟真的推上去了没有 */
	pushed: boolean;
	/** 远程还是空仓库（第一次推就是这种情况） */
	remoteEmpty: boolean;
	/** 本地领先远程几个提交（没推上去的） */
	ahead: number;
	/** 远程领先本地几个提交（没拉下来的） */
	behind: number;
	/** 现在的 HEAD（空仓库是 null） */
	head: string | null;
	/** 这一趟是不是刚建了货架（界面上要说一句"接上了"） */
	createdShelf: boolean;
}

/** 把货架和远程对一遍（幂等：没有变化时只花几条本地 git 命令） */
export async function syncShelf(options: ShelfOptions): Promise<GitSyncReport> {
	const prepared = await prepareShelf(options);
	const dir = path.resolve(options.dir);
	const git = gitRunner(options);

	// 上一次卡在半路的 rebase / merge：先收拾掉，否则后面每条命令都会失败
	await clearStuckState(dir, git);

	// 提交本机新写的包（含"撤下"的删除）
	options.onStage?.('检查本机的包…');
	const before = await listBundlePaths(dir, options.trashDir);
	options.onStage?.('提交本机的包…');
	const committed = await commitPending(git);

	// 拉：远程还是空仓库是正常情况（第一次推之前就是）
	options.onStage?.('连接远程…');
	const fetched = await fetchRemote(git, options.branch);
	let remoteEmpty = false;
	if (fetched.kind === 'fetched') {
		options.onStage?.('合并远程的包…');
		await mergeFetched(git);
	} else if (fetched.kind === 'empty') {
		remoteEmpty = true;
	} else {
		throw fetched.error;
	}

	// 这一趟新出现的包 ＝ 拉下来的（给"自动应用"那条路用）
	const after = await listBundlePaths(dir, options.trashDir);
	const pulled = [...after].filter(item => !before.has(item)).sort();

	let counts = await aheadBehind(git, options.branch);
	let pushed = false;
	if (counts.ahead > 0) {
		options.onStage?.('推送远程…');
		pushed = await pushWithRetry(options);
		counts = await aheadBehind(git, options.branch);
	}

	const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD']);
	return {
		committed,
		pulled,
		pushed,
		remoteEmpty,
		ahead: counts.ahead,
		behind: counts.behind,
		head: head.code === 0 ? head.stdout.trim() : null,
		createdShelf: prepared.created,
	};
}

/**
 * 推送；被另一台机器抢先时**自动再拉一遍、再推一次**（不解析本地化文案，只看结果变没变）。
 *
 * 为什么会撞：两边都在 30 秒的节拍上工作，A 推完 B 才推，B 的远程引用还是旧的 ——
 * 这是**正常情况**，不是错误。真正推不上去（认证 / 权限 / 网络）才会抛。
 */
export async function pushWithRetry(options: ShelfOptions, retries = 1): Promise<boolean> {
	const git = gitRunner(options);
	let push = await pushOnce(git, options.branch);
	if (push.code === 0) return true;

	for (let attempt = 0; attempt < retries; attempt++) {
		const before = await remoteTip(git, options.branch);
		const fetch = await git(['fetch', 'origin', options.branch], true);
		if (fetch.code !== 0) break; // 连不上：重试没意义，把原始失败报出去
		await mergeFetched(git);
		const after = await remoteTip(git, options.branch);
		if (after === before) break; // 远程没往前走：再推也是一样的结果
		push = await pushOnce(git, options.branch);
		if (push.code === 0) return true;
	}
	throw gitFailure('把包推到远程', push);
}

/** 本机的包 → 一笔提交（没有变化就跳过，不产生空提交） */
async function commitPending(git: GitRunner): Promise<{ commit: string; files: string[] } | null> {
	// `git add -A` 只加得进 `.git/info/exclude` 放行的那几类（见 shelf.ts）：包，以及已跟踪文件的增删
	// （完整包与回收站都被挡在外面 —— 完整包不推，回收站不进仓库）
	const add = await git(['add', '-A']);
	if (add.code !== 0) throw gitFailure('把包加进仓库', add);

	const staged = await git(['diff', '--cached', '--quiet']);
	if (staged.code === 0) return null;
	if (staged.code !== 1) throw gitFailure('检查包的变化', staged);

	const names = await git(['diff', '--cached', '--name-only', '-z']);
	if (names.code !== 0) throw gitFailure('列出要提交的包', names);
	const files = names.stdout.split('\0').filter(item => item !== '');

	const commit = await git(['commit', '-m', `同步包：${files.length} 个`]);
	if (commit.code !== 0) throw gitFailure('提交包', commit);
	const head = await git(['rev-parse', 'HEAD']);
	if (head.code !== 0) throw gitFailure('读取本次提交', head);
	return { commit: head.stdout.trim(), files };
}

type FetchOutcome =
	| { kind: 'fetched' }
	| { kind: 'empty' }
	| { kind: 'failed'; error: Error };

/** 拉一次。远程还是空仓库（刚建、还没有分支）不算失败 —— 第一次推之前就是这样 */
async function fetchRemote(git: GitRunner, branch: string): Promise<FetchOutcome> {
	const fetch = await git(['fetch', 'origin', branch], true);
	if (fetch.code === 0) return { kind: 'fetched' };
	// `fetch` 失败时再用 ls-remote 判一次：到底是"远程还没有这个分支"，还是"连不上 / 没权限"
	const remote = await git(['ls-remote', '--heads', 'origin', branch], true);
	if (remote.code === 0 && remote.stdout.trim() === '') return { kind: 'empty' };
	if (remote.code !== 0) return { kind: 'failed', error: gitFailure('连接远程仓库', remote) };
	return { kind: 'failed', error: gitFailure('从远程拉包', fetch) };
}

/**
 * 把 `FETCH_HEAD` 落到本地。
 *
 * 三种情况，顺序是"最省事到最费事"：
 * 1. 能快进就快进（绝大多数时候）；
 * 2. 两边各自有提交 → **rebase**（线性、不留合并提交；没有共同祖先时也能直接接上，实测）；
 * 3. rebase 万一失败（真正的冲突，理论上不会）→ 退回 merge，再失败就如实报错并收拾干净。
 */
async function mergeFetched(git: GitRunner): Promise<void> {
	const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD']);
	if (head.code !== 0) {
		// 本地还没有任何提交：直接把远程那笔落下来
		const merge = await git(['merge', '--ff-only', 'FETCH_HEAD']);
		if (merge.code === 0) return;
		const reset = await git(['reset', '--hard', 'FETCH_HEAD']);
		if (reset.code !== 0) throw gitFailure('把远程的包落到本地', merge);
		return;
	}

	const fastForward = await git(['merge', '--ff-only', 'FETCH_HEAD']);
	if (fastForward.code === 0) return;

	const rebase = await git(['rebase', 'FETCH_HEAD']);
	if (rebase.code === 0) return;
	await git(['rebase', '--abort']);

	const merge = await git(['merge', '--allow-unrelated-histories', '--no-edit', 'FETCH_HEAD']);
	if (merge.code === 0) return;
	await git(['merge', '--abort']);
	throw new Error(`两边的包合不到一起（文件夹没动）：${(merge.stderr || rebase.stderr).trim()}`);
}

/** 上一次留下的 rebase / merge 残局：先中止（插件从不做交互式合并，留着只会让每条命令都失败） */
async function clearStuckState(dir: string, git: GitRunner): Promise<void> {
	const gitDir = path.join(dir, '.git');
	if (
		fs.existsSync(path.join(gitDir, 'rebase-merge'))
		|| fs.existsSync(path.join(gitDir, 'rebase-apply'))
	) {
		await git(['rebase', '--abort']);
	}
	if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) {
		await git(['merge', '--abort']);
	}
}

/** 领先 / 落后几个提交（远程还没有这个分支时，领先 ＝ 本地提交数） */
async function aheadBehind(git: GitRunner, branch: string): Promise<{ ahead: number; behind: number }> {
	const remote = await git(['rev-parse', '--verify', '--quiet', `origin/${branch}`]);
	if (remote.code !== 0) {
		const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD']);
		if (head.code !== 0) return { ahead: 0, behind: 0 };
		const count = await git(['rev-list', '--count', 'HEAD']);
		return { ahead: Number.parseInt(count.stdout.trim(), 10) || 0, behind: 0 };
	}
	const counts = await git(['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`]);
	const parts = counts.stdout.trim().split(/\s+/);
	return {
		ahead: Number.parseInt(parts[0] ?? '0', 10) || 0,
		behind: Number.parseInt(parts[1] ?? '0', 10) || 0,
	};
}

async function remoteTip(git: GitRunner, branch: string): Promise<string | null> {
	const tip = await git(['rev-parse', '--verify', '--quiet', `origin/${branch}`]);
	return tip.code === 0 ? tip.stdout.trim() : null;
}

function pushOnce(git: GitRunner, branch: string): Promise<GitResult> {
	return git(['push', '--porcelain', '-u', 'origin', `HEAD:refs/heads/${branch}`], true);
}

/**
 * 货架上现在有哪些包（相对路径，正斜杠；给"这一趟拉下来哪些"对账用）。
 *
 * 跳过 `.git`、回收站与符号链接 —— 它们都不该出现在账里。
 */
async function listBundlePaths(dir: string, trashDir?: string | null): Promise<Set<string>> {	const skip = new Set<string>();
	if (trashDir) {
		const rel = path.relative(dir, path.resolve(trashDir));
		if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
			skip.add(rel.split(path.sep).join('/'));
		}
	}
	const out = new Set<string>();

	async function walk(relDir: string): Promise<void> {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(path.join(dir, relDir), { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				if (entry.name === '.git' || skip.has(rel)) continue;
				await walk(rel);
				continue;
			}
			if (entry.isFile() && entry.name.toLowerCase().endsWith('.lsave')) out.add(rel);
		}
	}

	await walk('');
	return out;
}

/**
 * 货架里有没有"还没提交的东西"（只看本地，不联网）。
 *
 * 节拍靠它判断"要不要现在跑一次同步"：本机刚留了包 → 脏 → 下一个 30 秒就提交 + 推送。
 * 用 `status --porcelain`：被 `.git/info/exclude` 挡住的（完整包、回收站）不会让它变脏。
 */
export async function shelfIsDirty(options: ShelfOptions): Promise<boolean> {
	const git = gitRunner(options);
	const status = await git(['status', '--porcelain']);
	return status.code === 0 && status.stdout.trim() !== '';
}

/** 界面上"检查环境"要看的那几项（全部本地命令，不联网、不改任何东西） */
export interface ShelfStatus {
	isRepo: boolean;
	head: string | null;
	remote: string | null;
	branch: string;
	/** 有没有还没提交的包 */
	dirty: boolean;
	ahead: number;
	behind: number;
}

/** 读一眼货架现状（"检查环境"用；不会 fetch、不会 init） */
export async function readShelfStatus(options: ShelfOptions): Promise<ShelfStatus> {
	const dir = path.resolve(options.dir);
	const git = gitRunner(options);
	const repo = await isShelf(dir, { gitPath: options.gitPath, timeoutMs: options.timeoutMs });
	const empty: ShelfStatus = {
		isRepo: false,
		head: null,
		remote: null,
		branch: options.branch,
		dirty: false,
		ahead: 0,
		behind: 0,
	};
	if (!repo) return empty;

	const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD']);
	const remote = await git(['remote', 'get-url', 'origin']);
	const status = await git(['status', '--porcelain']);
	const counts = await aheadBehind(git, options.branch);
	return {
		isRepo: true,
		head: head.code === 0 ? head.stdout.trim() : null,
		remote: remote.code === 0 ? remote.stdout.trim() : null,
		branch: options.branch,
		dirty: status.code === 0 && status.stdout.trim() !== '',
		ahead: counts.ahead,
		behind: counts.behind,
	};
}
