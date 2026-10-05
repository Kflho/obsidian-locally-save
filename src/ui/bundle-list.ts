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
import { dirExists } from '../sync/disk';
import { formatBytes, formatTime } from '../utils/format';
import { openFolderInExplorer } from './reveal';

/**
 * 同步包列表 —— 导出弹窗、导入弹窗、管理弹窗**共用同一套**。
 *
 * 以前只有导入弹窗列包，而且除了"点一下检查它"什么也做不了：
 * 想删掉一个过时的包、想看看它到底在哪个目录，都只能去资源管理器里翻。
 * 这里把"常用操作"直接放到每一行上：检查 / 应用、打开所在文件夹、复制路径、删除。
 *
 * 列表只是**显示与转发**：扫描、删除、回收站都在 `bundle/manage.ts` 里（不 import obsidian，能直接测）。
 * Modal 不继承 Component，所以事件监听由本类自己挂、元素被清空时一起丢。
 */

/** 列表里最多列多少个包（再多也没人往下翻，还给"省略"一行说明） */
const MAX_BUNDLES = 20;

export interface BundleListViewOptions {
	/** 此刻要显示哪个目录里的包：弹窗里用户可能刚改过路径，所以给的是函数 */
	baseDir: () => string;
	/** 点某一行（选中） */
	onSelect?: (item: ManagedBundle) => void;
	/** 行内主动作（如「应用…」「检查」）；不给就不显示这个按钮 */
	actionLabel?: string;
	onAction?: (item: ManagedBundle) => void;
	/** 某个包被挪进回收站之后（导入弹窗要把当前选中的清掉） */
	onRemove?: (file: string) => void;
	/** 显示回收站那一行（只有管理弹窗要） */
	showTrash?: boolean;
	/** 列表为空时显示什么 */
	emptyText?: string;
}

export class BundleListView {
	private plugin: LocallySavePlugin;
	private options: BundleListViewOptions;
	private headEl!: HTMLElement;
	private listEl!: HTMLElement;
	/** 路径不存在 / 没有包之类的说明 */
	private noteEl!: HTMLElement;
	private trashEl: HTMLElement | null = null;
	private items: ManagedBundle[] = [];
	private selected: string | null = null;
	/** 包文件夹在不在：不在跟"里面没有包"要分开说，路径打错时前者更有用 */
	private baseExists = true;
	/** 刷新序号：连打几个字会触发好几次，异步读目录会乱序返回 */
	private token = 0;
	/** 攒着的那次刷新（见 schedule） */
	private pending: ReturnType<typeof setTimeout> | null = null;

	constructor(plugin: LocallySavePlugin, parent: HTMLElement, options: BundleListViewOptions) {
		this.plugin = plugin;
		this.options = options;
		this.headEl = parent.createDiv({ cls: 'locally-save-bundles-head' });
		this.noteEl = parent.createDiv({ cls: 'locally-save-hint' });
		// 回收站那一行放在**列表上面**：放下面时会被"最多 40vh 的滚动列表"顶出视野，
		// 用户翻不到就会问"删掉的包到底去哪了、回收站在哪"（报过）
		if (options.showTrash) this.trashEl = parent.createDiv({ cls: 'locally-save-trash' });
		this.listEl = parent.createDiv({ cls: 'locally-save-list' });
	}

	/**
	 * 路径输入框每敲一个字都会调它：攒 250 毫秒再扫。
	 *
	 * 直接 refresh 的话，敲一个路径就是十几次「读目录 + 挨个读包头部」——
	 * 包多的时候卡的是自己。按钮点击、删完包这种要立刻看到结果的**仍然直接 refresh**。
	 */
	schedule(): void {
		if (this.pending) clearTimeout(this.pending);
		this.pending = setTimeout(() => {
			this.pending = null;
			void this.refresh();
		}, 250);
	}

	/** 重新扫一遍包文件夹并重画 */
	async refresh(): Promise<void> {
		const token = ++this.token;
		const base = this.options.baseDir();
		const exists = base !== '' && await dirExists(base);
		const items = exists ? await listBundles(base) : [];
		if (token !== this.token) return; // 有更新的刷新在跑，这次的结果作废

		this.baseExists = exists;
		this.items = items;
		// 选中的包可能已经被删 / 被换过目录了
		if (this.selected && !items.some(item => item.file === this.selected)) this.selected = null;
		this.render();
		if (this.trashEl) await this.renderTrash();
	}

	/** 选中某个包（外面拖进来 / 粘了路径时同步高亮） */
	markSelected(file: string): void {
		this.selected = file;
		this.render();
	}

