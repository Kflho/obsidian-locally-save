import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type LocallySavePlugin from '../main';
import { bundleBaseDir } from '../bundle/paths';
import { describeLocalChanges } from '../bundle/export';
import { loadState } from '../sync/state';
import { scanTree } from '../sync/disk';
import { VAULT_TRASH_DIR, excludePatterns } from '../sync/vault';
import { ApplyBundleModal } from './bundle-modal';
import { BundleListView } from './bundle-list';
import { BundleLogModal } from './log-modal';
import { openFolderInExplorer } from './reveal';

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
				.setButtonText('更新记录…')
				.setTooltip('从哪份完整副本开始、中间收发过哪些更新包')
				.onClick(() => new BundleLogModal(this.app, this.plugin).open()))
			.addButton(button => button
				.setButtonText('关闭')
				.onClick(() => this.close()));
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
