/** 状态栏进度最多多久写一次 DOM（毫秒） */
export const PROGRESS_THROTTLE_MS = 100;

/**
 * 状态栏上的一次进度：`done / total` 的含义由发起方决定
 * （导出＝已经打进包里几个文件 / 一共几个）。
 */
export interface SyncProgress {
	done: number;
	total: number;
	path: string;
	/**
	 * 状态栏上那句动词，默认"同步中"。
	 * 导出 / 应用同步包也借这一格显示进度，界面要能说清此刻在干什么。
	 */
	label?: string;
}

/**
 * 状态栏那一格：平时写一句结果，跑长活时写进度 / 阶段。
 *
 * 优先级：**进度（n/m）> 阶段（"推拉中…"）> 上次结果**。
 * 用户提过右下角太啰嗦 —— 所以平时只有一句 `已同步 12:31 · 对方一致`，
 * 细节（上次留包几个文件、攒了多大）在更新记录 / 通知里。
 */
export class SyncStatusBar {
	private el: HTMLElement;
	private summary = '尚未同步';
	/** 悬停时显示的详情（每台机器一行；点击还能打开完整窗口） */
	private detail = '';
	private visible = true;
	/** 阶段文案（"正在拉取…"）；null ＝ 没在跑长活 */
	private activity: string | null = null;
	/** 进度文案（"导出中 12/100"）；空闲时是空串 */
	private progressText = '';
	/** 上一次真的写了 DOM 的时间与文字（进度更新要节流，见 showProgress） */
	private lastProgressAt = 0;
	private lastProgressText = '';
	/** `flash()` 那几秒的收尾定时器 */
	private flashTimer: number | null = null;

	constructor(el: HTMLElement, onClick?: () => void) {
		this.el = el;
		this.el.addClass('locally-save-status');
		if (onClick) {
			this.el.addClass('locally-save-status-clickable');
			this.el.addEventListener('click', () => onClick());
		}
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
	 * 动词由调用方给（导出中 / 应用中）：同一个数字在不同的活里
	 * 意思不一样，别让用户在导出时看到"同步中"。
	 */
	showProgress(progress: SyncProgress | null): void {
		if (!progress) {
			this.progressText = '';
			this.lastProgressText = '';
			this.render();
			return;
		}
		const text = `${progress.label ?? '处理中'} ${progress.done}/${progress.total}`;
		this.progressText = text;
		if (text === this.lastProgressText) return;
		const now = Date.now();
		if (progress.done < progress.total && now - this.lastProgressAt < PROGRESS_THROTTLE_MS) return;
		this.lastProgressAt = now;
		this.lastProgressText = text;
		this.el.setText(text);
	}

	/**
	 * 阶段文案（"同步中：拉取远程…"），用于**没有文件计数**的步骤（git 推拉）。
	 * 传 null 收工，回到上次结果。
	 */
	showActivity(text: string | null): void {
		// 真要演别的了，就别让 `flash` 的收尾定时器把新文案提前清掉
		if (this.flashTimer !== null) {
			window.clearTimeout(this.flashTimer);
			this.flashTimer = null;
		}
		this.activity = text;
		this.lastProgressText = '';
		this.render();
	}

	/**
	 * **顶一句结果、过几秒回到上次结果**（不弹通知的那种"报一句"）。
	 *
	 * 用在哪：自动收包把对方的改动落进仓库之后 —— 那是"你该知道、但不用你动手"的事。
	 * 以前它是一条右上角通知，用户嫌"不断显示信息"；可完全不说不等于没事发生，
	 * 所以放状态栏：`已应用对方更新 · 写入 3 · 删除 1`，看几秒就自动回到
	 * `已推送 12:31 · 对方：一致` 那一句。
	 */
	flash(text: string, ms = 8000): void {
		this.activity = text;
		this.lastProgressText = '';
		this.render();
		if (this.flashTimer !== null) window.clearTimeout(this.flashTimer);
		this.flashTimer = window.setTimeout(() => {
			this.flashTimer = null;
			this.activity = null;
			this.render();
		}, ms);
	}

	/** 收工后写一句结果 */
	setSummary(text: string): void {
		this.summary = text;
		this.render();
	}

	/** 悬停提示：每台机器一行（没有多台时为空） */
	setDetail(text: string): void {
		this.detail = text;
		this.render();
	}

	private render(): void {
		this.el.toggleClass('locally-save-hidden', !this.visible);
		if (!this.visible) return;
		// 进度 > 阶段 > 上次结果
		const text = this.progressText !== '' ? this.progressText : (this.activity ?? this.summary);
		this.el.setText(text);
		this.el.setAttribute('aria-label', `Locally Save：${text}`);
		this.el.setAttribute('title', this.detail !== '' ? this.detail : `Locally Save：${text}`);
	}
}
