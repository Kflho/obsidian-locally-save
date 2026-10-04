/**
 * 路径工具。
 *
 * 仓库内部一律用**正斜杠的相对路径**（和 Obsidian 的 `TFile.path` 一致，
 * 换平台不会出岔子）；只有真要落到磁盘时才转成本机路径（`toNative`）。
 * 这些函数不碰磁盘、不 import obsidian，所以能直接跑测试。
 */

/** 把反斜杠统一成正斜杠，去掉开头与结尾多余的斜杠 */
export function toPosix(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

/** 本机绝对路径：`root`（本机路径）+ 仓库相对路径 `rel` */
export function toNative(root: string, rel: string): string {
	const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
	const trimmed = root.replace(/[/\\]+$/, '');
	if (!rel) return trimmed;
	return trimmed + separator + rel.split('/').join(separator);
}

/** 相对路径的目录部分；顶层文件返回空串 */
export function dirnameRel(rel: string): string {
	const index = rel.lastIndexOf('/');
	return index === -1 ? '' : rel.slice(0, index);
}

/** 相对路径的文件名 */
export function basename(rel: string): string {
	const index = rel.lastIndexOf('/');
	return index === -1 ? rel : rel.slice(index + 1);
}

/** 扩展名（含点，小写）；没有扩展名返回空串 */
export function extname(rel: string): string {
	const name = basename(rel);
	const index = name.lastIndexOf('.');
	return index <= 0 ? '' : name.slice(index).toLowerCase();
}

/**
 * 冲突副本的名字：`笔记.md` → `笔记 (冲突副本 20261004-143022).md`。
 * 放在同目录下，扩展名保持不动（Obsidian 才会当成同一种文件打开）。
 */
export function conflictName(rel: string, stamp: string, label = '冲突副本'): string {
	const dir = dirnameRel(rel);
	const name = basename(rel);
	const ext = extname(rel);
	const stem = ext ? name.slice(0, name.length - ext.length) : name;
	const renamed = `${stem} (${label} ${stamp})${ext}`;
	return dir ? `${dir}/${renamed}` : renamed;
}
