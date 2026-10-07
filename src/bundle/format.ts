import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { ensureDir } from '../sync/disk';
import type { StateIdInfo } from '../sync/state';
import { YIELD_EVERY, yieldToUi } from '../utils/async';

/**
 * 同步包（`.lsave`）的容器格式。
 *
 * 一个包 = 头部 JSON + 一段连续的负载 + 尾部校验：
 *
 * ```
 *   [MAGIC 12 字节][头长度 u32][头部 JSON][各文件的原始字节…][尾部标记 8][尾部 JSON][尾长度 u32]
 * ```
 *
 * 尾部把长度放在最后，是为了读取时**先看文件末尾 4 字节**就知道 JSON 有多长，
 * 不用扫描整个文件（包可能几百 MB）。写的时候顺序必须一致。
 * 设计取舍：
 * - **不用 zip**：Node 没有内置 zip 写入，而 tar/gzip 要额外实现；负载本来就是
 *   一堆文件原样拼起来，自己定个格式反而更简单，也方便"只读某一个文件"（见 readEntry）；
 * - **头部先写、偏移量提前算好**：每个文件的大小在扫描时就知道，所以偏移量能一次算完，
 *   不用回头改写头部（回写是断电时最容易把包写坏的写法）；
 * - **负载不压缩**：笔记与附件多半已经是压缩格式（jpg/png/zip），再压一遍白费 CPU，
 *   还拖慢"几秒钟搬完"这个核心体验；
 * - **尾部记校验和**：U 盘、网盘搬来搬去，最怕静默损坏。
 */

export const BUNDLE_MAGIC = Buffer.from('LOCALLYSAVE1\n', 'utf8');
export const BUNDLE_TRAILER_MAGIC = Buffer.from('LSAVEEND', 'utf8');
export const BUNDLE_FORMAT = 'locally-save-bundle';
export const BUNDLE_VERSION = 1;
/** 后缀：界面里也用这个值（settings/model.ts 的 BUNDLE_EXTENSION） */
export const BUNDLE_EXT = '.lsave';

/** 一份副本的身份 + 世代，用于同步包头部的血脉信息 */
export interface CopyRef {
	copyId: string;
	generation: number;
}

/**
 * 包里的一个文件。
 *
 * `base*` 是**导出方认为接收方在应用前应该有的样子**（增量包才有）：
 * 接收方拿它做三方合并 —— 本地文件等于 base 才敢直接覆盖，
 * 否则说明本地也改过，得走冲突处理。这是"增量包必须同一副本"这条规矩的落地方式：
 * 不是拒绝服务，而是逐文件判断。
 */
export interface BundleEntry {
	path: string;
	/** 在负载段里的起始偏移（相对负载开头） */
	offset: number;
	size: number;
	mtime: number;
	/** 内容指纹（十六进制 sha256）；算得出来才有（单个超过 64MB、读失败时没有） */
	hash?: string;
	baseSize?: number;
	baseMtime?: number;
	baseHash?: string;
	/**
	 * 这个文件自上次**完整包**以来经历过的版本（不含现在这一版）。
	 *
	 * 用来认"中间版本"：接收方可能跳过了一两个更新包，手里那份是我以前发过的，
	 * 而不是他自己改的 —— 比对得上就直接覆盖，不该留冲突副本。
	 */
	history?: { size: number; mtime: number }[];
}

/** 增量包里的删除项：同样带 base，本地改过就不删 */
export interface BundleDeletedEntry {
	path: string;
	baseSize?: number;
	baseMtime?: number;
	baseHash?: string;
}

