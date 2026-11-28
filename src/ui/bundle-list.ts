import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type LocallySavePlugin from '../main';
import {
	bundleTrashRoot,
	deleteBundles,
	emptyBundleTrash,
	groupBundles,
	listBundles,
	readBundleTrash,
	trashBundles,
} from '../bundle/manage';
import type { ManagedBundle } from '../bundle/manage';
import { baselineOfBundle } from '../bundle/baseline';
import { dirExists } from '../sync/disk';
import { loadState, loadStateSync } from '../sync/state';
import type { PluginState } from '../sync/state';
import { formatBytes, formatTime } from '../utils/format';
import { syncGitNow } from './git';
import { markDestructive, setupModal } from './modal-layout';
import { openFolderInExplorer } from './reveal';

/**
 * 同步包列表：导出、应用、管理三个弹窗共用。
 *
 * 每行显示两行信息：第一行写类型、版本与“当前基准”，第二行写内容编号、大小与时间。
 * 行内只放一个主要动作和一个“更多”按钮；删除、复制路径、打开文件夹放进展开区，
 * 避免一行五六个按钮把信息列压成竖排。
 *
 * 列表只负责显示与转发：扫描、删除、回收站在 `bundle/manage.ts` 里（不 import obsidian，能直接测）。
 * Modal 不继承 Component，所以事件监听由本类自己挂、元素被清空时一起丢。
 */

/** 列表里最多显示多少个包；超出时列出一行说明与总数。 */
const MAX_BUNDLES = 20;

export interface BundleListViewOptions {
	/** 此刻显示哪个目录里的包：弹窗里用户可能刚改过路径，所以给函数。 */
	baseDir: () => string;
	/** 点某一行（选中）。 */
	onSelect?: (item: ManagedBundle) => void;
	/** 行内主要动作（如「应用」）；不提供时不显示按钮。 */
	actionLabel?: string;
	onAction?: (item: ManagedBundle) => void;
	/**
	 * 完整备份那一行多出来的动作（如「以这一份为基准」）。
	 * 只对完整备份出现：更新包本身不是完整内容，要由应用那边计算目标状态。
	 * 回调进入应用对话框，先出报告再动手。
	 */
	baselineLabel?: string;
	onBaseline?: (item: ManagedBundle) => void;
	/** 某个包被移到回收站之后（应用弹窗要清掉当前选中项）。 */
	onRemove?: (file: string) => void;
	/** 显示回收站那一行（管理弹窗与导出弹窗需要）。 */
	showTrash?: boolean;
	/** 顶部状态条：本电脑版本、当前基准、内容编号。 */
	showPosition?: boolean;
	/** 列表为空时显示的文字。 */
	emptyText?: string;
}

export class BundleListView {
	private plugin: LocallySavePlugin;
	private options: BundleListViewOptions;
	private headEl!: HTMLElement;
	private listEl!: HTMLElement;
	/** 路径不存在 / 没有包之类的说明。 */
	private noteEl!: HTMLElement;
	/** 顶部状态条（可选，见 showPosition）。 */
	private positionEl: HTMLElement | null = null;
	private trashEl: HTMLElement | null = null;
	private items: ManagedBundle[] = [];
	private selected: string | null = null;
	/** 本电脑状态：标出“哪个包是当前基准”，并填充顶部状态条。 */
	private local: PluginState | null = null;
	/** 同步包文件夹在不在：与“里面没有包”分开说明。 */
	private baseExists = true;
	/** 刷新序号：连续输入会触发多次刷新，异步读目录可能乱序返回。 */
	private token = 0;
	/** 待执行的那次刷新（见 schedule）。 */
	private pending: number | null = null;

	constructor(plugin: LocallySavePlugin, parent: HTMLElement, options: BundleListViewOptions) {
		this.plugin = plugin;
		this.options = options;
		this.headEl = parent.createDiv({ cls: 'locally-save-bundles-head' });
		if (options.showPosition) this.positionEl = parent.createDiv({ cls: 'locally-save-position' });
		this.noteEl = parent.createDiv({ cls: 'locally-save-hint' });
		if (options.showTrash) this.trashEl = parent.createDiv({ cls: 'locally-save-trash' });
		this.listEl = parent.createDiv({ cls: 'locally-save-list' });
	}

	/**
	 * 路径输入框每输入一个字都会调用它：等待 250 毫秒再扫描。
	 * 按钮点击、删除之后仍直接调用 refresh，立即看到结果。
	 */
	schedule(): void {
		if (this.pending) window.clearTimeout(this.pending);
		this.pending = window.setTimeout(() => {
			this.pending = null;
			void this.refresh();
		}, 250);
	}

