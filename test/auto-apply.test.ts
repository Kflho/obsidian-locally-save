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
function createPlugin(data: unknown, vault: string = VAULT): LocallySavePlugin {
	const plugin = new LocallySavePlugin(new App(), MANIFEST);
	(plugin as unknown as { stubData: unknown }).stubData = data;
	(plugin.app.vault.adapter as unknown as { basePath: string }).basePath = vault;
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
async function seedBaseline(plugin: LocallySavePlugin, file: string, vault: string = VAULT): Promise<void> {
	await applyBundle({
		settings: plugin.settings,
		log,
		vaultRoot: vault,
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

// 5b. 对方把那个文件放回来了：那一环接在**本机没走到的那一点**后面
//     （"删"的那一环没自动应用 → 本机还停在前一点上）→ 直接搁着等缺的环到齐，绝不猜着合
write(OTHER, 'notes/b.md', 'BBB 回来了');
await exportFromOther('changes');
noticeLog.length = 0;
check('撤回之后那一环也接不上（前一环没走到）', await checkIncomingBundles(plugin), false);
check('本地那个文件没被动', read(VAULT, 'notes/b.md'), 'BBB');
checkTrue(
	'提示里说清"接在本机还没走到的那一环后面"',
	noticeLog.some(m => m.includes('还没走到')),
	noticeLog.join(' / '),
);

// 6. **链条中间断了一环、后来补上**：接得上的先接、接不上的搁着；缺的那环到了就一路接到底
//    （这是链条模型下自动应用真正要干的事 —— 以前"只看最新那一个"是累积语义的产物）
const SND = path.join(ROOT, 'sender-chain');
const STATE_SND = path.join(ROOT, 'state-sender.json');
const RECV2 = path.join(ROOT, 'recv-chain');
// 单独的包目录：这一组的两环不能被别的机器的包搅进来
const OUT_CHAIN = path.join(ROOT, 'bundles-chain');
for (const dir of [SND, RECV2, OUT_CHAIN]) fs.mkdirSync(dir, { recursive: true });
// 发送方：照第一份完整副本铺一遍（认祖 = 同血脉、站在那一点上），连导两环
await applyBundle({
	settings: { ...DEFAULT_SETTINGS },
	log,
	vaultRoot: SND,
	stateFile: STATE_SND,
	file: firstFull.file as string,
});
// 内容长度要不一样：同长度 + 同一秒内会被 2 秒容差当成"没改过"，第二个包就成空的了
write(SND, 'notes/a.md', '第一环');
const linkOne = await exportBundle({
	settings: { ...DEFAULT_SETTINGS }, log, vaultRoot: SND, vaultName: '链条机器',
	stateFile: STATE_SND, mode: 'changes', outDir: OUT_CHAIN,
});
write(SND, 'notes/a.md', '第二环 — 更长一点的改动');
const linkTwo = await exportBundle({
	settings: { ...DEFAULT_SETTINGS }, log, vaultRoot: SND, vaultName: '链条机器',
	stateFile: STATE_SND, mode: 'changes', outDir: OUT_CHAIN,
});
checkTrue('两环都导出来了', linkOne.file !== null && linkTwo.file !== null, `${linkOne.file} / ${linkTwo.file}`);

// 接收方：也站在第一份完整副本那一点上（所以只有 linkOne 接得上）
const plugin2 = createPlugin({ logLevel: 'silent', bundleDir: OUT_CHAIN, autoApplyIncoming: true }, RECV2);
await plugin2.onload();
await seedBaseline(plugin2, firstFull.file as string, RECV2);
// 先把**后一环**放进去：它接在前一环的落点上，本机还没走到那儿 → 搁着
const hideOne = `${linkOne.file}.tmp-hold`;
fs.renameSync(linkOne.file as string, hideOne);
noticeLog.length = 0;
check('只有后一环时：接不上，什么都不动', await checkIncomingBundles(plugin2), false);
check('内容没变', read(RECV2, 'notes/a.md'), 'AAA');
checkTrue('提示里说清"接在本机还没走到的那一环后面"', noticeLog.some(m => m.includes('还没走到')), noticeLog.join(' / '));
const beforeFill = await loadState(plugin2.stateFile());
checkTrue(
	'接不上的那一份**不记账**（缺的环到了还要自动接）',
	beforeFill.incoming.every(item => item.id !== linkTwo.header?.bundleId),
	JSON.stringify(beforeFill.incoming),
);

// 缺的那一环到了：一路接到底（两环一口气接完）
fs.renameSync(hideOne, linkOne.file as string);
noticeLog.length = 0;
check('缺的环到了：自动接上（两环一起）', await checkIncomingBundles(plugin2), true);
check('接完就是链条末端那一版', read(RECV2, 'notes/a.md'), '第二环 — 更长一点的改动');
check('两环各记一笔"已应用"', (await loadState(plugin2.stateFile())).incoming.filter(item => item.note === 'applied').length, 2);
check('再扫一遍：不会重复劳动', await checkIncomingBundles(plugin2), false);

console.log(`\n共 ${checks} 次检查，失败 ${failures.length} 项`);
for (const message of failures.slice(0, 10)) console.log("\n❌ " + message);
if (failures.length > 10) console.log(`\n…… 其余 ${failures.length - 10} 项失败已省略`);
if (failures.length > 0) process.exitCode = 1;
