/**
 * 状态栏 / 同步总结里的「对方：…」与「各台电脑同步状态」文案。
 *
 * 钉的是"说法和行为对齐"：
 * - `已推送` / `已拉取` / `远程已是最新` 是 **git 推拉** 的结果，不能写成"已同步"；
 * - `一致` / `不同步` / `待上报` / `还没上报` 是 **内容层面** 每台机器的结论；
 * - 多台机器要逐台计数，不能压成一句"对方：不同步"；
 * - "我这边刚应用完、它还没报新状态"要单独说 `待上报`，不能当成内容不同。
 */
import { describePeerDetail, describePeersShort, peerMatch } from '../src/git/peers';
import type { PeerState } from '../src/git/peers';
import { statusSummary } from '../src/ui/status';
import type { PluginState } from '../src/sync/state';

// -------------------------------------------------------------------- 断言
let checks = 0;
const failures: string[] = [];

function checkTrue(name: string, condition: boolean, detail = name): void {
	checks++;
	if (!condition) failures.push(`[断言失败] ${name}\n  ${detail}`);
}

function check(name: string, actual: unknown, expected: unknown): void {
	checks++;
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		failures.push(`[期望不符] ${name}\n  期望 ${JSON.stringify(expected)}\n  实际 ${JSON.stringify(actual)}`);
	}
}

/** 一台机器上报的状态（只填文案要用到的字段） */
function peer(over: Partial<PeerState> = {}): PeerState {
	return {
		format: 'locally-save-peer',
		version: 1,
		copyId: '3f26ea0e-3b53-450e-8816-fae9d7287f16',
		vault: 'laptop',
		host: 'test-host',
		lineage: 'same-lineage',
		stateId: 'aaaa1111bbbb2222',
		generation: 105,
		baselineHash: 'd4fa00f069bba03e',
		baselineGeneration: 100,
		lastExport: null,
		lastApply: null,
		pending: 0,
		at: 1000,
		...over,
	};
}

const MINUTE = 60_000;

// -------------------------------------------------------------------- 用例
// 1. 没有别的机器
check('没有别的机器：还没上报', describePeersShort([], 'mine', 0), '对方：还没上报');

// 2. 一台一致
check('一台一致', describePeersShort([peer({ stateId: 'mine' })], 'mine', 0), '对方：一致');
check('一台一致：详情写清两边编号', describePeerDetail(peer({ stateId: 'mine' }), 'mine', 0).includes('它 mine / 我 mine'), true);

// 3. 真不同步（它上报得比我最近一次状态还新，编号却不同）
check('一台不同步', describePeersShort([peer({ stateId: 'other', at: 2000 })], 'mine', 1000), '对方：不同步');
const different = describePeerDetail(peer({ stateId: 'other', at: 2000 }), 'mine', 1000);
checkTrue('不同步：详情带两边编号', different.includes('✗ 不同步') && different.includes('它 other / 我 mine'), different);
checkTrue('详情带主机名：多台机器认得出是哪台', different.includes('test-host'), different);
check('不同步的判据', peerMatch(peer({ stateId: 'other', at: 2000 }), 'mine', 1000), 'different');

// 4. 我刚应用完、它还没报新状态：不能断言"不同步"
const staleAt = 1000;
const mineAt = 1000 + 5 * MINUTE;
check('刚应用完：待上报', describePeersShort([peer({ stateId: 'other', at: staleAt })], 'mine', mineAt), '对方：待上报');
check('待上报的判据', peerMatch(peer({ stateId: 'other', at: staleAt }), 'mine', mineAt), 'stale');
checkTrue(
	'待上报：详情说清不是内容不同',
	describePeerDetail(peer({ stateId: 'other', at: staleAt }), 'mine', mineAt).includes('还没报新状态'),
	describePeerDetail(peer({ stateId: 'other', at: staleAt }), 'mine', mineAt),
);

// 4b. 本机还没算过状态编号：不能把"没法比"说成"对方没上报"
check('本机没状态：无法比较', describePeersShort([peer()], null, 0), '对方：本机还没算过状态');
checkTrue(
	'本机没状态：详情说清原因',
	describePeerDetail(peer(), null, 0).includes('本机还没算过状态'),
	describePeerDetail(peer(), null, 0),
);

// 5. 多台机器：逐台计数
const two = [
	peer({ copyId: 'peer-1', stateId: 'mine', at: 2000 }),
	peer({ copyId: 'peer-2', stateId: 'other', at: 2000 }),
];
check('两台：一台一致、一台不同步', describePeersShort(two, 'mine', 1000), '对方：1 台一致 · 1 台不同步');
const three = [
	peer({ copyId: 'peer-1', stateId: 'mine', at: 2000 }),
	peer({ copyId: 'peer-2', stateId: 'other', at: 400_000 }),
	peer({ copyId: 'peer-3', stateId: 'third', at: 500 }),
];
check('三台：一致 / 不同步 / 待上报', describePeersShort(three, 'mine', 1000 + 5 * MINUTE), '对方：1 台一致 · 1 台不同步 · 1 台待上报');
check('一台没上报状态编号', describePeersShort([peer({ stateId: null })], 'mine', 0), '对方：没上报');

// 6. 状态栏前半句：git 推拉结果，不再写"已同步"
function stateWithGit(git: PluginState['git']): PluginState {
	return {
		version: 1,
		copyId: 'me',
		lineage: 'l',
		generation: 105,
		maxGeneration: 105,
		lastBundleId: null,
		lastExportedBundleId: null,
		bundle: null,
		hashes: {},
		bundleLog: [],
		pendingReturn: null,
		stateId: { id: 'mine', files: 1, dirs: 0, unverified: 0, at: 1000 },
		incoming: [],
		git,
	} as unknown as PluginState;
}
const when = new Date(2026, 0, 1, 12, 31).getTime();
check(
	'只推上去：已推送（不是"已同步"）',
	statusSummary(stateWithGit({ at: when, ok: true, pushed: true, pulled: 0, ahead: 0, behind: 0 })),
	'已推送 12:31',
);
check(
	'没有可推的：远程已是最新',
	statusSummary(stateWithGit({ at: when, ok: true, pushed: false, pulled: 0, ahead: 0, behind: 0 })),
	'远程已是最新 12:31',
);
check(
	'推拉都做了：已推拉',
	statusSummary(stateWithGit({ at: when, ok: true, pushed: true, pulled: 2, ahead: 0, behind: 0 })),
	'已推拉 12:31',
);
check(
	'失败：同步失败',
	statusSummary(stateWithGit({ at: when, ok: false, pushed: false, pulled: 0, ahead: 1, behind: 0 })),
	'同步失败 12:31',
);
check(
	'后面接内容状态',
	statusSummary(stateWithGit({ at: when, ok: true, pushed: true, pulled: 0, ahead: 0, behind: 0 }), '对方：待上报'),
	'已推送 12:31 · 对方：待上报',
);

console.log(`\n共 ${checks} 次检查，失败 ${failures.length} 项`);
for (const message of failures.slice(0, 10)) console.log(`\n❌ ${message}`);
if (failures.length > 10) console.log(`\n…… 其余 ${failures.length - 10} 项失败已省略`);
if (failures.length > 0) process.exitCode = 1;
