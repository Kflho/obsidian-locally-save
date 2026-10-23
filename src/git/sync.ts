import fs from 'node:fs';
import path from 'node:path';
import { gitFailure } from './run';
import type { GitResult } from './run';
import { gitRunner, prepareShelf, readShelfLayout } from './shelf';
import type { GitRunner, ShelfLayout, ShelfOptions } from './shelf';
import { clearRemovals, readRemovals } from './removals';

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
 *
 * 0.16 起货架可能是**别人仓库里的一个子目录**（比如 `kf-personal-data/locally-save`）。
 * 那种形态下这个模块的纪律更紧（细节见 `shelf.ts`）：
 * - 提交只认货架自己那一段（`git add -A -- .`，cwd 就在货架里），绝不整仓 `add -A`；
 * - **绝不 rebase、绝不 abort** 外层仓库的合并 —— 那里可能有用户的提交和正在做的事；
 *   对不齐就报错停下，让人来处理；
 * - 推的是外层仓库当前的**整个分支**（git 只能推分支），这一点界面上会写明。
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
	/** 货架是外层仓库的子目录（提交/推送只涉及货架那一段，但推的是整个分支） */
	hosted: boolean;
}

/** 把货架和远程对一遍（幂等：没有变化时只花几条本地 git 命令） */
export async function syncShelf(options: ShelfOptions): Promise<GitSyncReport> {
	/**
	 * **同步是五个步骤**，界面按"第几步 / 共几步"显示（用户提的："连接远程这种信息经常闪现，
	 * 改成步骤进度、用数字表示"）。步骤号在这里定，别在界面那边另编一套。
	 */
	const totalSteps = 5;
	const stage = (index: number, label: string): void => {
		options.onStage?.(label, { index, total: totalSteps });
	};
	const prepared = await prepareShelf(options);
	const layout = prepared.layout;
	const dir = path.resolve(options.dir);
	const git = gitRunner(options);
	const hosted = layout.hosted;
	const branch = hosted ? layout.branch : options.branch;

	if (hosted) {
		// 外层仓库里有没做完的 rebase / merge：那是用户的活，插件不碰，也不在这上面动手
		if (await hasStuckState(git, dir)) {
			throw new Error('这个仓库里还有没做完的 rebase / merge：先把它收拾掉再同步（插件不会替你中止）。');
		}
	} else {
		// 上一次卡在半路的 rebase / merge：先收拾掉，否则后面每条命令都会失败
		await clearStuckState(dir, git);
	}

	// 提交本机新写的包（含"撤下"的删除）
	stage(1, '检查本机的包…');
	/**
	 * **本地把包删了 ≠ 我要远程也删掉**（用户报的："包弄乱了我会删，这时候要从远程重新拉最新的，
	 * 现在删了他就不会拉了"）。两道处理：
	 * - 插件**主动撤下**的（`bundle/manage.ts` 的挪进回收站 / 彻底删除、被新包取代的老包）记过记号，
	 *   照旧提交并推到对面（"删包要同步"那条没变）；
	 * - 别的（用户在文件夹里删的）一律当成"我这份副本丢了"：**从 HEAD 恢复回来**，
	 *   于是这一趟只剩拉取，不会把自己删的东西推到远程、也不会因为多出一笔本地提交卡在"不能快进"。
	 */
	const restored = await restoreDroppedBundles(git, dir, layout);
	if (restored.length > 0) stage(1, `本机少掉的 ${restored.length} 个包已拉回来…`);
	const before = await listBundlePaths(dir, options.trashDir);
	stage(2, '提交本机的包…');
	const committed = hosted ? await commitScoped(git, layout) : await commitPending(git);

	// 拉：远程还是空仓库是正常情况（第一次推之前就是）
	stage(3, '连接远程…');
	const fetched = await fetchRemote(git, branch);
	let remoteEmpty = false;
	if (fetched.kind === 'fetched') {
		stage(4, '合并远程的包…');
		await mergeFetched(git, layout);
	} else if (fetched.kind === 'empty') {
		remoteEmpty = true;
	} else {
		throw fetched.error;
	}

	// 这一趟新出现的包 ＝ 拉下来的（给"自动应用"那条路用）
	const after = await listBundlePaths(dir, options.trashDir);
	const pulled = [...after].filter(item => !before.has(item)).sort();

	let counts = await aheadBehind(git, branch);
	let pushed = false;
	if (counts.ahead > 0) {
		stage(5, '推送远程…');
		pushed = await pushWithRetry(options, 1, layout, branch);
		counts = await aheadBehind(git, branch);
	}

	const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD']);
	// 该提交的删除都进仓库了，记号可以清掉（留着会挡住以后"我在文件夹里删了要恢复"的那种）
	clearRemovals(dir);
	return {
		committed,
		pulled,
		pushed,
		remoteEmpty,
		ahead: counts.ahead,
		behind: counts.behind,
		head: head.code === 0 ? head.stdout.trim() : null,
		createdShelf: prepared.created,
		hosted,
	};
}

