import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type LocallySavePlugin from '../main';
import { bundleBaseDir } from '../bundle/paths';
import { describeLocalChanges, exportBundle } from '../bundle/export';
import { describeExportRange } from '../bundle/log';
import { loadState } from '../sync/state';
import { scanTree } from '../sync/disk';
import { VAULT_TRASH_DIR, excludePatterns } from '../sync/vault';
import { formatBytes, formatDuration } from '../utils/format';
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
 * 这里还有两件**跟"基准"有关**的事（用户提的两条需求都落在这儿）：
 * 1. **以本机现状立一份新完整包**（顶上的按钮）：本机领先于基准时，更新包会越滚越大，
 *    把现状固化成分新完整包当基准，之后的更新包就从零开始攒；这份完整包同时也是备份；
 * 2. **把某一份完整副本设为基准**（每行那个按钮）：拿到别人发来的完整副本时用它 ——
 *    走的是应用那条路（先算报告再动手），本机已有的改动会留在原地成为"相对新基准的改动"。
 */
export class BundleManagerModal extends Modal {
	private plugin: LocallySavePlugin;
	/** 弹窗里那个输入框的值（默认就是设置里的包目录，允许临时换一个看看） */
	private dir: string;
	private defaultDir: string;
	private list: BundleListView | null = null;
	/** 顶上那句"本机现在有多少改动还没发出去" */
	private positionEl!: HTMLElement;
	/** 正在跑"立新基准"，防止连点 */
	private busy = false;

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

		// ------------------------------------------------ 立新基准（要点一的第一件事）
		this.positionEl = contentEl.createDiv({ cls: 'locally-save-hint' });
		new Setting(contentEl)
			.setName('立新基准')
			.setDesc('按本机现状导一份新完整副本并换基准：更新包从此从零累积。仓库文件不动')
			.addButton(button => button
				.setButtonText('立新基准…')
				.onClick(() => { void this.confirmResetBaseline(); }));
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
	 * 这句话正是"要不要立新基准"的依据 —— 没有它，用户只能看着更新包一天天变大猜。
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
				this.positionEl.setText('本机还没有基准（没导过、也没应用过完整副本）：先导一份完整副本，更新包才谈得上基准');
				return;
			}
			this.positionEl.setText(`本机现在：第 ${state.generation} 代`
				+ `，自基准以来改了 ${changes.changed} 个文件`
				+ `${changes.deleted > 0 ? `、删了 ${changes.deleted} 个` : ''}`
				+ '（这些就是下次更新包会装的内容）');
		} catch (error) {
			this.positionEl.setText(`读不到本机状态：${describe(error)}`);
		}
	}

	/**
	 * 「立新基准」先确认：它**会重写一份完整包**（几百 MB 的仓库就是几百 MB 的写入），
	 * 而且换基准之后旧更新包会被清掉（新完整包已经含全部内容，留着也没用）。
	 * 这两件事必须写清楚再动手。
	 */
	private async confirmResetBaseline(): Promise<void> {
		const base = this.effectiveDir();
		if (!base) {
			new Notice('先去设置里填「同步包文件夹」', 9000);
			return;
		}
		let note = '';
		try {
			const state = await loadState(this.plugin.stateFile());
			const inventory = await scanTree(this.plugin.vaultRoot(), {
				exclude: excludePatterns(this.plugin.settings.excludePatterns, this.plugin.configDir()),
				skipTopLevelDirs: [VAULT_TRASH_DIR],
			});
			const changes = describeLocalChanges(state, inventory);
			note = changes
				? `现在是第 ${state.generation} 代，自基准以来改了 ${changes.changed} 个文件`
					+ `${changes.deleted > 0 ? `、删了 ${changes.deleted} 个` : ''}。`
				: '本机还没有基准，这一份就是第一份。';
		} catch {
			note = '';
		}
		new ConfirmBaselineModal(this.app, {
			note: `${note}新完整包会写到 ${base} 的 full 目录，写完本机基准就换成它；`
				+ '旧更新包会被清掉（新完整包已经含全部内容）。仓库里的文件一个都不动。',
			onConfirm: () => this.resetBaseline(),
		}).open();
	}

	/** 真去导那份新完整包（＝立新基准），跑完刷新列表与顶上那句 */
	private async resetBaseline(): Promise<void> {
		if (this.busy) {
			new Notice('上一次「立新基准」还在跑');
			return;
		}
		this.busy = true;
		try {
			const outcome = await exportBundle({
				settings: this.plugin.settings,
				log: this.plugin.log,
				vaultRoot: this.plugin.vaultRoot(),
				vaultName: this.plugin.vaultName(),
				stateFile: this.plugin.stateFile(),
				mode: 'full',
				outDir: this.effectiveDir(),
				configDir: this.plugin.configDir(),
				onProgress: (done, total, file) => this.plugin.reportProgress({
					done,
					total,
					path: file,
					label: '导出中',
				}),
			});
			this.plugin.reportProgress(null);
			if (!outcome.file) {
				new Notice(`没能立新基准：${outcome.reason ?? '没有内容可导出'}`, 9000);
				return;
			}
			new Notice(
				`已立新基准：第 ${outcome.header?.targetGeneration ?? '?'} 代，`
				+ `${outcome.entryCount} 个文件、${formatBytes(outcome.payloadBytes)}`
				+ `（${formatDuration(outcome.durationMs)}）${describeExportRange(outcome)}`
				+ `${outcome.superseded.length > 0 ? `；清掉了 ${outcome.superseded.length} 个被它取代的旧更新包` : ''}`
				+ ` → ${outcome.file}`,
				12000,
			);
			this.plugin.log.debug(`立新基准完成：${outcome.file}`);
			await this.list?.refresh();
			await this.renderPosition();
		} catch (error) {
			this.plugin.reportProgress(null);
			new Notice(`立新基准失败：${describe(error)}`, 9000);
			this.plugin.log.error('立新基准失败', error);
		} finally {
			this.busy = false;
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

/** 「立新基准」的确认框：把"会写哪个文件、旧更新包会怎样、仓库不动"摊开说清楚 */
class ConfirmBaselineModal extends Modal {
	private note: string;
	private onConfirm: () => void | Promise<void>;

	constructor(app: App, options: { note: string; onConfirm: () => void | Promise<void> }) {
		super(app);
		this.note = options.note;
		this.onConfirm = options.onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('locally-save-modal');
		contentEl.createEl('h2', { text: '以本机现状立一份新完整包？' });
		contentEl.createEl('p', { text: this.note, cls: 'locally-save-hint' });
		new Setting(contentEl)
			.addButton(button => button
				.setButtonText('取消')
				.onClick(() => this.close()))
			.addButton(button => button
				.setButtonText('立新基准')
				.setCta()
				.onClick(() => {
					this.close();
					void this.onConfirm();
				}));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
