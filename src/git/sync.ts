import { debugEvent } from '../debugLog';
import fs from 'node:fs';
import path from 'node:path';
import { gitFailure } from './run';
import type { GitResult } from './run';
import { gitRunner, prepareShelf, readShelfLayout } from './shelf';
import type { GitRunner, ShelfLayout, ShelfOptions } from './shelf';
import { clearRemovals, noteBundleRemoved, readRemovals } from './removals';
import { moveToTrash } from '../sync/disk';
import { bundleTrashRoot } from '../bundle/manage';
import { BUNDLE_ROOT_DIR } from '../bundle/paths';
import { formatStamp } from '../utils/format';

/**
 * 一次"和远程对一遍"：**提交本机的包 → 拉下别人的包 → 推上去**。
 *
 * 只搬包，不搬库。git 在这里是货车：
 * - 谁用哪一份基准上、这个包能不能收，仍然由包头部说了算（`bundle/` 那套），
 *   这里一行都不碰那些判断；
 * - 合并永远只发生在"新增一个整文件 / 删掉一个整文件"上 ——
 *   包的文件名带随机位、内容写下就不改，所以两台机器同时操作也不会撞车。
 *
 * 顺序不能换：**先提交再拉**。倒过来的话，本地刚写出来、还没提交的包会让 rebase 拒绝开工；
 * 而先提交的那一笔要是推送失败，下一次同步会原样再试（提交本身不联网，失败了也不丢东西）。
 *
 * 0.16 起远程仓库可能是**别人仓库里的一个子目录**（比如 `kf-personal-data/locally-save`）。
 * 那种形态下这个模块的纪律更紧（细节见 `shelf.ts`）：
 * - 提交只认远程仓库自己那一段（`git add -A -- .`，cwd 就在远程仓库里），绝不整仓 `add -A`；
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
	/** 这一趟是不是刚建了远程仓库（界面上要说一句"接上了"） */
	createdShelf: boolean;
	/** 远程仓库是外层仓库的子目录（提交/推送只涉及远程仓库那一段，但推的是整个分支） */
	hosted: boolean;
}

