import { Notice } from 'obsidian';
import type LocallySavePlugin from '../main';
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
	plugin.addCommand({
		id: 'sync-now',
		name: '立即同步（导出包并推拉）',
		callback: () => { void syncNow(plugin); },
	});

	plugin.addCommand({
		id: 'sync-preview',
		name: '预览这次会导出什么',
		callback: () => { void previewBundleExport(plugin); },
	});

	// 下面两条是 0.8.0 砍掉的副本通道留下的 ID：**ID 不变**（用户的快捷键还认它们），
	// 现在接到 git 货架的"推 / 拉"上 —— 语义正好是当年那两个方向。
	plugin.addCommand({
		id: 'upload-to-copy',
		name: '让对面和我一致（推上去）',
		callback: () => { void uploadNow(plugin); },
	});

	plugin.addCommand({
		id: 'download-from-copy',
		name: '让我和对面一致（拉下来）',
		callback: () => { void downloadNow(plugin); },
	});

	plugin.addCommand({
		id: 'export-bundle',
		name: '导出同步包…',
		callback: () => { exportBundleAction(plugin); },
	});

	plugin.addCommand({
		id: 'apply-bundle',
		name: '打开同步包并应用…',
		callback: () => { applyBundleAction(plugin); },
	});

	plugin.addCommand({
		id: 'manage-bundles',
		name: '管理同步包…',
		callback: () => { manageBundlesAction(plugin); },
	});

	plugin.addCommand({
		id: 'bundle-log',
		name: '同步包更新记录…',
		callback: () => { bundleLogAction(plugin); },
	});

	plugin.addCommand({
		id: 'git-sync',
		name: '与 git 远程同步一次',
		callback: () => { void syncGitNow(plugin, { manual: true }); },
	});

	plugin.addCommand({
		id: 'sync-status',
		name: '查看各台电脑同步状态…',
		callback: () => {
			void openPeerStatus(plugin, () => { void syncGitNow(plugin, { manual: true }); });
		},
	});

	// 这条不受总开关限制 —— 它就是用来把插件重新打开的
	plugin.addCommand({
		id: 'toggle-enabled',
		name: '启用 / 停用插件',
		callback: async () => {
			const enabled = !plugin.settings.enabled;
			plugin.settings.enabled = enabled;
			await plugin.saveSettings();
			new Notice(enabled ? '插件已启用' : '插件已停用');
		},
	});
}
