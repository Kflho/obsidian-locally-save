import { baselineOfBundle } from './baseline';
import { listBundles, trashBundles } from './manage';
import type { TrashOutcome } from './manage';
import type { PluginState } from '../sync/state';
import type { PeerState } from '../git/peers';

/**
 * **没人站的旧完整副本**：换基准之后留在 `full/` 里的那些「上一份基准」。
 *
 * 为什么单独一块、而且**必须由用户点**：完整副本是**还原点**（它是唯一能"回到那一天"的东西），
 * 0.14 起 `removeSupersededChanges` 明文规定"完整包一律不碰"，正确性上不能自动删。
 * 但换过几次基准之后它们很占地方（一份几百 MB），所以给一个入口，条件卡死：
 *
 * 三条同时成立才列出来（缺一条都留着，并在界面上说明为什么）：
 * 1. 它**不是我现在站的这一份**（`state.bundle.fullHash`）—— 那份是我脚下这块地；
 * 2. **货架上有别的电脑上报过状态**（`peers.length > 0`），而且**没有任何一台**报的
 *    `baselineHash` 等于它 —— 有一台还停在上面就不能动（它的更新包全是相对那份算的）；
 * 3. 它的世代**不比我站的这份新**（比我新的那份是"我往回退过"之后的还原点，更不该删）。
 *
 * 删的时候照旧**移到回收站**（`manage.ts` 的 `trashBundles`）：点错了能捞回来，
 * 真腾空间由用户再点「清空回收站」—— 这跟包列表里那几行的规矩是同一条。
 *
 * 判"有没有人站"只认**货架上的 peer 文件**，所以：
 * - 没开 git / 还没人上报 → 一律不清（分不清），界面如实说明；
 * - 某台电脑很久没同步、上报的还是旧基准 → 它会保护旧包（宁可多留，不可误删）。
 */
export interface StaleFullBundle {
	file: string;
	name: string;
	generation: number;
	hash: string | null;
	size: number;
}

export interface StaleFullPlan {
	/** 能清的（确认后整批移到回收站） */
	trash: StaleFullBundle[];
	/** 留着没动的，以及为什么 */
	kept: { name: string; why: string }[];
	/** `trash` 一共占多少字节 */
	bytes: number;
	/** 现在判断不了时的一句话（null ＝ 能判断，`trash` 可能为空） */
	blocked: string | null;
	/** 我现在站的完整副本 */
	mine: { generation: number; hash: string } | null;
	/** 各台电脑各自用哪（界面上对号用） */
	peers: { label: string; baselineGeneration: number | null; baselineHash: string | null }[];
}

function peerLabel(peer: PeerState): string {
	if (peer.host !== '') return peer.host;
	if (peer.vault !== '') return peer.vault;
	return peer.copyId.slice(0, 8);
}

/** 只算不写：哪些旧完整副本已经没人站了、哪些还挡着 */
export async function planStaleFullBundles(
	baseDir: string,
	state: PluginState,
	peers: PeerState[],
): Promise<StaleFullPlan> {
	const mineHash = state.bundle?.fullHash ?? null;
	const mineGeneration = state.bundle?.fullGeneration ?? state.generation;
	const plan: StaleFullPlan = {
		trash: [],
		kept: [],
		bytes: 0,
		blocked: null,
		mine: mineHash ? { generation: mineGeneration, hash: mineHash } : null,
		peers: peers.map(peer => ({
			label: peerLabel(peer),
			baselineGeneration: peer.baselineGeneration,
			baselineHash: peer.baselineHash,
		})),
	};
	if (!baseDir) {
		plan.blocked = '还没确定同步包文件夹';
		return plan;
	}
	if (!mineHash) {
		plan.blocked = '本机还没有基准：先导一份完整副本，才分得清哪份是旧的';
		return plan;
	}
	if (peers.length === 0) {
		plan.blocked = '货架上还没有别的电脑上报过状态：分不清哪一份还有人用（要清就自己在列表里移）';
		return plan;
	}

	for (const item of await listBundles(baseDir)) {
		const header = item.header;
		if (!header) continue;
		if (header.mode !== 'full') continue;
		if (header.lineage !== state.lineage) {
			plan.kept.push({ name: item.name, why: '另一个来源的包（多半是另一台机器另立的基准）' });
			continue;
		}
		const hash = baselineOfBundle(header);
		if (hash === mineHash) {
			plan.kept.push({ name: item.name, why: '← 就是本机现在的基准' });
			continue;
		}
		if (header.targetGeneration > mineGeneration) {
			plan.kept.push({
				name: item.name,
				why: `第 ${header.targetGeneration} 代，比本机现在的基准还新（往回退过才用得到它），留着`,
			});
			continue;
		}
		const holder = peers.find(peer => peer.baselineHash === hash);
		if (holder) {
			plan.kept.push({
				name: item.name,
				why: `${peerLabel(holder)} 用的还是第 ${header.targetGeneration} 代，它要用这份`,
			});
			continue;
		}
		plan.trash.push({
			file: item.file,
			name: item.name,
			generation: header.targetGeneration,
			hash,
			size: item.size,
		});
		plan.bytes += item.size;
	}
	return plan;
}

