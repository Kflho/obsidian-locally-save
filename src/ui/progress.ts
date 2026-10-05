import type { SyncProgress } from '../sync/runner';

/** 状态栏进度最多多久写一次 DOM（毫秒） */
export const PROGRESS_THROTTLE_MS = 100;

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
	/** 上一次真的写了 DOM 的时间与文字（进度更新要节流，见 showProgress） */
	private lastProgressAt = 0;
	private lastProgressText = '';

	constructor(el: HTMLElement) {
		this.el = el;
		this.el.addClass('locally-save-status');
		this.render();
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		this.render();
	}

	/**
	 * 同步进行中：显示 done/total；传 null 表示收工（回到上次结果）。
	 *
	 * **节流**：引擎是"每个文件报一次进度"，一万个文件就是一万次 `setText` ——
	 * 光是这些 DOM 写入就够让界面发顿（用户报的"卡界面"里有它一份）。
	 * 所以 100 毫秒内的重复更新直接丢掉，收工那一次（null）一定会写。
	 *
	 * 动词由调用方给（同步中 / 导出中 / 应用中）：同一个数字在不同的活里
	 * 意思不一样，别让用户在导出时看到"同步中"。
	 */
	showProgress(progress: SyncProgress | null): void {
		if (!progress) {
			this.lastProgressText = '';
			this.render();
			return;
		}
		const text = `${progress.label ?? '同步中'} ${progress.done}/${progress.total}`;
		if (text === this.lastProgressText) return;
		const now = Date.now();
		if (progress.done < progress.total && now - this.lastProgressAt < PROGRESS_THROTTLE_MS) return;
		this.lastProgressAt = now;
		this.lastProgressText = text;
		this.el.setText(text);
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
