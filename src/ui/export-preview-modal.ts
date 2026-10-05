import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type LocallySavePlugin from '../main';
import type { BundleExportPreview } from '../bundle/export';
import { formatBytes } from '../utils/format';

/** 列表里最多列多少条 —— 几千条会把界面拖垮，剩下的用计数说明 */
const MAX_ROWS = 200;

/**
 * 导出预览：**这次留包会装什么**。
 *
 * 为什么要有：导出是"往磁盘写一个可能几百 MB 的文件"的动作，而"包里到底有什么"
 * 以前只有导完才能从结果里看到。这里把挑选结果（哪些文件、点名删哪些、多大）先摊开 ——
 * 只读不写，看完再决定。数据来自 `planBundleExport()`，与真正导出**共用同一套挑选逻辑**，
 * 不会出现"预览说一套、实际导另一套"。
 */
export class ExportPreviewModal extends Modal {
	private previews: BundleExportPreview[];
	private onConfirm: () => void;

	constructor(app: App, _plugin: LocallySavePlugin, previews: BundleExportPreview[], onConfirm: () => void) {
		super(app);
		this.previews = previews;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('locally-save-modal');
		contentEl.createEl('h2', { text: '导出预览' });
		contentEl.createEl('p', {
			text: '这一步只算不写：下面是按当前设置留包时会装进包里的东西。',
			cls: 'locally-save-hint',
		});

		for (const preview of this.previews) {
			contentEl.createEl('h3', { text: preview.mode === 'full' ? '完整副本' : '更新包' });
			if (preview.problem) {
				contentEl.createEl('p', { text: preview.problem, cls: 'locally-save-warn' });
				continue;
			}
			const parts = [`${preview.fileCount} 个文件`, `约 ${formatBytes(preview.bytes)}`];
			if (preview.mode === 'changes' && preview.deletedCount > 0) {
				parts.push(`点名删除 ${preview.deletedCount} 个`);
			}
			if (preview.mode === 'changes' && preview.anchorGeneration !== null) {
				parts.push(`基于第 ${preview.anchorGeneration} 代完整副本`);
			}
			contentEl.createEl('p', { text: parts.join(' · '), cls: 'locally-save-summary' });

			if (preview.fileCount === 0 && preview.deletedCount === 0) {
				contentEl.createEl('p', { text: '自上次完整副本以来没有变化，这个包不会生成。' });
				continue;
			}
			const list = contentEl.createDiv({ cls: 'locally-save-list' });
			for (const file of preview.files.slice(0, MAX_ROWS)) {
				const row = list.createDiv({ cls: 'locally-save-row is-modify' });
				row.createSpan({ text: '装入', cls: 'locally-save-action' });
				row.createSpan({ text: file, cls: 'locally-save-file' });
			}
			if (preview.files.length > MAX_ROWS) {
				list.createDiv({
					text: `…… 其余 ${preview.files.length - MAX_ROWS} 个文件已省略`,
					cls: 'locally-save-more',
				});
			}
			for (const file of preview.deleted.slice(0, MAX_ROWS)) {
				const row = list.createDiv({ cls: 'locally-save-row is-delete' });
				row.createSpan({ text: '点名删除', cls: 'locally-save-action' });
				row.createSpan({ text: file, cls: 'locally-save-file' });
			}
		}

		// 没有任何内容可留时，把出路写出来：想去导一份完整副本得走导出对话框
		const nothing = this.previews.every(item => item.problem || (item.fileCount === 0 && item.deletedCount === 0));
		if (nothing) {
			contentEl.createEl('p', {
				text: '要强行导一份完整副本（哪怕没有改动）：用命令「导出同步包…」，'
					+ '或者在设置 → Locally Save → 同步包 里点「导出同步包…」。',
				cls: 'locally-save-hint',
			});
		}

		new Setting(contentEl)
			.addButton(button => button
				.setButtonText('留包')
				.setCta()
				.setDisabled(nothing)
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
