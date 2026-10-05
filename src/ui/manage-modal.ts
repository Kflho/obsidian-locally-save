import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type LocallySavePlugin from '../main';
import { bundleBaseDir } from '../bundle/paths';
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
 */
export class BundleManagerModal extends Modal {
	private plugin: LocallySavePlugin;
	/** 弹窗里那个输入框的值（默认就是设置里的包目录，允许临时换一个看看） */
	private dir: string;
	private defaultDir: string;
	private list: BundleListView | null = null;

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
		contentEl.createEl('p', {
			text: '这里列出同步包文件夹里的所有包（完整副本与更新包）。选中一个可以打开它所在的文件夹、'
				+ '复制路径，或者删掉它 —— 删除只是挪进回收站，底下那个「清空回收站」才是真删。',
			cls: 'locally-save-hint',
		});

		new Setting(contentEl)
			.setName('同步包文件夹')
			.setDesc('默认用设置里那个「同步包文件夹」；在这里改只影响这个窗口，不会动设置')
			.addText(text => text
				.setPlaceholder(this.defaultDir || '先去设置里填「同步包文件夹」')
				.setValue(this.dir)
				.onChange(value => {
					this.dir = value.trim();
					this.list?.schedule();
				}))
			.addExtraButton(button => button
				.setIcon('folder-open')
				.setTooltip('在系统文件管理器里打开')
				// App 的类型里没有声明 openWithDefaultApp（Obsidian 有，类型文件没跟上）
				.onClick(() => openFolderInExplorer(
					this.effectiveDir(),
					this.app as unknown as { openWithDefaultApp?: (path: string) => void },
				)));

		this.list = new BundleListView(this.plugin, contentEl, {
			baseDir: () => this.effectiveDir(),
			actionLabel: '应用…',
			// 管理界面里"应用"是把包丢给导入弹窗：那边会先算一份报告让人看清再动手
			onAction: item => new ApplyBundleModal(this.app, this.plugin, item.file).open(),
			showTrash: true,
			emptyText: '这个文件夹里还没有 .lsave 文件（先去「导出同步包」导一个）',
		});
		void this.list.refresh();

		new Setting(contentEl)
			.addButton(button => button
				.setButtonText('更新记录…')
				.setTooltip('从哪份完整副本开始、中间收发过哪些更新包')
				.onClick(() => new BundleLogModal(this.app, this.plugin).open()))
			.addButton(button => button
				.setButtonText('关闭')
				.onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