	/** 重新扫描同步包文件夹并重画。 */
	async refresh(): Promise<void> {
		const token = ++this.token;
		const base = this.options.baseDir();
		const exists = base !== '' && await dirExists(base);
		const items = exists ? await listBundles(base) : [];
		if (token !== this.token) return;
		if (this.positionEl) {
			try {
				this.local = await loadState(this.plugin.stateFile());
			} catch {
				this.local = null;
			}
		}

		this.baseExists = exists;
		this.items = items;
		if (this.selected && !items.some(item => item.file === this.selected)) this.selected = null;
		this.render();
		if (this.trashEl) await this.renderTrash();
	}

	/** 选中某个包（拖入 / 粘贴路径时同步高亮）。 */
	markSelected(file: string): void {
		this.selected = file;
		this.render();
	}

	private render(): void {
		const base = this.options.baseDir();
		this.headEl.empty();
		this.listEl.empty();
		this.noteEl.setText('');
		this.renderPosition();

		if (!base) {
			this.noteEl.setText('尚未确定位置：请先在设置中填写「同步包文件夹」，或在此填写一个路径。');
			return;
		}
		if (!this.baseExists) {
			this.noteEl.setText(`文件夹不存在：${base}（检查路径，或直接粘贴包文件路径）`);
			return;
		}
		const full = this.items.filter(item => item.mode === 'full').length;
		const changes = this.items.filter(item => item.mode === 'changes').length;
		const unknown = this.items.filter(item => item.mode === null).length;
		this.headEl.createSpan({
			text: this.items.length > 0 ? `同步包 ${this.items.length} 个` : '同步包',
		});
		if (this.items.length > 0) {
			this.headEl.createSpan({
				text: `更新 ${changes} · 完整 ${full}${unknown > 0 ? ` · 读不出信息 ${unknown}` : ''}`,
				cls: 'locally-save-hint',
			});
		}
		const refreshButton = this.headEl.createEl('button', { text: '重新列出', cls: 'locally-save-mini' });
		refreshButton.addEventListener('click', () => { void this.refresh(); });

		if (this.items.length === 0) {
			this.listEl.createDiv({
				text: this.options.emptyText ?? '同步包文件夹里没有 .lsave 文件',
				cls: 'locally-save-hint',
			});
			return;
		}

		let mine: string | null = null;
		try {
			mine = loadStateSync(this.plugin.stateFile())?.copyId ?? null;
		} catch {
			mine = null;
		}
		let shown = 0;
		for (const group of groupBundles(this.items, mine)) {
			if (group.items.length === 0 || shown >= MAX_BUNDLES) continue;
			this.listEl.createDiv({
				text: `${group.title}（${group.items.length} 个）`,
				cls: 'locally-save-bundles-group',
			});
			for (const item of group.items.slice(0, MAX_BUNDLES - shown)) {
				this.renderRow(item);
				shown++;
			}
		}
		if (this.items.length > shown) {
			this.listEl.createDiv({
				text: `未显示 ${this.items.length - shown} 个（仍在文件夹里，可在资源管理器中按时间查找）`,
				cls: 'locally-save-more',
			});
		}
	}

	/** 一行：标题与元数据各一行，右侧一个主要动作与“更多”。 */
	private renderRow(item: ManagedBundle): void {
		const row = this.listEl.createDiv({
			cls: `locally-save-row is-bundle${item.file === this.selected ? ' is-selected' : ''}`
				+ `${item.header ? '' : ' is-unknown'}`,
		});
		row.setAttribute('title', item.error ? `读不出包信息：${item.error}` : item.file);

		const main = row.createDiv({ cls: 'locally-save-row-main' });
		main.createSpan({ text: this.titleOf(item), cls: 'locally-save-row-title' });
		if (this.isCurrentBaseline(item)) {
			main.createSpan({ text: '当前完整备份', cls: 'locally-save-current' });
		}

		const meta = row.createDiv({ cls: 'locally-save-row-meta', text: this.metaOf(item) });
		const stateId = item.header?.stateId?.id;
		if (stateId) meta.setAttribute('title', stateId);

		const actions = row.createDiv({ cls: 'locally-save-row-actions' });
		if (this.options.actionLabel && this.options.onAction) {
			this.addButton(actions, this.options.actionLabel, false, () => this.options.onAction?.(item));
		}
		const moreButton = actions.createEl('button', { text: '更多', cls: 'locally-save-mini' });
		moreButton.setAttribute('aria-label', '更多操作');
		let actionsOpen = false;
		moreButton.addEventListener('click', (event: Event) => {
			event?.stopPropagation?.();
			actionsOpen = !actionsOpen;
			row.toggleClass('is-actions-open', actionsOpen);
		});

		const more = row.createDiv({ cls: 'locally-save-row-more' });
		if (this.options.baselineLabel && this.options.onBaseline && item.mode === 'full' && item.header) {
			this.addButton(more, this.options.baselineLabel, false,
				() => this.options.onBaseline?.(item));
		}
		this.addButton(more, '打开文件夹', false, () => openFolderInExplorer(
			item.dir,
			// App 的类型里没有声明 openWithDefaultApp（Obsidian 有，类型文件没跟上）
			this.plugin.app as unknown as { openWithDefaultApp?: (path: string) => void },
		));
		this.addButton(more, '复制路径', false, () => { void copyPath(item.file); });
		this.addButton(more, '移到回收站', false, () => this.confirmTrash(item));
		this.addButton(more, '彻底删除', true, () => this.confirmDelete(item));

		row.addEventListener('click', () => {
			this.selected = item.file;
			this.render();
			this.options.onSelect?.(item);
		});
	}

