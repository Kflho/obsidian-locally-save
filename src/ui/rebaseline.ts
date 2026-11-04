import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type LocallySavePlugin from '../main';
import { listFullAnchorsSync } from '../bundle/anchor';
import { exportBundle } from '../bundle/export';
import { bundleBaseDir } from '../bundle/paths';
import {
	describeRebaselineTask,
	exportRebaselineDiffs,
	peerLabel,
	planBaselineCopy,
	planRebaselineDiffs,
} from '../bundle/rebaseline';
import type { RebaselineDiffPlan } from '../bundle/rebaseline';
import { planStaleFullBundles, trashStaleFullBundles, planBaselineHealth } from '../bundle/stale';
import type { StaleFullPlan, BaselineHealth } from '../bundle/stale';
import { trashBundles } from '../bundle/manage';
import { readPeers } from '../git/peers';
import { loadState, saveState } from '../sync/state';
import { scanTree } from '../sync/disk';
import { VAULT_TRASH_DIR, excludePatterns } from '../sync/vault';
import { formatBytes } from '../utils/format';
import { syncGitNow } from './git';

/**
 * 换基准的两件收尾事（界面层）：**导出差量包** 与 **清理没人站的旧完整副本**。
 *
 * 为什么要有第一件：完整副本按决定不进 git（几百 MB），而更新包只跟"同一份完整副本"算。
 * 我导了一份新的完整副本之后，还停在旧那台上的电脑收到的更新包会被判"基准对不上"，
 * 两边就卡住 —— 除非有一份**差量包**（两端都是完整副本，只装两者之间的差异）。
 * 它收下应用完就换到新基准上，手里不需要有新的完整副本。
 *
 * 为什么第二件必须手动：完整副本是**还原点**，引擎里明文规定"完整包一律不碰"。
 * 只有确认"没有任何一台电脑还以它为准"（货架上的 `peer.baselineHash`）时，
 * 才把旧的移到回收站，跟包列表里那几行同一个规矩。
 *
 * 界面文案规矩：只写当前状态与要用户做什么，原理留在 README / help-modal。
 */

/** 组合好的参数（命令、按钮、导出完整副本之后那一下都用同一套） */
function exportOptionsFor(plugin: LocallySavePlugin, dir: string) {
	return {
		settings: plugin.settings,
		log: plugin.log,
		vaultRoot: plugin.vaultRoot(),
		vaultName: plugin.vaultName(),
		stateFile: plugin.stateFile(),
		mode: 'changes' as const,
		outDir: dir,
		configDir: plugin.configDir(),
	};
}

/**
 * 算一遍计划：每台电脑停在哪一份完整副本上、缺哪一份差量包。
 *
 * 没有别的电脑上报过状态时返回空列表 —— 那种情况本来就把完整副本整份拷过去，
 * 不做一份谁也用不上的包。
 */
async function planFor(plugin: LocallySavePlugin, dir: string): Promise<RebaselineDiffPlan> {
	const state = await loadState(plugin.stateFile());
	return planRebaselineDiffs(dir, state, readPeers(dir, state.copyId));
}

/**
 * 按计划导出差量包并推货架，返回**一句给人看的话**（null ＝ 没导出任何东西）。
 *
 * 供命令 / 按钮与"导出完整副本之后顺手来一下"共用：后者不该自己再拼一套判断。
 */
export async function runRebaselineDiffs(
	plugin: LocallySavePlugin,
	dir: string,
): Promise<string | null> {
	if (!dir) return null;
	const plan = await planFor(plugin, dir);
	if (plan.problem || plan.ready === 0) return null;
	const run = await exportRebaselineDiffs(exportOptionsFor(plugin, dir), plan);
	if (run.exported.length === 0) {
		return run.failed.length > 0
			? `差量包没导成：${run.failed.map(item => `${item.host}（${item.error}）`).join('、')}`
			: null;
	}
	const detail = run.exported
		.map(item => `第 ${item.fromGeneration ?? '?'} → ${item.toGeneration} 代 · ${formatBytes(item.payloadBytes)}`)
		.join('、');
	let pushed = false;
	if (plugin.settings.gitEnabled) pushed = await syncGitNow(plugin, { quiet: true });
	const parts = [`已导出 ${run.exported.length} 份差量包（${detail}）`];
	if (run.failed.length > 0) parts.push(`另有 ${run.failed.length} 份没导成`);
	parts.push(pushed ? '已推到货架' : (plugin.settings.gitEnabled ? '推货架失败，下次同步会再推' : 'git 没开：自己把包拷过去'));
	return parts.join('；');
}

