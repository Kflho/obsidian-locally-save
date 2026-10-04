import { toNative } from '../utils/paths';
import { hashFile } from './disk';
import { cachedHash, rememberHash } from './state';
import type { PluginState } from './state';
import type { FileRecord } from './types';

/**
 * 内容指纹的懒算与缓存。
 *
 * 快速通道（血脉世代一致）**完全不碰这里** —— 判断"改没改"只需要大小与修改时间。
 * 只有世代对不上、要逐文件三方合并时，才需要"内容"这个更硬的证据：
 * 因为修改时间会被复制、被外部工具改，靠它认文件在某些场景下会出错。
 */

/** 超过这个大小就不算指纹了：读一遍太贵，而且大文件本来就少 */
const MAX_FINGERPRINT_BYTES = 64 * 1024 * 1024;

/**
 * 取一个文件的内容指纹；关了设置就返回 undefined（调用方退回只看大小与时间）。
 * 命中缓存直接返回，没命中才算一次并记下来 —— 缓存按「大小 + 修改时间」失效。
 */
export async function fingerprint(
	vaultRoot: string,
	state: PluginState,
	path: string,
	record: FileRecord,
	enabled: boolean,
): Promise<string | undefined> {
	if (!enabled) return undefined;
	const cached = cachedHash(state, path, record);
	if (cached) return cached;
	if (record.size > MAX_FINGERPRINT_BYTES) return undefined;
	try {
		const hash = await hashFile(toNative(vaultRoot, path));
		rememberHash(state, path, record, hash);
		return hash;
	} catch {
		// 读不到就算了：合并时会退回到"大小 + 时间"的判断
		return undefined;
	}
}
