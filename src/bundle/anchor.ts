import path from 'node:path';
import { baselineOfBundle } from './baseline';
import { listBundles } from './manage';
import { BUNDLE_EXT, readBundleInfoSync } from './format';
import type { BundleHeader } from './format';
import { bundleDirsToScan } from './paths';
import type { ChainPoint } from './points';
import { listFilesSync } from '../sync/disk';
import type { PluginState, StateIdInfo } from '../sync/state';
import type { FileRecord } from '../sync/types';

/**
 * 「状态」＝**一份完整副本**（或者"最新"＝当前仓库）。
 *
 * 更新包本来就是"从某个状态到某个状态的差量"，两个端点在界面上都该能选：
 *
 * - **从**：对方手里那份完整副本 —— 默认是"我最新那份"，也可以指定硬盘上更老的那一份。
 *   为什么需要：我重立了基准（第 36 代那份），对方还站在第 32 代上，按最新基准导出来的
 *   更新包对它是"基于一份它没有的完整副本"（只能逐文件合并）。而**第 32 代那份完整包
 *   还在硬盘上**（完整副本是还原点，从来不会被清），指定它当起点，对方收到就是
 *   接着自己那份基准的确定性更新。
 * - **到**：默认"最新"（当前仓库，含你刚改的东西）；也可以指定另一份完整副本 ——
 *   那就导一份"从 a 到 b 那一刻"的差量包，内容取自 b 那份包本身（不是你现在的仓库）。
 *
 * 一句话对照 git：完整包 ＝ commit，更新包 ＝ "从某个 commit 到某个 commit 的 diff"。
 *
 * **认状态靠「基准指纹」，世代号只是给人读的**：世代号说的是"这份内容走到第几版"
 * （同一个内容必然同一个号，见 `apply.ts` 里那段定义），可它认不出"我们是不是从同一份
 * 完整副本分出来的" —— 两台各自立过基准时，两边的"第 3 代"可能是两份不同的东西。
 * 所以界面上每个状态都写成「第 N 代 · 基准 xxxx」（起点）/「第 N 代 · 状态 xxxx」（终点）。
 * 这个文件不 import obsidian。
 */

/** 一份可用于当"状态"的完整副本 */
export interface BundleAnchor {
	/** 它是第几代导出的（包头部 `targetGeneration`）—— 站在它的接收方手里的世代 */
	generation: number;
	/** 它的基准指纹（见 `baseline.ts`）：应用过它的机器，`fullHash` 就是这个 */
	hash: string | null;
	/** 它的完整清单（path → 大小 / 修改时间）：差量包按它挑"自它以来变过的文件" */
	files: Record<string, FileRecord>;
	/** 它记着的空文件夹（有文件的目录会随文件写入顺带建出来，空的只能靠这份清单） */
	emptyDirs: string[];
	/** 在界面 / 报告里显示的文件名（不含目录） */
	name: string;
	/** 包文件绝对路径（导 a→b 差量包时要读它的负载；空串 ＝ 状态里记着、磁盘上找不到） */
	file: string;
	/**
	 * 这份完整包记的**状态编号**（导出方导完那一刻的文件状态，见 `sync/state-id.ts`）。
	 *
	 * 存整份而不只是那个 id：导"到某一份完整副本"的差量包时，要把它原样写进新包的头部 ——
	 * 接收方应用完算一个自己的跟它比，**相同就说明正好落到了那一刻**。
	 */
	stateId: StateIdInfo | null;
	/** 包文件的修改时间：同一代有好几份时按它挑最新的那份 */
	mtime: number;
	/**
	 * 每个文件的字节在哪儿（包文件 + 负载内偏移）。
	 *
	 * **只有"链条上的点"才带它**（见 `points.ts`）：那种点没有自己的包文件，
	 * 内容散在链条上好几份包里（改过的在那一环的包里，没动过的还在起点那份包里）。
	 * 完整副本不带它 —— 那种情况直接读 `file` 的负载、按条目 offset 取就行。
	 */
	sources?: Map<string, { file: string; offset: number; size: number; mtime: number; hash?: string }>;
}

/**
 * 报错 / 下拉框只需要点儿的"身份"这几样 —— 清单是重活，等真要用了再去取
 * （`BundleAnchor` 与 `points.ts` 的 `PointRef` 都满足它）。
 */
export interface AnchorRef {
	generation: number;
	hash: string | null;
	stateId: StateIdInfo | null;
	name: string;
}