	private render(): void {
		const base = this.options.baseDir();
		this.headEl.empty();
		this.listEl.empty();
		this.noteEl.setText('');

		if (!base) {
			this.noteEl.setText('还没法确定位置：先在设置里填「目标文件夹」，或在这里填一个路径。');
			return;
		}
		if (!this.baseExists) {
			this.noteEl.setText(`这个文件夹不存在：${base}（检查一下路径，或者直接在下面粘包文件路径）`);
			return;
		}
		const full = this.items.filter(item => item.mode === 'full').length;
		const changes = this.items.filter(item => item.mode === 'changes').length;
		const unknown = this.items.filter(item => item.mode === null).length;
		this.headEl.createSpan({
			text: this.items.length > 0
				? `已有的同步包：${this.items.length} 个（更新 ${changes} · 完整 ${full}`
					+ `${unknown > 0 ? ` · 读不出头部 ${unknown}` : ''}）`
				: '已有的同步包',
		});
		const refreshButton = this.headEl.createEl('button', { text: '重新列出', cls: 'locally-save-mini' });
		refreshButton.addEventListener('click', () => { void this.refresh(); });

		if (this.items.length === 0) {
			this.listEl.createDiv({
				text: this.options.emptyText ?? '这个文件夹里没有 .lsave 文件',
				cls: 'locally-save-hint',
			});
			return;
		}

		// 分组：同一类排一起，组内从新到老（规则在 bundle/manage.ts 的 groupBundles）
		let shown = 0;
		for (const group of groupBundles(this.items)) {
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
				text: `…… 其余 ${this.items.length - shown} 个已省略（它们仍在文件夹里，删的时候去资源管理器按时间找）`,
				cls: 'locally-save-more',
			});
		}
	}

	private renderRow(item: ManagedBundle): void {
		const row = this.listEl.createDiv({
			cls: `locally-save-row is-bundle${item.file === this.selected ? ' is-selected' : ''}`
				+ `${item.header ? '' : ' is-unknown'}`,
		});
		row.setAttribute('title', item.error ? `读不出包头部：${item.error}` : item.file);
		// 类型由分组标题说了，行里不再重复标一遍；世代要写出来 ——
		// 两台机器的 full/ 目录各有一堆包时，靠它才看得出谁跟谁是同一份基准
		row.createSpan({ text: item.name, cls: 'locally-save-file' });
		const generation = item.header
			? (item.header.mode === 'full'
				? `第 ${item.header.targetGeneration} 代`
				: `基于第 ${item.header.baseGeneration ?? '?'} 代`)
			: '';
		row.createSpan({
			text: `${formatBytes(item.size)} · ${formatTime(item.mtime)}`
				+ `${generation ? ` · ${generation}` : ''}`
				+ (item.header ? '' : '（读不出头部，可能不是我们的包）'),
			cls: 'locally-save-reason',
		});

		const actions = row.createDiv({ cls: 'locally-save-bundle-actions' });
		if (this.options.actionLabel && this.options.onAction) {
			this.addButton(actions, this.options.actionLabel, false, () => this.options.onAction?.(item));
		}
		this.addButton(actions, '文件夹', false, () => openFolderInExplorer(
			item.dir,
			// App 的类型里没有声明 openWithDefaultApp（Obsidian 有，类型文件没跟上）
			this.plugin.app as unknown as { openWithDefaultApp?: (path: string) => void },
		));
		this.addButton(actions, '复制路径', false, () => { void copyPath(item.file); });
		// 两个删除并排：默认那个是"挪进回收站"（还能捞回来），旁边才是真删 ——
		// 只有"挪走"的话，想单独扔掉一个没用的包就得清空整个回收站（用户提的）
		this.addButton(actions, '挪进回收站', false, () => this.confirmTrash(item));
		this.addButton(actions, '彻底删除', true, () => this.confirmDelete(item));

		row.addEventListener('click', () => {
			this.selected = item.file;
			this.render();
			this.options.onSelect?.(item);
		});
	}

	/** 行内小按钮：点了别让整行的"选中"也跟着触发 */
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
	 * 删除 = **挪进回收站**，不是真删：同步包往往是"改动唯一的备份"，
	 * 手滑一下整份改动就没了。真要腾地方：单个包用旁边的「彻底删除」，
	 * 或者清空整个回收站。
	 */
	private confirmTrash(item: ManagedBundle): void {
		const root = bundleTrashRoot(this.options.baseDir());
		new ConfirmBundleModal(this.plugin.app, {
			title: '把同步包挪进回收站？',
			lines: [
				`${item.name}（${item.mode === 'full' ? '完整副本' : item.mode === 'changes' ? '更新包' : '类型未知'}，${formatBytes(item.size)}）`,
			],
			note: `文件会挪到 ${root}/时间戳/ ，需要时还能手动捞回来；`
				+ '确认没用了就点旁边的「彻底删除」（那个不进回收站），'
				+ '或者在列表上面的回收站那一行点「清空回收站」。',
			confirmText: '挪进回收站',
			onConfirm: async () => {
				const outcome = await trashBundles(this.options.baseDir(), [item.file]);
				if (outcome.failed.length > 0) {
					new Notice(`没能挪走 ${outcome.failed[0]?.path}：${outcome.failed[0]?.error}`, 9000);
				} else {
					// 把落脚点也报出来：用户想反悔时知道去哪儿捞
					new Notice(`已挪进回收站：${item.name}（${outcome.target}）`, 12000);
				}
				this.options.onRemove?.(item.file);
				await this.refresh();
			},
		}).open();
	}

	/**
	 * **彻底删除**：直接删文件，不进回收站。
	 *
	 * 跟"挪进回收站"分成两个按钮是刻意的：默认那条路永远能捞回来，
	 * 只有用户在这一步（标题、按钮文字、说明都写明"捞不回来"）再点一次才真删。
	 */
	private confirmDelete(item: ManagedBundle): void {
		new ConfirmBundleModal(this.plugin.app, {
			title: '彻底删除这个同步包？',
			lines: [
				`${item.name}（${item.mode === 'full' ? '完整副本' : item.mode === 'changes' ? '更新包' : '类型未知'}，${formatBytes(item.size)}）会被**直接删掉，不进回收站**`,
			],
			note: '这一步之后就捞不回来了。只是想把它从列表里清走的话，用旁边的「挪进回收站」—— 那一步还能捞回来。',
			confirmText: '彻底删除',
			onConfirm: async () => {
				const outcome = await deleteBundles([item.file]);
				if (outcome.failed.length > 0) {
					new Notice(`没能删掉 ${outcome.failed[0]?.path}：${outcome.failed[0]?.error}`, 9000);
				} else {
					new Notice(`已彻底删除：${item.name}`, 6000);
				}
				this.options.onRemove?.(item.file);
				await this.refresh();
			},
		}).open();
	}

	private async renderTrash(): Promise<void> {
		const host = this.trashEl;
		if (!host) return;
		host.empty();
		// 包文件夹都不存在时没什么好说的（下面那句"文件夹不存在"已经解释了）
		if (!this.baseExists) return;
		const contents = await readBundleTrash(this.options.baseDir());
		if (contents.count === 0) {
			host.createSpan({ text: '回收站：空的' });
			host.createSpan({
				text: '（点某个包的「挪进回收站」会把它挪到这里，还能手动捞回来）',
				cls: 'locally-save-hint',
			});
			return;
		}
		host.createSpan({ text: `回收站：${contents.count} 个包（${formatBytes(contents.bytes)}）` });
		const empty = host.createEl('button', { text: '清空回收站', cls: 'locally-save-mini is-danger' });
		empty.addEventListener('click', () => {
			new ConfirmBundleModal(this.plugin.app, {
				title: '清空回收站？',
				lines: [`回收站里的 ${contents.count} 个包（${formatBytes(contents.bytes)}）会被**真正删掉**`],
				note: '这一步之后就捞不回来了。只想真删某一个包的话，用那一行里的「彻底删除」；这里是把回收站整个清掉。',
				confirmText: '彻底删除',
				onConfirm: async () => {
					await emptyBundleTrash(this.options.baseDir());
					new Notice(`回收站已清空（${contents.count} 个包）`, 6000);
					await this.refresh();
				},
			}).open();
		});
		// 路径照实写出来：回收站的位置跟着同步包文件夹走，别让用户去找"那个 .lsave 到底在哪"
		host.createSpan({
			text: `删除的包都在这儿：${bundleTrashRoot(this.options.baseDir())}`,
			cls: 'locally-save-hint',
		});
	}
}

/** 复制路径：Obsidian 没给公开的剪贴板 API，用浏览器的；写不进去就把路径显示出来让人手抄 */
async function copyPath(file: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(file);
		new Notice(`已复制路径：${file}`, 6000);
	} catch {
		new Notice(`没能写进剪贴板，路径是：${file}`, 12000);
	}
}

/**
 * 一个很小的确认框：把"要动哪些文件、动到哪儿去"摊开说清楚再动手。
 *
 * 删除与清空回收站都是不可逆（或看着像不可逆）的动作，界面上必须先问一次。
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
		contentEl.addClass('locally-save-modal');
		contentEl.createEl('h2', { text: this.options.title });

		const facts = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		for (const line of this.options.lines) facts.createEl('li', { text: line });
		contentEl.createEl('p', { text: this.options.note, cls: 'locally-save-hint' });

		new Setting(contentEl)
			.addButton(button => button
				.setButtonText('取消')
				.onClick(() => this.close()))
			.addButton(button => button
				.setButtonText(this.options.confirmText)
				.setWarning()
				.onClick(() => {
					this.close();
					void this.options.onConfirm();
				}));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