/**
 * 推送；被另一台机器抢先时**自动再拉一遍、再推一次**（不解析本地化文案，只看结果变没变）。
 *
 * 为什么会撞：两边都在 30 秒的节拍上工作，A 推完 B 才推，B 的远程引用还是旧的 ——
 * 这是**正常情况**，不是错误。真正推不上去（认证 / 权限 / 网络）才会抛。
 */
export async function pushWithRetry(
	options: ShelfOptions,
	retries = 1,
	layout?: ShelfLayout | null,
	branch = options.branch,
): Promise<boolean> {
	const git = gitRunner(options);
	let push = await pushOnce(git, branch);
	if (push.code === 0) return true;

	for (let attempt = 0; attempt < retries; attempt++) {
		const before = await remoteTip(git, branch);
		const fetch = await git(['fetch', 'origin', branch], true);
		if (fetch.code !== 0) break; // 连不上：重试没意义，把原始失败报出去
		await mergeFetched(git, layout ?? null);
		const after = await remoteTip(git, branch);
		if (after === before) break; // 远程没往前走：再推也是一样的结果
		push = await pushOnce(git, branch);
		if (push.code === 0) return true;
	}
	throw gitFailure('把包推到远程', push);
}

/**
 * **本地"丢"了的包，从货架（HEAD）恢复回来**（插件主动撤下的除外，见 `git/removals.ts`）。
 *
 * 判据用 `git diff HEAD --diff-filter=D`：只看"工作区/暂存区里没了、HEAD 里还有"的那些，
 * 路径是**仓库根相对**的，所以 `git checkout` 一律带 `:(top)` 前缀 —— 货架是别人仓库的子目录时，
 * cwd 在子目录里、裸路径会被 git 当成"相对当前目录"，恢复错文件（真踩过）。
 *
 * 只认包与对表文件（`.lsave` / `.lsave-peers/*.json`）：货架里本来就只有这两类，
 * 别的路径就算被删了也不该由插件替用户恢复。
 */
async function restoreDroppedBundles(git: GitRunner, dir: string, layout: ShelfLayout): Promise<string[]> {
	const diff = await git(['diff', '--diff-filter=D', '--name-only', '-z', 'HEAD', '--', '.']);
	if (diff.code !== 0) return [];
	const marked = readRemovals(dir);
	const prefix = layout.hosted && layout.rel !== '' ? `${layout.rel}/` : '';
	const dropped: string[] = [];
	for (const repoRel of diff.stdout.split('\0')) {
		if (repoRel === '') continue;
		const lower = repoRel.toLowerCase();
		const shelfRel = prefix !== '' && repoRel.startsWith(prefix) ? repoRel.slice(prefix.length) : repoRel;
		const managed = lower.endsWith('.lsave') || shelfRel.startsWith('.lsave-peers/');
		if (!managed) continue;
		if (marked.has(shelfRel)) continue; // 我自己撤下的：要提交成删除，别恢复
		dropped.push(repoRel);
	}
	if (dropped.length === 0) return [];
	const checkout = await git(['checkout', '--', ...dropped.map(item => `:(top)${item}`)]);
	if (checkout.code !== 0) return [];
	return dropped;
}

export interface ShelfRefreshReport {
	/** 本地原来比远程多几笔提交（这一趟被丢掉） */
	dropped: number;
	/** 对齐之后的 HEAD */
	head: string | null;
	/** 这一趟新出现的包（文件名） */
	pulled: string[];
}

