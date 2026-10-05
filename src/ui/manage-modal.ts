import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type LocallySavePlugin from '../main';
import { bundleBaseDir } from '../bundle/paths';
import { describeLocalChanges } from '../bundle/export';
import { mergeBundleGroup, planBundleMerges } from '../bundle/merge';
import type { MergePlan } from '../bundle/merge';
import { loadState } from '../sync/state';
import { scanTree } from '../sync/disk';
import { VAULT_TRASH_DIR, excludePatterns } from '../sync/vault';
import { ApplyBundleModal } from './bundle-modal';
import { BundleListView } from './bundle-list';
import { BundleLogModal } from './log-modal';
import { openFolderInExplorer } from './reveal';
import { formatBytes } from '../utils/format';

/**
 * 管理同步包：一个窗口把包文件夹里的东西全摊开 ——
 * 哪个是完整副本、哪个是更新包、多大、什么时候导的，选中就能打开所在文件夹、
 * 复制路径、删掉（挪进回收站），底下还有回收站的计数与「清空」。
 *
 * 为什么单独一个窗口，而不是只在导入弹窗里加按钮：
 * 导入弹窗的主线是"选一个包、看懂它、应用它"，管理是另一件事
 * （比如攒了七八个包要清一清、上个月那个包到底放哪儿了）；
 * 但两边**共用同一个列表组件**，不会出现"这边能删、那边不能"的错位。
 *
 * 这里还剩一件跟"基准点"有关的事：**把某一份完整副本设成本机的基准点**（完整副本那一行的按钮）——
 * 拿到别人发来的完整副本时用它，走的是应用那条路（先算报告再动手），
 * 本机已有的改动会留在原地成为"相对新基准点的改动"。
 *
 * （0.11 删掉了原来的「立新基准…」按钮：基准点现在**自己往前走**，手动换基准这件事没有了。
 * 想留一个还原点就走「导出同步包…」勾「完整副本」—— 同一件事，不必两个入口。）
 */
export class BundleManagerModal extends Modal {
	private plugin: LocallySavePlugin;
	/** 弹窗里那个输入框的值（默认就是设置里的包目录，允许临时换一个看看） */
	private dir: string;
	private defaultDir: string;
	private list: BundleListView | null = null;
	/** 顶上那句"本机现在有多少改动还没发出去" */
	private positionEl!: HTMLElement;
	constructor(app: App, plugin: LocallySavePlugin) {
		super(app);
		this.plugin = plugin;
		this.dir = plugin.settings.bundleDir.trim();
		this.defaultDir = bundleBaseDir(plugin.settings);
	}

	/** 此刻实际要去找的根目录 */
	private effectiveDir(): string {
		return bundleBaseDir({ ...this.plugin.settings, bundleDir: this.dir });
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('locally-save-modal');
		contentEl.createEl('h2', { text: '管理同步包' });

		new Setting(contentEl)
			.setName('同步包文件夹')
			.setDesc('只影响这个窗口，不动设置')
			.addText(text => text
				.setPlaceholder(this.defaultDir || '先去设置里填「同步包文件夹」')
				.setValue(this.dir)
				.onChange(value => {
					this.dir = value.trim();
					this.list?.schedule();
					void this.renderPosition();
				}))
			.addExtraButton(button => button
				.setIcon('folder-open')
				.setTooltip('在系统文件管理器里打开')
				// App 的类型里没有声明 openWithDefaultApp（Obsidian 有，类型文件没跟上）
				.onClick(() => openFolderInExplorer(
					this.effectiveDir(),
					this.app as unknown as { openWithDefaultApp?: (path: string) => void },
				)));

		// ------------------------------------------------ 本机现在有多少改动还没发出去
		this.positionEl = contentEl.createDiv({ cls: 'locally-save-hint' });
		new Setting(contentEl)
			.setName('想留一个还原点？')
			.setDesc('用「导出同步包…」勾上「完整副本」：整个仓库写成一份包，你也会站到它上面（仓库文件不动）');
		this.list = new BundleListView(this.plugin, contentEl, {
			baseDir: () => this.effectiveDir(),
			actionLabel: '应用…',
			// 管理界面里"应用"是把包丢给导入弹窗：那边会先算一份报告让人看清再动手
			onAction: item => new ApplyBundleModal(this.app, this.plugin, item.file).open(),
			// 完整副本那一行多一个「以这一份为基准」：点它会走**应用**那条路
			// （先出报告、再动手）—— 完整副本是**镜像**应用，应用完这个仓库就是那个包
			baselineLabel: '以这一份为基准…',
			onBaseline: item => new ApplyBundleModal(this.app, this.plugin, item.file).open(),
			showTrash: true,
			// 「我现在基于第几代、状态编号是什么」——管包的时候最需要对上号
			showPosition: true,
			emptyText: '这个文件夹里还没有 .lsave 文件（先去「导出同步包」导一个）',
		});
		void this.list.refresh();
		void this.renderPosition();

		new Setting(contentEl)
			.addButton(button => button
				.setButtonText('合并相邻的更新包…')
				.setTooltip('把连着的一串小环并成一份大的（链条上少几个基准点，搬起来也省事）')
				.onClick(() => { void this.mergeAdjacent(); }))
			.addButton(button => button
				.setButtonText('更新记录…')
				.setTooltip('从哪份完整副本开始、中间收发过哪些更新包')
				.onClick(() => new BundleLogModal(this.app, this.plugin).open()))
			.addButton(button => button
				.setButtonText('关闭')
				.onClick(() => this.close()));
	}

