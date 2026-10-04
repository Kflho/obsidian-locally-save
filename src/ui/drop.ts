/**
 * 拖放支持：把 `.lsave` 文件拖进对话框，等同于在输入框里粘路径。
 *
 * 路径的取法有两代：
 * - Electron 32 之前：`File.path` 直接给完整路径；
 * - Electron 32 起：`File.path` 被移除，改由 `webUtils.getPathForFile(file)` 提供。
 *
 * 插件是桌面端专属（isDesktopOnly），所以这两条都能用；两条都拿不到就老实说拿不到，
 * 提示用户改用粘贴路径 —— 别硬猜文件名（同名文件在别的目录里多得是）。
 */

export interface DroppedFile {
	name: string;
	/** 老 Electron 的快捷属性；新版没有 */
	path?: string;
}

export interface DropResult {
	/** 认出完整路径时给出；否则为 null */
	path: string | null;
	/** 认不出时的原因（直接展示给用户） */
	error: string | null;
}

/** 同步包的后缀 */
const BUNDLE_SUFFIX = '.lsave';

/** 取拖进来的文件在磁盘上的完整路径；拿不到返回 null */
export function resolveDroppedPath(file: DroppedFile): string | null {
	if (typeof file.path === 'string' && file.path !== '') return file.path;

	try {
		const holder = window as unknown as { require?: (id: string) => unknown };
		const electron = holder.require?.('electron') as
			| { webUtils?: { getPathForFile?: (dropped: unknown) => string } }
			| undefined;
		const resolved = electron?.webUtils?.getPathForFile?.(file);
		return typeof resolved === 'string' && resolved !== '' ? resolved : null;
	} catch {
		// 取不到就算了，调用方会提示改用粘贴路径
		return null;
	}
}

/** 从拖进来的文件里挑出同步包；不是包或拿不到路径就给出人话的原因 */
export function pickBundleFromDrop(files: ArrayLike<DroppedFile> | null | undefined): DropResult {
	if (!files || files.length === 0) {
		return { path: null, error: '没读到你拖进来的文件：请拖一个 .lsave 同步包过来' };
	}

	// 拖多个文件时挑第一个 .lsave（其余不动）
	let picked: DroppedFile | null = null;
	for (let index = 0; index < files.length; index++) {
		const file = files[index];
		if (file && file.name.toLowerCase().endsWith(BUNDLE_SUFFIX)) {
			picked = file;
			break;
		}
	}

	if (!picked) {
		const first = files[0];
		return {
			path: null,
			error: `这不是同步包：${first?.name ?? '（没有名字）'}（同步包的后缀是 ${BUNDLE_SUFFIX}）`,
		};
	}

	const path = resolveDroppedPath(picked);
	if (!path) {
		return { path: null, error: '拿不到这个文件的完整路径：请改用下面的输入框粘贴路径' };
	}
	return { path, error: null };
}