/** 把远程仓库和远程对一遍（幂等：没有变化时只花几条本地 git 命令） */
export async function syncShelf(options: ShelfOptions): Promise<GitSyncReport> {
	/**
	 * **同步是五个步骤**，步骤号在这里定，别在界面那边另编一套。
	 *
	 * 界面按需用这个回调：手动同步现在只演一句「正在同步…」（用户报的"连跳很多状态"），
	 * 「刷新包」那条仍借它显示进度。引擎只报事实，演不演由调用方决定。
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

	/**
	 * **单提交模式**（0.18.3）：远程仓库只用于搬运，不留历史。
	 * 只对独立仓库生效 —— 子目录形态强推会改写外层仓库的分支，把别人的提交一起带走。
	 */
	if (options.singleCommit === true && !hosted) {
		return syncSingleCommit(prepared.created, git, dir, layout, branch, stage);
	}

	// 提交本机新写的包（含"撤下"的删除）
	stage(1, '检查本机的包…');
	/**
	 * **本地把包删了 ≠ 我要远程也删掉**（用户报的："包弄乱了我会删，这时候要从远程重新拉最新的，
	 * 现在删了他就不会拉了"）。两道处理：
	 * - 插件**主动撤下**的（`bundle/manage.ts` 的移到回收站 / 彻底删除、被新包取代的老包）记过记号，
	 *   照旧提交并推到对面（"删包要同步"那条没变）；
	 * - 别的（用户在文件夹里删的）一律当成"我这份副本丢了"：**从 HEAD 恢复回来**，
	 *   于是这一趟只剩拉取，不会把自己删的东西推到远程、也不会因为多出一笔本地提交卡在"不能快进"。
	 */
	const salvaged = await salvageDroppedBundles(git, dir, layout);
	if (salvaged.length > 0) {
		stage(1, `本机少掉的 ${salvaged.length} 个包已备份进回收站，删除会同步出去…`);
	}
	const before = await listBundlePaths(dir, options.trashDir);
	stage(2, '提交本机的包…');
	const committed = hosted ? await commitScoped(git, layout) : await commitPending(git);
	/**
	 * 记账的起点：**提交之后**的 HEAD。
	 *
	 * 为什么取在提交之后：本机刚写进包目录的东西（导出的包、回收站备份、"应用前先把改动存下来"
	 * 那一份）不算法"从远程拉到"；把它们算进去，界面上就会说一句
	 * 「已从 Git 远程接收 1 个同步包」—— 而远程那边其实没有本机的包（用户报的现场：
	 * 一台"没有更新包"，另一台却一直提示"收到你们的更新包"）。
	 */
	const baseHead = (await git(['rev-parse', '--verify', '--quiet', 'HEAD'])).stdout.trim() || null;

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

	// 这一趟**从远程真正落下来**的包 ＝ 合并把哪几个 .lsave 加进了仓库（见 `pulledBundles`）
	const pulled = await pulledBundles(git, baseHead, layout, dir, before, options.trashDir);

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
		const fetch = await git(['fetch', '--prune', 'origin', branch], true);
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
 * **本地少掉的包 ＝ 撤下它**（0.18.2 改的语义，用户拍板：
 * "正确逻辑应该删掉以后远程和其他终端都不再出现"）。
 *
 * 以前这里反过来：磁盘上没了、HEAD 里还有的一律 `git checkout` 恢复回来，
 * 理由是"包弄乱了我会删，这时候要从远程重新拉最新的"。代价是**删不掉的包**：
 * 在资源管理器里删一份，下一轮 30 秒同步就把它变回来，远程和别的机器上还在，
 * 用户看到的就是"我删了它又出现了"（真机 2026-11-04，`320 → 650` 那份）。
 *
 * 现在分成两件事：
 * 1. **先把 HEAD 里那份取回来、移到本机回收站**（`bundles-trash/<时间戳>/`）——
 *    误删也可以恢复，回收站不进仓库、不占远程仓库；
 * 2. **记一笔"撤下"记号**，这一轮就会把删除提交并推走：远程和别的机器一起没掉。
 *
 * 唯一例外：`.lsave-peers/*.json` 是各台机器的对表文件，不是包 —— 少一个只说明
 * "我这份对表丢了"，照旧从 HEAD 恢复（它没有内容，恢复了也只会被对方的下一次上报盖掉）。
 *
 * 想重新拿回远程上的包，走「刷新包（对齐远程）」（`refreshShelf` 的 `reset --hard`）——
 * 那是用户明确点的动作，不再由每 30 秒的节拍替他决定。
 */
async function salvageDroppedBundles(git: GitRunner, dir: string, layout: ShelfLayout): Promise<string[]> {
	const diff = await git(['diff', '--diff-filter=D', '--name-only', '-z', 'HEAD', '--', '.']);
	if (diff.code !== 0) return [];
	const marked = readRemovals(dir);
	const prefix = layout.hosted && layout.rel !== '' ? `${layout.rel}/` : '';
	const dropped: string[] = [];
	const peers: string[] = [];
	for (const repoRel of diff.stdout.split('\0')) {
		if (repoRel === '') continue;
		const lower = repoRel.toLowerCase();
		const shelfRel = prefix !== '' && repoRel.startsWith(prefix) ? repoRel.slice(prefix.length) : repoRel;
		if (lower.endsWith('.lsave')) {
			if (marked.has(shelfRel)) continue; // 已经记过：这一轮就是来提交删除的
			dropped.push(repoRel);
			continue;
		}
		if (shelfRel.startsWith('.lsave-peers/')) peers.push(repoRel);
	}
	// 对表文件：照旧从 HEAD 恢复（不是包，没有内容可留）
	if (peers.length > 0) await git(['checkout', '--', ...peers.map(item => `:(top)${item}`)]);
	if (dropped.length === 0) return [];

	const stamp = formatStamp(Date.now());
	const saved: string[] = [];
	for (const repoRel of dropped) {
		const shelfRel = prefix !== '' && repoRel.startsWith(prefix) ? repoRel.slice(prefix.length) : repoRel;
		const abs = path.join(dir, ...shelfRel.split('/'));
		try {
			// 先把 HEAD 那一版放回磁盘（`git show` 走的是文本通道，几百 MB 的包不能用它）
			const checkout = await git(['checkout', '--', `:(top)${repoRel}`]);
			if (checkout.code !== 0) continue;
			await moveToTrash(abs, bundleTrashRoot(dir), path.basename(abs), stamp);
			noteBundleRemoved(dir, [abs]);
			saved.push(shelfRel);
		} catch {
			// 备份失败就**别删**：宁可这一份留着，也不能悄悄丢掉用户的东西
			await git(['checkout', '--', `:(top)${repoRel}`]).catch(() => undefined);
		}
	}
	return saved;
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
 * **刷新包：把远程仓库对齐到远程**（用户点的动作，不是自动的）。
 *
 * 用户现场："包弄乱了我会删，这时候要从远程重新拉最新的……现在删了他就不会拉了"。
 * 自动同步遇到"本地有提交 + 远程也有提交"时会停下（绝不能悄悄 rebase 用户的仓库），
 * 所以给它一个**明确的**出口：
 *
 * 1. `fetch` 远程；
 * 2. 子目录形态下先确认"本地多出来的提交只动远程仓库那一段、远程仓库之外没有未提交改动"
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
	if (layout.hosted) {
		await assertCleanOutsideShelf(git, layout);
		await assertOnlyShelfCommits(git, layout, branch);
	}
	stage(2, '把远程仓库对齐到远程…');
	const before = await listBundlePaths(dir, options.trashDir);
	const reset = await git(['reset', '--hard', `origin/${branch}`]);
	if (reset.code !== 0) throw gitFailure('把远程仓库对齐到远程', reset);
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
 * 子目录远程仓库刷新前的闸门：**只同意丢掉"远程仓库那一段"的本地提交/改动**。
 *
 * 外层是用户的仓库（可能还有别的项目在里面），`reset --hard` 会把整棵工作树对齐远程 ——
 * 只要有一笔提交或一处改动落在远程仓库之外，就不能替用户决定（报错，让他自己处理）。
 */
/**
 * 闸门之一：**远程仓库之外不许有未提交的改动**（合并 / rebase 都要一棵能动的树）。
 *
 * 只看工作区与暂存区（`git diff HEAD`），**不看已提交的历史** —— 已提交的东西 rebase 会接着演，
 * 冲突就 abort，用户不会丢活；把它也算成"越界"会让正常分叉永远同步不过去（0.16.8 改的）。
 * `-z` 出原样路径：带中文的包名默认会被 git 加引号转义，拿 `startsWith` 比会误判（0.16.6 踩过）。
 */
async function assertCleanOutsideShelf(git: GitRunner, layout: ShelfLayout): Promise<void> {
	const prefix = layout.rel === '' ? '' : `${layout.rel}/`;
	const changed = await git(['diff', 'HEAD', '--name-only', '-z']);
	const dirty = changed.stdout
		.split('\0')
		.filter(item => item !== '')
		.filter(item => prefix === '' || !item.startsWith(prefix));
	if (dirty.length > 0) {
		throw new Error(
			`仓库里还有远程仓库之外的未提交改动（${dirty[0]}…）：先提交或 stash，再来同步`,
		);
	}
}

/**
 * 闸门之二（**只有「刷新包」用**）：本地没推的提交**每一笔都只动远程仓库那一段**。
 *
 * 刷新是 `reset --hard origin/<分支>`：它会**丢掉**那些提交，所以必须确认丢的都是远程仓库上的包；
 * 动过远程仓库之外的一律拒绝（那些活不能替用户丢）。自动 rebase 不走这道闸 —— 它保留提交。
 */
async function assertOnlyShelfCommits(
	git: GitRunner,
	layout: ShelfLayout,
	branch: string,
): Promise<void> {
	const prefix = layout.rel === '' ? '' : `${layout.rel}/`;
	const commits = await git(['rev-list', `origin/${branch}..HEAD`]);
	if (commits.code !== 0) return;
	const list = commits.stdout.split('\n').map(item => item.trim()).filter(item => item !== '');
	for (const commit of list) {
		const files = await git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commit]);
		const outside = files.stdout
			.split('\0')
			.filter(item => item !== '')
			.filter(item => prefix === '' || !item.startsWith(prefix));
		if (outside.length > 0) {
			throw new Error(
				`本地有 ${list.length} 笔提交没推到远程，而且改到了远程仓库之外（${outside[0]}…）：`
				+ '先在仓库里把它们处理掉，再来刷新（插件不会替你的仓库做 reset）',
			);
		}
	}
}

