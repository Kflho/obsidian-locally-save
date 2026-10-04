import type { PluginSettings } from '../settings/model';
import { toNative } from '../utils/paths';

/**
 * 同步包放哪儿。
 *
 * 默认放在**同步目标文件夹**下的 `.lsave/bundles`：
 * - 用户不用再单独想一个路径，包就跟着副本走；
 * - 放在 `.lsave/` 里面很关键 —— 这个目录在扫描副本时是**整个跳过**的，
 *   否则包文件会被当成"副本新增的文件"同步回仓库，越滚越多。
 *
 * 完整包与改动包各自一个子目录：两种包用途不同（一个用来整份恢复、一个用来天天搬），
 * 混在一起很快就不认识谁是谁了。
 */

/** 副本里那个"不参与同步"的目录名 */
export const BUNDLE_ROOT_DIR = '.lsave';
export const BUNDLE_SUBDIR = 'bundles';

/** 同步包的类型：与 settings 的 bundleMode 一致 */
export type BundleMode = 'full' | 'changes';

/**
 * 包的根目录（绝对路径）。设置里填了就用填的，否则跟着同步目标走。
 * 两个都没填时返回空串 —— 调用方要提示用户先填一个。
 */
export function bundleBaseDir(settings: PluginSettings, targetDir: string): string {
	const custom = settings.bundleDir.trim();
	if (custom) return custom;
	const target = targetDir.trim();
	return target ? toNative(target, `${BUNDLE_ROOT_DIR}/${BUNDLE_SUBDIR}`) : '';
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
