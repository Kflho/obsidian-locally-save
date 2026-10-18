/**
 * 「只拉不推」＝ 和另一半**严格相等**（0.15.2）。
 *
 * 用户报的现场：只拉那台误改了一行；对方（只推）发来的更新包只装"变过的文件"，
 * 那一行不在包里 —— 普通镜像把它当"我这一半"留着，应用完状态编号永远差一点。
 * 正确语义：只拉端没有"我这一半"，包里没点名的本地改动要**恢复成基准那一版**
 * （旧版本进回收目录），应用完与对方严格相等。
 *
 * 这个文件钉三件事：
 * 1. 双向语义不变：不传 `alignToPeer` 时，本机误改仍然保留（那是要回传的一半）；
 * 2. 只拉语义：`alignToPeer` 时从基准完整副本恢复，状态编号与对方一致；
 * 3. 基准完整副本不在磁盘上时**明确报错**，不静默删掉/假装恢复。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyBundle, executeBundlePlan, planBundleApply } from '../src/bundle/apply';
import type { ApplyOptions } from '../src/bundle/apply';
import { exportBundle } from '../src/bundle/export';
import { pickIncoming, sweepIncoming } from '../src/bundle/incoming';
import type { IncomingPolicy } from '../src/bundle/incoming';
import { listBundles } from '../src/bundle/manage';
import { DEFAULT_SETTINGS } from '../src/settings/model';
import { loadState } from '../src/sync/state';
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
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lsave-download-mirror-'));
const SEND = path.join(ROOT, 'send');
const RECV = path.join(ROOT, 'recv');
const OUT = path.join(ROOT, 'bundles');
const STATE_SEND = path.join(ROOT, 'state-send.json');
const STATE_RECV = path.join(ROOT, 'state-recv.json');
for (const dir of [SEND, RECV, OUT]) fs.mkdirSync(dir, { recursive: true });

const at = (root: string, rel: string): string => path.join(root, ...rel.split('/'));

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

/** 回收目录里有没有一份内容等于 `content` 的副本（文件名可能是时间戳 / 冲突目录） */
function trashHas(content: string): boolean {
	const root = at(RECV, '.trash/locally-save');
	const walk = (dir: string): boolean => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return false;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (walk(full)) return true;
				continue;
			}
			try {
				if (fs.readFileSync(full, 'utf8') === content) return true;
			} catch {
				// 二进制 / 读不出：不是我们要找的那一份
			}
		}
		return false;
	};
	return walk(root);
}

const settings = () => ({ ...DEFAULT_SETTINGS });

function exportFromSend(mode: 'full' | 'changes', forcePaths?: string[]): ReturnType<typeof exportBundle> {
	return exportBundle({
		settings: settings(),
		log,
		vaultRoot: SEND,
		vaultName: '对面',
		stateFile: STATE_SEND,
		mode,
		outDir: OUT,
		...(forcePaths ? { forcePaths } : {}),
	});
}

function applyOptions(file: string, alignToPeer = false): ApplyOptions {
	return {
		settings: settings(),
		log,
		vaultRoot: RECV,
		stateFile: STATE_RECV,
		file,
		bundleDir: OUT,
		strictness: 'mirror',
		...(alignToPeer ? { alignToPeer: true } : {}),
	};
}

/** 本机（只拉端）应用一个包：先算、再落盘 */
async function applyOnRecv(file: string, alignToPeer: boolean): Promise<{ stateIdCompare: string; restored: number }> {
	const options = applyOptions(file, alignToPeer);
	const plan = await planBundleApply(options);
	const result = await executeBundlePlan(plan, options);
	return { stateIdCompare: result.stateIdCompare, restored: result.restored };
}

