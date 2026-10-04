/**
 * 比对算法的完整矩阵：**增加 / 修改 / 删除 / 移动 / 冲突** 五种情况，
 * 三种同步方向，两种删除传播设置。
 *
 * 这是整个插件最需要"保证正确"的地方 —— 判断错了就是丢数据，
 * 所以每种组合都在这里钉死，改算法必须先过这一关。
 */
import { planSync, rebuildState, DEFAULT_MTIME_TOLERANCE_MS } from "../src/sync/diff";
import type { FileRecord, Inventory, SyncAction, SyncPlan } from "../src/sync/types";

// -------------------------------------------------------------------- 断言
let checks = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
	checks++;
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		failures.push(`[期望不符] ${name}\n  期望 ${JSON.stringify(expected)}\n  实际 ${JSON.stringify(actual)}`);
	}
}

function checkTrue(name: string, condition: boolean, detail: string): void {
	checks++;
	if (!condition) failures.push(`[断言失败] ${name}\n  ${detail}`);
}

// -------------------------------------------------------------------- 工具
const T = 1_700_000_000_000;

function inventory(files: Record<string, [number, number]>): Inventory {
	const map = new Map<string, FileRecord>();
	for (const [path, [size, mtime]] of Object.entries(files)) map.set(path, { size, mtime });
	return { files: map };
}

function plan(
	local: Record<string, [number, number]>,
	remote: Record<string, [number, number]>,
	state: Record<string, [number, number]>,
	overrides: Partial<Parameters<typeof planSync>[3]> = {},
): SyncPlan {
	const base: Record<string, FileRecord> = {};
	for (const [path, [size, mtime]] of Object.entries(state)) base[path] = { size, mtime };
	return planSync(inventory(local), inventory(remote), base, {
		direction: 'both',
		propagateDeletions: true,
		conflictStrategy: 'keep-both',
		...overrides,
	});
}

/** 只取动作的「类型 + 路径」，方便断言 */
function kinds(result: SyncPlan): string[] {
	return result.actions.map((action: SyncAction) =>
		action.from ? `${action.kind}:${action.from}->${action.path}` : `${action.kind}:${action.path}`);
}

// -------------------------------------------------------------------- 用例
// ---------------------------------------------------------------- 新增
check("本地新增 → 上传", kinds(plan({ 'a.md': [10, T] }, {}, {})), ['upload:a.md']);
check("副本新增 → 下载", kinds(plan({}, { 'a.md': [10, T] }, {})), ['download:a.md']);
check("新增算 add", plan({ 'a.md': [10, T] }, {}, {}).summary, { add: 1, modify: 0, delete: 0, move: 0, conflict: 0 });
check("只上传方向：副本新增不动", kinds(plan({}, { 'a.md': [10, T] }, {}, { direction: 'upload' })), []);
check("只下载方向：本地新增不动", kinds(plan({ 'a.md': [10, T] }, {}, {}, { direction: 'download' })), []);

// ---------------------------------------------------------------- 修改
const base = { 'a.md': [10, T] as [number, number] };
check("本地修改 → 上传", kinds(plan({ 'a.md': [20, T + 5000] }, { 'a.md': [10, T] }, base)), ['upload:a.md']);
check("副本修改 → 下载", kinds(plan({ 'a.md': [10, T] }, { 'a.md': [20, T + 5000] }, base)), ['download:a.md']);
check("都没动 → 不处理", kinds(plan({ 'a.md': [10, T] }, { 'a.md': [10, T] }, base)), []);
checkTrue("都没动记进 unchanged", plan({ 'a.md': [10, T] }, { 'a.md': [10, T] }, base).unchanged === 1, "unchanged 应为 1");
check("修改算 modify", plan({ 'a.md': [20, T] }, { 'a.md': [10, T] }, base).summary.modify, 1);
// 容差：2 秒内的修改时间差异（FAT / U 盘）不算改过
check("容差内不算修改", kinds(plan({ 'a.md': [10, T + 1500] }, { 'a.md': [10, T] }, base)), []);
check("超出容差算修改", kinds(plan({ 'a.md': [10, T + 3000] }, { 'a.md': [10, T] }, base)), ['upload:a.md']);

// ---------------------------------------------------------------- 冲突
const bothChanged = plan(
	{ 'a.md': [20, T + 9000] },
	{ 'a.md': [30, T + 1000] },
	base,
);
check("两边都改 → 冲突动作", kinds(bothChanged), ['conflict:a.md']);
check("冲突留新的那份", bothChanged.actions[0]?.winner, 'local');
check("冲突算 conflict", bothChanged.summary.conflict, 1);
check(
	"以本地为准时 → 上传",
	kinds(plan({ 'a.md': [20, T + 9000] }, { 'a.md': [30, T + 1000] }, base, { conflictStrategy: 'local-wins' })),
	['upload:a.md'],
);
check(
	"以副本为准时 → 下载",
	kinds(plan({ 'a.md': [20, T + 9000] }, { 'a.md': [30, T + 1000] }, base, { conflictStrategy: 'remote-wins' })),
	['download:a.md'],
);
check(
	"副本更新时冲突偏向副本",
	plan({ 'a.md': [20, T + 1000] }, { 'a.md': [30, T + 9000] }, base).actions[0]?.winner,
	'remote',
);

