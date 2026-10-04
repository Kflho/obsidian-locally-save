import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type LocallySavePlugin from '../main';
import { executeBundlePlan, planBundleApply, APPLY_MODE_LABELS } from '../bundle/apply';
import type { ApplyMode, ApplyPlan } from '../bundle/apply';
import { exportBundle } from '../bundle/export';
import { bundleBaseDir, bundleDirForMode, bundleDirsToScan } from '../bundle/paths';
import { readBundleInfo } from '../bundle/format';
import type { DropdownComponent } from 'obsidian';
import { listFiles } from '../sync/disk';
import { formatBytes, formatDuration, formatTime } from '../utils/format';

/** 列表里最多列多少个包 */
const MAX_BUNDLES = 20;
/** 确认框里最多列多少个会被删的文件 */
const MAX_ROWS = 200;

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
	private whereEl!: HTMLElement;

	constructor(app: App, plugin: LocallySavePlugin) {
		super(app);
		this.plugin = plugin;
		this.mode = plugin.settings.bundleMode;
		// 默认跟着同步目标走（设置里填了同步包文件夹就用填的）
		this.outDir = bundleBaseDir(plugin.settings, plugin.settings.targetDir);
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
				.onChange(value => {
					this.mode = value === 'changes' ? 'changes' : 'full';
					this.renderWhere();
				}));

		new Setting(contentEl)
			.setName('同步包文件夹')
			.setDesc('留空＝跟着同步目标文件夹走；完整包与改动包分别放在它的 full 与 changes 子目录里')
			.addText(text => text
				.setPlaceholder('例如 D:\\传输')
				.setValue(this.outDir)
				.onChange(value => {
					this.outDir = value.trim();
					this.renderWhere();
				}));

		this.whereEl = contentEl.createEl('p', { cls: 'locally-save-hint' });
		this.statusEl = contentEl.createEl('p', { cls: 'locally-save-hint' });
		this.renderWhere();

		new Setting(contentEl)
			.addButton(button => button
				.setButtonText('导出')
				.setCta()
				.onClick(() => { void this.run(); }))
			.addButton(button => button
				.setButtonText('取消')
				.onClick(() => this.close()));
	}

	/** 让用户看清"这个包会落到哪个目录" */
	private renderWhere(): void {
		if (!this.outDir) {
			this.whereEl.setText('还没填文件夹：先在设置里填「目标文件夹」，或在这里填一个路径。');
			return;
		}
		this.whereEl.setText(`会写到：${bundleDirForMode(this.outDir, this.mode)}`);
	}

	private async run(): Promise<void> {
		if (!this.outDir) {
			new Notice('请先填同步包文件夹（留空则需要在设置里填目标文件夹）');
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
	/** 应用方式：默认最保守的「所有都保留」 */
	private mode: ApplyMode = 'keep-all';
	private keepBackup: boolean;
	private modeDropdown: DropdownComponent | null = null;
	private listEl!: HTMLElement;
	private reportEl!: HTMLElement;
	private applyButton: { setDisabled(disabled: boolean): unknown } | null = null;

	constructor(app: App, plugin: LocallySavePlugin) {
		super(app);
		this.plugin = plugin;
		// 默认跟着同步目标走（设置里填了同步包文件夹就用填的）
		this.dir = bundleBaseDir(plugin.settings, plugin.settings.targetDir);
		this.keepBackup = plugin.settings.deletedToTrash;
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
			.setDesc('留空＝跟着同步目标文件夹走。会列出它的 full 与 changes 两个子目录里的包')
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

		// ---------------------------------------------------------- 应用方式
		// 放在这儿而不是设置里：这是"这一次要怎么应用"的决定，每次搬包时的心态都不一样
		new Setting(contentEl)
			.setName('应用方式')
			.setDesc('「清老的」与「强制应用」只能对着完整副本用 —— 改动包里只装了变过的文件，对着它清理会把仓库其余文件全删掉')
			.addDropdown(dropdown => {
				this.modeDropdown = dropdown;
				dropdown
					.addOptions({
						'keep-all': APPLY_MODE_LABELS['keep-all'],
						'delete-old': APPLY_MODE_LABELS['delete-old'],
						force: APPLY_MODE_LABELS.force,
					})
					.setValue(this.mode)
					.onChange(value => {
						this.mode = value === 'delete-old' || value === 'force' ? value : 'keep-all';
						void this.replan();
					});
			});

		new Setting(contentEl)
			.setName('覆盖 / 删掉的先进回收目录')
			.setDesc('强制应用与清老的会动到本地原有的文件：开启这一项后它们会被挪进「仓库/.trash/locally-save/时间戳」，'
				+ '仍然捞得回来。关掉就是直接覆盖 / 删除')
			.addToggle(toggle => toggle
				.setValue(this.keepBackup)
				.onChange(value => {
					this.keepBackup = value;
					void this.replan();
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

		// 两个子目录都看，列表里标出包来自哪一类
		const found: { file: string; label: string; size: number; mtime: number }[] = [];
		for (const dir of bundleDirsToScan(this.dir)) {
			const segments = dir.split(/[/\\]/);
			const sub = dir === this.dir ? '' : `${segments[segments.length - 1] ?? ''}/`;
			for (const item of await listFiles(dir)) {
				if (!item.name.endsWith('.lsave')) continue;
				found.push({
					file: `${dir.replace(/[/\\]+$/, '')}/${item.name}`,
					label: `${sub}${item.name}`,
					size: item.size,
					mtime: item.mtime,
				});
			}
		}
		found.sort((a, b) => b.mtime - a.mtime);

		if (found.length === 0) {
			this.listEl.setText('这些文件夹里没有 .lsave 文件');
			return;
		}
		for (const item of found.slice(0, MAX_BUNDLES)) {
			const row = this.listEl.createDiv({ cls: 'locally-save-row is-bundle' });
			row.createSpan({ text: item.label, cls: 'locally-save-file' });
			row.createSpan({
				text: `${formatBytes(item.size)} · ${formatTime(item.mtime)}`,
				cls: 'locally-save-reason',
			});
			row.addEventListener('click', () => { void this.select(item.file); });
		}
	}

	/** 选中一个包：只读地算一遍，把报告画出来 */
	private async select(file: string): Promise<void> {
		this.current = file;
		this.plan = null;
		this.applyButton?.setDisabled(true);
		this.reportEl.empty();
		this.reportEl.setText('正在检查这个包……');
		await this.replan();
	}

	/**
	 * 重新算一遍（换包、换应用方式、换备份开关都要走这里）。
	 *
	 * 防呆的第一层：**改动包不能配破坏性的应用方式**。改动包里只装了变过的文件，
	 * 对着它"清老的"或"强制应用"等于把仓库里其余文件全删掉 ——
	 * 所以这两种方式只对完整副本开放，选了就自动切回来并说明原因。
	 */
	private async replan(): Promise<void> {
		const file = this.current;
		if (!file) return;
		this.applyButton?.setDisabled(true);
		try {
			const info = await readBundleInfo(file);
			const isFull = info.header.mode === 'full';
			if (!isFull && this.mode !== 'keep-all') {
				this.mode = 'keep-all';
				this.modeDropdown?.setValue('keep-all');
				new Notice('这是「仅改动」的包：已自动切回「所有都保留」。改动包不能强制应用或清理多余文件', 8000);
			}
			this.modeDropdown?.setDisabled(!isFull);

			const plan = await planBundleApply({
				settings: this.plugin.settings,
				log: this.plugin.log,
				vaultRoot: this.plugin.vaultRoot(),
				stateFile: this.plugin.stateFile(),
				file,
				configDir: this.plugin.configDir(),
				mode: this.mode,
				keepBackup: this.keepBackup,
			});
			this.plan = plan;
			this.renderReport(plan);
			this.applyButton?.setDisabled(false);
		} catch (error) {
			this.reportEl.empty();
			this.reportEl.setText(`打不开这个包：${describe(error)}`);
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

		// 防呆第二层：改动包说清它不能干什么
		if (report.bundle.mode !== 'full') {
			this.reportEl.createEl('p', {
				text: '⚠ 这是「仅改动」的包：里面只装了变过的文件。所以「清老的」与「强制应用」都用不了 ——'
					+ ' 对着它清理会把仓库里其余文件全删掉（那两个选项已灰掉）。'
					+ '真要让仓库和某个状态完全一致，让对方导一份**完整副本**。',
				cls: 'locally-save-warn',
			});
		}

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
		if (report.forcedOverwrites > 0) {
			line(`其中 ${report.forcedOverwrites} 个是本地也改过的（强制应用：以包为准）`);
		}
		if (report.conflicts > 0) line(`本地也改过、会留冲突副本的：${report.conflicts} 个`);
		if (report.deletes > 0) line(`删除 ${report.deletes} 个（本地未改动过的）`);
		if (report.keptDeletes > 0) line(`包里要求删、但本地改过所以保留的：${report.keptDeletes} 个`);
		if (report.extraDeletes > 0) line(`本地多出来、会被删的：${report.extraDeletes} 个`);

		// 走哪条路，以及为什么
		this.reportEl.createEl('h3', { text: '会怎么处理' });
		this.reportEl.createEl('p', {
			text: APPLY_MODE_LABELS[report.applyMode]
				+ (report.keepBackup
					? '。被覆盖 / 删掉的本地版本会先进回收目录（仓库/.trash/locally-save）'
					: '。注意：被覆盖 / 删掉的本地版本**直接消失**（回收目录已关）'),
			cls: report.keepBackup ? 'locally-save-hint' : 'locally-save-warn',
		});

		const mode = this.reportEl.createEl('p');
		if (report.mode === 'fast') {
			mode.setText('通道：快速 —— 两边是同一条血脉的同一世代，按包的清单直接写入。');
		} else {
			mode.setText('通道：逐文件合并 —— 世代对不上，会逐个确认"本地是不是还停在包的基准上"，'
				+ '本地也改过的留冲突副本。');
		}
		mode.addClass('locally-save-hint');

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

		// 防呆第三层：真要删文件 / 覆盖本地改动之前，把账摊开让人再点一次
		if (isDestructive(plan)) {
			new ConfirmApplyModal(this.app, plan, () => { void this.runApply(); }).open();
			return;
		}
		await this.runApply();
	}

	private async runApply(): Promise<void> {
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
				mode: plan.options.mode,
				keepBackup: plan.options.keepBackup,
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

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 这次应用会不会"动到本地已经有的东西"：删文件、覆盖本地改动 */
function isDestructive(plan: ApplyPlan): boolean {
	return plan.options.mode !== 'keep-all'
		|| plan.extra.length > 0
		|| plan.deletes.some(item => item.action === 'delete')
		|| plan.report.forcedOverwrites > 0;
}

/**
 * 应用前的确认框。
 *
 * 只在"真会动到本地已有的东西"时才弹（删文件 / 覆盖本地改动）——
 * 平时应用一个纯新增的包不该被打断。弹的时候把账摊开：删几个、覆盖几个、去哪了。
 */
class ConfirmApplyModal extends Modal {
	private plan: ApplyPlan;
	private onConfirm: () => void;

	constructor(app: App, plan: ApplyPlan, onConfirm: () => void) {
		super(app);
		this.plan = plan;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		const { report } = this.plan;
		contentEl.empty();
		contentEl.addClass('locally-save-modal');
		contentEl.createEl('h2', { text: '确认应用：会动到本地已有的文件' });

		const deleting = this.plan.deletes.filter(item => item.action === 'delete').map(item => item.path);
		const paths = [...this.plan.extra, ...deleting];

		const facts = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		facts.createEl('li', { text: `应用方式：${APPLY_MODE_LABELS[report.applyMode]}` });
		if (report.forcedOverwrites > 0) {
			facts.createEl('li', { text: `会覆盖 ${report.forcedOverwrites} 个本地改动过的文件` });
		}
		if (paths.length > 0) {
			facts.createEl('li', { text: `会删除 ${paths.length} 个本地文件` });
		}
		facts.createEl('li', {
			text: report.keepBackup
				? '被覆盖 / 删掉的本地版本会先进回收目录（仓库/.trash/locally-save），还能捞回来'
				: '⚠ 回收目录已关：被覆盖 / 删掉的本地版本会直接消失',
		});

		if (paths.length > 0) {
			contentEl.createEl('h3', { text: '会被删掉的文件' });
			const list = contentEl.createDiv({ cls: 'locally-save-list' });
			for (const item of paths.slice(0, MAX_ROWS)) {
				list.createDiv({ text: item, cls: 'locally-save-row is-delete' });
			}
			if (paths.length > MAX_ROWS) {
				list.createDiv({ text: `…… 其余 ${paths.length - MAX_ROWS} 个已省略`, cls: 'locally-save-more' });
			}
		}

		new Setting(contentEl)
			.addButton(button => button
				.setButtonText('取消')
				.onClick(() => this.close()))
			.addButton(button => button
				.setButtonText('确认应用')
				.setWarning()
				.onClick(() => {
					this.close();
					this.onConfirm();
				}));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