	/**
	 * **合并相邻的更新包**：把连着的一串小环并成一份大的。
	 *
	 * 一进一出都是"先算后做"：先把"哪几份并成哪一份、少掉几个基准点、省多少"摊开给用户看，
	 * 确认了才动手（`mergeBundleGroup`：先写新的、写成了才把那几份小的挪进回收站）。
	 */
	private async mergeAdjacent(): Promise<void> {
		const state = await loadState(this.plugin.stateFile());
		const { plans, forks } = await planBundleMerges(this.effectiveDir(), state.lineage);
		if (plans.length === 0) {
			new Notice(forks > 0
				? '没有可以合并的：同一个点往外分了岔（有好几份不同落点的包），哪条是正路只有你清楚，插件不替你猜'
				: '没有可以合并的：这里没有"连着两份以上、首尾相接"的更新包');
			return;
		}
		new ConfirmMergeModal(this.app, plans, async () => {
			const done: string[] = [];
			const failed: string[] = [];
			for (const plan of plans) {
				try {
					const outcome = await mergeBundleGroup({
						outDir: this.effectiveDir(),
						log: this.plugin.log,
						stateFile: this.plugin.stateFile(),
						vaultName: this.plugin.vaultName(),
						onProgress: (count, total, file) => this.plugin.reportProgress({ done: count, total, path: file, label: '导出中' }),
					}, plan);
					done.push(`${plan.anchorGeneration} → ${plan.targetGeneration} 代（${plan.links.length} 份并成 1 份）`);
					if (outcome.failed.length > 0) {
						failed.push(`${plan.links.length} 份里有 ${outcome.failed.length} 份没能挪进回收站`);
					}
				} catch (error) {
					failed.push(describe(error));
				} finally {
					this.plugin.reportProgress(null);
				}
			}
			const parts = [...done];
			if (failed.length > 0) parts.push(`失败：${failed.join('；')}`);
			new Notice(`合并完成：${parts.join('、')}。原来那几份在回收站里，捞得回来`, 9000);
			await this.list?.refresh();
			void this.renderPosition();
		}).open();
	}

	/**
	 * 顶上那句：**本机现在有多少改动是基准里没有的**。
	 *
	 * 这句话是"下次留包会装多少"的依据 —— 也就是"我现在站在哪一点上"。
	 * 还没有基准时如实说"算不出来"，不硬凑一个数。
	 */
	private async renderPosition(): Promise<void> {
		if (!this.positionEl) return;
		try {
			const state = await loadState(this.plugin.stateFile());
			const inventory = await scanTree(this.plugin.vaultRoot(), {
				exclude: excludePatterns(this.plugin.settings.excludePatterns, this.plugin.configDir()),
				skipTopLevelDirs: [VAULT_TRASH_DIR],
			});
			const changes = describeLocalChanges(state, inventory);
			if (!changes) {
				this.positionEl.setText('本机还没有基准点（没导过、也没应用过完整副本）：先导一份完整副本，更新包才有起点');
				return;
			}
			this.positionEl.setText(`本机现在：第 ${state.generation} 代`
				+ `，自基准点以来改了 ${changes.changed} 个文件`
				+ `${changes.deleted > 0 ? `、删了 ${changes.deleted} 个` : ''}`
				+ '（这些就是下次更新包会装的内容）');
		} catch (error) {
			this.positionEl.setText(`读不到本机状态：${describe(error)}`);
		}
	}

	onClose(): void {
		this.plugin.reportProgress(null);
		this.contentEl.empty();
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 合并前的确认框：**把账摊开**（哪几份并成哪一份、少掉几个基准点、省多少），
 * 并说清"原来那几份去回收站"与"站在中间点上的机器照样接得上"。
 */
class ConfirmMergeModal extends Modal {
	private plans: MergePlan[];
	private onConfirm: () => Promise<void>;

	constructor(app: App, plans: MergePlan[], onConfirm: () => Promise<void>) {
		super(app);
		this.plans = plans;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('locally-save-modal');
		contentEl.createEl('h2', { text: '合并相邻的更新包' });
		contentEl.createEl('p', {
			text: '把连着的一串小环并成一份大的：链条上少几个基准点，搬起来也省事。'
				+ '合并后那份**起点还是段首那一点、落点还是段末那一点**，中间那几个点不再有自己的包。',
			cls: 'locally-save-hint',
		});

		const facts = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		for (const plan of this.plans) {
			facts.createEl('li', {
				text: `第 ${plan.anchorGeneration} → ${plan.targetGeneration} 代：`
					+ `${plan.links.length} 份并成 1 份，少掉 ${plan.middlePoints.length} 个基准点，`
					+ `原来那几份一共 ${formatBytes(plan.bytes)}`,
			});
		}
		contentEl.createEl('p', {
			text: '**原来那几份会挪进回收站**（不是真删，捞得回来）。'
				+ '站在中间那几个点上的机器**照样收得下合并后的这一份**：应用它会算一遍落点，正好落到段末那一点。',
			cls: 'locally-save-hint',
		});

		new Setting(contentEl)
			.addButton(button => button
				.setButtonText('取消')
				.onClick(() => this.close()))
			.addButton(button => {
				button.setButtonText('合并').setCta();
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
