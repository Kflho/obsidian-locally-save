import path from 'node:path';
import { BUNDLE_EXT, readBundleInfo } from './format';
import type { BundleHeader } from './format';
import { BUNDLE_ROOT_DIR, bundleDirsToScan } from './paths';
import type { BundleMode } from './paths';
import { listFiles, moveToTrash, removeDirRecursive, removeEmptyDir, removeFile, scanTree } from '../sync/disk';
import { formatStamp } from '../utils/format';
import { toNative } from '../utils/paths';

/**
 * 同步包的管理：列出、挪进回收站、清空回收站。
 *
 * 为什么不放在 ui/ 里：这些是**引擎层**的活（碰 fs、读包头部），
 * 界面上三个地方（导出弹窗、导入弹窗、管理弹窗）都要用同一套结果；
 * 而且不 import obsidian 就能拿临时目录直接测（见 test/bundle.test.ts）。
 *
 * 回收站用 `.lsave` 这个名字是有意的：包目录里混进一个回收站本来就不该被当成笔记，
 * 而且万一用户把包文件夹设在了仓库里，`.lsave` 也在默认排除规则里、不会被装进下一个包。
 * 具体放在哪个 `.lsave` 里见 `bundleTrashRoot`。
 */

export const BUNDLE_TRASH_DIR = 'bundles-trash';

/**
 * 回收站根目录（绝对路径）＝**离包最近的那个 `.lsave` 里**的 `bundles-trash`。
 *
 * 关键一条：**不要塞进 `bundles` 里面**。包目录的上一级或它本身就是 `.lsave` 时，
 * 再往里放会把 `.lsave` 套两层（`.lsave/bundles/.lsave/bundles-trash`），
 * 翻起来又乱又难找（用户报过）。所以：
 * - `<x>/.lsave/bundles`（0.8.0 之前副本通道的默认布局）→ `<x>/.lsave/bundles-trash`，跟 `bundles` 平级；
 * - `<x>/.lsave`（用户直接把包文件夹指到了 `.lsave`）→ `<x>/.lsave/bundles-trash`；
 * - 用户自己填的文件夹（那儿压根没有 `.lsave`）→ `<自定义>/.lsave/bundles-trash`。
 *
 * 根目录没配就返回空串（调用方要提示先去填）。
 */
export function bundleTrashRoot(baseDir: string): string {
	if (!baseDir) return '';
	const parent = path.dirname(baseDir);
	// 包目录的上一级已经是 .lsave 了：回收站直接跟它做邻居
	if (path.basename(parent) === BUNDLE_ROOT_DIR) return toNative(parent, BUNDLE_TRASH_DIR);
	// 包文件夹本身就指到了 .lsave：那就放在它里面
	if (path.basename(baseDir) === BUNDLE_ROOT_DIR) return toNative(baseDir, BUNDLE_TRASH_DIR);
	return toNative(baseDir, `${BUNDLE_ROOT_DIR}/${BUNDLE_TRASH_DIR}`);
}

/**
 * 早期版本把回收站塞在 `bundles` 里面（`.lsave/bundles/.lsave/bundles-trash`）。
 *
 * 现在的位置换了，但**看一眼老位置**：那是用户已经删掉的包，
 * 界面报"回收站：空的"、清空又清不掉它们的话，看着就像包人间蒸发了。
 * 老位置里的东西跟着"清空回收站"一起清掉，之后这个目录自然消失。
 */
function legacyTrashRoot(baseDir: string): string {
	return baseDir ? toNative(baseDir, `${BUNDLE_ROOT_DIR}/${BUNDLE_TRASH_DIR}`) : '';
}

/** 真正要看 / 要清的几个回收站目录（新位置 + 老位置，去重） */
function trashRoots(baseDir: string): string[] {
	return [...new Set([bundleTrashRoot(baseDir), legacyTrashRoot(baseDir)])].filter(dir => dir !== '');
}

/** 列表里的一个包 */
export interface ManagedBundle {
	/** 绝对路径（唯一标识，也是"应用"时的入参） */
	file: string;
	name: string;
	/** 所在目录：打开所在文件夹时用它 */
	dir: string;
	/** full / changes；头部读不出来时按文件名猜，猜不出就是 null */
	mode: BundleMode | null;
	/** 读不出头部时为 null（不是我们的包 / 传坏了）：照样列出来，界面标一下 */
	header: BundleHeader | null;
	/** 头部读不出来时的原因 */
	error?: string;
	size: number;
	mtime: number;
}

/**
 * 文件名里认一下类型（头部读不出来的包才有这一步：传坏了、被改过名、不是我们的包）。
 *
 * 0.8.x 起名字里写的是「**完整** / **更新**」（用户提的：原名 full / changes 太费解），
 * 早期版本的包还是 `-full-` / `-changes-` —— **两种都认**：只认新写法的话，
 * 一个读不出头部的新包会从"更新包"那一组掉进"类型未知"，用户还以为包坏了。
 */
function modeFromName(name: string): BundleMode | null {
	if (name.includes('-full-') || name.includes('-完整-')) return 'full';
	if (name.includes('-changes-') || name.includes('-更新-')) return 'changes';
	return null;
}

/**
 * 列出同步包文件夹里所有的包，新的排前面。
 *
 * 三个目录都看（根目录 + full + changes）：早期版本把包直接放在根目录，
 * 不看根目录的话那些老包在界面上就"消失"了 —— 明明还在硬盘上。
 * 头部读不出来的**也列出来**：用户得看得见它、才能删掉它。
 */
