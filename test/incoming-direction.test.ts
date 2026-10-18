/**
 * 收包策略按「方向」分的守卫（0.15）。
 *
 * 三种方向是**硬边界**，不是提示文案：
 * - 仅拉（download）：完整副本也收、会删 / 覆盖的也照做（目标是对面那一点），
 *   而且这台机器**不写包**（`isReceiveOnly`）；
 * - 双向（both）：先确认（`confirm` 返回 false 就记一笔 dismissed，同一个包不再问），
 *   确认后按普通合并应用；
 * - 仅推（upload）：不看收件箱（调度层的事，见 `checkIncomingBundles`）。
 *
 * 默认（没开 git / 没给策略）必须保持老的安全边界：会删文件的包只报 needs-review，绝不动手。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { App } from 'obsidian';
import type { PluginManifest } from 'obsidian';
import { applyBundle } from '../src/bundle/apply';
import type { ApplyOptions } from '../src/bundle/apply';
import { exportBundle } from '../src/bundle/export';
import { handleIncoming, pickIncoming, unappliedIncoming } from '../src/bundle/incoming';
import type { IncomingPolicy } from '../src/bundle/incoming';
import { listBundles } from '../src/bundle/manage';
import LocallySavePlugin from '../src/main';
import { DEFAULT_SETTINGS } from '../src/settings/model';
import { loadState } from '../src/sync/state';
import { checkIncomingBundles, isReceiveOnly } from '../src/ui/actions';
import { createLogger } from '../src/utils/log';

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

// -------------------------------------------------------------------- 环境
const log = createLogger(() => 'silent');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lsave-direction-'));
const SEND = path.join(ROOT, 'send');
const RECV = path.join(ROOT, 'recv');
const OUT = path.join(ROOT, 'bundles');
const STATE_SEND = path.join(ROOT, 'state-send.json');
const STATE_RECV = path.join(ROOT, 'state-recv.json');
for (const dir of [SEND, RECV, OUT]) fs.mkdirSync(dir, { recursive: true });

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

function exists(root: string, rel: string): boolean {
	return fs.existsSync(at(root, rel));
}

/** 对方导出（它自己的仓库与状态文件） */
async function exportFromSend(mode: 'full' | 'changes'): Promise<string> {
	const result = await exportBundle({
		settings: { ...DEFAULT_SETTINGS },
		log,
		vaultRoot: SEND,
		vaultName: '对面',
		stateFile: STATE_SEND,
		mode,
		outDir: OUT,
	});
	if (!result.file) throw new Error(`对面没有导出包（${mode}）`);
	return result.file;
}

/** 本机应用一个包要的参数（状态文件是本机那份） */
function applyOptions(file: string): ApplyOptions {
	return {
		settings: { ...DEFAULT_SETTINGS },
		log,
		vaultRoot: RECV,
		stateFile: STATE_RECV,
		file,
	};
}

/** 从收件箱里挑出下一个还没处理的包（真实流程里这一步也在 `checkIncomingBundles` 里） */
async function nextIncoming() {
	const state = await loadState(STATE_RECV);
	const candidates = pickIncoming(await listBundles(OUT), state);
	return candidates[0];
}

/** 「仅拉」：完全跟对面一致；本机被覆盖 / 删掉的进回收目录 */
const DOWNLOAD_POLICY: IncomingPolicy = {
	force: true,
	allowFull: true,
	apply: { strictness: 'mirror', alignToPeer: true },
};

const MANIFEST = {
	id: 'locally-save',
	name: 'Locally Save',
	version: '0.1.0',
	minAppVersion: '1.7.0',
	description: 'test',
	author: 'test',
	// 不写死配置目录名：测试只需要一个放状态文件的目录，本机配置目录叫什么无所谓
	dir: 'plugins/locally-save',
} as PluginManifest;