export interface BundleHeader {
	format: typeof BUNDLE_FORMAT;
	version: number;
	/** 这个包自己的 ID */
	bundleId: string;
	/** 导出方上一次导出的包 ID：接收方拿它发现漏包 */
	parentBundleId: string | null;
	created: number;
	mode: 'full' | 'changes';
	/** 导出时的仓库名，只用于界面提示 */
	vault: string;
	/**
	 * 血脉：标识"这是同一份内容家族"。
	 * 接收方应用**完整包**时会认祖（把自己的血脉改成包里的），
	 * 之后两边就能靠血脉 + 世代判断彼此是不是同一条线上的人。
	 */
	lineage: string;
	/** 导出方的身份（排查问题用：这个包是哪台机器、第几代导出的） */
	source: CopyRef;
	/**
	 * 增量包的基准世代：导出方以为接收方现在停在第几代。
	 * **完整包为 null ＝ 免校验**。
	 */
	baseGeneration: number | null;
	/** 应用这个包之后，接收方应该到达的世代 */
	targetGeneration: number;
	/**
	 * **我这份基准的指纹**（见 `bundle/baseline.ts`）：
	 * - 完整包：它自己这份清单的指纹（接收方应用后就把这个当成自己的基准令牌）；
	 * - 更新包：我基于的那份完整副本的指纹 —— 接收方一比就知道"是不是接着同一份基准"。
	 * 旧版本的包没有这个字段 → 判成"说不清"，只能逐文件合并（不静默降级，界面会说明）。
	 */
	baselineHash?: string;
	/**
	 * **差量包（"到某一份完整副本为止"）的目的地指纹**：那份终点完整副本的基准指纹。
	 *
	 * 有了它，接收方就能一眼看出"这个包要送到的那份完整副本，**正好就是我现在的基准**"——
	 * 那说明包里点名的东西它全都有，应用它什么都不会改（用户实测遇到过：把"32→36"的包
	 * 发给一台**已经站在第 36 代**上的机器，只看到一句"基准对不上"，看不出其实是白跑一趟）。
	 * 普通更新包（到"最新"）没有终点完整副本，就没有这个字段。
	 */
	targetBaselineHash?: string;
	/**
	 * **这个包送到的是"另一份完整副本"**（差量包）—— 只有这种包的终点才算一个真基准点。
	 *
	 * 接收方靠它决定**应用完基准点往不往前走**（0.14，见 `docs/只有完整包才算基准点-实施计划.md`）：
	 * - 有这一项：应用完就站到终点那份完整副本上（`targetBaselineHash` 就是它的指纹）；
	 * - 没有（更新包，送到的是"最新状态"）：**基准点不动** —— 它只是"从这份完整包往外长出来的一层"。
	 *
	 * 旧包没有这个字段 → 当成更新包（不推进基准点），下次导出自然归位。
	 */
	targetFullBundle?: boolean;
	/**
	 * **这个包一路上经过哪几个基准点**（不含起点与落点）—— 链条时代（0.11–0.13）的来路说明。
	 *
	 * **0.14 起不再生成**（点只有完整包了，没有"中间点"这回事），只为老包留着：
	 * `apply.ts` 的 `checkAncestor` 照样认它，链条时代发出去的包收得下。
	 */
	viaHashes?: string[];
	/**
	 * **导出方导完这一刻的状态编号**（见 `sync/state-id.ts`）：整个仓库的内容指纹。
	 *
	 * 接收方应用完之后算一个自己的跟它比：**相同 ＝ 两边文件内容一致**（用户要的就是这句话）。
	 * 基准指纹只能说明"我们是同一份祖先"，说不清"此刻一样不一样"；世代号连祖先都说不准。
	 * 旧版本的包没有这个字段 → 判成"说不清"（界面说明对方那个包没记编号）。
	 */
	stateId?: StateIdInfo;
	entries: BundleEntry[];
	deleted: BundleDeletedEntry[];
	/**
	 * 里面**没有任何文件**的目录（相对路径）。
	 *
	 * 只记空的就够了：有文件的目录会随着文件的写入被 `ensureDir` 顺带建出来；
	 * 而一个空文件夹没有任何文件可以"顺带"，不记就永远传不过去。
	 */
	emptyDirs?: string[];
	/** 负载总字节数 */
	payloadBytes: number;
}

export interface BundleTrailer {
	/** 整段负载的 sha256（十六进制） */
	payloadHash: string;
	payloadBytes: number;
	entryCount: number;
}

export interface BundleInfo {
	header: BundleHeader;
	trailer: BundleTrailer;
	/** 负载在文件里的起始位置 */
	payloadOffset: number;
	/** 包文件总大小 */
	fileSize: number;
}

/** 要写进包里的一个源文件 */
export interface BundleSource {
	/** 仓库相对路径 */
	path: string;
	/** 磁盘上的绝对路径（内容来自仓库里的文件时用它） */
	abs: string;
	/**
	 * 内容**来自另一份包**里的某一段（`payloadOffset + offset`）。
	 *
	 * 什么时候用：导"从状态 a 到状态 b"的差量包（b 是一份完整副本）时，要装的是
	 * **b 那一刻的内容** —— 那些字节只存在于 b 那份包的负载里，当前仓库里可能早就不是那一版了。
	 * 给了它就用它，`abs` 不读。
	 */
	from?: { file: string; offset: number };
	size: number;
	mtime: number;
	hash?: string;
	baseSize?: number;
	baseMtime?: number;
	baseHash?: string;
	/** 自上次完整包以来经历过的版本（见 BundleEntry.history） */
	history?: { size: number; mtime: number }[];
}

const CHUNK = 4 * 1024 * 1024;

/** 每搬完一个文件报一次（右下角的数字靠它跳动，见 ui/progress.ts） */
export type BundleWriteProgress = (done: number, total: number, path: string) => void;

/**
 * 写一个同步包。
 *
 * 逐块搬运（4MB 一块），几百 MB 的仓库也不会把内存吃满。
 * 每个文件搬完都会核对字节数 —— 对不上说明扫描之后文件被改过，
 * 这时**删掉半截的包并报错**，而不是留下一个看似正常的坏包。
 */