// ---------------------------------------------------------------- 删除
check("本地删除 + 传播 → 删副本", kinds(plan({}, { 'a.md': [10, T] }, base)), ['delete-remote:a.md']);
check("本地删除 + 不传播 → 取回", kinds(plan({}, { 'a.md': [10, T] }, base, { propagateDeletions: false })), ['download:a.md']);
check("副本删除 + 传播 → 删本地", kinds(plan({ 'a.md': [10, T] }, {}, base)), ['delete-local:a.md']);
check("副本删除 + 不传播 → 送回", kinds(plan({ 'a.md': [10, T] }, {}, base, { propagateDeletions: false })), ['upload:a.md']);
check("没同步过的新文件不会被删", kinds(plan({}, { 'a.md': [10, T] }, {})), ['download:a.md']);
check("两边都删了 → 什么都不做", kinds(plan({}, {}, base)), []);
check("删除算 delete", plan({}, { 'a.md': [10, T] }, base).summary.delete, 1);

// 一边删、一边改：这是最容易出错的组合
check(
	"本地改了、副本删了 → 默认保留本地",
	kinds(plan({ 'a.md': [20, T + 5000] }, {}, base)),
	['upload:a.md'],
);
check(
	"本地改了、副本删了 + 以副本为准 → 删本地",
	kinds(plan({ 'a.md': [20, T + 5000] }, {}, base, { conflictStrategy: 'remote-wins' })),
	['delete-local:a.md'],
);
check(
	"副本改了、本地删了 → 默认保留副本",
	kinds(plan({}, { 'a.md': [20, T + 5000] }, base)),
	['download:a.md'],
);
check(
	"副本改了、本地删了 + 以本地为准 → 删副本",
	kinds(plan({}, { 'a.md': [20, T + 5000] }, base, { conflictStrategy: 'local-wins' })),
	['delete-remote:a.md'],
);

// ---------------------------------------------------------------- 移动
const moveBase = { 'a.md': [10, T] as [number, number] };
check(
	"本地改名 → 副本跟着改名（不重传）",
	kinds(plan({ 'b.md': [10, T] }, { 'a.md': [10, T] }, moveBase)),
	['rename-remote:a.md->b.md'],
);
check(
	"副本改名 → 本地跟着改名",
	kinds(plan({ 'a.md': [10, T] }, { 'b.md': [10, T] }, moveBase)),
	['rename-local:a.md->b.md'],
);
check("移动算 move", plan({ 'b.md': [10, T] }, { 'a.md': [10, T] }, moveBase).summary.move, 1);
check("移动不额外产生上传或删除", plan({ 'b.md': [10, T] }, { 'a.md': [10, T] }, moveBase).actions.length, 1);
check(
	"关掉删除传播时移动照样认（否则会两边各留一份）",
	kinds(plan({ 'b.md': [10, T] }, { 'a.md': [10, T] }, moveBase, { propagateDeletions: false })),
	['rename-remote:a.md->b.md'],
);
check(
	"挪进子目录也算移动",
	kinds(plan({ 'sub/b.md': [10, T] }, { 'a.md': [10, T] }, moveBase)),
	['rename-remote:a.md->sub/b.md'],
);
// 不满足条件时不能硬认成移动
check(
	"大小不同 → 不认移动：副本那份留下、本地新文件上传",
	kinds(plan({ 'b.md': [10, T] }, { 'a.md': [99, T] }, moveBase)),
	['download:a.md', 'upload:b.md'],
);
check(
	"副本那份也改过 → 不认移动（两边各留各的）",
	kinds(plan({ 'b.md': [10, T] }, { 'a.md': [10, T + 9000] }, moveBase)),
	['download:a.md', 'upload:b.md'],
);
check(
	"没有基准（对方那边是新文件）→ 不猜移动",
	kinds(plan({ 'b.md': [10, T] }, { 'a.md': [10, T] }, {})),
	['download:a.md', 'upload:b.md'],
);
check(
	"两个候选同时存在：只认能对上的那个",
	kinds(plan({ 'b.md': [10, T], 'c.md': [77, T] }, { 'a.md': [10, T] }, moveBase)),
	['rename-remote:a.md->b.md', 'upload:c.md'],
);

// ---------------------------------------------------------------- 状态重建
const rebuilt = rebuildState(
	inventory({ 'a.md': [10, T], 'b.md': [20, T] }),
	inventory({ 'a.md': [10, T], 'b.md': [30, T] }),
	DEFAULT_MTIME_TOLERANCE_MS,
);
check("重建状态只记两边一致的", Object.keys(rebuilt), ['a.md']);
check("重建状态不记单边文件", rebuilt['b.md'], undefined);

console.log(`\n共 ${checks} 次检查，失败 ${failures.length} 项`);
for (const message of failures.slice(0, 10)) console.log("\n❌ " + message);
if (failures.length > 10) console.log(`\n…… 其余 ${failures.length - 10} 项失败已省略`);
if (failures.length > 0) process.exitCode = 1;