/** 本机的包 → 一笔提交（没有变化就跳过，不产生空提交） */
async function commitPending(git: GitRunner): Promise<{ commit: string; files: string[] } | null> {	// `git add -A` 只加得进 `.git/info/exclude` 放行的那几类（见 shelf.ts）：包，以及已跟踪文件的增删
	// （完整备份与回收站都被挡在外面 —— 完整备份不推，回收站不进仓库）
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
 * 子目录形态的提交：**只提交远程仓库自己那一段**。
 *
 * cwd 就在远程仓库里，所以 `-- .` 正好圈住它；`commit` 也带同一个 pathspec，
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
 * 把 `FETCH_HEAD` 变成本地。
 *
 * 独立远程仓库：能快进就快进 → 不行就 rebase（线性、不留合并提交）→ 再不行 merge。
 *
 * **子目录形态（0.16.6 起）**：快进不行时，先过一道闸 ——
 * 本地没推的提交**全都在远程仓库那一段**、而且远程仓库之外没有未提交改动 → 做一次**限定范围的 rebase**；
 * 撞上"两边改了同一个文件"或者动了远程仓库之外的东西，一律**报错不动**（那是用户的仓库，
 * 插件不替他 reset / 合并）。用户的原话："两边同时改，改完就推不过去，一直卡着" ——
 * 远程仓库上两边各写各的包、各写各的对表文件，本来就不该卡死。
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
		if (reset.code !== 0) throw gitFailure('把远程的包变成本地', merge);
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
 * 子目录远程仓库的"限定范围对齐"：闸门过了才 rebase，否则把原因原样报出去。
 *
 * 闸门（`assertOnlyShelfLocalChanges`）：本地没推的提交**每一笔都只动远程仓库那一段**，
 * 远程仓库之外没有未提交改动。少一条都说明外层仓库里有用户自己的活，插件不能替他重写历史。
 */
async function alignHostedShelf(git: GitRunner, layout: ShelfLayout): Promise<void> {
	// 只要求"远程仓库之外没有**未提交**的改动"：rebase 要一棵能动的树。
	// **已提交**的改动（哪怕在远程仓库之外）不拦 —— rebase 会把它们接着演下去，冲突就 abort，
	// 用户的活不会丢。0.16.8 之前这条收得太窄，把"两台机器各改各的其它文件"也判成越界，
	// 结果正常分叉永远同步不过去（对面报的就是这个）。
	await assertCleanOutsideShelf(git, layout);
	// 快进失败＝两边各自提交过（典型：两边都删过同一个过时的包）。留一条记录，
	// 下次排查"同步失败"时能直接看到是分叉、而不是网络。
	debugEvent('git.hosted-diverged', {});
	const rebase = await git(['rebase', 'FETCH_HEAD']);
	if (rebase.code === 0) return;
	await git(['rebase', '--abort']);
	throw new Error(
		'远程有新提交，本地也有没推的提交，而且**同一批文件两边都动了**（rebase 冲突）。\n'
		+ '插件不替你合并冲突：可以先用「刷新包（对齐远程）」丢掉本地远程仓库那几笔提交再拉一遍，'
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
	// 单提交模式下两个无父提交没有共同祖先，rev-list 会把两边各算 1；
	// 内容一样就直接报 0/0，别让界面写「领先 1、落后 1」。
	const mineTree = await git(['rev-parse', '--verify', '--quiet', 'HEAD^{tree}']);
	const theirTree = await git(['rev-parse', '--verify', '--quiet', `origin/${branch}^{tree}`]);
	if (mineTree.code === 0 && theirTree.code === 0
		&& mineTree.stdout.trim() === theirTree.stdout.trim()) {
		return { ahead: 0, behind: 0 };
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
 * 这一趟**从远程真正落下来**的包（同步包文件夹里的相对路径）。
 *
 * 判据是 git 自己的差异（`baseHead..HEAD` 里新增的 `.lsave`），不是"磁盘上前后多了哪些文件"：
 * - 磁盘快照会把**本机在同步窗口里自己写下的东西**算成"从远程收到" —— 导出的包、
 *   回收站备份、`full/` 里刚写的完整备份（它根本不走 git）；读目录偶发失败时更糟：
 *   `before` 少看见几个，`after` 全算成新拉下来的；
 * - 界面上那句「已从 Git 远程接收 N 个同步包」就是拿这个数报的。报错了，另一台会以为
 *   自己发出了包（用户报的"一边没有更新包、另一边一直提示收到"）。
 *
 * 本机还没有提交（第一次同步）或读不出 HEAD 时，仍按磁盘前后比对：那种情况下没有 git
 * 记录可查「哪些是远程带来的」，只能全部算作新来的。
 */
async function pulledBundles(
	git: GitRunner,
	baseHead: string | null,
	layout: ShelfLayout,
	dir: string,
	before: Set<string>,
	trashDir?: string | null,
): Promise<string[]> {
	const tip = await git(['rev-parse', '--verify', '--quiet', 'HEAD']);
	const head = tip.code === 0 ? tip.stdout.trim() : '';
	if (baseHead !== null && head !== '') {
		if (head === baseHead) return [];
		const diff = await git(['diff', '--name-only', '-z', '--diff-filter=A', '--no-renames', `${baseHead}..${head}`]);
		if (diff.code === 0) {
			const prefix = layout.hosted && layout.rel !== '' ? `${layout.rel}/` : '';
			const out: string[] = [];
			for (const item of diff.stdout.split('\0')) {
				if (item === '') continue;
				if (prefix !== '' && !item.startsWith(prefix)) continue;
				const rel = prefix === '' ? item : item.slice(prefix.length);
				if (!rel.toLowerCase().endsWith('.lsave')) continue;
				if (before.has(rel)) continue;
				out.push(rel);
			}
			return out.sort();
		}
	}
	const after = await listBundlePaths(dir, trashDir);
	return [...after].filter(item => !before.has(item)).sort();
}

/**
 * **单提交模式**的一次同步（`ShelfOptions.singleCommit`，只给独立仓库用）。
 *
 * 远程仓库只用于搬运，历史没有用途：每次同步生成**一个无父提交**再强推，本地也只留一个。
 * 拉取不合并也不 rebase —— 按 tree 差异把远程的文件取回工作区（远程删掉的本地也删），
 * 所以两边永远不会"合不到一起"。
 */
async function syncSingleCommit(
	preparedCreated: boolean,
	git: GitRunner,
	dir: string,
	layout: ShelfLayout,
	branch: string,
	stage: (index: number, label: string) => void,
): Promise<GitSyncReport> {
	stage(1, '检查本机的包…');
	const salvaged = await salvageDroppedBundles(git, dir, layout);
	if (salvaged.length > 0) {
		stage(1, `本机少掉的 ${salvaged.length} 个包已备份进回收站，删除会同步出去…`);
	}

	/** 本机"上次同步后的样子"：只有按它才说得清远程改了什么 */
	const prevTree = await treeOf(git, 'HEAD');
	await stageShelf(git);

	stage(3, '连接远程…');
	const fetched = await fetchRemote(git, branch);
	if (fetched.kind === 'failed') throw fetched.error;
	const remoteEmpty = fetched.kind === 'empty';

	let pulled: string[] = [];
	const remoteTree = remoteEmpty ? '' : await treeOf(git, 'FETCH_HEAD');
	if (remoteTree !== '' && remoteTree !== prevTree) {
		stage(4, '取回远程的包…');
		pulled = await adoptTree(git, dir, prevTree, remoteTree);
		await stageShelf(git);
	}

	stage(5, '推送远程…');
	const published = await publishSingle(git, dir, branch, remoteTree, prevTree, remoteEmpty);
	// 本机也要收拾：每次同步都会留下一个不再引用的旧提交（reflog 还挂着它）
	await pruneLocal(git);
	const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD']);
	return {
		committed: published.commit ? { commit: published.commit, files: [] } : null,
		pulled,
		pushed: published.pushed,
		remoteEmpty,
		ahead: 0,
		behind: 0,
		head: head.code === 0 ? head.stdout.trim() : null,
		createdShelf: preparedCreated,
		hosted: false,
	};
}

/** 上一次在本机回收旧对象的时间（单提交模式每次同步都会留下一个不再引用的旧提交） */
let lastPruneAt = 0;

/**
 * 本机回收：过期 reflog 再 `gc --prune=now`。
 *
 * 单提交模式只压**远端**不够 —— `update-ref` 每次都会往 reflog 里记一条，
 * 旧提交因此仍然可达，`.git` 会随导出次数变大。半小时一次就够（一次 gc 很快），
 * 不必每拍都跑。
 */
async function pruneLocal(git: GitRunner): Promise<void> {
	const now = Date.now();
	if (now - lastPruneAt < 30 * 60_000) return;
	lastPruneAt = now;
	await git(['reflog', 'expire', '--expire=now', '--all']);
	await git(['gc', '--prune=now', '--quiet']);
}

/** 某个引用的 tree（引用不存在时给空串） */
async function treeOf(git: GitRunner, ref: string): Promise<string> {
	const result = await git(['rev-parse', '--verify', '--quiet', `${ref}^{tree}`]);
	return result.code === 0 ? result.stdout.trim() : '';
}

/** 把同步包文件夹的工作区整个暂存（`.git/info/exclude` 已经把非包文件挡住） */
async function stageShelf(git: GitRunner): Promise<void> {
	const add = await git(['add', '-A', '--', '.']);
	if (add.code !== 0) throw gitFailure('把包加进仓库', add);
}

/**
 * 把远程那棵树取回工作区：远程新增/改过的覆盖本地，远程删掉的本地也删。
 *
 * 为什么不用 merge：两个单提交没有共同祖先，合并必然冲突；而远程仓库里只有整个文件，
 * 按路径覆盖就是正确语义。返回"远程新增了哪些"（界面要报"收到几个包"）。
 */
async function adoptTree(
	git: GitRunner,
	dir: string,
	fromTree: string,
	toTree: string,
): Promise<string[]> {
	const split = (out: string): string[] => out.split('\0').filter(item => item !== '');
	let added: string[];
	let removed: string[] = [];
	if (fromTree === '') {
		// 本机还没有任何提交：远程那棵树里的全是"新增"
		const all = await git(['ls-tree', '-r', '--name-only', '-z', toTree]);
		added = split(all.stdout);
	} else {
		const range = ['--no-renames', fromTree, toTree];
		const adds = await git(['diff-tree', '-r', '--name-only', '-z', '--diff-filter=AM', ...range]);
		const dels = await git(['diff-tree', '-r', '--name-only', '-z', '--diff-filter=D', ...range]);
		added = split(adds.stdout);
		removed = split(dels.stdout);
	}
	for (let index = 0; index < added.length; index += 40) {
		const batch = added.slice(index, index + 40);
		const checkout = await git(['checkout', toTree, '--', ...batch]);
		if (checkout.code !== 0) throw gitFailure('取回远程的包', checkout);
	}
	/**
	 * 远程撤下的包**先移进回收站**（AGENTS 第 3 条：删除前先备份、宁可留着）。
	 *
	 * 远端被重建过、或者换了仓库时，这台机器没有重新 clone 的话包会被静默清掉，
	 * 而那份包可能还没应用。回收站位置与平时一致：`<同步包文件夹>/.lsave/bundles-trash/`。
	 */
	if (removed.length > 0) {
		const trashRoot = bundleTrashRoot(dir);
		const stamp = formatStamp(Date.now());
		for (const rel of removed) {
			const abs = path.join(dir, ...rel.split('/'));
			if (!fs.existsSync(abs)) continue;
			if (trashRoot !== '') {
				await moveToTrash(abs, trashRoot, rel, stamp);
				continue;
			}
			fs.rmSync(abs, { force: true });
		}
	}
	// 报数：远程撤下了哪几份（界面不显示，排障时从 debug.log 能查到）
	if (removed.length > 0) debugEvent('git.deleted', { files: removed });
	return added;
}

/**
 * 把当前索引压成一个**无父提交**并强推（单提交模式）。
 *
 * `--force-with-lease`：远程在我们 fetch 之后又被人推过就让这次失败，绝不覆盖别人的包；
 * 失败后取回远程、再压一次（最多两趟）。
 */
async function publishSingle(
	git: GitRunner,
	dir: string,
	branch: string,
	remoteTree: string,
	prevTree: string,
	remoteEmpty: boolean,
): Promise<{ commit: string | null; pushed: boolean }> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const tree = (await git(['write-tree'])).stdout.trim();
		if (tree === '') throw new Error('没有可提交的包');
		/**
		 * **内容和本机那个提交一样：什么都不做**（对面实测：无变化时仍会换一个提交，
		 * 状态栏就显示成「本地已提交、还没推」）。返回 null，让调用方报「没有变化」。
		 */
		if (tree === (await treeOf(git, 'HEAD'))) return { commit: null, pushed: false };
		const files = await git(['ls-tree', '-r', '--name-only', '-z', tree]);
		const count = files.stdout.split('\0').filter(item => item !== '').length;
		const commit = await git(['commit-tree', tree, '-m', `同步包：${count} 个`]);
		if (commit.code !== 0) throw gitFailure('记录这次的包', commit);
		const sha = commit.stdout.trim();
		const update = await git(['update-ref', `refs/heads/${branch}`, sha]);
		if (update.code !== 0) throw gitFailure('更新本机分支', update);
		if (tree === remoteTree) {
			// 内容和远程一样：本地指到同一个根就行，不必推
			return { commit: sha, pushed: false };
		}
		// 远端是空的（新建 / 删掉重建）：显式期望"这个引用还不存在"，
		// 否则本地残留的 origin/<branch> 会让 --force-with-lease 报 stale info。
		const lease = remoteEmpty
			? `--force-with-lease=refs/heads/${branch}:`
			: '--force-with-lease';
		const push = await git(['push', '--porcelain', lease, '-u', 'origin', `HEAD:refs/heads/${branch}`], true);
		if (push.code === 0) return { commit: sha, pushed: true };
		if (attempt === 1) throw gitFailure('把包推到远程', push);
		// 被别的机器抢先：取回远程那份，再压一次
		const fetched = await fetchRemote(git, branch);
		if (fetched.kind !== 'fetched') throw gitFailure('把包推到远程', push);
		const theirs = await treeOf(git, 'FETCH_HEAD');
		const base = treeOfPrev(prevTree, tree);
		await adoptTree(git, dir, base, theirs);
		await stageShelf(git);
	}
	throw new Error('把包推到远程失败');
}

/** 远程那份要按"我们上一次的样子"对齐：优先用本机旧 HEAD，没有就用这次建的树 */
function treeOfPrev(prevTree: string, fallback: string): string {
	return prevTree !== '' ? prevTree : fallback;
}

/**
 * 远程仓库上现在有哪些包（相对路径，正斜杠；给"这一趟拉下来哪些"对账用）。
 *
 * 跳过 `.git`、回收站、本插件自己的 `.lsave` 目录与符号链接 —— 它们都不该出现在账里。
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
				// 本插件自己的目录（回收站 / 本机保管的包）不算"远程仓库上的包"
				if (entry.name === '.git' || entry.name === BUNDLE_ROOT_DIR || skip.has(rel)) continue;
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
 * 远程仓库里有没有"还没提交的东西"（只看本地，不联网）。
 *
 * 节拍靠它判断"要不要现在跑一次同步"：本机刚留了包 → 脏 → 下一个 30 秒就提交 + 推送。
 * 独立远程仓库用整仓 `status`（被 `.git/info/exclude` 挡住的完整备份、回收站不会让它变脏）；
 * 子目录形态只看远程仓库自己那一段 —— 外层仓库里用户改了别的文件，不该让插件一直"以为有活干"。
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
	/** 远程仓库是外层仓库的子目录（界面上要说清"推的是整个分支"） */
	hosted: boolean;
}

/** 读一眼远程仓库现状（"检查环境"用；不会 fetch、不会 init） */
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