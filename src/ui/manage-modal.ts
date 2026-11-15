import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type LocallySavePlugin from '../main';
import { bundleBaseDir } from '../bundle/paths';
import { describeLocalChanges } from '../bundle/export';
import { loadState } from '../sync/state';
import { scanTree } from '../sync/disk';
import { VAULT_TRASH_DIR, excludePatterns } from '../sync/vault';
import { ApplyBundleModal } from './bundle-modal';
import { refreshBundlesAction } from './git';
import { BundleListView } from './bundle-list';
import { BundleLogModal } from './log-modal';
import { openFolderInExplorer } from './reveal';
import { cleanupStaleFullBundlesAction, rebaselineDiffAction, baselineHealthAction } from './rebaseline';
import { mergeAdjacentBundles } from './shelf-tools';

/**
 * 管理同步包：一个窗口把同步包文件夹里的东西全摊开 ——
 * 哪个是完整备份、哪个是更新包、多大、什么时候导的，选中就能打开所在文件夹、
 * 复制路径、删掉（移到回收站），底下还有回收使用的计数与「清空」。
 *
 * 为什么单独一个窗口，而不是只在导入弹窗里加按钮：
 * 导入弹窗的主线是"选一个包、看懂它、应用它"，管理是另一件事
 * （比如攒了七八个包要清一清、上个月那个包到底放哪儿了）；
 * 但两边**共用同一个列表组件**，不会出现"这边能删、那边不能"的错位。
 *
 * 这里还剩一件跟"基准"有关的事：**把某一份完整备份应用成本机的基准**（完整备份那一行的按钮）——
 * 拿到别人发来的完整备份时用它，走的是应用那条路（先算报告再动手），
 * 本机已有的改动会先存成一个包，之后自己应用或发给对方都行。
 *
 * （0.11 删掉了原来的「立新基准…」按钮，0.14 起只有完整备份会改变本机当前使用的那一份：
 * 导出 / 应用完整备份之后你以它为基准面，更新包怎么导怎么应用都不动它。
 * 想留一个还原点就走「导出同步包…」勾「完整备份」—— 同一件事，不必两个入口。）
 */
export class BundleManagerModal extends Modal {
	private plugin: LocallySavePlugin;
	/** 弹窗里那个输入框的值（默认就是设置里的包目录，允许临时换一个看看） */
	private dir: string;
	private defaultDir: string;
	private list: BundleListView | null = null;
	/** 顶部那句"本机现在有多少改动还没发出去" */
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
			.setDesc('只影响「管理同步包」窗口中浏览的目录，不改动设置')
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
			.setName('换基准之后')
			.setDesc('完整备份不通过 Git 传输：仍以旧完整备份为基准的电脑需要先接收一份差分更新包；确认没有电脑再用旧完整备份后，可以清理。')
			.addButton(button => button
				.setButtonText('导出差分更新包…')
				.setTooltip('两端都是完整备份，只装两者之间的差异，收下应用完就变成你现在这份上')
				.onClick(() => {
					void rebaselineDiffAction(this.app, this.plugin, this.effectiveDir(), () => this.refreshAll());
				}))
			.addButton(button => button
				.setButtonText('清理旧完整备份…')
				.setTooltip('只列出没有任何电脑仍在使用的完整备份；移入回收站后可从回收站恢复')
				.onClick(() => {
					void cleanupStaleFullBundlesAction(this.app, this.plugin, this.effectiveDir(), () => this.refreshAll());
				}));
		new Setting(contentEl)
			.setName('想留一个还原点？')
			.setDesc('在「导出同步包…」里勾上「完整备份」：整个仓库写成一份包，你也会以它为基准，仓库文件不动。');
		this.list = new BundleListView(this.plugin, contentEl, {
			baseDir: () => this.effectiveDir(),
			actionLabel: '应用…',
			// 管理界面里"应用"是把包丢给导入弹窗：那边会先算一份报告让人看清再动手
			onAction: item => new ApplyBundleModal(this.app, this.plugin, item.file).open(),
			// 完整备份那一行多一个「以这一份为基准」：点它会走**应用**那条路
			// （先出报告、再动手）—— 完整备份是**镜像**应用，应用完这个仓库就是那个包
			baselineLabel: '以这一份为基准…',
			onBaseline: item => new ApplyBundleModal(this.app, this.plugin, item.file).open(),
			showTrash: true,
			// 「我现在基于第几代、内容校验值是什么」——管包的时候最需要对上号
			showPosition: true,
			emptyText: '该文件夹中尚无 .lsave 文件（请先用「导出同步包」导出一份）',
		});
		void this.list.refresh();
		void this.renderPosition();

		new Setting(contentEl)
			.addButton(button => button
				.setButtonText('刷新包（对齐远程）')
				.setTooltip('丢弃本地未推送的提交，与远程仓库对齐，并拉取新的同步包')
				.onClick(() => { void refreshBundlesAction(this.plugin); }))
			.addButton(button => button
				.setButtonText('整理更新包…')
				.setTooltip('把首尾相接的几份合并为一份；同一基准的旧包只保留最新一份（均移入回收站，可从回收站恢复）')
				.onClick(() => { void this.mergeAdjacent(); }))
			.addButton(button => button
				.setButtonText('完整备份体检…')
				.setTooltip('本机基准 / 盘上的完整备份 / 各台电脑报的基准，对不对得上一眼看清')
				.onClick(() => {
					void baselineHealthAction(this.app, this.plugin, this.effectiveDir(), () => this.refreshAll());
				}))
			.addButton(button => button
				.setButtonText('更新记录…')
				.setTooltip('从哪份完整备份开始、中间收发过哪些更新包')
				.onClick(() => new BundleLogModal(this.app, this.plugin).open()))
			.addButton(button => button
				.setButtonText('关闭')
				.onClick(() => this.close()));
	}

	/**
	 * 列表与顶部那句一起刷新（导完差分更新包 / 清完旧完整备份之后）。
	 * 别只刷列表：顶部那句写的是"我现在用哪一份上"，包一移就过时了。
	 */
	private async refreshAll(): Promise<void> {
		await this.list?.refresh();
		await this.renderPosition();
	}

	/**
	 * **合并相邻的更新包**：把连着的一串小包并成一份大的（历史遗留的那些小包）。
	 *
	 * 逻辑搬到了 `ui/shelf-tools.ts`（导出窗 / 导入窗也要用这一套），这里只负责转一手。
	 */
	private async mergeAdjacent(): Promise<void> {
		await mergeAdjacentBundles(this.app, this.plugin, this.effectiveDir(), async () => {
			await this.list?.refresh();
			void this.renderPosition();
		});
	}

	/**
	 * 顶部那句：**本机现在有多少改动是完整备份里没有的**。
	 *
	 * 这句话是"下次导出会装多少"的依据 —— 也就是"我现在使用的那一份是哪一个"。
	 * 还没有完整备份时如实说"算不出来"，不硬凑一个数。
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
				this.positionEl.setText('本机尚无完整备份（既未导出过，也未应用过）：请先导出一份完整备份，更新包才有起点。');
				return;
			}
			this.positionEl.setText(`本机：第 ${state.generation} 版。`
				+ `自本机当前基准的完整备份以来修改了 ${changes.changed} 个文件`
				+ `${changes.deleted > 0 ? `、删了 ${changes.deleted} 个` : ''}`
				+ '，这些就是下次更新包会装的内容。');
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