/**
 * **链条上的一个点**（`points.ts` 算出来的）→ 一个能当"状态"用的锚点。
 *
 * 它可能是一份更新包落出的点：清单与 `sources` 都是沿链条叠加出来的，
 * 所以导"到这一点为止"的差量包时，内容能逐文件从正确的包里取。
 */
export function anchorOfPoint(point: ChainPoint): BundleAnchor {
	return {
		generation: point.generation,
		hash: point.hash,
		files: point.files,
		emptyDirs: point.emptyDirs,
		name: point.name,
		file: point.file,
		stateId: point.stateId,
		mtime: point.mtime,
		sources: point.sources,
	};
}

/** 一份完整包 → 一个状态（不是完整包就返回 null） */
export function anchorOfHeader(
	header: BundleHeader | null | undefined,
	file: string,
	name: string,
	mtime: number,
): BundleAnchor | null {
	if (!header || header.mode !== 'full') return null;
	const files: Record<string, FileRecord> = {};
	for (const entry of header.entries ?? []) files[entry.path] = { size: entry.size, mtime: entry.mtime };
	return {
		generation: header.targetGeneration,
		hash: baselineOfBundle(header),
		files,
		emptyDirs: [...(header.emptyDirs ?? [])],
		name,
		file,
		stateId: header.stateId ?? null,
		mtime,
	};
}

/**
 * 包里目录下所有**同一条血脉**的完整副本，世代大的排前面（同代按修改时间新的在前）。
 *
 * 为什么只认同一条血脉：别的机器独立立的基准**跟我这边不是一份东西**
 * （它有它自己的第 1 代、第 2 代），拿它当起点算出来的更新包谁也不认识。
 */
export async function listFullAnchors(baseDir: string, lineage: string): Promise<BundleAnchor[]> {
	const out: BundleAnchor[] = [];
	for (const item of await listBundles(baseDir)) {
		const header = item.header;
		if (!header || header.mode !== 'full') continue;
		if (header.lineage !== lineage) continue;
		const anchor = anchorOfHeader(header, item.file, item.name, item.mtime);
		if (anchor) out.push(anchor);
	}
	return sortAnchors(out);
}

/**
 * 同步版：设置面板是**同步渲染**的，"从哪个状态 / 到哪个状态"两个下拉要在渲染那一刻
 * 就有选项，等不了 `await`。只看 `full/` 与根目录（完整包就放那儿，数量很少），
 * 读不出头部的包直接跳过 —— 选项里少一个，总比下拉框空着强。
 */
export function listFullAnchorsSync(baseDir: string, lineage: string): BundleAnchor[] {
	if (!baseDir) return [];
	const out: BundleAnchor[] = [];
	for (const dir of bundleDirsToScan(baseDir)) {
		// 更新包目录里不会有完整包，但真放了一份（用户手动挪的）也该列出来 —— 反正读头部很便宜
		for (const item of listFilesSync(dir)) {
			if (!item.name.toLowerCase().endsWith(BUNDLE_EXT)) continue;
			const file = path.join(dir, item.name);
			try {
				const header = readBundleInfoSync(file).header;
				if (header.mode !== 'full' || header.lineage !== lineage) continue;
				const anchor = anchorOfHeader(header, file, item.name, item.mtime);
				if (anchor) out.push(anchor);
			} catch {
				// 读不出头部（不是我们的包 / 传坏了）：不当状态用
			}
		}
	}
	return sortAnchors(out);
}

/** 世代大的在前；同代取最近写的那一份 */
function sortAnchors(anchors: BundleAnchor[]): BundleAnchor[] {
	return anchors.sort((a, b) => b.generation - a.generation || b.mtime - a.mtime);
}

/** 「自动选起点」的结论：这条线从我这一点往后能走到的最新点 */
export interface AutoStartPlan {
	/** 我站的这一点（还没有基准点时 null） */
	mine: { generation: number; hash: string; name: string } | null;
	/** 自动接上的线头；null ＝ 我就是线头，或者走不到（那时看 `problem`） */
	head: { generation: number; hash: string; name: string } | null;
	/** 接不上的说明（正常时为 null） */
	problem: string | null;
}

