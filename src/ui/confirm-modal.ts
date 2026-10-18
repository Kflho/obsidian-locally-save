import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';
import { markDestructive } from './modal-layout';

/**
 * 一个最小的"确认"窗口：标题 + 几行说明 + 取消 / 确认。
 *
 * 用在**会覆盖本机内容**的动作上（比如「让我和对面一致」）：插件自己的规矩是
 * "删除 / 覆盖是唯一不可逆的动作，宁可先问一句"，不拿一条 Notice 糊弄过去。
 *
 * 两种用法：
 * - 只给 `onConfirm`（点按钮时执行动作）；
 * - 给 `onResolve`（回调布尔结果，调用方 `await` 它）—— 自动收包那条路要"等用户点完再决定应用"，
 *   取消 / 关窗 / 点确认都会**只回报一次**，不会重复也不悬着。
 */
export class ConfirmModal extends Modal {
	private title: string;
	private lines: string[];
	private confirmText: string;
	private onConfirm: (() => void) | undefined;
	private onResolve: ((ok: boolean) => void) | undefined;
	private settled = false;

	constructor(app: App, options: {
		title: string;
		lines: string[];
		confirmText: string;
		onConfirm?: () => void;
		onResolve?: (ok: boolean) => void;
	}) {
		super(app);
		this.title = options.title;
		this.lines = options.lines;
		this.confirmText = options.confirmText;
		this.onConfirm = options.onConfirm;
		this.onResolve = options.onResolve;
	}

	/** 只回报一次：确认 / 取消 / ESC / 点外面关掉，都算 */
	private settle(ok: boolean): void {
		if (this.settled) return;
		this.settled = true;
		this.onResolve?.(ok);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: this.title });
		for (const line of this.lines) contentEl.createEl('p', { text: line });
		new Setting(contentEl)
			.addButton(button => button
				.setButtonText('取消')
				.onClick(() => {
					this.settle(false);
					this.close();
				}))
			.addButton(button => {
				button.setButtonText(this.confirmText).onClick(() => {
					// 先回报、再关窗：关窗会走 onClose，那里的 settle(false) 会被这次 settle(true) 挡掉
					this.settle(true);
					this.close();
					this.onConfirm?.();
				});
				markDestructive(button);
			});
	}

	onClose(): void {
		this.contentEl.empty();
		this.settle(false);
	}
}
