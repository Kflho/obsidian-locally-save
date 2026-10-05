import type { PluginSettings } from '../settings/model';
import { toNative } from '../utils/paths';

/**
 * 同步包放哪儿。
 *
 * 用户在设置里填一个目录（**必填**），包就放在它的 `full` / `changes` 子目录里：
 * 完整副本与更新包用途不同（一个用来整份恢复、一个用来天天搬），混在一起很快就认不出谁是谁。
 *
 * 目录本身不参与任何扫描 —— 包不是笔记，不该被打进另一个包或者当成仓库内容。
 * （老版本的默认位置是"本地副本文件夹的 `.lsave/bundles`"：`.lsave` 在扫描副本时整个跳过。
 * 副本通道砍掉之后这个兜底也没了，见 `bundleBaseDir`。）
 */

/** 副本里那个"不参与同步"的目录名 */
export const BUNDLE_ROOT_DIR = '.lsave';
export const BUNDLE_SUBDIR = 'bundles';

/** 同步包的类型：与 settings 的 bundleMode 一致 */
export type BundleMode = 'full' | 'changes';

/**
 * 包的根目录（绝对路径）。
 *
 * **0.8.0 起必须由用户填**：以前留空会跟着「目标文件夹」（本地副本）走，
 * 那条通道已经砍掉了。包是这里唯一的搬运格式，"放哪儿"不该有藏起来的默认值 ——
 * 用户填过才知道去哪儿找包、才会记得把它拷走。
 * 留空时返回空串，调用方负责提示"先去设置里填同步包文件夹"。
 */
export function bundleBaseDir(settings: PluginSettings): string {
	return settings.bundleDir.trim();
}

/** 某一类包具体放哪个目录 */
export function bundleDirForMode(baseDir: string, mode: BundleMode): string {
	return toNative(baseDir, mode === 'full' ? 'full' : 'changes');
}

/**
 * 找包时要看哪几个目录：根目录 + 两个子目录。
 * 早期版本把包直接放在根目录，所以根目录也要看（不然老包就"找不到"了）。
 */
export function bundleDirsToScan(baseDir: string): string[] {
	if (!baseDir) return [];
	return [baseDir, bundleDirForMode(baseDir, 'full'), bundleDirForMode(baseDir, 'changes')];
}
