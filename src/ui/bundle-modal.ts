import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type LocallySavePlugin from '../main';
import { executeBundlePlan, planBundleApply } from '../bundle/apply';
import type { ApplyPlan } from '../bundle/apply';
import { exportBundle } from '../bundle/export';
import { listFiles } from '../sync/disk';
import { formatBytes, formatDuration, formatTime } from '../utils/format';

/** 列表里最多列多少个包 */
const MAX_BUNDLES = 20;

/**
 * 导出同步包。
 *
 * 两个选项都能在这里临时改：设置里的默认值只是"平时用哪个"，
 * 偶尔导一份完整包给别人时不该被迫先去改设置。
 */
export class ExportBundleModal extends Modal {
	private plugin: LocallySavePlugin;
	private mode: 'full' | 'changes';
	private outDir: string;
	private statusEl!: HTMLElement;

	constructor(app: App, plugin: LocallySavePlugin) {
		super(app);
		this.plugin = plugin;
		this.mode = plugin.settings.bundleMode;
		this.outDir = plugin.settings.bundleDir;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('locally-save-modal');
		contentEl.createEl('h2', { text: '导出同步包' });
		contentEl.createEl('p', {
			text: '把仓库（或只把改动）打包成单个文件，拷到别的机器上打开即可应用。',
			cls: 'locally-save-hint',
		});

		new Setting(contentEl)
			.setName('导出内容')
			.setDesc('完整副本＝整个仓库；仅改动＝自上次导出后变过的文件加删除清单')
			.addDropdown(dropdown => dropdown
				.addOptions({
					full: '完整副本',
					changes: '仅改动',
				})
				.setValue(this.mode)
				.onChange(value => { this.mode = value === 'changes' ? 'changes' : 'full'; }));

		new Setting(contentEl)
			.setName('输出文件夹')
			.setDesc('填绝对路径；文件夹不存在会自动创建')
			.addText(text => text
				.setPlaceholder('例如 D:\\传输')
				.setValue(this.outDir)
				.onChange(value => { this.outDir = value.trim(); }));

		this.statusEl = contentEl.createEl('p', { cls: 'locally-save-hint' });

		new Setting(contentEl)
			.addButton(button => button
				.setButtonText('导出')
				.setCta()
				.onClick(() => { void this.run(); }))
			.addButton(button => button
				.setButtonText('取消')
				.onClick(() => this.close()));
	}

	private async run(): Promise<void> {
		if (!this.outDir) {
			new Notice('请先填输出文件夹');
			return;
		}
		this.statusEl.setText('正在导出……');
		try {
			const outcome = await exportBundle({
				settings: this.plugin.settings,
				log: this.plugin.log,
				vaultRoot: this.plugin.vaultRoot(),
				vaultName: this.plugin.vaultName(),
				stateFile: this.plugin.stateFile(),
				outDir: this.outDir,
				configDir: this.plugin.configDir(),
				onProgress: (done, total, file) => this.plugin.reportProgress({ done, total, path: file }),
			});
			this.plugin.reportProgress(null);

			if (!outcome.file) {
				this.statusEl.setText(outcome.reason ?? '没有需要导出的内容');
				return;
			}
			this.close();
			new Notice(
				`同步包已导出：${outcome.entryCount} 个文件、${formatBytes(outcome.payloadBytes)}`
				+ `（${formatDuration(outcome.durationMs)}）\n${outcome.file}`,
				10000,
			);
		} catch (error) {
			this.plugin.reportProgress(null);
			const message = error instanceof Error ? error.message : String(error);
			this.statusEl.setText(`导出失败：${message}`);
			new Notice(`导出同步包失败：${message}`, 8000);
			this.plugin.log.error('导出同步包失败', error);
		}
	}

	onClose(): void {
		this.plugin.reportProgress(null);
		this.contentEl.empty();
	}
}

/**
 * 打开同步包并应用 —— **先出报告，再决定应不应用**。
 *
 * 报告里的"同步程度"就是接收方最想知道的那件事：
 * 这个包跟本地差多少、里面有多少是本地也改过的（会留冲突副本）、
 * 会不会删东西、走的是快速通道还是逐文件合并。
 */
export class ApplyBundleModal extends Modal {
	private plugin: LocallySavePlugin;
	private dir: string;
	private current: string | null = null;
	private plan: ApplyPlan | null = null;
	private listEl!: HTMLElement;
	private reportEl!: HTMLElement;
	private applyButton: { setDisabled(disabled: boolean): unknown } | null = null;

