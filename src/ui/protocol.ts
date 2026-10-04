import { Notice } from 'obsidian';
import type LocallySavePlugin from '../main';
import { ApplyBundleModal } from './bundle-modal';

/**
 * 用 Obsidian 直接打开同步包。
 *
 * ## 为什么不能简单"关联到 Obsidian.exe"
 *
 * 把 `.lsave` 的打开方式设成 `Obsidian.exe "%1"` 是**通不了**的：Obsidian 收到一个陌生路径
 * 只会当成未知文件，压根到不了插件。能到插件的通路只有一条 —— **URI 协议**
 * （`obsidian://…`），Obsidian 会把 URI 交给注册了对应 action 的插件处理。
 *
 * 所以这里的配合是：
 * - 插件注册 `obsidian://locally-save?path=<文件路径>`；
 * - 系统的文件关联指向"调起这个 URI"（见 `associate.ts`，在设置里一键设置）。
 *
 * 于是双击 `.lsave` → 系统调起 URI → Obsidian 转给插件 → 直接就打开了应用对话框。
 */

/** 协议 action 名（`obsidian://locally-save?...`） */
export const PROTOCOL_ACTION = 'locally-save';

/**
 * 把协议里带过来的路径收拾干净。
 *
 * 两种情况都要认：
 * - 我们自己生成的链接是 URL 编码过的；
 * - 系统文件关联里用的是 `%1`，原样塞进来（带反斜杠、可能带引号、可能带空格）。
 */
export function normalizeProtocolPath(raw: string): string {
	const trimmed = raw.trim().replace(/^"+|"+$/g, '');
	try {
		return decodeURIComponent(trimmed);
	} catch {
		// 路径里带 % 之类不是合法编码的字符：原样用
		return trimmed;
	}
}

/** 生成"用 Obsidian 打开某个包"的链接（复制给别人 / 自己做快捷方式用） */
export function bundleLink(path: string): string {
	return `obsidian://${PROTOCOL_ACTION}?path=${encodeURIComponent(path)}`;
}

/** 注册协议处理器：`obsidian://locally-save?path=…` */
export function registerProtocolHandler(plugin: LocallySavePlugin): void {
	plugin.registerObsidianProtocolHandler(PROTOCOL_ACTION, params => {
		const raw = params.path ?? params.file ?? '';
		const path = raw ? normalizeProtocolPath(raw) : '';

		if (!plugin.settings.enabled) {
			new Notice('插件已停用：在设置里重新启用后才能应用同步包');
			return;
		}
		if (path) plugin.log.debug(`从链接打开同步包：${path}`);
		// 没带路径也行：那就是"打开应用对话框"，让用户自己选
		new ApplyBundleModal(plugin.app, plugin, path || undefined).open();
	});
}