export async function listBundles(baseDir: string): Promise<ManagedBundle[]> {
	if (!baseDir) return [];
	const out: ManagedBundle[] = [];
	for (const dir of bundleDirsToScan(baseDir)) {
		for (const item of await listFiles(dir)) {
			if (!item.name.toLowerCase().endsWith(BUNDLE_EXT)) continue;
			const file = path.join(dir, item.name);
			let header: BundleHeader | null = null;
			let error: string | undefined;
			try {
				header = (await readBundleInfo(file)).header;
			} catch (caught) {
				error = caught instanceof Error ? caught.message : String(caught);
			}
			out.push({
				file,
				name: item.name,
				dir,
				mode: header?.mode ?? modeFromName(item.name),
				header,
				...(error ? { error } : {}),
				size: item.size,
				mtime: item.mtime,
			});
		}
	}
	out.sort((a, b) => b.mtime - a.mtime);
	return out;
}

export interface BundleGroup {
	title: string;
	items: ManagedBundle[];
}

/**
 * 列表分组：**同一类排一起，组内从新到老**。
 *
 * 顺序：更新包 → 完整副本 → 类型未知。更新包放最前是因为它是天天要传的那一份
 * （完整副本平时只是还原点）；读不出头部的不跟正经包混在一起。
 *
 * 组内自己再排一次时间（不依赖调用方传进来的顺序）：界面上"从新到老"是硬要求，
 * 不该因为上游换了排序就悄悄变样。
 */
export function groupBundles(items: ManagedBundle[]): BundleGroup[] {
	const pick = (mode: BundleMode | null) =>
		items.filter(item => item.mode === mode).sort((a, b) => b.mtime - a.mtime);
	return [
		{ title: '更新包', items: pick('changes') },
		{ title: '完整副本', items: pick('full') },
		{ title: '类型未知（读不出头部）', items: pick(null) },
	];
}

export interface TrashOutcome {
	/** 挪走的包（文件名，已排序） */
	moved: string[];
	failed: { path: string; error: string }[];
	/** 落到回收站里的目录（一个时间戳一个，界面上告诉用户去哪儿捞） */
	target: string;
}

/**
 * 删包 = 挪进回收站（同一次操作用同一个时间戳，捞的时候好认）。
 *
 * 为什么不真删：同步包是"改动唯一的备份"，点错一下整份改动就没了。
 * 回收站占地方，所以界面上另给一个"清空回收站"，让用户自己决定什么时候真删。
 */
export async function trashBundles(baseDir: string, files: string[]): Promise<TrashOutcome> {
	const root = bundleTrashRoot(baseDir);
	const stamp = formatStamp(Date.now());
	const outcome: TrashOutcome = { moved: [], failed: [], target: toNative(root, stamp) };
	for (const file of files) {
		try {
			await moveToTrash(file, root, path.basename(file), stamp);
			outcome.moved.push(path.basename(file));
		} catch (error) {
			outcome.failed.push({ path: file, error: error instanceof Error ? error.message : String(error) });
		}
	}
	outcome.moved.sort();
	return outcome;
}

export interface TrashContents {
	/** 回收站里还有几个包 */
	count: number;
	bytes: number;
}

/** 数一数回收站里还剩什么（界面上显示"回收站：2 个包（3.4 MB）"） */
export async function readBundleTrash(baseDir: string): Promise<TrashContents> {
	let bytes = 0;
	let count = 0;
	for (const root of trashRoots(baseDir)) {
		// 不套排除规则：回收站是我们自己建的，里面全是包，没有"该跳过的"
		const inventory = await scanTree(root, { exclude: [] });
		for (const [rel, record] of inventory.files) {
			if (!rel.toLowerCase().endsWith(BUNDLE_EXT)) continue;
			count++;
			bytes += record.size;
		}
	}
	return { count, bytes };
}

/** 清空回收站：**真删**，删完捞不回来（界面上必须先确认） */
export async function emptyBundleTrash(baseDir: string): Promise<void> {
	for (const root of trashRoots(baseDir)) await removeDirRecursive(root);
	// 老位置的回收站在 `<base>/.lsave/` 底下，清完会剩一个空壳 —— 顺手收掉，
	// 别在 bundles 里面留个空 `.lsave`（那正是这次要修掉的乱）。走 rmdir：
	// 里面但凡还有别的东西就删不动，不会误伤。
	const legacy = legacyTrashRoot(baseDir);
	if (legacy) await removeEmptyDir(path.dirname(legacy));
}

export interface DeleteOutcome {
	deleted: string[];
	failed: { path: string; error: string }[];
}

/**
 * **彻底删除**这些包（不进回收站）。
 *
 * 为什么除了"挪进回收站"还要有它：同步包往往是"改动唯一的备份"，所以默认那条路是先挪走、
 * 还能捞回来；但某一个包你确认没用了、又不想为它把整个回收站清空时，就该能单独真删
 * （用户提的：只有"挪进回收站"不方便）。
 *
 * 界面上必须**单独确认一次**，措辞也别跟"挪进回收站"混 —— 这一步之后真的捞不回来。
 */
export async function deleteBundles(files: string[]): Promise<DeleteOutcome> {
	const outcome: DeleteOutcome = { deleted: [], failed: [] };
	for (const file of files) {
		try {
			await removeFile(file); // 文件本来就不在也算成功（可能刚被别的操作挪走）
			outcome.deleted.push(path.basename(file));
		} catch (error) {
			outcome.failed.push({ path: file, error: error instanceof Error ? error.message : String(error) });
		}
	}
	outcome.deleted.sort();
	return outcome;
}