/**
 * **刷新包：把货架对齐到远程**（用户点的动作，不是自动的）。
 *
 * 用户现场："包弄乱了我会删，这时候要从远程重新拉最新的……现在删了他就不会拉了"。
 * 自动同步遇到"本地有提交 + 远程也有提交"时会停下（绝不能悄悄 rebase 用户的仓库），
 * 所以给它一个**明确的**出口：
 *
 * 1. `fetch` 远程；
 * 2. 子目录形态下先确认"本地多出来的提交只动货架那一段、货架之外没有未提交改动"
 *    —— 不满足就报错，绝不动用户的其它文件；
 * 3. `reset --hard origin/<分支>`（只重置，不合并、不留冲突），清掉"主动撤下"记号；
 * 4. 返回新出现哪些包（界面接着说"新到 N 个包"）。
 */
export async function refreshShelf(options: ShelfOptions): Promise<ShelfRefreshReport> {
	const prepared = await prepareShelf(options);
	const layout = prepared.layout;
	const dir = path.resolve(options.dir);
	const git = gitRunner(options);
	const branch = layout.hosted ? layout.branch : options.branch;
	if (layout.hosted && await hasStuckState(git, dir)) {
		throw new Error('这个仓库里还有没做完的 rebase / merge：先把它收拾掉再刷新（插件不会替你中止）');
	}
	const refreshSteps = 3;
	const stage = (index: number, label: string): void => {
		options.onStage?.(label, { index, total: refreshSteps });
	};
	stage(1, '连接远程…');
	const fetched = await git(['fetch', 'origin', branch], true);
	if (fetched.code !== 0) throw gitFailure('从远程拉包', fetched);
	const remoteRef = await git(['rev-parse', '--verify', '--quiet', `origin/${branch}`]);
	const target = remoteRef.stdout.trim();
	if (remoteRef.code !== 0 || target === '') {
		throw new Error(`远程还没有 ${branch} 分支：没有可拉的东西`);
	}
	const aheadResult = await git(['rev-list', '--count', `origin/${branch}..HEAD`]);
	const dropped = aheadResult.code === 0 ? Number.parseInt(aheadResult.stdout.trim(), 10) || 0 : 0;
	if (layout.hosted) await assertOnlyShelfLocalChanges(git, layout, branch);
	stage(2, '把货架对齐到远程…');
	const before = await listBundlePaths(dir, options.trashDir);
	const reset = await git(['reset', '--hard', `origin/${branch}`]);
	if (reset.code !== 0) throw gitFailure('把货架对齐到远程', reset);
	clearRemovals(dir);
	const after = await listBundlePaths(dir, options.trashDir);
	const pulled = [...after].filter(item => !before.has(item)).sort();
	const headResult = await git(['rev-parse', '--verify', '--quiet', 'HEAD']);
	return {
		dropped,
		head: headResult.code === 0 ? headResult.stdout.trim() : null,
		pulled,
	};
}

/**
 * 子目录货架刷新前的闸门：**只同意丢掉"货架那一段"的本地提交/改动**。
 *
 * 外层是用户的仓库（可能还有别的项目在里面），`reset --hard` 会把整棵工作树对齐远程 ——
 * 只要有一笔提交或一处改动落在货架之外，就不能替用户决定（报错，让他自己处理）。
 */
async function assertOnlyShelfLocalChanges(
	git: GitRunner,
	layout: ShelfLayout,
	branch: string,
): Promise<void> {
	const prefix = layout.rel === '' ? '' : `${layout.rel}/`;
	/** 货架之外的路径（**`-z` 出路径**：带中文的包名默认会被 git 加引号转义，
	 *  拿 `startsWith(prefix)` 直接比会把货架内的包误判成"货架之外" —— 用户就是这么撞上的） */
	const outsideOf = (paths: string[]): string[] =>
		paths.filter(item => item !== '' && (prefix === '' || !item.startsWith(prefix)));
	const commits = await git(['rev-list', `origin/${branch}..HEAD`]);
	if (commits.code === 0) {
		const list = commits.stdout.split('\n').map(item => item.trim()).filter(item => item !== '');
		for (const commit of list) {
			const files = await git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commit]);
			const outside = outsideOf(files.stdout.split('\0'));
			if (outside.length > 0) {
				throw new Error(
					`本地有 ${list.length} 笔提交没推到远程，而且改到了货架之外（${outside[0]}…）：`
					+ '先在仓库里把它们处理掉，再来同步（插件不会替你的仓库做 reset）',
				);
			}
		}
	}
	// 未提交的改动：`git diff HEAD`（不带 `--`，整个仓库；`-z` 不给路径加引号）
	const changed = await git(['diff', 'HEAD', '--name-only', '-z']);
	const dirty = outsideOf(changed.stdout.split('\0'));
	if (dirty.length > 0) {
		throw new Error(
			`仓库里还有货架之外的未提交改动（${dirty[0]}…）：先提交或 stash，再来同步`,
		);
	}
}