/**
 * 命令 / 管理窗口的入口：**先把账摊开再动手**（列出会导哪几份、做不了的那几台为什么）。
 */
export async function rebaselineDiffAction(
	app: App,
	plugin: LocallySavePlugin,
	dir: string,
	onChanged?: () => void | Promise<void>,
): Promise<void> {
	if (!dir) {
		new Notice('先去设置里填「同步包文件夹」');
		return;
	}
	const plan = await planFor(plugin, dir);
	if (plan.problem) {
		new Notice(`导不出差量包：${plan.problem}`, 9000);
		return;
	}
	const mine = plan.mine?.generation ?? null;
	const lines = plan.tasks.map(task => describeRebaselineTask(task, mine));
	if (plan.tasks.length === 0) {
		new Notice('货架上还没有别的电脑上报过状态：分不清谁停在旧的完整副本上。'
			+ '先在另一台机器上同步一次，或直接把完整副本整份拷过去。', 9000);
		return;
	}
	if (plan.ready === 0) {
		new Notice(`没有要导的差量包 —— ${lines.join('；')}`, 12000);
		return;
	}
	new RebaselineDiffModal(app, lines, async () => {
		const summary = await runRebaselineDiffs(plugin, dir);
		new Notice(summary ?? '差量包没导成（原因见日志）', 9000);
		await onChanged?.();
	}).open();
}

/**
 * **清理没人站的旧完整副本**：先算、再摊开、确认了才移到回收站。
 *
 * 判断不了一律不动（没开 git / 还没人上报 / 我还没有基准）：那种时候分不清哪一份还有人用，
 * 而完整副本是唯一能"回到那一天"的东西。
 */
export async function cleanupStaleFullBundlesAction(
	app: App,
	plugin: LocallySavePlugin,
	dir: string,
	onChanged?: () => void | Promise<void>,
): Promise<void> {
	if (!dir) {
		new Notice('先去设置里填「同步包文件夹」');
		return;
	}
	const state = await loadState(plugin.stateFile());
	let plan: StaleFullPlan;
	try {
		plan = await planStaleFullBundles(dir, state, readPeers(dir, state.copyId));
	} catch (error) {
		new Notice(`算不出来：${error instanceof Error ? error.message : String(error)}`, 9000);
		return;
	}
	if (plan.blocked) {
		new Notice(`先不清理：${plan.blocked}`, 12000);
		return;
	}
	if (plan.trash.length === 0) {
		const why = plan.kept.map(item => item.why);
		new Notice(why.length > 0
			? `没有能清的旧完整副本：${why.join('；')}`
			: '没有能清的旧完整副本（除了我现在站的这份，这里没别的了）', 12000);
		return;
	}
	const lines = plan.trash.map(item =>
		`第 ${item.generation} 代 · ${formatBytes(item.size)} · ${item.name}`);
	const kept = plan.kept.map(item => `${item.why}：${item.name}`);
	const peerLines = plan.peers.map(item =>
		`${item.label}：停在 ${item.baselineGeneration !== null ? `第 ${item.baselineGeneration} 代` : (item.baselineHash ?? '未记')}`);
	new StaleFullModal(app, {
		lines,
		kept,
		peerLines,
		total: plan.bytes,
		onConfirm: async () => {
			const outcome = await trashStaleFullBundles(dir, plan);
			const parts = [`已移到回收站 ${outcome.moved.length} 份完整副本（${formatBytes(plan.bytes)}）`];
			if (outcome.failed.length > 0) parts.push(`${outcome.failed.length} 份没移成`);
			parts.push('能捞回来；要真腾空间再点「清空回收站」');
			new Notice(parts.join('；'), 12000);
			// 别在这里「刷新包」：那是 reset --hard origin，刚移走的会回来。改成把这次删除推出去
			if (plugin.settings.gitEnabled) await syncGitNow(plugin, { quiet: true });
			await onChanged?.();
		},
	}).open();
}

