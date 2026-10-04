import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { ensureDir } from '../sync/disk';

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
	/** 内容指纹（十六进制 sha256）；导出时开了「记住内容指纹」才有 */
	hash?: string;
	baseSize?: number;
	baseMtime?: number;
	baseHash?: string;
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
	entries: BundleEntry[];
	deleted: BundleDeletedEntry[];
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
	/** 磁盘上的绝对路径 */
	abs: string;
	size: number;
	mtime: number;
	hash?: string;
	baseSize?: number;
	baseMtime?: number;
	baseHash?: string;
}

const CHUNK = 4 * 1024 * 1024;

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

		for (const source of sources) {
			const sourceHandle = await fs.promises.open(source.abs, 'r');
			try {
				let written = 0;
				while (written < source.size) {
					const want = Math.min(CHUNK, source.size - written);
					const { bytesRead } = await sourceHandle.read(buffer, 0, want, written);
					if (bytesRead <= 0) break;
					payloadHash.update(buffer.subarray(0, bytesRead));
					await handle.write(buffer, 0, bytesRead, position);
					position += bytesRead;
					written += bytesRead;
				}
				if (written !== source.size) {
					throw new Error(
						`${source.path} 在导出过程中被改动了（预期 ${source.size} 字节，实际写入 ${written} 字节）`,
					);
				}
			} finally {
				await sourceHandle.close();
			}
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

/** 读包的头部与尾部，不碰负载 */
export async function readBundleInfo(file: string): Promise<BundleInfo> {
	const stat = await fs.promises.stat(file);
	if (stat.size < BUNDLE_MAGIC.length + 4 + BUNDLE_TRAILER_MAGIC.length + 4) {
		throw new Error('不是有效的同步包（文件太短）');
	}

	const handle = await fs.promises.open(file, 'r');
	try {
		const magic = Buffer.alloc(BUNDLE_MAGIC.length);
		await handle.read(magic, 0, magic.length, 0);
		if (!magic.equals(BUNDLE_MAGIC)) throw new Error('不是有效的同步包（开头标记不对）');

		const lengthPrefix = Buffer.alloc(4);
		await handle.read(lengthPrefix, 0, 4, BUNDLE_MAGIC.length);
		const headerLength = lengthPrefix.readUInt32BE(0);

		const headerBytes = Buffer.alloc(headerLength);
		await handle.read(headerBytes, 0, headerLength, BUNDLE_MAGIC.length + 4);
		const header = JSON.parse(headerBytes.toString('utf8')) as BundleHeader;
		if (header.format !== BUNDLE_FORMAT) throw new Error('不是有效的同步包（格式标记不对）');
		if (header.version > BUNDLE_VERSION) {
			throw new Error(`这个同步包是更新版本的插件导出的（包版本 ${header.version}），请先升级插件`);
		}

		const trailerLengthPrefix = Buffer.alloc(4);
		await handle.read(trailerLengthPrefix, 0, 4, stat.size - 4);
		const trailerLength = trailerLengthPrefix.readUInt32BE(0);
		const trailerStart = stat.size - 4 - trailerLength;

		const trailerBytes = Buffer.alloc(trailerLength);
		await handle.read(trailerBytes, 0, trailerLength, trailerStart);

		const marker = Buffer.alloc(BUNDLE_TRAILER_MAGIC.length);
		await handle.read(marker, 0, marker.length, trailerStart - BUNDLE_TRAILER_MAGIC.length);
		if (!marker.equals(BUNDLE_TRAILER_MAGIC)) throw new Error('同步包不完整（尾部标记丢失）');

		return {
			header,
			trailer: JSON.parse(trailerBytes.toString('utf8')) as BundleTrailer,
			payloadOffset: BUNDLE_MAGIC.length + 4 + headerLength,
			fileSize: stat.size,
		};
	} finally {
		await handle.close();
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
		while (read < info.header.payloadBytes) {
			const want = Math.min(CHUNK, info.header.payloadBytes - read);
			const { bytesRead } = await handle.read(buffer, 0, want, info.payloadOffset + read);
			if (bytesRead <= 0) break;
			hash.update(buffer.subarray(0, bytesRead));
			read += bytesRead;
		}
		return read === info.header.payloadBytes && hash.digest('hex') === info.trailer.payloadHash;
	} finally {
		await handle.close();
	}
}