/** 本机的包 → 一笔提交（没有变化就跳过，不产生空提交） */
async function commitPending(git: GitRunner): Promise<{ commit: string; files: string[] } | null> {	// `git add -A` 只加得进 `.git/info/exclude` 放行的那几类（见 shelf.ts）：包，以及已跟踪文件的增删
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

/**
 * 子目录形态的提交：**只提交货架自己那一段**。
 *
 * cwd 就在货架里，所以 `-- .` 正好圈住它；`commit` 也带同一个 pathspec，
 * 外层仓库里用户自己暂存的文件不会被顺手提交进去。
 */
async function commitScoped(
	git: GitRunner,
	layout: ShelfLayout,
): Promise<{ commit: string; files: string[] } | null> {
	const add = await git(['add', '-A', '--', '.']);
	if (add.code !== 0) throw gitFailure('把包加进仓库', add);

	const staged = await git(['diff', '--cached', '--quiet', '--', '.']);
	if (staged.code === 0) return null;
	if (staged.code !== 1) throw gitFailure('检查包的变化', staged);

	const names = await git(['diff', '--cached', '--name-only', '-z', '--', '.']);
	if (names.code !== 0) throw gitFailure('列出要提交的包', names);
	const prefix = layout.rel === '' ? '' : `${layout.rel}/`;
	const files = names.stdout
		.split('\0')
		.filter(item => item !== '')
		.map(item => (prefix !== '' && item.startsWith(prefix) ? item.slice(prefix.length) : item));

	const commit = await git(['commit', '-m', `同步包：${files.length} 个`, '--', '.']);
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
 * 独立货架：能快进就快进 → 不行就 rebase（线性、不留合并提交）→ 再不行 merge。
 *
 * **子目录形态（0.16.6 起）**：快进不行时，先过一道闸 ——
 * 本地没推的提交**全都在货架那一段**、而且货架之外没有未提交改动 → 做一次**限定范围的 rebase**；
 * 撞上"两边改了同一个文件"或者动了货架之外的东西，一律**报错不动**（那是用户的仓库，
 * 插件不替他 reset / 合并）。用户的原话："两边同时改，改完就推不过去，一直卡着" ——
 * 货架上两边各写各的包、各写各的对表文件，本来就不该卡死。
 */
async function mergeFetched(git: GitRunner, layout: ShelfLayout | null): Promise<void> {
	const hosted = layout?.hosted === true;
	const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD']);
	if (head.code !== 0) {
		// 本地还没有任何提交
		if (hosted) throw new Error('这个仓库还没有任何提交：先在仓库里提交一次，再来同步');
		const merge = await git(['merge', '--ff-only', 'FETCH_HEAD']);
		if (merge.code === 0) return;
		const reset = await git(['reset', '--hard', 'FETCH_HEAD']);
		if (reset.code !== 0) throw gitFailure('把远程的包落到本地', merge);
		return;
	}

	const fastForward = await git(['merge', '--ff-only', 'FETCH_HEAD']);
	if (fastForward.code === 0) return;

	if (hosted && layout) {
		await alignHostedShelf(git, layout);
		return;
	}

	const rebase = await git(['rebase', 'FETCH_HEAD']);
	if (rebase.code === 0) return;
	await git(['rebase', '--abort']);

	const merge = await git(['merge', '--allow-unrelated-histories', '--no-edit', 'FETCH_HEAD']);
	if (merge.code === 0) return;
	await git(['merge', '--abort']);
	throw new Error(`两边的包合不到一起（文件夹没动）：${(merge.stderr || rebase.stderr).trim()}`);
}

/**
 * 子目录货架的"限定范围对齐"：闸门过了才 rebase，否则把原因原样报出去。
 *
 * 闸门（`assertOnlyShelfLocalChanges`）：本地没推的提交**每一笔都只动货架那一段**，
 * 货架之外没有未提交改动。少一条都说明外层仓库里有用户自己的活，插件不能替他重写历史。
 */
async function alignHostedShelf(git: GitRunner, layout: ShelfLayout): Promise<void> {
	await assertOnlyShelfLocalChanges(git, layout, layout.branch);
	const rebase = await git(['rebase', 'FETCH_HEAD']);
	if (rebase.code === 0) return;
	await git(['rebase', '--abort']);
	throw new Error(
		'远程有新提交，本地货架那一段也有没推的包，而且**同一批文件两边都动了**（rebase 冲突）。\n'
		+ '插件不替你合并冲突：可以先用「刷新包（对齐远程）」丢掉本地货架那几笔提交再拉一遍，'
		+ '或者手工在仓库里处理。',
	);
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

/** 仓库里有没有没做完的 rebase / merge（**只看不动**：子目录形态下绝不替用户中止） */
async function hasStuckState(git: GitRunner, shelfDir: string): Promise<boolean> {
	const result = await git(['rev-parse', '--git-dir']);
	if (result.code !== 0) return false;
	const gitDir = path.resolve(shelfDir, result.stdout.trim());
	return (
		fs.existsSync(path.join(gitDir, 'rebase-merge'))
		|| fs.existsSync(path.join(gitDir, 'rebase-apply'))
		|| fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))
	);
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
async function listBundlePaths(dir: string, trashDir?: string | null): Promise<Set<string>> {
	const skip = new Set<string>();
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
 * 独立货架用整仓 `status`（被 `.git/info/exclude` 挡住的完整包、回收站不会让它变脏）；
 * 子目录形态只看货架自己那一段 —— 外层仓库里用户改了别的文件，不该让插件一直"以为有活干"。
 */
export async function shelfIsDirty(options: ShelfOptions): Promise<boolean> {
	const dir = path.resolve(options.dir);
	const git = gitRunner(options);
	const layout = await readLayout(dir, options);
	const status = layout?.hosted
		? await git(['status', '--porcelain', '--', '.'])
		: await git(['status', '--porcelain']);
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
	/** 货架是外层仓库的子目录（界面上要说清"推的是整个分支"） */
	hosted: boolean;
}

/** 读一眼货架现状（"检查环境"用；不会 fetch、不会 init） */
export async function readShelfStatus(options: ShelfOptions): Promise<ShelfStatus> {
	const dir = path.resolve(options.dir);
	const git = gitRunner(options);
	const layout = await readLayout(dir, options);
	const empty: ShelfStatus = {
		isRepo: false,
		head: null,
		remote: null,
		branch: options.branch,
		dirty: false,
		ahead: 0,
		behind: 0,
		hosted: false,
	};
	if (!layout) return empty;

	const branch = layout.hosted ? layout.branch : options.branch;
	const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD']);
	const remote = await git(['remote', 'get-url', 'origin']);
	const status = layout.hosted
		? await git(['status', '--porcelain', '--', '.'])
		: await git(['status', '--porcelain']);
	const counts = branch === '' ? { ahead: 0, behind: 0 } : await aheadBehind(git, branch);
	return {
		isRepo: true,
		head: head.code === 0 ? head.stdout.trim() : null,
		remote: remote.code === 0 ? remote.stdout.trim() : null,
		branch: branch === '' ? options.branch : branch,
		dirty: status.code === 0 && status.stdout.trim() !== '',
		ahead: counts.ahead,
		behind: counts.behind,
		hosted: layout.hosted,
	};
}

/** `readShelfLayout` 的薄包装：这一层不关心它的失败（读不到就当没接上） */
async function readLayout(
	dir: string,
	options: Pick<ShelfOptions, 'gitPath' | 'timeoutMs'>,
): Promise<ShelfLayout | null> {
	return readShelfLayout(dir, options);
}
