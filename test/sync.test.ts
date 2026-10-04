/**
 * 端到端：在临时目录里造一个"仓库"和一个"副本"，跑**真的**同步。
 *
 * 覆盖增加 / 修改 / 删除 / 移动 / 冲突，以及两件最容易出错的事：
 * 复制后修改时间有没有对齐（不对齐每轮都会重传）、删掉的文件进没进回收目录。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSync, removeFromTarget } from '../src/sync/runner';
import { loadState } from '../src/sync/state';
import { describeChanges, describeRecord, statusBarText } from '../src/sync/summary';
import type { LastSyncRecord } from '../src/sync/summary';
import type { SyncHost, SyncOutcome } from '../src/sync/runner';
import { DEFAULT_SETTINGS } from '../src/settings/model';
import type { PluginSettings } from '../src/settings/model';
import { createLogger } from '../src/utils/log';

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

// -------------------------------------------------------------------- 环境
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lsave-sync-'));
const VAULT = path.join(ROOT, 'vault');
const TARGET = path.join(ROOT, 'target');
const STATE = path.join(ROOT, 'state.json');
fs.mkdirSync(VAULT, { recursive: true });
fs.mkdirSync(TARGET, { recursive: true });

function abs(root: string, rel: string): string {
	return path.join(root, ...rel.split('/'));
}

function write(root: string, rel: string, content: string, mtime?: number): void {
	const target = abs(root, rel);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
	if (mtime !== undefined) fs.utimesSync(target, new Date(mtime), new Date(mtime));
}

function read(root: string, rel: string): string | null {
	try {
		return fs.readFileSync(abs(root, rel), 'utf8');
	} catch {
		return null;
	}
}

function exists(root: string, rel: string): boolean {
	return fs.existsSync(abs(root, rel));
}

function host(overrides: Partial<PluginSettings> = {}): SyncHost {
	const settings: PluginSettings = { ...DEFAULT_SETTINGS, targetDir: TARGET, ...overrides };
	return {
		settings,
		log: createLogger(() => 'silent'),
		vaultRoot: () => VAULT,
		stateFile: () => STATE,
		configDir: () => '.obsidian',
		reportProgress: () => {},
	};
}

function kinds(outcome: SyncOutcome): string[] {
	return outcome.plan.actions.map(action =>
		action.from ? `${action.kind}:${action.from}->${action.path}` : `${action.kind}:${action.path}`);
}

/** 回收目录里有没有这个文件（按后缀找，因为中间隔了一层时间戳目录） */
function inTrash(rel: string): boolean {
	return findInTrash(rel) !== null;
}

/** 找出回收目录里某个文件的实际路径 */
function findInTrash(rel: string): string | null {
	const root = path.join(TARGET, '.lsave', 'trash');
	const vaultTrash = path.join(VAULT, '.trash', 'locally-save');
	for (const base of [root, vaultTrash]) {
		if (!fs.existsSync(base)) continue;
		const walk = (dir: string): string | null => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const next = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					const found = walk(next);
					if (found !== null) return found;
					continue;
				}
				if (next.replace(/\\/g, '/').endsWith(rel)) return next;
			}
			return null;
		};
		const found = walk(base);
		if (found !== null) return found;
	}
	return null;
}

/** 仓库里有没有「冲突副本」文件（留在原地的那种；现在应该没有了） */
function hasConflictCopy(dir: string): boolean {
	const root = abs(VAULT, dir);
	if (!fs.existsSync(root)) return false;
	return fs.readdirSync(root).some(name => name.includes('冲突副本') || name.includes('包里的版本'));
}

// -------------------------------------------------------------------- 用例
// 1. 首次同步：全是新增
write(VAULT, 'notes/a.md', 'AAA');
write(VAULT, 'notes/sub/b.md', 'BBB');
let outcome = await runSync(host());
check('首次同步：两个新增', kinds(outcome), ['upload:notes/a.md', 'upload:notes/sub/b.md']);
check('副本里出现 a.md', read(TARGET, 'notes/a.md'), 'AAA');
check('子目录也建出来了', read(TARGET, 'notes/sub/b.md'), 'BBB');
const drift = Math.abs(
	fs.statSync(abs(TARGET, 'notes/a.md')).mtimeMs - fs.statSync(abs(VAULT, 'notes/a.md')).mtimeMs,
);
checkTrue(
	'副本的修改时间对齐到仓库（不对齐的话每轮都会重传）',
	drift < 5,
	`偏差 ${drift} 毫秒`,
);