	constructor(app: App, plugin: LocallySavePlugin) {
		super(app);
		this.plugin = plugin;
		this.dir = plugin.settings.bundleDir;
		this.current = null;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('locally-save-modal');
		contentEl.createEl('h2', { text: '打开同步包' });
		contentEl.createEl('p', {
			text: '选一个 .lsave 文件，这里会先算一遍"应用之后会变成什么样"，确认无误再动手。',
			cls: 'locally-save-hint',
		});

		new Setting(contentEl)
			.setName('同步包文件夹')
			.setDesc('填绝对路径后按刷新，或直接在下面手填包文件路径')
			.addText(text => text
				.setPlaceholder('例如 D:\\传输')
				.setValue(this.dir)
				.onChange(value => { this.dir = value.trim(); }))
			.addExtraButton(button => button
				.setIcon('refresh-cw')
				.setTooltip('重新列出')
				.onClick(() => { void this.refresh(); }));

		new Setting(contentEl)
			.setName('包文件路径')
			.setDesc('也可以直接粘一个完整路径')
			.addText(text => text
				.setPlaceholder('D:\\传输\\我的笔记-changes-20261004-153000.lsave')
				.onChange(value => {
					const path = value.trim();
					if (path) void this.select(path);
				}));

		this.listEl = contentEl.createDiv({ cls: 'locally-save-list' });
		this.reportEl = contentEl.createDiv({ cls: 'locally-save-report' });
		this.reportEl.setText('还没有选择同步包。');

		new Setting(contentEl)
			.addButton(button => {
				this.applyButton = button
					.setButtonText('应用')
					.setCta()
					.setDisabled(true)
					.onClick(() => { void this.apply(); });
				return button;
			})
			.addButton(button => button
				.setButtonText('关闭')
				.onClick(() => this.close()));

		void this.refresh();
	}

	private async refresh(): Promise<void> {
		this.listEl.empty();
		if (!this.dir) {
			this.listEl.setText('（没填文件夹，可直接在下面粘包文件路径）');
			return;
		}
		const files = (await listFiles(this.dir))
			.filter(file => file.name.endsWith('.lsave'))
			.sort((a, b) => b.mtime - a.mtime)
			.slice(0, MAX_BUNDLES);

		if (files.length === 0) {
			this.listEl.setText('这个文件夹里没有 .lsave 文件');
			return;
		}
		for (const file of files) {
			const full = `${this.dir.replace(/[/\\]+$/, '')}/${file.name}`;
			const row = this.listEl.createDiv({ cls: 'locally-save-row is-bundle' });
			row.createSpan({ text: file.name, cls: 'locally-save-file' });
			row.createSpan({
				text: `${formatBytes(file.size)} · ${formatTime(file.mtime)}`,
				cls: 'locally-save-reason',
			});
			row.addEventListener('click', () => { void this.select(full); });
		}
	}

	/** 选中一个包：只读地算一遍，把报告画出来 */
	private async select(file: string): Promise<void> {
		this.current = file;
		this.plan = null;
		this.applyButton?.setDisabled(true);
		this.reportEl.empty();
		this.reportEl.setText('正在检查这个包……');

		try {
			const plan = await planBundleApply({
				settings: this.plugin.settings,
				log: this.plugin.log,
				vaultRoot: this.plugin.vaultRoot(),
				stateFile: this.plugin.stateFile(),
				file,
				configDir: this.plugin.configDir(),
			});
			this.plan = plan;
			this.renderReport(plan);
			this.applyButton?.setDisabled(false);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.reportEl.setText(`打不开这个包：${message}`);
		}
	}

