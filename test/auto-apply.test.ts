/**
 * 自动应用「别人发来的包」：搬过来的文件不用再手点那一下。
 *
 * 这条测试真正要钉的是**安全边界**（写错一条就是悄悄删数据）：
 * - 非破坏性的更新包 → 自己应用；
 * - 要删文件 / 覆盖本地改动的 → 只提示，绝不动手；
 * - 完整包 → 只提示，从不自动应用；
 * - 同一个包只处理一次（不会每 30 秒重复弹）；
 * - 比最新那个旧的、还没处理的包 → 记成"被更新的包取代"，不重复劳动。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { App, Notice } from 'obsidian';
import type { PluginManifest } from 'obsidian';
import LocallySavePlugin from '../src/main';
import { applyBundle } from '../src/bundle/apply';
import { exportBundle } from '../src/bundle/export';
import type { ExportOutcome } from '../src/bundle/export';
import { DEFAULT_SETTINGS } from '../src/settings/model';
import { loadState } from '../src/sync/state';
import { checkIncomingBundles } from '../src/ui/actions';
import { createLogger } from '../src/utils/log';

// -------------------------------------------------------------------- 断言
let checks = 0;
const failures: string[] = [];

function checkTrue(name: string, condition: boolean, detail: string): void {
	checks++;
	if (!condition) failures.push(`[断言失败] ${name}\n  ${detail}`);
}

function check(name: string, actual: unknown, expected: unknown): void {
	checks++;
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		failures.push(`[期望不符] ${name}\n  期望 ${JSON.stringify(expected)}\n  实际 ${JSON.stringify(actual)}`);
	}
}

// -------------------------------------------------------------------- 环境
const noticeLog = (Notice as unknown as { messages: string[] }).messages;
const log = createLogger(() => 'silent');

const MANIFEST = {
	id: 'locally-save',
	name: 'Locally Save',
	version: '0.1.0',
	minAppVersion: '1.7.0',
	description: 'test',
	author: 'test',
	dir: '.obsidian/plugins/locally-save',
} as PluginManifest;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lsave-incoming-'));
const VAULT = path.join(ROOT, 'my-vault');
const OTHER = path.join(ROOT, 'other-vault');
const OUT = path.join(ROOT, 'bundles');
const STATE_OTHER = path.join(ROOT, 'state-other.json');
for (const dir of [VAULT, OTHER, OUT]) fs.mkdirSync(dir, { recursive: true });

const at = (root: string, rel: string) => path.join(root, ...rel.split('/'));

function write(root: string, rel: string, content: string): void {
	const target = at(root, rel);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
}

function read(root: string, rel: string): string | null {
	try {
		return fs.readFileSync(at(root, rel), 'utf8');
	} catch {
		return null;
	}
}

/** 造一个"我这台机器"的插件：仓库根指向临时目录 */
function createPlugin(data: unknown): LocallySavePlugin {
	const plugin = new LocallySavePlugin(new App(), MANIFEST);
	(plugin as unknown as { stubData: unknown }).stubData = data;
	(plugin.app.vault.adapter as unknown as { basePath: string }).basePath = VAULT;
	return plugin;
}

/** 另一台机器导一个包到同一个包目录里（它的血脉、它的 copyId，跟我们没关系） */
async function exportFromOther(mode: 'full' | 'changes'): Promise<ExportOutcome> {
	return exportBundle({
		settings: { ...DEFAULT_SETTINGS },
		log,
		vaultRoot: OTHER,
		vaultName: '别的机器',
		stateFile: STATE_OTHER,
		mode,
		outDir: OUT,
	});
}

/** 我这边先应用一次对方的完整副本：立基准（真实流程里这一步是手动做的） */
async function seedBaseline(plugin: LocallySavePlugin, file: string): Promise<void> {
	await applyBundle({
		settings: plugin.settings,
		log,
		vaultRoot: VAULT,
		stateFile: plugin.stateFile(),
		file,
	});
}

// -------------------------------------------------------------------- 用例
// 两边一开始内容一样
for (const [rel, content] of [['notes/a.md', 'AAA'], ['notes/b.md', 'BBB']] as const) {
	write(OTHER, rel, content);
	write(VAULT, rel, content);
}

// 1. 开关关着时什么都不做
const off = createPlugin({ logLevel: 'silent', bundleDir: OUT });
await off.onload();
const firstFull = await exportFromOther('full');
check('开关关着：不看包目录', await checkIncomingBundles(off), false);
check('开关关着：不提示、更不动文件', noticeLog.length, 0);
check('开关关着：文件没变', read(VAULT, 'notes/a.md'), 'AAA');

// 2. 开着：完整包只提示，从不自动应用（它可能删掉本机独有的文件）
noticeLog.length = 0;
const plugin = createPlugin({ logLevel: 'silent', bundleDir: OUT, autoApplyIncoming: true });
await plugin.onload();
check('完整包：不自动应用（返回"没干活"）', await checkIncomingBundles(plugin), false);
checkTrue(
	'完整包：提示一句、说清是完整副本',
	noticeLog.some(m => m.includes('收到') && m.includes('完整副本')),
	noticeLog.join(' / '),
);
check('完整包：本地文件没被动', read(VAULT, 'notes/a.md'), 'AAA');
const afterFullNotice = await loadState(plugin.stateFile());
check('完整包：记了一笔"要人看"', afterFullNotice.incoming.at(-1)?.note, 'needs-review');