	/** 第一行：类型与版本。 */
	private titleOf(item: ManagedBundle): string {
		const header = item.header;
		if (!header) return '无法读取包信息';
		if (header.mode === 'full') return `完整备份 · 第 ${header.targetGeneration} 版`;
		return `更新包 · 第 ${header.baseGeneration ?? '?'} 版 → 第 ${header.targetGeneration} 版`;
	}

	/** 第二行：内容编号、大小、时间；完整编号放悬停。 */
	private metaOf(item: ManagedBundle): string {
		const size = formatBytes(item.size);
		const time = formatTime(item.created ?? item.mtime);
		const id = item.header?.stateId?.id;
		const idText = id ? `内容编号 ${id.slice(0, 8)}` : '内容编号未记录';
		if (!item.header) return `${size} · ${time} · 读不出包信息`;
		return `${idText} · ${size} · ${time}`;
	}

	/** 这一行是不是本电脑当前使用的完整备份：文件名与基准校验值都要对上。 */
	private isCurrentBaseline(item: ManagedBundle): boolean {
		const local = this.local?.bundle;
		if (!local?.fullFile || !item.header) return false;
		return local.fullFile === item.name && local.fullHash === baselineOfBundle(item.header);
	}

	/** 顶部状态条：三个事实，代替一句长话。 */
	private renderPosition(): void {
		const host = this.positionEl;
		if (!host) return;
		host.empty();
		const state = this.local;
		if (!state) {
			host.setText('无法读取本电脑状态：下面只列出同步包文件夹中的内容');
			return;
		}
		const id = state.stateId?.id ?? '';
		const facts: [string, string][] = [
			['本电脑内容', `第 ${state.generation} 版`],
			['当前完整备份', state.bundle?.fullGeneration
				? `第 ${state.bundle.fullGeneration} 版完整备份`
				: '未记录'],
			['内容编号', id ? id.slice(0, 8) : '未计算'],
		];
		const strip = host.createDiv({ cls: 'locally-save-facts-strip' });
		for (const [label, value] of facts) {
			const cell = strip.createDiv({ cls: 'locally-save-fact' });
			cell.createDiv({ text: label, cls: 'locally-save-fact-label' });
			const valueEl = cell.createDiv({ text: value, cls: 'locally-save-fact-value' });
			if (label === '内容编号' && id) valueEl.setAttribute('title', id);
		}
	}

	/** 行内小按钮：点击时不触发行选中。 */
	private addButton(host: HTMLElement, text: string, danger: boolean, handler: () => void): void {
		const button = host.createEl('button', {
			text,
			cls: `locally-save-mini${danger ? ' is-danger' : ''}`,
		});
		button.addEventListener('click', (event: Event) => {
			event?.stopPropagation?.();
			handler();
		});
	}

	/**
	 * 删除 = 移到回收站，不是直接删除：同步包往往是某次改动唯一的备份。
	 * 要腾出空间时，单个包可用「彻底删除」，或者清空整个回收站。
	 */
	private confirmTrash(item: ManagedBundle): void {
		new ConfirmBundleModal(this.plugin.app, {
			title: '移到回收站',
			lines: [
				`${item.name}（${item.mode === 'full' ? '完整备份' : item.mode === 'changes' ? '更新包' : '类型未知'}，${formatBytes(item.size)}）`,
			],
			note: '文件会移入回收站里的时间戳目录，可从回收站恢复。确认无用后，可在回收站那一行清空。',
			confirmText: '移到回收站',
			onConfirm: async () => {
				const outcome = await trashBundles(this.options.baseDir(), [item.file]);
				if (outcome.failed.length > 0) {
					new Notice(`无法移动 ${outcome.failed[0]?.path}。原因：${outcome.failed[0]?.error}。`, 9000);
				} else {
					new Notice(`已移到回收站：${item.name}`, 8000);
				}
				this.options.onRemove?.(item.file);
				if (this.plugin.settings.gitEnabled) void syncGitNow(this.plugin, { quiet: true });
				await this.refresh();
			},
		}).open();
	}

