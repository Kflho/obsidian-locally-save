import type { SyncProgress } from '../sync/runner';

/**
 * 状态栏那一格：同步中显示进度，平时显示上次同步的结果。
 *
 * 进度与结果共用一个元素是刻意的 —— 用户只关心"现在在干什么 / 上次干得怎么样"，
 * 分两格反而要来回找。
 */
export class SyncStatusBar {
	private el: HTMLElement;
	private summary = '尚未同步';
	private visible = true;

	constructor(el: HTMLElement) {
		this.el = el;
		this.el.addClass('locally-save-status');
		this.render();
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		this.render();
	}

	/** 同步进行中：显示 done/total；传 null 表示收工（回到上次结果） */
	showProgress(progress: SyncProgress | null): void {
		if (!progress) {
			this.render();
			return;
		}
		this.el.setText(`同步中 ${progress.done}/${progress.total}`);
	}

	/** 收工后写一句结果 */
	setSummary(text: string): void {
		this.summary = text;
		this.render();
	}

	private render(): void {
		this.el.toggleClass('locally-save-hidden', !this.visible);
		if (!this.visible) return;
		this.el.setText(this.summary);
		this.el.setAttribute('aria-label', `Locally Save：${this.summary}`);
	}
}