	private renderReport(plan: ApplyPlan): void {
		const { report } = plan;
		this.reportEl.empty();
		this.reportEl.createEl('h3', { text: '这个包里有什么' });

		const info = this.reportEl.createEl('ul', { cls: 'locally-save-facts' });
		const add = (text: string) => info.createEl('li', { text });
		add(`来源：${report.bundle.vault}，导出于 ${formatTime(report.bundle.created)}`);
		add(`类型：${report.bundle.mode === 'full' ? '完整副本' : '仅改动'}`
			+ `，${report.bundle.entryCount} 个文件、${formatBytes(report.bundle.payloadBytes)}`);
		if (report.bundle.deletedCount > 0) add(`包里标记了 ${report.bundle.deletedCount} 个删除`);

		// 同步程度：接收方最关心的一个数
		this.reportEl.createEl('h3', { text: `同步程度 ${report.syncPercent}%` });
		this.reportEl.createEl('p', {
			text: `${report.synchronized} / ${report.bundle.entryCount} 个文件已经和本地一致`,
			cls: 'locally-save-hint',
		});

		const detail = this.reportEl.createEl('ul', { cls: 'locally-save-facts' });
		const line = (text: string) => detail.createEl('li', { text });
		line(`新增 ${report.adds} 个`);
		line(`覆盖 ${report.overwrites} 个`);
		if (report.conflicts > 0) line(`本地也改过、会留冲突副本的：${report.conflicts} 个`);
		if (report.deletes > 0) line(`删除 ${report.deletes} 个（本地未改动过的）`);
		if (report.keptDeletes > 0) line(`包里要求删、但本地改过所以保留的：${report.keptDeletes} 个`);
		if (report.extraDeletes > 0) line(`本地多出来、会被删的：${report.extraDeletes} 个`);

		// 走哪条路，以及为什么
		this.reportEl.createEl('h3', { text: '会怎么处理' });
		const mode = this.reportEl.createEl('p');
		if (report.mode === 'fast') {
			mode.setText('快速通道：两边是同一条血脉的同一世代，按包的清单直接写入。');
		} else {
			mode.setText('逐文件合并：世代对不上，会逐个文件确认"本地是不是还停在包的基准上"，'
				+ '本地也改过的留成冲突副本，不会静默覆盖。');
		}
		if (report.bundle.mode === 'full') {
			this.reportEl.createEl('p', { text: '完整包：不需要校验世代，直接按内容比对。', cls: 'locally-save-hint' });
		}
		if (!report.sameLineage) {
			this.reportEl.createEl('p', {
				text: '注意：这个包来自另一条血脉（另一份独立的副本）。应用后会认祖，之后就能按世代快速同步了。',
				cls: 'locally-save-warn',
			});
		}
		if (!report.parentMatches && report.bundle.mode === 'changes') {
			this.reportEl.createEl('p', {
				text: '注意：这个包的上一个包不是你最后应用的那个 —— 中间可能漏了包。'
					+ '漏掉的内容不会凭空补上，必要时让对方导一份完整副本。',
				cls: 'locally-save-warn',
			});
		}
		if (report.generationGap !== null && report.generationGap > 0) {
			this.reportEl.createEl('p', {
				text: `注意：你的世代落后 ${report.generationGap} 代，中间可能漏了包。`,
				cls: 'locally-save-warn',
			});
		}
	}

	private async apply(): Promise<void> {
		const plan = this.plan;
		const file = this.current;
		if (!plan || !file) return;
		this.reportEl.setText('正在应用……');
		try {
			const result = await executeBundlePlan(plan, {
				settings: this.plugin.settings,
				log: this.plugin.log,
				vaultRoot: this.plugin.vaultRoot(),
				stateFile: this.plugin.stateFile(),
				file,
				configDir: this.plugin.configDir(),
				onProgress: (done, total, path) => this.plugin.reportProgress({ done, total, path }),
			});
			this.plugin.reportProgress(null);
			this.plugin.settings.showLastSyncInStatusBar
				&& this.plugin.statusBar.setSummary(`同步包已应用（写入 ${result.written}）`);

			const parts = [`写入 ${result.written}`, `跳过 ${result.skipped}`];
			if (result.conflicts > 0) parts.push(`冲突 ${result.conflicts}`);
			if (result.deleted > 0) parts.push(`删除 ${result.deleted}`);
			if (result.failed.length > 0) parts.push(`失败 ${result.failed.length}`);
			new Notice(`同步包已应用：${parts.join('、')}`, 8000);
			this.close();
		} catch (error) {
			this.plugin.reportProgress(null);
			const message = error instanceof Error ? error.message : String(error);
			this.reportEl.setText(`应用失败：${message}`);
			new Notice(`应用同步包失败：${message}`, 8000);
			this.plugin.log.error('应用同步包失败', error);
		}
	}

	onClose(): void {
		this.plugin.reportProgress(null);
		this.contentEl.empty();
	}
}