// 2. 再同步一次：什么都不用干
outcome = await runSync(host());
check('第二轮没有任何动作', outcome.plan.actions.length, 0);
check('第二轮两个文件都算一致', outcome.plan.unchanged, 2);

// 3. 修改本地 → 上传
write(VAULT, 'notes/a.md', 'AAA2');
outcome = await runSync(host());
check('本地修改 → 上传', kinds(outcome), ['upload:notes/a.md']);
check('修改算 modify', outcome.plan.summary.modify, 1);
check('副本内容跟上', read(TARGET, 'notes/a.md'), 'AAA2');

// 4. 修改副本 → 下载（修改时间要拉开，否则会落在 2 秒容差里被当成没动过）
write(TARGET, 'notes/a.md', 'AAA3', Date.now() + 60_000);
outcome = await runSync(host());
check('副本修改 → 下载', kinds(outcome), ['download:notes/a.md']);
check('仓库内容跟上', read(VAULT, 'notes/a.md'), 'AAA3');

// 5. 删除本地（传播开 + 进回收目录）
write(VAULT, 'notes/gone.md', 'GONE');
await runSync(host());
check('先把它传上去', read(TARGET, 'notes/gone.md'), 'GONE');
fs.rmSync(abs(VAULT, 'notes/gone.md'));
outcome = await runSync(host());
check('本地删除 → 删副本', kinds(outcome), ['delete-remote:notes/gone.md']);
check('副本里没有了', exists(TARGET, 'notes/gone.md'), false);
checkTrue('删掉的那份进了回收目录（没有真的消失）', inTrash('notes/gone.md'), '回收目录里找不到它');

// 6. 关掉删除传播 → 从副本取回
write(VAULT, 'notes/keep.md', 'KEEP');
await runSync(host());
fs.rmSync(abs(VAULT, 'notes/keep.md'));
outcome = await runSync(host({ propagateDeletions: false }));
check('关掉删除传播 → 取回', kinds(outcome), ['download:notes/keep.md']);
check('文件回来了', read(VAULT, 'notes/keep.md'), 'KEEP');

// 7. 移动：改名不能让两边各留一份
write(VAULT, 'notes/move-me.md', 'MOVE');
await runSync(host());
fs.renameSync(abs(VAULT, 'notes/move-me.md'), abs(VAULT, 'notes/moved.md'));
outcome = await runSync(host());
check('移动 → 副本跟着改名', kinds(outcome), ['rename-remote:notes/move-me.md->notes/moved.md']);
check('新名字下有内容', read(TARGET, 'notes/moved.md'), 'MOVE');
check('旧名字下没留副本（不是"删一个加一个"）', exists(TARGET, 'notes/move-me.md'), false);
check('移动之后再同步一次就是干净的', (await runSync(host())).plan.actions.length, 0);

// 8. 冲突：两边都改，留两份
write(VAULT, 'notes/conflict.md', 'BASE');
await runSync(host());
write(VAULT, 'notes/conflict.md', 'LOCAL-EDIT', Date.now());
write(TARGET, 'notes/conflict.md', 'REMOTE-EDIT', Date.now() + 60_000);
outcome = await runSync(host());
check('两边都改 → 冲突', kinds(outcome), ['conflict:notes/conflict.md']);
check('新的那份占原名', read(VAULT, 'notes/conflict.md'), 'REMOTE-EDIT');
checkTrue('仓库里**不再**留下冲突副本（留在原地会跟着同步传出去）', !hasConflictCopy('notes'), '原地不该有');
checkTrue(
	'输的那份（本地改的那版）进了回收目录的「冲突」文件夹',
	inTrash('notes/conflict.md'),
	'回收目录里应该有一份',
);
check(
	'而且存的是本地那一版',
	fs.readFileSync(findInTrash('notes/conflict.md') ?? '', 'utf8'),
	'LOCAL-EDIT',
);

