/**
 * 让出一次事件循环（**宏任务**，不是微任务）。
 *
 * 为什么需要：一轮同步 / 一次应用要连续处理几百上千个文件，虽然每一步都是 `await`
 * 文件操作（不阻塞线程），但一堆 promise 回调会挤在一起把渲染帧挤掉 ——
 * 用户看到的就是"界面卡住了、点什么都没反应"。插一个 `setTimeout(0)` 是让浏览器
 * 真正拿到一次重绘机会最省事的办法。
 *
 * 只在长循环里"每 N 次让一步"：太勤会拖慢整体，太懒又会卡。
 */
export function yieldToUi(): Promise<void> {
	return new Promise(resolve => {
		// 优先用**当前窗口**的计时器：Obsidian 的弹出窗口（popout）有自己的那一套，
		// 全局那个在那种窗口里可能被节流甚至不触发
		const win = typeof window !== 'undefined' ? window : undefined;
		if (win && typeof win.setTimeout === 'function') {
			win.setTimeout(() => resolve(), 0);
			return;
		}
		// 没有窗口环境（测试跑在 Node 里）：setImmediate 同样是"让到宏任务队列末尾"
		setImmediate(() => resolve());
	});
}

/** 长循环里每处理多少项让一次步 */
export const YIELD_EVERY = 25;

/** 纯 CPU 的循环里，隔多久让一帧（见 yieldIfDue） */
export const YIELD_INTERVAL_MS = 50;

/**
 * 时间切片：距上次让帧够久了就让一次，返回新的"上次让帧时间"。
 *
 * 与 `YIELD_EVERY` 那套"每 N 项让一步"的分工：那套适合每项都要做 I/O 的循环；
 * **纯 CPU 的循环不能按项数让**（一万项可能只要几毫秒，按项让纯属白等），
 * 只能看表 —— 每过 `YIELD_INTERVAL_MS` 让一帧，界面才跟得上。
 *
 * 用法：`last = await yieldIfDue(last)`，`last` 由每个循环自己带着（互不干扰）。
 */
export async function yieldIfDue(lastAt: number, now = Date.now()): Promise<number> {
	if (now - lastAt < YIELD_INTERVAL_MS) return lastAt;
	await yieldToUi();
	return Date.now();
}