/**
 * **自动选起点：这条线从我站的这一点往后，最新的一点是哪一点**（只读）。
 *
 * 为什么需要（用户报的）：应用一份完整副本**回退**到第 39 代之后，老的默认是"从我站的
 * 这一点往外导"——于是导出来「39 → 40」，而 40 在历史上早被这条线用过，顺序当场乱掉、
 * 还从 39 分出一条岔。用户的原话："我希望更新有严格顺序，所以应该基于最新基准点"。
 *
 * 走法就是链条本身（与 `chain.ts` 那套一致）：每一步找"起点指纹 ＝ 当前落点"的那一环，
 * 同一起点上有分支时取**最新**的那一份（另一份是并行的支线）；世代必须往前走（防环）。
 * 三类结果：
 * - **我就是线头**（没有环从我这一点往外长）→ `head` 为 null，导出行为与老版本一模一样；
 * - **前面有线** → `head` ＝ 那一串的末尾（从它后面往外导，顺序不乱、不分支）；
 * - **中间那几环被完整副本取代掉了**（完整副本一写就会清老环，`removeSupersededChanges`）→
 *   退一步拿"比我新的最新那份完整副本"当线头（它自带完整清单，照样能当起点）；
 * - 都不行 → `head` 为 null 并给一句 `problem`（退回"我站的这一点"导出，
 *   号仍然从高水位往后发，不会撞号）。
 */
export async function planAutoStart(baseDir: string, state: PluginState): Promise<AutoStartPlan> {
	const mineHash = state.bundle?.fullHash ?? null;
	const mine: AutoStartPlan['mine'] = mineHash
		? {
			generation: state.bundle?.fullGeneration ?? state.generation,
			hash: mineHash,
			name: state.bundle?.fullFile ?? '（状态里记着的那份包）',
		}
		: null;
	if (!baseDir || !mine) return { mine, head: null, problem: null };

	// 只看同一条血脉：别的机器独立立的基准跟我这边不是一份东西，拿它当起点谁也不认识
	const items = (await listBundles(baseDir)).filter(item => item.header?.lineage === state.lineage);
	const rings = items
		.filter(item => item.header?.mode === 'changes' && (item.header.targetBaselineHash ?? null) !== null)
		.map(item => ({
			file: item.file,
			name: item.name,
			generation: item.header?.targetGeneration ?? 0,
			baseline: item.header?.baselineHash ?? null,
			target: item.header?.targetBaselineHash as string,
		}));

	const used = new Set<string>();
	let cursor = mine.hash;
	let generation = mine.generation;
	let head: AutoStartPlan['head'] = null;
	for (;;) {
		const next = rings
			.filter(ring => ring.baseline === cursor && !used.has(ring.file) && ring.generation > generation)
			.sort((a, b) => b.generation - a.generation)[0];
		if (!next) break;
		used.add(next.file);
		cursor = next.target;
		generation = next.generation;
		head = { generation, hash: cursor, name: next.name };
	}
	if (head) return { mine, head, problem: null };

	// 老环可能已经被一份完整副本取代掉了：拿"比我新"的最新那份完整副本当线头
	const fulls = items
		.filter(item => item.header?.mode === 'full')
		.map(item => ({
			name: item.name,
			generation: item.header?.targetGeneration ?? 0,
			hash: item.header ? baselineOfBundle(item.header) : null,
		}))
		.filter(item => item.hash !== null && item.generation > mine.generation)
		.sort((a, b) => b.generation - a.generation);
	const freshest = fulls[0];
	if (freshest?.hash) {
		return { mine, head: { generation: freshest.generation, hash: freshest.hash, name: freshest.name }, problem: null };
	}

	// 前面确实还有东西、但接不上：如实说一句（这一份只能从本机这一点往外导）
	const highest = items.reduce((max, item) => Math.max(max, item.header?.targetGeneration ?? 0), 0);
	return {
		mine,
		head: null,
		problem: highest > mine.generation
			? `这条线在包目录里已经到第 ${highest} 代了，但没有接着你站的那一点往后的环（中间缺几份包）——`
				+ '这一份只能从你站的这一点往外导。把缺的那几份包（或者一份更新的完整副本）拷进来就能接在线头后面'
			: null,
	};
}

/**
 * 按**基准指纹**找状态 —— 下拉框的键就是它（`''` ＝ 最新）。
 *
 * **为什么认指纹、不认世代号**：世代号说的是"这份内容走到第几版了"（同一内容必然同一个号，
 * 见 `apply.ts` 里那段新定义），可它**不说明"我们是从哪一份完整副本分出来的"** ——
 * 两台机器各自立过完整副本时，两边的"第 3 代"可能是**两份内容完全不同的完整副本**，
 * 号一样、祖先不一样。用户实测就踩了这个：按"第 32 代"选起点导出的更新包，
 * 对面报「基准对不上」—— 选中的那一份根本不是对方手里那份。
 * 指纹是那份清单的直接证据，认它才认得出"同一份东西"。
 */