// 9. 排除规则真的生效
write(VAULT, '.obsidian/app.json', '{}');
write(VAULT, 'notes/temp.tmp', 'TMP');
outcome = await runSync(host({ excludePatterns: `${DEFAULT_SETTINGS.excludePatterns}\n*.tmp` }));
check('被默认规则排除的配置目录不参与同步', exists(TARGET, '.obsidian/app.json'), false);
checkTrue('.tmp 被自定义规则排除了', !exists(TARGET, 'notes/temp.tmp'), '被排除的文件不该被传上去');
checkTrue('笔记还是正常同步的', exists(TARGET, 'notes/a.md'), '排除规则不能误伤笔记');

// 10. 收工后要把"仓库清单 + 改动数"带出来（「同步后自动留改动包」靠它省一次全库遍历）
write(VAULT, 'notes/for-bundle.md', 'BUNDLE');
outcome = await runSync(host());
checkTrue('改动数被带出来', outcome.changed > 0, `实际 ${outcome.changed}`);
checkTrue(
	'收工后的仓库清单也一并带出来',
	outcome.localInventory.files.has('notes/for-bundle.md'),
	'清单里应该有刚同步的文件',
);
outcome = await runSync(host());
check('两边一致时改动数为 0', outcome.changed, 0);

// 11. 包留在副本文件夹里也不会被当成"副本内容"传回仓库
// （默认的包目录就在目标文件夹的 .lsave 下，这个目录必须整个跳过）
fs.mkdirSync(path.join(TARGET, '.lsave', 'bundles', 'changes'), { recursive: true });
fs.writeFileSync(path.join(TARGET, '.lsave', 'bundles', 'changes', 'fake.lsave'), 'FAKE');
outcome = await runSync(host());
checkTrue(
	'留在副本里的包不会被同步回仓库',
	!exists(VAULT, '.lsave/bundles/changes/fake.lsave'),
	'目标目录下的 .lsave 整个都该跳过',
);
check('这一轮也不该有任何动作', outcome.plan.actions.length, 0);

// 12. 「应用同步包之后顺便同步副本」的关键一步：
//     包删掉的路径要先从副本里清掉并划掉基准，否则常规同步会把它还原回仓库
write(VAULT, 'notes/from-bundle.md', 'FROM-BUNDLE');
await runSync(host());
check('先让它两边都有', read(TARGET, 'notes/from-bundle.md'), 'FROM-BUNDLE');

fs.rmSync(abs(VAULT, 'notes/from-bundle.md')); // 模拟"包把它删了"
const cleared = await removeFromTarget(host(), TARGET, ['notes/from-bundle.md'], true);
check('副本里也清掉了', cleared, 1);
check('副本里确实没了', exists(TARGET, 'notes/from-bundle.md'), false);
checkTrue('进的是副本的回收目录', inTrash('notes/from-bundle.md'), '副本回收目录里应该有一份');

// 关键：用「不传播删除」的设置同步 —— 要是基准没划掉，这里会把文件还原回仓库
outcome = await runSync(host({ propagateDeletions: false }));
checkTrue('没有被还原回仓库（顺序错了就会复活）', !exists(VAULT, 'notes/from-bundle.md'), '删除传播关着时不该复活');
check('这一轮不该有任何动作', outcome.plan.actions.length, 0);

// 14. 空文件夹要跟着走（只比文件的话，空目录永远传不过去 —— 它里面没有文件可复制）
fs.mkdirSync(abs(VAULT, '空目录/更深一层'), { recursive: true });
outcome = await runSync(host());
check('计划的目录清单：两层都要建', outcome.plan.folders, [
	{ path: '空目录', side: 'remote' },
	{ path: '空目录/更深一层', side: 'remote' },
]);
check('副本里真的建出来了', exists(TARGET, '空目录/更深一层'), true);
checkTrue('建目录不算文件动作', outcome.plan.actions.length === 0, `实际 ${outcome.plan.actions.length} 个动作`);
check('结果里记了建几个目录', outcome.result?.foldersCreated, 2);
const afterDirs = await loadState(STATE);
check(
	'状态栏会把"新建文件夹"说出来（不然只建目录的那一轮显示成"无事可做"）',
	describeChanges(afterDirs.lastSync as LastSyncRecord),
	'新建文件夹 2',
);