// 3. 先手动应用那份完整副本立基准，然后对方改一个文件、发更新包 → 应该自动应用
await seedBaseline(plugin, firstFull.file as string);
check('立基准之后本地就是对方那一版', read(VAULT, 'notes/a.md'), 'AAA');

write(OTHER, 'notes/a.md', 'AAA 改过了');
await exportFromOther('changes');
noticeLog.length = 0;
check('更新包：自己应用了（返回"干过活"）', await checkIncomingBundles(plugin), true);
check('更新包：内容真的落地了', read(VAULT, 'notes/a.md'), 'AAA 改过了');
checkTrue('更新包：通知里说清"已自动应用"', noticeLog.some(m => m.includes('已自动应用')), noticeLog.join(' / '));
const afterApplied = await loadState(plugin.stateFile());
check('更新包：更新记录里有一条"应用"', afterApplied.bundleLog.at(-1)?.direction, 'apply');
check('更新包：也记了一笔"已应用"', afterApplied.incoming.at(-1)?.note, 'applied');

// 4. 同一个包不会处理第二遍（不会每 30 秒弹一次）
noticeLog.length = 0;
check('同一个包：第二次什么都不做', await checkIncomingBundles(plugin), false);
check('同一个包：不再提示', noticeLog.length, 0);

// 5. 要删文件的更新包：只提示，绝不动手
fs.rmSync(at(OTHER, 'notes/b.md'));
await exportFromOther('changes');
noticeLog.length = 0;
check('要删文件的包：不自动应用', await checkIncomingBundles(plugin), false);
check('要删文件的包：本地那个文件还在', read(VAULT, 'notes/b.md'), 'BBB');
checkTrue(
	'要删文件的包：提示里说清会删几个',
	noticeLog.some(m => m.includes('收到更新包') && m.includes('删 1 个文件')),
	noticeLog.join(' / '),
);
const afterRisky = await loadState(plugin.stateFile());
check('要删文件的包：记了一笔"要人看"', afterRisky.incoming.at(-1)?.note, 'needs-review');
check('要删文件的包：本地基准没被改坏', read(VAULT, 'notes/a.md'), 'AAA 改过了');

// 5b. 对方把那个文件放回来了：之后发的包里就不该再有"删除"这一笔
// （更新包是累积的 —— 不撤回的话，那一笔会一直跟着后面的每一个包）
write(OTHER, 'notes/b.md', 'BBB 回来了');
await exportFromOther('changes');
noticeLog.length = 0;
check('对方撤回删除之后：又能安全地自动应用了', await checkIncomingBundles(plugin), true);
check('撤回的那份内容也落地了', read(VAULT, 'notes/b.md'), 'BBB 回来了');

// 6. 文件夹里同时躺着两个更新包（同一血脉的两台机器各发一个）：只按最新那个办，旧的记成"被取代"
//    为什么两个包能同时存在：同一血脉的旧包在导出时就会被清掉（removeSupersededChanges），
//    但**同代**的包（两台都基于同一份完整副本）谁也清不掉谁 —— 这时"只看最新那一个"就派上用场了。
const THIRD = path.join(ROOT, 'third-vault');
const STATE_THIRD = path.join(ROOT, 'state-third.json');
fs.mkdirSync(THIRD, { recursive: true });

// 先让对方发一个更新包（这台机器 A 改的）
write(OTHER, 'notes/a.md', 'AAA 改过第二次');
const older = await exportFromOther('changes');

// 第三台机器 C：照 A 那份完整副本铺一遍（这一步会在 C 那边认祖 = 同血脉），改同一个文件再发一个包
await applyBundle({
	settings: { ...DEFAULT_SETTINGS },
	log,
	vaultRoot: THIRD,
	stateFile: STATE_THIRD,
	file: firstFull.file as string,
});
write(THIRD, 'notes/a.md', 'AAA 改过第三次');
const newer = await exportBundle({
	settings: { ...DEFAULT_SETTINGS },
	log,
	vaultRoot: THIRD,
	vaultName: '第三台机器',
	stateFile: STATE_THIRD,
	mode: 'changes',
	outDir: OUT,
});
checkTrue('两个更新包真的同时躺在文件夹里', older.file !== null && newer.file !== null, `${older.file} / ${newer.file}`);

noticeLog.length = 0;
check('两个包一起来：按最新那个应用', await checkIncomingBundles(plugin), true);
check('两个包一起来：落地的是最新那一版', read(VAULT, 'notes/a.md'), 'AAA 改过第三次');
const afterPair = await loadState(plugin.stateFile());
const notes = afterPair.incoming.map(item => `${item.id === older.header?.bundleId ? '旧' : item.id === newer.header?.bundleId ? '新' : '?'}:${item.note}`);
checkTrue('旧的被记成"被取代了"', notes.includes('旧:superseded'), notes.join(' / '));
checkTrue('新的被记成"已应用"', notes.includes('新:applied'), notes.join(' / '));
check('旧的不会再被处理一遍', (await checkIncomingBundles(plugin)), false);

console.log(`\n共 ${checks} 次检查，失败 ${failures.length} 项`);
for (const message of failures.slice(0, 10)) console.log("\n❌ " + message);
if (failures.length > 10) console.log(`\n…… 其余 ${failures.length - 10} 项失败已省略`);
if (failures.length > 0) process.exitCode = 1;
