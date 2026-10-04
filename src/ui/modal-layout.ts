/**
 * 打开"应用同步包"对话框时，把 **Obsidian 窗口本身**顶到最大、并叫到前台。
 *
 * 为什么：应用一个包要跑"扫仓库 → 校验包 → 写文件"，这期间界面只有一句"正在……"。
 * 窗口小、或者还在别的窗口后面时，看着就像卡死了 —— 顶到最大最前，至少进度看得见。
 *
 * Obsidian 没有公开的窗口 API，所以按可靠性从高到低试，全失败也不报错
 * （这只是体验优化，不值得为它中断用户的操作）：
 * 1. `@electron/remote`（桌面端带着它）→ `getCurrentWindow().maximize()`；
 * 2. 渲染进程的 `window.moveTo/resizeTo`（Electron 支持，等于手动拉满）；
 * 3. 都不行就只做"叫到前台"。
 */

/** Electron BrowserWindow 里我们用到的那几个方法（不引入 electron 类型） */
interface ElectronWindowLike {
	maximize?: () => void;
	isMaximized?: () => boolean;
	isFullScreen?: () => boolean;
	/** 最小化状态下直接 maximize 不一定能顶出来，得先还原 */
	isMinimized?: () => boolean;
	restore?: () => void;
}

interface ElectronRemoteLike {
	getCurrentWindow?: () => ElectronWindowLike;
}

/**
 * 拿 `@electron/remote`。
 *
 * 必须**通过变量间接调用** `require`：写成 `require('@electron/remote')` 的话
 * esbuild 会在打包时去找这个模块并报"解析不了"（它不是依赖）。
 */
function electronRemote(): ElectronRemoteLike | null {
	const loader = (window as unknown as { require?: unknown }).require;
	if (typeof loader !== 'function') return null;
	try {
		const remote = (loader as (name: string) => unknown)('@electron/remote');
		return typeof remote === 'object' && remote !== null ? remote as ElectronRemoteLike : null;
	} catch {
		return null;
	}
}

/** 窗口已经顶到最大（或全屏）了吗 */
function alreadyMaximized(win: ElectronWindowLike): boolean {
	try {
		return win.isMaximized?.() === true || win.isFullScreen?.() === true;
	} catch {
		return false;
	}
}

/**
 * 把 Obsidian 窗口最大化（已经最大就什么都不做）。
 *
 * 只做最大化，不切"真·全屏"（那会把标题栏也藏掉，用户往往并不想要）。
 */
export function maximizeWindow(): void {
	const win = electronRemote()?.getCurrentWindow?.();
	if (win) {
		try {
			// 缩在任务栏里的时候，直接 maximize 不一定能把它顶出来
			if (win.isMinimized?.() === true) win.restore?.();
			if (!alreadyMaximized(win)) win.maximize?.();
			return;
		} catch {
			// 落到下面的兜底
		}
	}
	try {
		const screenSize = window.screen;
		if (!screenSize || typeof window.resizeTo !== 'function') return;
		window.moveTo?.(0, 0);
		window.resizeTo(screenSize.availWidth, screenSize.availHeight);
	} catch {
		// 拿不到窗口就算了
	}
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

/** 打开包时统一做的两件事：顶到最大 + 叫到前台（想关掉的话见设置里的开关） */
export function bringWindowForward(): void {
	maximizeWindow();
	focusWindow();
}
