import type { Modal } from 'obsidian';

/**
 * 对话框的"铺满窗口"。
 *
 * 为什么要有：同步包的应用报告 + 文件列表很长，挤在默认宽度的对话框里要一直滚，
 * 背景又被遮罩压暗，用户很容易以为"界面卡死了"。铺满之后一眼能看到全部内容，
 * 也不用在小盒子里翻 —— 这个类只管尺寸，样式在 styles.css。
 *
 * 只加一个类：随时能关（设置里与对话框里各有一个开关，共用同一个设置项）。
 */

/** 铺满窗口用的类名 */
export const FULLSCREEN_MODAL_CLASS = 'locally-save-fullscreen';

/** 铺满（或恢复）一个对话框 */
export function setModalFullscreen(modal: Modal, on: boolean): void {
	modal.modalEl?.toggleClass(FULLSCREEN_MODAL_CLASS, on);
}

/**
 * 把 Obsidian 窗口叫到前台。
 *
 * 双击 .lsave（走 obsidian:// 链接）或把文件拖进来时，Obsidian 可能还在别的窗口后面，
 * 用户会以为"点了没反应"。拿不到窗口对象就算了，不值得为它报错。
 */
export function focusWindow(): void {
	try {
		window.focus?.();
	} catch {
		// 非桌面端 / 测试环境：没有 window 或没有 focus，忽略
	}
}
