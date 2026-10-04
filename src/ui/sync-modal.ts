import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type LocallySavePlugin from '../main';
import type { SyncOutcome } from '../sync/runner';
import { ACTION_LABELS, CHANGE_LABELS } from '../sync/types';

/** 预览里最多列多少条 —— 几千条会把界面拖垮，剩下的用计数说明 */
const MAX_ROWS = 200;

/**
 * 同步预览：把"这次会干什么"摊开给人看，确认了才动手。
 *
 * 同步是**会改文件**的操作，哪怕判定逻辑再稳，也该让用户有机会先看一眼 ——
 * 尤其是删除与冲突这两类。
 */
export class SyncPreviewModal extends Modal {
	private plugin: LocallySavePlugin;
	private outcome: SyncOutcome;
	private onConfirm: () => void;

	constructor(app: App, plugin: LocallySavePlugin, outcome: SyncOutcome, onConfirm: () => void) {
		super(app);
		this.plugin = plugin;
		this.outcome = outcome;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		const { plan } = this.outcome;
		contentEl.empty();
		contentEl.addClass('locally-save-modal');
		contentEl.createEl('h2', { text: '同步预览' });

		contentEl.createEl('p', {
			text: `目标：${this.outcome.targetDir}`,
			cls: 'locally-save-path',
		});
		contentEl.createEl('p', {
			text: `本地 ${this.outcome.scannedLocal} 个文件 · 副本 ${this.outcome.scannedRemote} 个文件 · `
				+ `一致 ${plan.unchanged} 个 · 待处理 ${plan.actions.length} 项`,
		});

		if (plan.actions.length === 0) {
			contentEl.createEl('p', { text: '两边已经一致，没有需要处理的内容。' });
		} else {
			const summary = Object.entries(plan.summary)
				.filter(([, count]) => count > 0)
				.map(([kind, count]) => `${CHANGE_LABELS[kind as keyof typeof CHANGE_LABELS]} ${count}`)
				.join(' · ');
			contentEl.createEl('p', { text: summary, cls: 'locally-save-summary' });

			const list = contentEl.createDiv({ cls: 'locally-save-list' });
			for (const action of plan.actions.slice(0, MAX_ROWS)) {
				const row = list.createDiv({ cls: `locally-save-row is-${action.change}` });
				row.createSpan({ text: ACTION_LABELS[action.kind], cls: 'locally-save-action' });
				row.createSpan({ text: action.from ? `${action.from} → ${action.path}` : action.path, cls: 'locally-save-file' });
				row.createSpan({ text: action.reason, cls: 'locally-save-reason' });
			}
			if (plan.actions.length > MAX_ROWS) {
				list.createDiv({
					text: `…… 其余 ${plan.actions.length - MAX_ROWS} 项已省略`,
					cls: 'locally-save-more',
				});
			}
		}

		new Setting(contentEl)
			.addButton(button => button
				.setButtonText('执行同步')
				.setCta()
				.setDisabled(plan.actions.length === 0)
				.onClick(() => {
					this.close();
					this.onConfirm();
				}))
			.addButton(button => button
				.setButtonText('取消')
				.onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