/** 导出前的确认框：把"会导哪几份、哪几台不用导（为什么）"摊开 */
class RebaselineDiffModal extends Modal {
	private lines: string[];
	private onConfirm: () => Promise<void>;

	constructor(app: App, lines: string[], onConfirm: () => Promise<void>) {
		super(app);
		this.lines = lines;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('locally-save-modal');
		contentEl.createEl('h2', { text: '导出换基准的差量包' });
		contentEl.createEl('p', {
			text: '完整副本不进 git；差量包只装两份完整副本之间的差异，对方应用完就变成你现在这份上。',
			cls: 'locally-save-hint',
		});
		const facts = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		for (const line of this.lines) facts.createEl('li', { text: line });
		contentEl.createEl('p', {
			text: '包写在 changes/ 里，接上 git 货架时会跟着推上去。',
			cls: 'locally-save-hint',
		});
		new Setting(contentEl)
			.addButton(button => button.setButtonText('取消').onClick(() => this.close()))
			.addButton(button => {
				button.setButtonText('导出').setCta();
				button.onClick(() => {
					this.close();
					void this.onConfirm();
				});
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** 清理前的确认框：哪几份、多大、谁已经不在上面了、留着的那几份为什么留着 */
class StaleFullModal extends Modal {
	private options: {
		lines: string[];
		kept: string[];
		peerLines: string[];
		total: number;
		onConfirm: () => Promise<void>;
	};

	constructor(app: App, options: StaleFullModal['options']) {
		super(app);
		this.options = options;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('locally-save-modal');
		contentEl.createEl('h2', { text: '清理没人站的旧完整副本' });
		contentEl.createEl('p', {
			text: `这 ${this.options.lines.length} 份一共 ${formatBytes(this.options.total)}，`
				+ '没有任何一台电脑还停在它们上面。',
			cls: 'locally-save-hint',
		});
		const facts = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		for (const line of this.options.lines) facts.createEl('li', { text: line });
		if (this.options.peerLines.length > 0) {
			contentEl.createEl('p', {
				text: `各台电脑现在用哪：${this.options.peerLines.join('；')}`,
				cls: 'locally-save-hint',
			});
		}
		if (this.options.kept.length > 0) {
			contentEl.createEl('p', {
				text: `留着没动：${this.options.kept.join('；')}`,
				cls: 'locally-save-hint',
			});
		}
		contentEl.createEl('p', {
			text: '会移到回收站（能捞回来）；要真腾出空间，再点「清空回收站」。',
			cls: 'locally-save-hint',
		});
		new Setting(contentEl)
			.addButton(button => button.setButtonText('取消').onClick(() => this.close()))
			.addButton(button => {
				button.setButtonText('移到回收站').setCta();
				button.onClick(() => {
					this.close();
					void this.options.onConfirm();
				});
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** 导出结果里那句"顺手导了差量包"（一句话，别展开） */
export function describeRebaselinePeers(plan: RebaselineDiffPlan): string | null {
	const ready = plan.tasks.filter(task => task.status === 'ready');
	if (ready.length === 0) return null;
	return ready.map(task => `${peerLabel(task.peer)} 停在第 ${task.peer.baselineGeneration ?? '?'} 代`).join('、');
}

/** 界面上的默认目录（设置里那个） */
export function defaultBundleDir(plugin: LocallySavePlugin): string {
	return bundleBaseDir(plugin.settings);
}

/**
 * **本机停在某个基准上、却没有它的包文件 → 立刻留一份**（0.18.1，用户拍板：
 * "对面接收后也要导出一个完整包，保证两边完整包相同，然后才继续更新，这样最稳"）。
 *
 * 什么时候需要：应用了一份**差量包**之后 —— 基准前进到了另一份完整副本，可手里只有那份更新包，
 * `state.bundle.fullFile` 只能是空的（`apply.ts` 里那段：拿更新包的文件名冒充基准包会让
 * "恢复本机误改"去找错东西）。不补会怎样：`findBaselineBundle` 按名字找不到它 →
 * 「恢复本机误改」/「强制回退到基准再应用」只能报"把那份包放回来"；给第三台机器导差量包时，
 * 终点那份完整副本不在本机也做不出来。补一份之后，两台机器**各持一份同一份基准**，
 * 之后两边都从它往外更新。
 *
 * 三条规矩：
 * - **先看盘上有没有**（别人拷过来的、或之前导过）：有就只把 `fullFile` 记准，不重写几百 MB；
 * - **先核对指纹**再补：拿现在的仓库算一遍，和 `fullHash` 不等就**不补** —— 那说明磁盘上这份
 *   并不是大家站的那一点（典型的：文件系统 mtime 精度不同），补出来的会是**另一个基准**，
 *   两边从此对不上。这种情况如实说出来，让对面再发一次完整副本；
 * - 补的时候**什么都不推进**：世代号沿用（内容没动 → `moved` 为假），`fullHash` 仍是原来那个
 *   （已经在 `planBaselineCopy` 里核过了），只是多了一个包文件、`fullFile` 有了名字。
 *
 * 返回一句给人看的话；null ＝ 什么都不用做。
 */
export async function ensureLocalBaselineBundle(
	plugin: LocallySavePlugin,
	dir: string,
): Promise<string | null> {
	if (!dir) return null;
	const state = await loadState(plugin.stateFile());
	const hash = state.bundle?.fullHash ?? null;
	if (!hash) return null;
	if (state.bundle?.fullFile) return null;

	// 盘上已经有同一份（指纹相等）：只把"我站的是哪份文件"记准，别重写一遍
	const existing = listFullAnchorsSync(dir, state.lineage).find(anchor => anchor.hash === hash) ?? null;
	if (existing) {
		const fresh = await loadState(plugin.stateFile());
		if (fresh.bundle && !fresh.bundle.fullFile) {
			fresh.bundle.fullFile = existing.name;
			await saveState(plugin.stateFile(), fresh);
		}
		return `本机已经有第 ${existing.generation} 代那份完整副本，已记成本机的基准包`;
	}

	const inventory = await scanTree(plugin.vaultRoot(), {
		exclude: excludePatterns(plugin.settings.excludePatterns, plugin.configDir()),
		skipTopLevelDirs: [VAULT_TRASH_DIR],
	});
	const plan = planBaselineCopy(state, inventory);
	if (!plan.needed) return null;
	const generation = plan.generation ?? '?';
	if (!plan.matches) {
		return `本机这份和第 ${generation} 代那个基准对不上（${plan.driftCount} 个路径的大小或时间不同），`
			+ '没有拿它当完整副本 —— 让对面再发一份完整副本，或手动「导出同步包…」勾完整副本';
	}
	const outcome = await exportBundle({
		settings: plugin.settings,
		log: plugin.log,
		vaultRoot: plugin.vaultRoot(),
		vaultName: plugin.vaultName(),
		stateFile: plugin.stateFile(),
		mode: 'full',
		outDir: dir,
		configDir: plugin.configDir(),
	});
	if (!outcome.file) {
		return `没能给第 ${generation} 代这个基准留完整副本（${outcome.reason ?? '没有生成'}）`;
	}
	return `已给第 ${generation} 代这个基准留了一份完整副本（${formatBytes(outcome.fileBytes)}）：`
		+ '两边各自都有这一份，接着按同一份基准更新';
}

/** 一份差量包/完整副本的说明里只留前一小段名字（界面一行放不下整串） */
function shortName(name: string, max = 34): string {
	return name.length > max ? `${name.slice(0, max)}…` : name;
}

/**
 * **完整副本体检**：两边的基准对不对得上、本机缺不缺那份包。
 *
 * 用户报的那一类问题的入口：换过基准、或者换过好几次之后，只看到一句「基准对不上」，
 * 不知道是"本机那份包没了"、"盘上那份根本不是这个基准"，还是"对面换了新的、该我收它的"。
 * 窗口把三边摊开（本机基准 / 盘上的完整副本 / 各台电脑报的基准），并给一个动作：
 * **把不是本机基准、也没有电脑在用的完整副本移到回收站**（换过基准之后留下的错包）。
 */
export async function baselineHealthAction(
	app: App,
	plugin: LocallySavePlugin,
	dir: string,
	onChanged?: () => void | Promise<void>,
): Promise<void> {
	if (!dir) {
		new Notice('先去设置里填「同步包文件夹」');
		return;
	}
	const state = await loadState(plugin.stateFile());
	const health = await planBaselineHealth(dir, state, readPeers(dir, state.copyId));
	// 能清的是"不是本机基准，而且没有电脑报着它"的那些（别人的还原点别动）
	const removable = health.anchors.filter(item =>
		!item.mine && !health.peers.some(peer => peer.hash !== null && peer.hash === item.hash));
	new BaselineHealthModal(app, health, removable, async (files) => {
		const outcome = await trashBundles(dir, files);
		const parts = [`已移到回收站 ${outcome.moved.length} 份`];
		if (outcome.failed.length > 0) parts.push(`${outcome.failed.length} 份没移成`);
		parts.push('把对面那份完整副本拷进 full/，再在「管理同步包」里选它点「以这一份为基准…」');
		new Notice(parts.join('；'), 15000);
		// 别在这里『刷新包』：那是 reset --hard origin，刚移走的会回来。改成把这次删除推出去
		if (plugin.settings.gitEnabled) await syncGitNow(plugin, { quiet: true });
		await onChanged?.();
	}).open();
}

/** 体检窗口：结论 + 盘上每份完整副本 + 各台电脑，能清的直接列出来 */
class BaselineHealthModal extends Modal {
	private health: BaselineHealth;
	private removable: BaselineHealth['anchors'];
	private onTrash: (files: string[]) => Promise<void>;

	constructor(
		app: App,
		health: BaselineHealth,
		removable: BaselineHealth['anchors'],
		onTrash: (files: string[]) => Promise<void>,
	) {
		super(app);
		this.health = health;
		this.removable = removable;
		this.onTrash = onTrash;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('locally-save-modal');
		contentEl.createEl('h2', { text: '完整副本体检' });
		for (const note of this.health.notes) {
			contentEl.createEl('p', { text: note, cls: 'locally-save-hint' });
		}
		const facts = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		if (this.health.anchors.length === 0) {
			facts.createEl('li', { text: '这个文件夹里还没有完整副本' });
		}
		for (const item of this.health.anchors) {
			facts.createEl('li', {
				text: `${item.mine ? '✔ 就是本机这个基准' : '✘ 不是本机这个基准'}`
					+ ` · 第 ${item.generation} 代 · ${formatBytes(item.size)} · ${shortName(item.name)}`,
			});
		}
		for (const peer of this.health.peers) {
			facts.createEl('li', {
				text: `${peer.label}：${peer.generation !== null ? `第 ${peer.generation} 代` : '未记'}`
					+ ` · ${peer.same ? '和本机一致' : '和本机不一样'}`,
			});
		}
		const row = new Setting(contentEl);
		row.addButton(button => button.setButtonText('关闭').onClick(() => this.close()));
		if (this.removable.length > 0) {
			row.addButton(button => button
				.setButtonText(`把对不上的 ${this.removable.length} 份移到回收站`)
				.setTooltip('没有任何电脑报着它们的基准；移到回收站，能捞回来')
				.onClick(() => {
					const files = this.removable.map(item => item.file);
					this.close();
					void this.onTrash(files);
				}));
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** 命令入口：偶尔需要手动补一次（自动收包那条路已经自动做了） */
export async function baselineCopyAction(plugin: LocallySavePlugin): Promise<void> {
	if (!plugin.isActive()) return;
	const dir = defaultBundleDir(plugin);
	if (!dir) {
		new Notice('先去设置里填「同步包文件夹」');
		return;
	}
	const sentence = await ensureLocalBaselineBundle(plugin, dir);
	new Notice(sentence ?? '本机现在不缺完整副本：现在这个基准已经有包文件了', 12000);
}