// -------------------------------------------------------------------- 用例
async function main(): Promise<void> {
	// 两边从同一份完整副本出发
	for (const [rel, content] of [['notes/a.md', 'AAA'], ['notes/b.md', 'BBB']] as const) {
		write(SEND, rel, content);
		write(RECV, rel, content);
	}
	const full = await exportFromSend('full');
	if (!full.file) throw new Error('完整包没导出来');
	await applyBundle(applyOptions(full.file));
	check('立基准后本地就是对面那一版', read(RECV, 'notes/b.md'), 'BBB');

	// ---------------------------------------------------------------- 1. 双向语义不变
	// 只拉端误改一行；对面改另一个文件并发更新包。**不传 alignToPeer** 时，
	// 误改是"我这一半"，必须留着（回传由别的路负责）。
	write(RECV, 'notes/b.md', 'BBB 误改');
	write(SEND, 'notes/a.md', 'AAA 改一（更长）');
	const update1 = await exportFromSend('changes');
	if (!update1.file) throw new Error('第一份更新包没导出来');
	const merged = await applyOnRecv(update1.file, false);
	check('双向：对面改过的落地了', read(RECV, 'notes/a.md'), 'AAA 改一（更长）');
	check('双向：本机误改仍然保留', read(RECV, 'notes/b.md'), 'BBB 误改');
	check('双向：状态编号对不上（还有我这一半）', merged.stateIdCompare, 'mismatch');

	// ---------------------------------------------------------------- 2. 只拉语义：严格相等
	// 对面再改一次，导一份累积更新包；这次按"只拉"应用：b 的误改要恢复成基准版。
	// 内容长度要变：同长度 + 同一秒内会被 2 秒容差当成"没改过"。
	write(SEND, 'notes/a.md', 'AAA 改二（长了两点）');
	const update2 = await exportFromSend('changes');
	if (!update2.file) throw new Error('第二份更新包没导出来');
	const aligned = await applyOnRecv(update2.file, true);
	check('只拉：对面改过的落地了', read(RECV, 'notes/a.md'), 'AAA 改二（长了两点）');
	check('只拉：本机误改被恢复成基准那一版', read(RECV, 'notes/b.md'), 'BBB');
	check('只拉：恢复计数', aligned.restored, 1);
	check('只拉：应用完与对面严格相等', aligned.stateIdCompare, 'match');
	checkTrue('只拉：误改的旧版本进了回收目录', trashHas('BBB 误改'), '回收目录里找不到 BBB 误改');

	// ---------------------------------------------------------------- 3. 没有基准完整副本：明确报错
	// 只拉端又误改了一次；把基准完整包从磁盘上挪走 —— 这时不能静默删掉误改、也不能
	// 拿别的包顶替，只能明确说"要那份完整副本才能恢复"。
	write(RECV, 'notes/b.md', 'BBB 又误改');
	write(SEND, 'notes/a.md', 'AAA 改三（又长一点）');
	const update3 = await exportFromSend('changes');
	if (!update3.file) throw new Error('第三份更新包没导出来');
	const fullDir = path.join(OUT, 'full');
	const hidden = path.join(ROOT, 'hidden-full');
	fs.mkdirSync(hidden, { recursive: true });
	for (const name of fs.readdirSync(fullDir)) {
		fs.renameSync(path.join(fullDir, name), path.join(hidden, name));
	}
	let message = '';
	try {
		await applyOnRecv(update3.file, true);
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	checkTrue(
		'缺基准完整副本：明确报错并指路',
		message.includes('基准完整副本') && message.includes('完整包放回'),
		message || '（没有报错）',
	);
	check('缺基准完整副本：误改没有被悄悄删掉', read(RECV, 'notes/b.md'), 'BBB 又误改');

	// 收尾：把完整包放回去，确认状态没有在失败那一趟被改坏
	for (const name of fs.readdirSync(hidden)) {
		fs.renameSync(path.join(hidden, name), path.join(fullDir, name));
	}
	const state = await loadState(STATE_RECV);
	// 失败那一趟不能声称"我这边已经恢复了"：状态里还是上一次应用后的 BBB（3 字节），
	// 磁盘上仍是用户误改的 7 字节 —— 下一轮还会再次尝试 / 报错。
	check('失败那一趟没有把状态记成"已恢复"', state.bundle?.files['notes/b.md']?.size, 'BBB'.length);
	checkTrue('状态文件还在', exists(RECV, 'notes/a.md'));

	// ---------------------------------------------------------------- 4. forcePaths：强制把"没变过"的文件装进包
	// 给"让对面撤销误改"用：我们这边相对基准没动过 b，正常导出不会带它；
	// `forcePaths` 要把它带上（带 base = 基准那一版），对面应用时才会覆盖误改。
	const forced = await exportBundle({
		settings: settings(),
		log,
		vaultRoot: SEND,
		vaultName: '对面',
		stateFile: STATE_SEND,
		mode: 'changes',
		outDir: path.join(ROOT, 'forced'),
		forcePaths: ['notes/b.md'],
	});
	checkTrue('forcePaths：包导出来了', forced.file !== null, forced.reason ?? '（没给原因）');
	const forcedEntry = forced.header?.entries.find(entry => entry.path === 'notes/b.md');
	checkTrue(
		'forcePaths：没变过的文件也带上了，base 是基准那一版',
		forcedEntry !== undefined && forcedEntry.baseSize === 'BBB'.length,
		JSON.stringify(forcedEntry),
	);

	// ---------------------------------------------------------------- 5. 起点对不上、落点对得上：也能自动接
	// 恢复包的真实形状：只拉那台的起点被它自己导出的完整包挪走了（F1），
	// 而对方（还站在 F0 上）导的是「F0 → 最新」。按"起点严格相等"永远挑不到；
	// 但"我现在的清单 ＋ 条目 − 删除"正好等于它头部报的落点 → 内容确定，可以接。
	const SEND2 = path.join(ROOT, 'send2');
	const SEND3 = path.join(ROOT, 'send3');
	const RECV2 = path.join(ROOT, 'recv2');
	const OUT_SEND2 = path.join(ROOT, 'bundles-send2');
	const OUT2 = path.join(ROOT, 'bundles2');
	const STATE_SEND2 = path.join(ROOT, 'state-send2.json');
	const STATE_SEND3 = path.join(ROOT, 'state-send3.json');
	const STATE_RECV2 = path.join(ROOT, 'state-recv2.json');
	for (const dir of [SEND2, SEND3, RECV2, OUT_SEND2, OUT2]) fs.mkdirSync(dir, { recursive: true });
	for (const dir of [SEND2, RECV2]) {
		write(dir, 'n/a.md', 'F0-A');
		write(dir, 'n/b.md', 'F0-B');
	}
	// SEND2 立在 F0 上（之后一直站在 F0，用来导恢复包）
	const f0 = await exportBundle({
		settings: settings(), log, vaultRoot: SEND2, vaultName: '起点机器', stateFile: STATE_SEND2, mode: 'full', outDir: OUT_SEND2,
	});
	if (!f0.file) throw new Error('F0 完整包没导出来');
	await applyBundle({
		settings: settings(), log, vaultRoot: SEND2, stateFile: STATE_SEND2, file: f0.file,
	});
	// SEND3 是"最新内容"那一版：a 改过，b 没动；导完整副本给 RECV2，把它的基准挪到 F1
	write(SEND3, 'n/a.md', 'F1-A 更长');
	write(SEND3, 'n/b.md', 'F0-B');
	const f1 = await exportBundle({
		settings: settings(), log, vaultRoot: SEND3, vaultName: '最新机器', stateFile: STATE_SEND3, mode: 'full', outDir: OUT2,
	});
	if (!f1.file) throw new Error('F1 完整包没导出来');
	await applyBundle({
		settings: settings(), log, vaultRoot: RECV2, stateFile: STATE_RECV2, file: f1.file,
	});
	// SEND2 的仓库也改成 F1 的内容，但**基准仍是 F0** → 导出来的更新包起点 F0、落点 F1
	write(SEND2, 'n/a.md', 'F1-A 更长');
	const recovery = await exportBundle({
		settings: settings(), log, vaultRoot: SEND2, vaultName: '起点机器', stateFile: STATE_SEND2, mode: 'changes',
		outDir: OUT2, forcePaths: ['n/b.md'],
	});
	if (!recovery.file) throw new Error(`恢复包没导出来：${recovery.reason ?? ''}`);
	// RECV2 现在站在 F1 上，又误改了 b；接着它自己导了一份完整副本 ——
	// 这一步把它的基准挪到"含误改的那一份"（真实现场里对面就是这么把基准挪走的）。
	write(RECV2, 'n/b.md', 'BAD LOCAL');
	const badFullDir = path.join(ROOT, 'bad-full');
	fs.mkdirSync(badFullDir, { recursive: true });
	const badFull = await exportBundle({
		settings: settings(), log, vaultRoot: RECV2, vaultName: '只拉机器', stateFile: STATE_RECV2, mode: 'full', outDir: badFullDir,
	});
	if (!badFull.file) throw new Error('只拉那台的完整副本没导出来（测试想模拟基准被挪走）');
	const policy: IncomingPolicy = {
		force: true,
		allowFull: true,
		apply: { strictness: 'mirror', alignToPeer: true, bundleDir: OUT2 },
	};
	const incoming = pickIncoming(await listBundles(OUT2), await loadState(STATE_RECV2));
	check('恢复包进了候选（但起点不是本机的）', incoming.some(item => item.bundle.header?.bundleId === recovery.header?.bundleId), true);
	const sweep = await sweepIncoming(
		file => ({ settings: settings(), log, vaultRoot: RECV2, stateFile: STATE_RECV2, file, bundleDir: OUT2 }),
		STATE_RECV2,
		incoming,
		policy,
	);
	check('落点对得上：自动接了恢复包', sweep.applied.length, 1);
	check('误改被恢复成恢复包里的那一版', read(RECV2, 'n/b.md'), 'F0-B');
	check('应用完与恢复包落点一致', sweep.applied[0]?.stateIdCompare, 'match');
	const after = await loadState(STATE_RECV2);
	check('基准接回恢复包的起点（F0），不是继续站在 F1 上', after.bundle?.fullHash, f0.header?.baselineHash);

	console.log(`\n共 ${checks} 次检查，失败 ${failures.length} 项`);
	for (const message of failures.slice(0, 10)) console.log(`\n❌ ${message}`);
	if (failures.length > 10) console.log(`\n…… 其余 ${failures.length - 10} 项失败已省略`);
	if (failures.length > 0) process.exitCode = 1;
}

await main().catch(error => {
	console.error('测试自身炸了：', error);
	process.exitCode = 1;
});