// -------------------------------------------------------------------- 用例
async function main(): Promise<void> {
	// 0. 方向映射：只有"开着 git + 仅拉"才算只收不发
	check('仅拉 = 只收不发', isReceiveOnly({ ...DEFAULT_SETTINGS, gitEnabled: true, syncDirection: 'download' }), true);
	check('双向不限制导出', isReceiveOnly({ ...DEFAULT_SETTINGS, gitEnabled: true, syncDirection: 'both' }), false);
	check('仅推本来就不收，但不算"仅拉"', isReceiveOnly({ ...DEFAULT_SETTINGS, gitEnabled: true, syncDirection: 'upload' }), false);
	check('没开 git 时方向不生效', isReceiveOnly({ ...DEFAULT_SETTINGS, gitEnabled: false, syncDirection: 'download' }), false);

	// 1. 两边从同一份完整副本出发
	for (const [rel, content] of [['notes/a.md', 'AAA'], ['notes/b.md', 'BBB']] as const) {
		write(SEND, rel, content);
		write(RECV, rel, content);
	}
	const full = await exportFromSend('full');
	await applyBundle(applyOptions(full));

	// 2. 对面删一个、改一个、加一个 → 导更新包
	//    （新加的那个故意跟被删的长度不一样：同长度同秒会被识别成"改名"，那就不是删除了）
	fs.rmSync(at(SEND, 'notes/b.md'));
	write(SEND, 'notes/a.md', 'AAA 改');
	write(SEND, 'notes/new.md', 'NEW CONTENT');
	await exportFromSend('changes');
	const risky = await nextIncoming();
	checkTrue('收件箱里挑到了这份更新包', risky !== undefined, '没有候选包');

	// 3. **默认策略**：会删文件的包只报 needs-review，绝不动手（老边界不能被这次改动带松）
	const refused = await handleIncoming(applyOptions(risky!.bundle.file), risky!);
	check('默认策略：会删文件的包判"要人看"', refused.kind, 'needs-review');
	check('默认策略：本机文件没有被动', read(RECV, 'notes/b.md'), 'BBB');
	check('默认策略：记了一笔 needs-review', (await loadState(STATE_RECV)).incoming.at(-1)?.note, 'needs-review');

	// 4. 「仅拉」策略：同一份包直接镜像应用（删 / 改 / 加都照做）
	const applied = await handleIncoming(applyOptions(risky!.bundle.file), risky!, DOWNLOAD_POLICY);
	check('仅拉：直接应用了', applied.kind, 'applied');
	check('仅拉：对面删掉的本地也删了', exists(RECV, 'notes/b.md'), false);
	check('仅拉：对面改过的落地了', read(RECV, 'notes/a.md'), 'AAA 改');
	check('仅拉：对面新增的落地了', read(RECV, 'notes/new.md'), 'NEW CONTENT');
	check('仅拉：记了一笔 applied', (await loadState(STATE_RECV)).incoming.at(-1)?.note, 'applied');

	// 5. 「双向」：确认窗点取消 → 不动文件、记 dismissed、同一个包不再问
	write(SEND, 'notes/a.md', 'AAA 再改');
	await exportFromSend('changes');
	const pending = await nextIncoming();
	checkTrue('双向：挑到了新的候选', pending !== undefined, '没有候选包');
	const dismissed = await handleIncoming(applyOptions(pending!.bundle.file), pending!, {
		confirm: async () => false,
	});
	check('双向：取消 = dismissed', dismissed.kind, 'dismissed');
	check('双向：取消后文件没动', read(RECV, 'notes/a.md'), 'AAA 改');
	check('双向：取消也记了一笔', (await loadState(STATE_RECV)).incoming.at(-1)?.note, 'dismissed');
	checkTrue('双向：取消过的包不会再挑出来', (await nextIncoming()) === undefined, '又挑出来了');

	// 6. 「双向」：确认后按普通合并应用
	write(SEND, 'notes/a.md', 'AAA 再改一次');
	await exportFromSend('changes');
	const again = await nextIncoming();
	checkTrue('双向：又挑到了新的候选（旧那份已经被记过）', again !== undefined, '没有候选包');
	const merged = await handleIncoming(applyOptions(again!.bundle.file), again!, {
		confirm: async () => true,
	});
	check('双向：确认后应用了', merged.kind, 'applied');
	check('双向：内容落地', read(RECV, 'notes/a.md'), 'AAA 再改一次');

	// 7. 「仅拉」：完整副本也直接应用 —— 本机独有的文件会被镜像掉（进回收目录）
	write(RECV, 'notes/local-only.md', 'LOCAL');
	write(SEND, 'notes/a.md', '整库换了一版');
	fs.rmSync(at(SEND, 'notes/new.md'));
	const full2 = await exportFromSend('full');
	const fullCandidate = await nextIncoming();
	checkTrue('仅拉：完整副本进入候选', fullCandidate !== undefined && fullCandidate.bundle.file === full2, '没有候选包');
	const fullApplied = await handleIncoming(applyOptions(full2), fullCandidate!, DOWNLOAD_POLICY);
	check('仅拉：完整副本直接应用', fullApplied.kind, 'applied');
	check('仅拉：本机独有的文件被镜像掉（进了回收目录）', exists(RECV, 'notes/local-only.md'), false);
	check('仅拉：完整副本的内容落地', read(RECV, 'notes/a.md'), '整库换了一版');
	check('仅拉：包里没有的文件也没了', exists(RECV, 'notes/new.md'), false);

	// 8. 插件级：方向真的驱动了收包（不是"策略参数单独能跑"而已）
	const SEND2 = path.join(ROOT, 'send2');
	const RECV2 = path.join(ROOT, 'recv2');
	const OUT2 = path.join(ROOT, 'bundles2');
	const STATE_SEND2 = path.join(ROOT, 'state-send2.json');
	for (const dir of [SEND2, RECV2, OUT2]) fs.mkdirSync(dir, { recursive: true });
	for (const [rel, content] of [['n/x.md', 'X'], ['n/y.md', 'YYY']] as const) {
		write(SEND2, rel, content);
		write(RECV2, rel, content);
	}
	const exportFromSend2 = (mode: 'full' | 'changes') => exportBundle({
		settings: { ...DEFAULT_SETTINGS },
		log,
		vaultRoot: SEND2,
		vaultName: '对面2',
		stateFile: STATE_SEND2,
		mode,
		outDir: OUT2,
	});
	const plugin = new LocallySavePlugin(new App(), MANIFEST);
	(plugin as unknown as { stubData: unknown }).stubData = {
		bundleDir: OUT2,
		autoApplyIncoming: true,
		gitEnabled: true,
		syncDirection: 'download',
		logLevel: 'silent',
	};
	(plugin.app.vault.adapter as unknown as { basePath: string }).basePath = RECV2;
	await plugin.onload();
	const seed2 = await exportFromSend2('full');
	await applyBundle({
		settings: plugin.settings,
		log,
		vaultRoot: RECV2,
		stateFile: plugin.stateFile(),
		file: seed2.file as string,
	});
	fs.rmSync(at(SEND2, 'n/y.md'));
	write(SEND2, 'n/x.md', 'X 改了');
	await exportFromSend2('changes');
	check('插件级·仅拉：收包返回"干过活"', await checkIncomingBundles(plugin), true);
	check('插件级·仅拉：对面删掉的本地也删了', exists(RECV2, 'n/y.md'), false);
	check('插件级·仅拉：对面改过的落地了', read(RECV2, 'n/x.md'), 'X 改了');

	// 切「仅推」：不再看收件箱（只发不收）
	plugin.settings.syncDirection = 'upload';
	write(SEND2, 'n/x.md', 'X 又改');
	await exportFromSend2('changes');
	check('插件级·仅推：不看收件箱', await checkIncomingBundles(plugin), false);
	check('插件级·仅推：本地没动', read(RECV2, 'n/x.md'), 'X 改了');

	// 9. **确认过就不能再拦**（用户报的"一台 108、一台 109，点同步都提示已经最新"）
	//    双向策略是"先问一句"，用户点了「应用」＝ 看过会删几个 / 覆盖几个那份账；
	//    后面那条 isDestructivePlan 兜底是给**没人问过**的自动路径准备的，不能再拦一次。
	const SEND_R = path.join(ROOT, 'send-r');
	const RECV_R = path.join(ROOT, 'recv-r');
	const OUT_R = path.join(ROOT, 'bundles-r');
	const STATE_SEND_R = path.join(ROOT, 'state-send-r.json');
	const STATE_RECV_R = path.join(ROOT, 'state-recv-r.json');
	for (const dir of [SEND_R, RECV_R, OUT_R]) fs.mkdirSync(dir, { recursive: true });
	const exportR = (mode: 'full' | 'changes') => exportBundle({
		settings: { ...DEFAULT_SETTINGS },
		log,
		vaultRoot: SEND_R,
		vaultName: '对面R',
		stateFile: STATE_SEND_R,
		mode,
		outDir: OUT_R,
	});
	const applyR = (file: string): ApplyOptions => ({
		settings: { ...DEFAULT_SETTINGS },
		log,
		vaultRoot: RECV_R,
		stateFile: STATE_RECV_R,
		file,
	});
	for (const [rel, content] of [['n/one.md', 'ONE'], ['n/two.md', 'TWO']] as const) {
		write(SEND_R, rel, content);
		write(RECV_R, rel, content);
	}
	const seedR = await exportR('full');
	await applyBundle(applyR(seedR.file as string));
	const pickR = async (options?: { retryBlocked?: boolean }) => {
		const state = await loadState(STATE_RECV_R);
		return pickIncoming(await listBundles(OUT_R), state, options);
	};

	// 对面删一个、改一个：这份包是"会删文件"的那种
	fs.rmSync(at(SEND_R, 'n/two.md'));
	write(SEND_R, 'n/one.md', 'ONE 改了，更长');
	await exportR('changes');
	const riskyR = (await pickR())[0];
	checkTrue('确认后应用：挑到了会删文件的包', riskyR !== undefined, '没有候选包');

	// 双向 + 用户点了「应用」→ 必须真的应用，不能记成 needs-review
	const confirmedApply = await handleIncoming(applyR(riskyR!.bundle.file), riskyR!, {
		confirm: async () => true,
	});
	check('确认后应用：真的应用了（不再被"会删文件"拦下）', confirmedApply.kind, 'applied');
	check('确认后应用：对面删掉的本地也删了', exists(RECV_R, 'n/two.md'), false);
	check('确认后应用：对面改过的落地了', read(RECV_R, 'n/one.md'), 'ONE 改了，更长');

	// 10. 手动同步会**重试**被拦下的包；取消过的不重试
	const SEND_T = path.join(ROOT, 'send-t');
	const RECV_T = path.join(ROOT, 'recv-t');
	const OUT_T = path.join(ROOT, 'bundles-t');
	const STATE_SEND_T = path.join(ROOT, 'state-send-t.json');
	const STATE_RECV_T = path.join(ROOT, 'state-recv-t.json');
	for (const dir of [SEND_T, RECV_T, OUT_T]) fs.mkdirSync(dir, { recursive: true });
	const exportT = (mode: 'full' | 'changes') => exportBundle({
		settings: { ...DEFAULT_SETTINGS },
		log,
		vaultRoot: SEND_T,
		vaultName: '对面T',
		stateFile: STATE_SEND_T,
		mode,
		outDir: OUT_T,
	});
	const applyT = (file: string): ApplyOptions => ({
		settings: { ...DEFAULT_SETTINGS },
		log,
		vaultRoot: RECV_T,
		stateFile: STATE_RECV_T,
		file,
	});
	const pickT = async (options?: { retryBlocked?: boolean }) => {
		const state = await loadState(STATE_RECV_T);
		return pickIncoming(await listBundles(OUT_T), state, options);
	};
	write(SEND_T, 'n/one.md', 'ONE');
	write(SEND_T, 'n/two.md', 'TWO');
	write(RECV_T, 'n/one.md', 'ONE');
	write(RECV_T, 'n/two.md', 'TWO');
	const seedT = await exportT('full');
	await applyBundle(applyT(seedT.file as string));
	fs.rmSync(at(SEND_T, 'n/two.md'));
	await exportT('changes');

	const blocked = (await pickT())[0];
	checkTrue('重试：挑到了会删文件的包', blocked !== undefined, '没有候选包');
	const refused2 = await handleIncoming(applyT(blocked!.bundle.file), blocked!);
	check('默认策略（没人问过）仍然只报 needs-review', refused2.kind, 'needs-review');
	check('重试：自动节拍不再挑它', (await pickT()).length, 0);
	check(
		'还没应用的包会被数出来（「立即同步」那句总结靠它，别只说"已经最新"）',
		unappliedIncoming(await listBundles(OUT_T), await loadState(STATE_RECV_T)).length,
		1,
	);
	const retried = await pickT({ retryBlocked: true });
	checkTrue(
		'重试：手动同步会把它重新挑出来',
		retried.some(item => item.bundle.header?.bundleId === blocked!.bundleId),
		JSON.stringify(retried.map(item => item.bundle.file)),
	);
	const offered = retried.find(item => item.bundle.header?.bundleId === blocked!.bundleId)!;
	check(
		'重试：确认窗里点取消 → dismissed',
		(await handleIncoming(applyT(offered.bundle.file), offered, { confirm: async () => false })).kind,
		'dismissed',
	);
	check(
		'重试：用户自己取消过的不再重挑',
		(await pickT({ retryBlocked: true })).some(item => item.bundle.header?.bundleId === blocked!.bundleId),
		false,
	);


	console.log(`\n共 ${checks} 次检查，失败 ${failures.length} 项`);
	for (const message of failures.slice(0, 10)) console.log('\n❌ ' + message);
	if (failures.length > 10) console.log(`\n…… 其余 ${failures.length - 10} 项失败已省略`);
	if (failures.length > 0) process.exitCode = 1;
}

await main();
