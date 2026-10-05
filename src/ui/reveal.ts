import { Notice } from 'obsidian';

/**
 * 在系统文件管理器里打开一个文件夹。
 *
 * 用途：弹窗里那句"先把更新包拷走"要能一步跳到它所在的目录 ——
 * 让用户自己去「同步包文件夹/changes」一层层点进去太费劲了。
 *
 * Obsidian 没有"打开文件夹"的公开 API，所以按可靠性降级，全失败就给个提示把路径显示出来
 * （至少能手动复制）：
 * 1. `@electron/remote` → `shell.openPath()`（最稳）；
 * 2. `app.openWithDefaultApp()`（Obsidian 自带，拿它开目录＝交给资源管理器）；
 * 3. 都不行 → 弹一条含有路径的通知。
 */
export function openFolderInExplorer(absPath: string, app?: { openWithDefaultApp?: (path: string) => void }): void {
	// ① electron 的 shell
	try {
		const loader = (window as unknown as { require?: unknown }).require;
		if (typeof loader === 'function') {
			const electron = (loader as (name: string) => unknown)('electron') as { shell?: { openPath?: (path: string) => unknown } };
			if (electron?.shell?.openPath) {
				void electron.shell.openPath(absPath);
				return;
			}
		}
	} catch {
		// 往下试
	}

	// ② Obsidian 自带的"用默认程序打开"
	try {
		if (app?.openWithDefaultApp) {
			app.openWithDefaultApp(absPath);
			return;
		}
	} catch {
		// 往下试
	}

	// ③ 至少把路径给出来
	new Notice(`没能自动打开文件夹，路径是：${absPath}`, 12000);
}