export function pickAnchor(anchors: BundleAnchor[], hash: string): BundleAnchor | null {
	return anchors.find(anchor => anchor.hash === hash) ?? null;
}

/** 按基准指纹找状态（自己去列目录） */
export async function findFullAnchor(
	baseDir: string,
	lineage: string,
	hash: string,
): Promise<BundleAnchor | null> {
	return pickAnchor(await listFullAnchors(baseDir, lineage), hash);
}

/**
 * 一个状态在界面上怎么念 —— **写对方报给你的那一项**：
 * - `from`（起点）：`第 32 代 · 基准 7a22d790635332a0` —— 对方「更新记录」顶上写着
 *   「基准：第 32 代 · 指纹 7a22d790635332a0」，照那个指纹选，别只看代；
 * - `to`（终点）：`第 32 代 · 状态 3f9a2c1d4e5f6a7b` —— 对方应用完的结论里写的是「状态 …」。
 *
 * **世代与编号必须一起写**：世代号是"这份内容走到第几版"（好认、好读），
 * 但它认不出"我们是不是从同一份完整副本分出来的" —— 那件事只有**基准指纹**说了算。
 * 所以标签里两个都在：先报第几代（人读的），再报指纹 / 状态编号（机器对得上的）。
 */
export function describeAnchor(anchor: AnchorRef, end: 'from' | 'to' = 'from'): string {
	const id = end === 'from'
		? `基准 ${anchor.hash ?? '未记（旧版包）'}`
		: `状态 ${anchor.stateId?.id ?? '未记（旧版包）'}`;
	return `第 ${anchor.generation} 代 · ${id}`;
}

/** 「本地有几个完整包就有几个状态」—— 下拉框的键：`''` ＝ 最新，其余是基准指纹 */
export const LATEST_STATE = '';

export interface LatestInfo {
	/** 我最新那份完整副本是第几代（还没立过基准时为 null） */
	generation: number | null;
	/** 那份完整副本的基准指纹 */
	hash: string | null;
	/** 那份完整包的文件名 */
	file: string | null;
}

/**
 * 两个下拉（从哪个状态 / 到哪个状态）的选项。
 *
 * **键是基准指纹**（不是世代号）：同一代可能有好几份完整副本（两台机器各导过一份），
 * 按世代做键会把它们挤成一个选项、还默默挑一份（用户实测就是这么踩到"基准对不上"的）。
 * 同一份东西（指纹相同）只留一个选项。
 *
 * 「最新」在两端意思不一样，所以文案分开写：
 * - `from`：最新 ＝ **自动接线头**（默认）—— 我就是这条线的最新点就从我这一点往外导；
 *   我落在后面（回退过 / 没跟上）时自动接在这条线的最新点后面（用户拍板的"严格顺序"，
 *   见 `planAutoStart`：不这么办会从老点分岔、还会撞上历史上用过的号）；
 * - `to`：最新 ＝ **当前仓库**（现在这一刻，含你刚改的东西）—— 这也是默认。
 *
 * 选项里除了完整副本，还有**链条上的点**（每份更新包落出的那一点，见 `points.ts`）：
 * 用户完全可能想"从对方站的某个中间点导到另一个点"。
 */
export function anchorOptions(
	anchors: AnchorRef[],
	end: 'from' | 'to',
	latest: LatestInfo,
): Record<string, string> {
	const options: Record<string, string> = {};
	if (end === 'from') {
		const detail = latest.generation !== null
			? `，你站在第 ${latest.generation} 代${latest.hash ? ` · ${latest.hash}` : ''}`
			: '（还没站上过基准点）';
		options[LATEST_STATE] = `自动：接在这条线的最新点后面${detail}`;
	} else {
		options[LATEST_STATE] = '最新（当前仓库，现在这一刻）';
	}
	const seen = new Set<string>();
	for (const anchor of anchors) {
		const hash = anchor.hash;
		if (!hash || seen.has(hash)) continue;
		seen.add(hash);
		options[hash] = describeAnchor(anchor, end);
	}
	return options;
}

/**
 * 报错 / 界面提示里把"现在有哪些状态"列出来：`第 36 代 · 基准 7a22d790…（包名）`。
 * 照这一串去对方「更新记录」里找同一个指纹，就知道该选哪一个。
 */
export function describeAnchorList(anchors: AnchorRef[]): string {
	if (anchors.length === 0) return '这个文件夹里还没有可以当起点的完整副本';
	return `现在找得到的状态是：${anchors
		.map(anchor => `${describeAnchor(anchor, 'from')}（${anchor.name}）`)
		.join('、')}`;
}
