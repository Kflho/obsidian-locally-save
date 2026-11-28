import { Modal, Setting } from 'obsidian';
import { setupModal } from './modal-layout';
import type { App } from 'obsidian';
import type LocallySavePlugin from '../main';
import { describeBundlePosition, describeLogEntry } from '../bundle/log';
import { loadState } from '../sync/state';
import type { BundleLogEntry } from '../sync/state';
import { formatTime } from '../utils/format';

/**
 * 「同步包更新记录」—— 像 git log 那样把来龙去脉摊开。
 *
 * 为什么不放进别的窗口：这份记录回答的是"我现在用哪份完整备份上、中间收发过哪些更新包"，
 * 用户想核对/排查时会专门来看它（用户提的："类似 git 的更新记录功能，比较直观"）。
 */
export class BundleLogModal extends Modal {
	private plugin: LocallySavePlugin;
	private listEl!: HTMLElement;

	constructor(app: App, plugin: LocallySavePlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		setupModal(this);
		contentEl.createEl('h2', { text: '同步包更新记录' });
		contentEl.createEl('p', {
			text: '每次导出或应用记一笔，最近的在上。「状态」编号相同，两台电脑内容一致。'
				+ '版本只说内容走到第几版；要认是不是同一份完整备份，看完整备份编号。'
				+ '本电脑当前使用的那份完整备份只在导出或应用它时改变，更新包不会动它。',
			cls: 'locally-save-hint',
		});

		this.listEl = contentEl.createDiv({ cls: 'locally-save-list' });
		this.listEl.setText('正在读记录…');

		new Setting(contentEl)
			.addButton(button => button
				.setButtonText('关闭')
				.onClick(() => this.close()));

		void this.refresh();
	}

	private async refresh(): Promise<void> {
		this.listEl.empty();
		try {
			const state = await loadState(this.plugin.stateFile());
			// 顶部：我现在在哪儿
			const head = this.listEl.createDiv({ cls: 'locally-save-log-head' });
			for (const line of describeBundlePosition(state)) {
				head.createDiv({ text: line });
			}

			const entries: BundleLogEntry[] = state.bundleLog ?? [];
			if (entries.length === 0) {
				this.listEl.createDiv({
					text: '还没有记录：导出或应用一次同步包就会有了。',
					cls: 'locally-save-hint',
				});
				return;
			}
			// 最近的排最上面（用户关心的是"刚才发生了什么"）
			for (const entry of [...entries].reverse()) {
				const row = this.listEl.createDiv({
					cls: `locally-save-row ${entry.direction === 'export' ? 'is-add' : 'is-modify'}`
						+ `${entry.mode === 'full' ? ' is-baseline' : ''}`,
				});
				row.createSpan({ text: formatTime(entry.at), cls: 'locally-save-log-time' });
				row.createSpan({ text: describeLogEntry(entry), cls: 'locally-save-file' });
			}
		} catch (error) {
			this.listEl.empty();
			this.listEl.setText(`读不到记录：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