export async function writeBundle(
	file: string,
	header: Omit<BundleHeader, 'entries' | 'payloadBytes'>,
	sources: BundleSource[],
	onProgress?: BundleWriteProgress,
): Promise<{ header: BundleHeader; trailer: BundleTrailer }> {
	const entries: BundleEntry[] = [];
	let offset = 0;
	for (const source of sources) {
		entries.push({
			path: source.path,
			offset,
			size: source.size,
			mtime: source.mtime,
			...(source.hash ? { hash: source.hash } : {}),
			...(source.baseSize !== undefined ? { baseSize: source.baseSize } : {}),
			...(source.baseMtime !== undefined ? { baseMtime: source.baseMtime } : {}),
			...(source.baseHash ? { baseHash: source.baseHash } : {}),
			...(source.history && source.history.length > 0 ? { history: source.history } : {}),
		});
		offset += source.size;
	}

	const fullHeader: BundleHeader = { ...header, entries, payloadBytes: offset };
	const headerBytes = Buffer.from(JSON.stringify(fullHeader), 'utf8');
	const lastSeparator = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
	if (lastSeparator > 0) await ensureDir(file.slice(0, lastSeparator));

	const handle = await fs.promises.open(file, 'w');
	let position = 0;
	try {
		const lengthPrefix = Buffer.alloc(4);
		lengthPrefix.writeUInt32BE(headerBytes.length, 0);
		await handle.write(BUNDLE_MAGIC, 0, BUNDLE_MAGIC.length, position);
		position += BUNDLE_MAGIC.length;
		await handle.write(lengthPrefix, 0, 4, position);
		position += 4;
		await handle.write(headerBytes, 0, headerBytes.length, position);
		position += headerBytes.length;

		const payloadHash = createHash('sha256');
		const buffer = Buffer.alloc(CHUNK);
		let chunks = 0;
		let doneFiles = 0;

		for (const source of sources) {
			// 内容可能来自仓库里的文件，也可能来自另一份包里的某一段（导 a→b 的差量包）
			const sourceHandle = await fs.promises.open(source.from?.file ?? source.abs, 'r');
			const start = source.from?.offset ?? 0;
			const where = source.from ? `包里的那一段（${source.from.file}）` : source.abs;
			try {
				let written = 0;
				while (written < source.size) {
					const want = Math.min(CHUNK, source.size - written);
					const { bytesRead } = await sourceHandle.read(buffer, 0, want, start + written);
					if (bytesRead <= 0) break;
					payloadHash.update(buffer.subarray(0, bytesRead));
					await handle.write(buffer, 0, bytesRead, position);
					position += bytesRead;
					written += bytesRead;
					// 导一个几百 MB 的完整包要好几秒：中途让出事件循环，界面才不会僵在那儿
					if (++chunks % YIELD_EVERY === 0) await yieldToUi();
				}
				if (written !== source.size) {
					throw new Error(
						`${source.path} 在导出过程中被改动了（预期 ${source.size} 字节，实际写入 ${written} 字节，来源：${where}）`,
					);
				}
			} finally {
				await sourceHandle.close();
			}
			// 报进度放在**搬完一个文件之后**：写包是导出里最耗时的一段，
			// 不报的话右下角的数字会一直停在算指纹结束的那个数上
			onProgress?.(++doneFiles, sources.length, source.path);
		}

		const trailer: BundleTrailer = {
			payloadHash: payloadHash.digest('hex'),
			payloadBytes: offset,
			entryCount: entries.length,
		};
		const trailerBytes = Buffer.from(JSON.stringify(trailer), 'utf8');
		const trailerLength = Buffer.alloc(4);
		trailerLength.writeUInt32BE(trailerBytes.length, 0);
		// 顺序必须是 [标记][JSON][长度]：读取时从**文件最后 4 字节**拿长度，
		// 再按长度回退定位 JSON 与标记。写成 [标记][长度][JSON] 就对不上了。
		await handle.write(BUNDLE_TRAILER_MAGIC, 0, BUNDLE_TRAILER_MAGIC.length, position);
		position += BUNDLE_TRAILER_MAGIC.length;
		await handle.write(trailerBytes, 0, trailerBytes.length, position);
		position += trailerBytes.length;
		await handle.write(trailerLength, 0, 4, position);

		return { header: fullHeader, trailer };
	} catch (error) {
		// 半截的包比没有包更危险：留着会被当成有效文件去应用
		await handle.close();
		await fs.promises.rm(file, { force: true });
		throw error;
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/**
 * 读包的头部与尾部，不碰负载。
 *
 * 实现放在同步版里（`readBundleInfoSync`），这里只是等价的异步外壳：
 * 读的只有**开头几十字节 + 末尾几十字节**，同步读一次的开销可以忽略，
 * 而设置面板那条路（同步渲染，要列出本地有几份完整包）需要同步版本 ——
 * 两个版本各写一遍解析最容易走偏（尾部布局的读写顺序错一次就是读不出来），所以只留一份实现。
 */
export async function readBundleInfo(file: string): Promise<BundleInfo> {
	return readBundleInfoSync(file);
}

/** 同步读包的头部与尾部（设置面板列"本地有哪些状态"时用；语义与上一版完全一致） */
export function readBundleInfoSync(file: string): BundleInfo {
	const stat = fs.statSync(file);
	if (stat.size < BUNDLE_MAGIC.length + 4 + BUNDLE_TRAILER_MAGIC.length + 4) {
		throw new Error('不是有效的同步包（文件太短）');
	}

	const handle = fs.openSync(file, 'r');
	try {
		const readAt = (buffer: Buffer, position: number): void => {
			let read = 0;
			while (read < buffer.length) {
				const got = fs.readSync(handle, buffer, read, buffer.length - read, position + read);
				if (got <= 0) break;
				read += got;
			}
		};

		const magic = Buffer.alloc(BUNDLE_MAGIC.length);
		readAt(magic, 0);
		if (!magic.equals(BUNDLE_MAGIC)) throw new Error('不是有效的同步包（开头标记不对）');

		const lengthPrefix = Buffer.alloc(4);
		readAt(lengthPrefix, BUNDLE_MAGIC.length);
		const headerLength = lengthPrefix.readUInt32BE(0);

		const headerBytes = Buffer.alloc(headerLength);
		readAt(headerBytes, BUNDLE_MAGIC.length + 4);
		const header = JSON.parse(headerBytes.toString('utf8')) as BundleHeader;
		if (header.format !== BUNDLE_FORMAT) throw new Error('不是有效的同步包（格式标记不对）');
		if (header.version > BUNDLE_VERSION) {
			throw new Error(`这个同步包是更新版本的插件导出的（包版本 ${header.version}），请先升级插件`);
		}

		const trailerLengthPrefix = Buffer.alloc(4);
		readAt(trailerLengthPrefix, stat.size - 4);
		const trailerLength = trailerLengthPrefix.readUInt32BE(0);
		const trailerStart = stat.size - 4 - trailerLength;

		const trailerBytes = Buffer.alloc(trailerLength);
		readAt(trailerBytes, trailerStart);

		const marker = Buffer.alloc(BUNDLE_TRAILER_MAGIC.length);
		readAt(marker, trailerStart - BUNDLE_TRAILER_MAGIC.length);
		if (!marker.equals(BUNDLE_TRAILER_MAGIC)) throw new Error('同步包不完整（尾部标记丢失）');

		return {
			header,
			trailer: JSON.parse(trailerBytes.toString('utf8')) as BundleTrailer,
			payloadOffset: BUNDLE_MAGIC.length + 4 + headerLength,
			fileSize: stat.size,
		};
	} finally {
		fs.closeSync(handle);
	}
}

/** 只把某一个文件的字节读出来（不用把整个包读进内存） */
export async function readEntry(file: string, info: BundleInfo, entry: BundleEntry): Promise<Buffer> {
	const buffer = Buffer.alloc(entry.size);
	const handle = await fs.promises.open(file, 'r');
	try {
		let read = 0;
		while (read < entry.size) {
			const { bytesRead } = await handle.read(
				buffer,
				read,
				entry.size - read,
				info.payloadOffset + entry.offset + read,
			);
			if (bytesRead <= 0) break;
			read += bytesRead;
		}
		if (read !== entry.size) throw new Error(`${entry.path} 在包里不完整（读出 ${read}/${entry.size} 字节）`);
		return buffer;
	} finally {
		await handle.close();
	}
}

/** 重算整段负载的校验和，跟尾部记的对比（可选，包大时慢） */
export async function verifyBundle(file: string, info: BundleInfo): Promise<boolean> {
	const handle = await fs.promises.open(file, 'r');
	try {
		const hash = createHash('sha256');
		const buffer = Buffer.alloc(CHUNK);
		let read = 0;
		let chunks = 0;
		while (read < info.header.payloadBytes) {
			const want = Math.min(CHUNK, info.header.payloadBytes - read);
			const { bytesRead } = await handle.read(buffer, 0, want, info.payloadOffset + read);
			if (bytesRead <= 0) break;
			hash.update(buffer.subarray(0, bytesRead));
			read += bytesRead;
			// 几百 MB 的包要读好几秒：中途让出事件循环，界面才不会僵在那儿
			if (++chunks % YIELD_EVERY === 0) await yieldToUi();
		}
		return read === info.header.payloadBytes && hash.digest('hex') === info.trailer.payloadHash;
	} finally {
		await handle.close();
	}
}