/** 把计划里那几份移到回收站（**只动 `plan.trash`**，别的包一个不碰） */
export async function trashStaleFullBundles(baseDir: string, plan: StaleFullPlan): Promise<TrashOutcome> {
	return trashBundles(baseDir, plan.trash.map(item => item.file));
}

/**
 * **基准体检**：两边的完整副本对不对得上、本机有没有那个包文件（0.18.1）。
 *
 * 为什么要有：换基准、应用差量包这些动作会把基准换来换去，出问题时用户只看到
 * 「基准对不上」这一句，不知道是"本机那份包没了"、"盘上那份不是这个基准"，
 * 还是"对面换了新的、该我收它的"。这里把三边摊开：
 *
 * ```
 *   本机基准：第 961 代 · ec94a8bf… · 包文件 obsidian-完整-961代-….lsave（有）
 *   盘上的完整副本：✔ 第 961 代（就是它）   ✘ 第 320 代（不是这个基准，512 MB）
 *   各台电脑：KahoTAT 第 320 代（和本机不一样 → 该给它导差量包 / 或把本机这份拷给它）
 * ```
 *
 * 三种结论：
 * - `ok`：本机的基准在盘上有包文件，各台电脑报的也是它；
 * - `missing-file`：本机的基准在盘上**没有**对应的包文件（应用差量包之后常见的状态）；
 * - `wrong-file`：`fullFile` 指的那份，指纹和本机基准不一样（换过 / 拷错过）——
 *   这种要**移到回收站**，再把对面那份拷进来、应用一遍；
 * - `peer-other`：有电脑报的基准和本机不同（不是错，只是还没跟上）。
 */
export interface BaselineHealth {
	verdict: 'ok' | 'no-baseline' | 'missing-file' | 'wrong-file' | 'peer-other';
	mine: { generation: number | null; hash: string; file: string | null } | null;
	/** 盘上的完整副本（`mine` ＝ 指纹就是本机这个基准） */
	anchors: { file: string; name: string; generation: number; hash: string | null; size: number; mine: boolean }[];
	/** 各台电脑报的基准（`same` ＝ 和本机一致） */
	peers: { label: string; generation: number | null; hash: string | null; same: boolean }[];
	/** 给人看的几行结论（界面直接列） */
	notes: string[];
}

export async function planBaselineHealth(
	baseDir: string,
	state: PluginState,
	peers: PeerState[],
): Promise<BaselineHealth> {
	const hash = state.bundle?.fullHash ?? null;
	const file = state.bundle?.fullFile ?? null;
	const anchors: BaselineHealth['anchors'] = [];
	for (const item of await listBundles(baseDir)) {
		const header = item.header;
		if (!header || header.mode !== 'full') continue;
		if (header.lineage !== state.lineage) continue;
		const own = baselineOfBundle(header);
		anchors.push({
			file: item.file,
			name: item.name,
			generation: header.targetGeneration,
			hash: own,
			size: item.size,
			mine: hash !== null && own === hash,
		});
	}
	const peerView = peers.map(peer => ({
		label: peerLabel(peer),
		generation: peer.baselineGeneration,
		hash: peer.baselineHash,
		same: hash !== null && peer.baselineHash === hash,
	}));
	const out: BaselineHealth = {
		verdict: 'ok',
		mine: hash ? { generation: state.bundle?.fullGeneration ?? null, hash, file } : null,
		anchors,
		peers: peerView,
		notes: [],
	};
	if (!hash) {
		out.verdict = 'no-baseline';
		out.notes.push('本机还没有基准：先导一份完整副本，或者应用对方发来的那份');
		return out;
	}
	if (file) {
		const named = anchors.find(item => item.name === file);
		if (named && !named.mine) {
			out.verdict = 'wrong-file';
			out.notes.push(`本机记着的包文件「${file}」指纹是 ${named.hash ?? '未记'}，和本机基准 ${hash} 不一样`);
			out.notes.push('把它移到回收站，再把对面那份完整副本拷进 full/，然后在「管理同步包」里选它点「以这一份为基准…」');
			return out;
		}
	}
	if (!anchors.some(item => item.mine)) {
		out.verdict = 'missing-file';
		out.notes.push(`本机没有第 ${out.mine?.generation ?? '?'} 代（${hash}）那份完整副本的包文件`);
		out.notes.push('把对面那份完整副本拷进 full/，再在「管理同步包」里选它点「以这一份为基准…」应用一遍');
		return out;
	}
	const behind = peerView.filter(peer => !peer.same);
	if (behind.length > 0) {
		out.verdict = 'peer-other';
		out.notes.push(`${behind.map(item => item.label).join('、')} 报的基准和本机不一样`);
		out.notes.push('对面停在本机以前那份上：命令「导出换基准的差量包…」能把它们换到本机这个基准；'
			+ '对面比本机新时，该收它的差量包');
		return out;
	}
	out.notes.push(peerView.length > 0
		? `本机基准第 ${out.mine?.generation ?? '?'} 代（${hash}），包文件在，各台电脑报的也是它`
		: `本机基准第 ${out.mine?.generation ?? '?'} 代（${hash}），包文件在；货架上还没有别的电脑上报过`);
	return out;
}

