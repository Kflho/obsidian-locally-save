import { Notice } from 'obsidian';
import type LocallySavePlugin from '../main';
import { ApplyBundleModal } from './bundle-modal';
import { pickBundleFromDrop } from './drop';

/**
 * 把 `.lsave` 直接拖到 Obsidian 窗口上 → 自动打开"应用同步包"对话框并填好路径。
 *
 * 两个要注意的地方：
 *
 * 1. **`dragover` 必须 preventDefault**，否则浏览器根本不会派发 `drop` —— 拖放最常见的坑。
 *    代价是整个窗口都变成"可放置"（光标会变），但只是视觉上的，没有副作用。
 * 2. **只拦 `.lsave`**：在**捕获阶段**接 `drop`，认出是自己的包才 `stopPropagation` +
 *    `preventDefault`，别的文件一概放行 —— 不然往笔记里拖图片就废了。
 *    捕获阶段还有个好处：能拿到真实的 `File` 对象（`dragover` 阶段只给 MIME 类型）。
 */
export function registerBundleDropTarget(plugin: LocallySavePlugin): void {
	const doc = activeDocument;

	plugin.registerDomEvent(doc, 'dragover', (event: DragEvent) => {
		event.preventDefault();
	}, { capture: true });

	plugin.registerDomEvent(doc, 'drop', (event: DragEvent) => {
		const { path } = pickBundleFromDrop(event.dataTransfer?.files);
		// 不是同步包：什么都不做，交给 Obsidian 自己处理（往笔记里拖图片照旧）
		if (!path) return;

		// 是我们的包：拦下来，别让 Obsidian 把它当成附件导进仓库
		event.preventDefault();
		event.stopPropagation();

		if (!plugin.settings.enabled) {
			new Notice('插件已停用：在设置里重新启用后，才能拖入同步包');
			return;
		}
		if (!plugin.settings.dropBundleToApply) return; // 用户关掉了"拖入即打开"

		new ApplyBundleModal(plugin.app, plugin, path).open();
	}, { capture: true });
}
