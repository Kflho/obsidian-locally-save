import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';

/**
 * 「检查环境」的小窗口：把 git 版本、货架状态、和远程差多少摊开看一眼。
 *
 * 不在这里直接调 `syncGitNow`（那会让 `ui/git.ts` 与这个文件互相 import）：
 * 抽屉里只放一个按钮，动作由调用方传进来。
 */
export class GitStatusModal extends Modal {
	private lines: string[];
	private onSync: (() => void) | null;
	private title: string;

	constructor(app: App, lines: string[], onSync?: () => void, title = 'Git 远程') {
		super(app);
		this.lines = lines;
		this.onSync = onSync ?? null;
		this.title = title;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: this.title });
		const box = contentEl.createDiv({ cls: 'locally-save-git-status' });
		for (const line of this.lines) box.createEl('p', { text: line });

		new Setting(contentEl)
			.addButton(button => button
				.setButtonText('关闭')
				.onClick(() => this.close()))
			.addButton(button => {
				button.setButtonText('现在同步一次').setCta().onClick(() => {
					this.close();
					this.onSync?.();
				});
				if (!this.onSync) button.setDisabled(true);
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
