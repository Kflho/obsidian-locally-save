import { Notice } from 'obsidian';
import type LocallySavePlugin from '../main';
import { debugEvent } from '../debugLog';
import {
	applyBundleAction,
	bundleLogAction,
	exportBundleAction,
	manageBundlesAction,
	previewBundleExport,
	syncNow,
} from '../ui/actions';
import { downloadNow, syncGitNow, uploadNow } from '../ui/git';
import { openPeerStatus } from '../ui/status';

/**
 * 注册一条命令，并**记一笔"到底跑没跑"**（0.15.9）。
 *
 * 为什么：用户报过「REST 调 sync-now 返回 204，但什么都没发生」—— 分不清是命令没注册、
 * 回调没进来、还是进来后早退了。命令一旦进来先写 `command.run`，抛错写 `command.error`，
 * 加上 `main.onload` 那条 `plugin.loaded`，三笔日志就能把这类"静默空转"定位到具体一步。
 */
function register(
	plugin: LocallySavePlugin,
	id: string,
	name: string,
	run: () => unknown,
): void {
	plugin.addCommand({
		id,
		name,
		// 把 promise 交回去：测试/executeCommandById 想 await 才能等到命令真的跑完
		callback: () => {
			debugEvent('command.run', { id });
			return (async () => {
				try {
					await run();
				} catch (error) {
					debugEvent('command.error', { id }, error);
					new Notice(`命令出错（${id}）：${error instanceof Error ? error.message : String(error)}`, 8000);
				}
			})();
		},
	});
}

/**
 * 命令注册。
 *
 * **命令 ID 一旦发布就是稳定接口**，改名会让用户的快捷键失效 —— 别改。
 * 所以 0.8.0 砍掉「同步到本地副本」通道时：
 * - `sync-now` / `sync-preview` 这两个 ID **留着，改指留包**（立即留一次 / 先预览会装什么），
 *   快捷键照旧能用，做的正好是最接近的那件事；
 * - `upload-to-copy` / `download-from-copy` 也留一版，只弹一句指路通知 ——
 *   直接删掉的话，用户的快捷键会静默失效，他只会觉得"插件坏了"。
 */
export function registerCommands(plugin: LocallySavePlugin): void {
	register(plugin, 'sync-now', '立即同步（导出包并推拉）', () => syncNow(plugin));
	register(plugin, 'sync-preview', '预览这次会导出什么', () => previewBundleExport(plugin));

	// 下面两条是 0.8.0 砍掉的副本通道留下的 ID：**ID 不变**（用户的快捷键还认它们），
	// 现在接到 git 货架的"推 / 拉"上 —— 语义正好是当年那两个方向。
	register(plugin, 'upload-to-copy', '让对面和我一致（推上去）', () => uploadNow(plugin));
	register(plugin, 'download-from-copy', '让我和对面一致（拉下来）', () => downloadNow(plugin));

	register(plugin, 'export-bundle', '导出同步包…', () => exportBundleAction(plugin));
	register(plugin, 'apply-bundle', '打开同步包并应用…', () => applyBundleAction(plugin));
	register(plugin, 'manage-bundles', '管理同步包…', () => manageBundlesAction(plugin));
	register(plugin, 'bundle-log', '同步包更新记录…', () => bundleLogAction(plugin));
	register(plugin, 'git-sync', '与 git 远程同步一次', () => syncGitNow(plugin, { manual: true }));
	register(plugin, 'sync-status', '查看各台电脑同步状态…', () =>
		openPeerStatus(plugin, () => { void syncGitNow(plugin, { manual: true }); }));

	// 这条不受总开关限制 —— 它就是用来把插件重新打开的
	register(plugin, 'toggle-enabled', '启用 / 停用插件', async () => {
		const enabled = !plugin.settings.enabled;
		plugin.settings.enabled = enabled;
		await plugin.saveSettings();
		new Notice(enabled ? '插件已启用' : '插件已停用');
	});
}