// 15. 反向：副本里新建的空文件夹 → 仓库里也建
fs.mkdirSync(abs(TARGET, '副本空目录'), { recursive: true });
outcome = await runSync(host());
check('副本空文件夹 → 仓库里建出来', exists(VAULT, '副本空目录'), true);
check('这一轮建的是本地侧', outcome.plan.folders, [{ path: '副本空目录', side: 'local' }]);

// 16. 两边都有之后就不该反复报
outcome = await runSync(host());
check('两边都有之后不再有目录动作', outcome.plan.folders.length, 0);
check('也不该有文件动作', outcome.plan.actions.length, 0);
check('上一轮建过目录也不会重复计数', describeChanges((await loadState(STATE)).lastSync as LastSyncRecord), '无改动');

// 17. 只上传方向：副本里多出来的空文件夹不往仓库建
fs.mkdirSync(abs(TARGET, '只在副本的目录'), { recursive: true });
fs.mkdirSync(abs(VAULT, '只在仓库的目录'), { recursive: true });
outcome = await runSync(host({ syncDirection: 'upload' }));
check('仅上传：仓库的目录照样传过去', exists(TARGET, '只在仓库的目录'), true);
check('仅上传：副本的目录不往仓库建', exists(VAULT, '只在副本的目录'), false);

// 18. 文件删光之后，空掉的目录要收拾掉（不然副本里留一串空壳）
write(VAULT, '一次性的/x.md', 'X');
await runSync(host());
check('先把它传上去', read(TARGET, '一次性的/x.md'), 'X');
fs.rmSync(abs(VAULT, '一次性的/x.md'));
outcome = await runSync(host());
check('副本里那个文件删了', exists(TARGET, '一次性的/x.md'), false);
check('空掉的目录也收拾了', exists(TARGET, '一次性的'), false);
check('记了收拾掉几个目录', outcome.result?.foldersRemoved, 1);

// 19. 仓库里剩下的空壳会被补回来（目录只建不删的必然结果），补完就稳定了
outcome = await runSync(host());
check('仓库里还剩个空目录 → 副本把它补回来', exists(TARGET, '一次性的'), true);
check('再一轮就稳定：没有任何动作', (await runSync(host())).plan.actions.length, 0);

// 20. 上次同步的结果要落盘 —— 不然重启 Obsidian 状态栏又变回"尚未同步"
const persisted = await loadState(STATE);
checkTrue('状态文件里记了上次同步', persisted.lastSync !== null, '没记下来');
checkTrue('记了时间', (persisted.lastSync?.at ?? 0) > 0, `实际 ${persisted.lastSync?.at}`);
check(
	'两次同步之间没有改动 → 记成"无改动"',
	describeChanges(persisted.lastSync as LastSyncRecord),
	'无改动',
);
checkTrue(
	'状态栏文案点明了"上次同步"',
	statusBarText(persisted.lastSync as LastSyncRecord).startsWith('上次同步'),
	statusBarText(persisted.lastSync as LastSyncRecord),
);
checkTrue(
	'一句话总结里能看到"未变的一致文件数"',
	describeRecord(persisted.lastSync as LastSyncRecord).includes('都一致'),
	describeRecord(persisted.lastSync as LastSyncRecord),
);

console.log(`\n共 ${checks} 次检查，失败 ${failures.length} 项`);
for (const message of failures.slice(0, 10)) console.log("\n❌ " + message);
if (failures.length > 10) console.log(`\n…… 其余 ${failures.length - 10} 项失败已省略`);
if (failures.length > 0) process.exitCode = 1;