	/** 彻底删除：直接删除文件，不进入回收站。 */
	private confirmDelete(item: ManagedBundle): void {
		new ConfirmBundleModal(this.plugin.app, {
			title: '删除同步包',
			lines: [
				`${item.name}（${item.mode === 'full' ? '完整备份' : item.mode === 'changes' ? '更新包' : '类型未知'}，${formatBytes(item.size)}）会被直接删除，不进入回收站`,
			],
			note: '删除后无法恢复。只想从列表中移除时，请使用「移到回收站」。',
			confirmText: '彻底删除',
			onConfirm: async () => {
				const outcome = await deleteBundles([item.file], this.options.baseDir());
				if (outcome.failed.length > 0) {
					new Notice(`无法删除 ${outcome.failed[0]?.path}。原因：${outcome.failed[0]?.error}。`, 9000);
				} else {
					new Notice(`已彻底删除：${item.name}`, 6000);
				}
				this.options.onRemove?.(item.file);
				if (this.plugin.settings.gitEnabled) void syncGitNow(this.plugin, { quiet: true });
				await this.refresh();
			},
		}).open();
	}

	/** 回收站：计数、打开目录、清空。 */
	private async renderTrash(): Promise<void> {
		const host = this.trashEl;
		if (!host) return;
		host.empty();
		if (!this.baseExists) return;
		const contents = await readBundleTrash(this.options.baseDir());
		if (contents.count === 0) {
			host.createSpan({ text: '回收站为空' });
			host.createSpan({
				text: '删除的包会移入回收站，可从回收站恢复。',
				cls: 'locally-save-hint',
			});
			return;
		}
		host.createSpan({ text: `回收站 ${contents.count} 个包 · ${formatBytes(contents.bytes)}` });
		const open = host.createEl('button', { text: '打开', cls: 'locally-save-mini' });
		open.setAttribute('title', bundleTrashRoot(this.options.baseDir()));
		open.addEventListener('click', () => openFolderInExplorer(
			bundleTrashRoot(this.options.baseDir()),
			this.plugin.app as unknown as { openWithDefaultApp?: (path: string) => void },
		));
		const empty = host.createEl('button', { text: '清空', cls: 'locally-save-mini is-danger' });
		empty.addEventListener('click', () => {
			new ConfirmBundleModal(this.plugin.app, {
				title: '清空回收站',
				lines: [`回收站里的 ${contents.count} 个包（${formatBytes(contents.bytes)}）会被真正删除`],
				note: '清空后无法恢复。只想删除某一个同步包时，使用那一行的「彻底删除」。',
				confirmText: '彻底删除',
				onConfirm: async () => {
					await emptyBundleTrash(this.options.baseDir());
					new Notice(`回收站已清空（${contents.count} 个包）`, 6000);
					await this.refresh();
				},
			}).open();
		});
	}
}

/** 复制路径：Obsidian 没有公开的剪贴板 API，使用浏览器的；写入失败时提示原因。 */
async function copyPath(file: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(file);
		new Notice('已复制包文件的完整路径。', 5000);
	} catch {
		new Notice(`无法写入剪贴板。路径为：${file}`, 12000);
	}
}

/**
 * 确认框：列出要动的包、移动到哪里，再执行。
 * 删除与清空回收站都不可逆，界面上先确认一次。
 */
class ConfirmBundleModal extends Modal {
	private options: {
		title: string;
		lines: string[];
		note: string;
		confirmText: string;
		onConfirm: () => void | Promise<void>;
	};

	constructor(app: App, options: ConfirmBundleModal['options']) {
		super(app);
		this.options = options;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		setupModal(this);
		contentEl.createEl('h2', { text: this.options.title });

		const facts = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		for (const line of this.options.lines) facts.createEl('li', { text: line });
		contentEl.createEl('p', { text: this.options.note, cls: 'locally-save-hint' });

		new Setting(contentEl)
			.addButton(button => button
				.setButtonText('取消')
				.onClick(() => this.close()))
			.addButton(button => {
				button.setButtonText(this.options.confirmText);
				markDestructive(button);
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
