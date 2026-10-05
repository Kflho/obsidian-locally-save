/**
 * 打开"应用同步包"对话框时，把 Obsidian 窗口**叫到前台**。
 *
 * 为什么：双击 .lsave（走 obsidian:// 链接）或把文件拖进来时，Obsidian 可能还在别的窗口后面，
 * 用户会以为"点了没反应"。
 *
 * **只叫到前台，不动窗口大小 / 位置**。以前这里还会试着把窗口顶到最大（理由是"应用要跑几秒，
 * 窗口小看着像卡死"），后来发现那个理由站不住：进度现在有状态栏与对话框里那句"正在……"，
 * 而"插件替我改窗口大小"是实打实的越界 —— 所以那个开关连同最大化一起删了。
 *
 * 非桌面端 / 测试环境里拿不到窗口就算了，不值得为它中断用户的操作。
 */
export function focusWindow(): void {
	try {
		window.focus?.();
	} catch {
		// 没有 window 或没有 focus：忽略
	}
}

/**
 * 把一个按钮标成"危险操作"（真删、批量覆盖这类）。
 *
 * 新版 Obsidian（1.13+）用 `setDestructive()` 上红样式；它比本插件声明的
 * `minAppVersion`（1.7.0）新，**不该为了一个按钮颜色把最低版本抬上去** ——
 * 升级门槛留给真正需要的 API。老版本上就拿它当普通按钮（按钮文字与确认框里那句
 * "这一步之后就捞不回来了"已经把风险说清了），不去调已废弃的 `setWarning()`。
 */
export function markDestructive(button: { setDestructive?: () => unknown }): void {
	try {
		button.setDestructive?.();
	} catch {
		// 老版本没有这个 API：忽略
	}
}
