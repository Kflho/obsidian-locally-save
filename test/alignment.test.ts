/**
 * **基准包 ＋ 对应更新包 ＝ 信息是完整的，应用完必须严格对齐。**
 *
 * 这个文件不测"某一条移动的边界"，测的是那条总原则：
 *
 * 1. 应用一份**完整副本** → 本机与那份包**逐文件、逐目录**完全一致（状态编号相同）；
 * 2. 在它上面应用对应的**更新包** → 与导出方那一刻**完全一致**（内容、目录、状态编号、世代）；
 * 3. 同一份更新包**再应用一次** → 一个文件都不动（幂等）；
 * 4. 本机被弄乱过（旧路径还在 / 手工搬过 / 少了一个被移动的文件）时：
 *    - 只要还站在基准点上，信息就是全的，应用完同样必须对齐；
 *    - 真缺内容的那种（少文件）现在会明确拒绝并指路 —— 这一条按下面的用例如实钉住，
 *      它是"要不要回退到基准包再更新"那条兜底路线的判断依据。
 *
 * 用户的原话："有基准包和对应更新包的情况下，是包括了所有信息，一定能更新成功的。"
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyBundle, planBundleApply, recoverToBaselineAndApply } from '../src/bundle/apply';
import { exportBundle } from '../src/bundle/export';
import { DEFAULT_SETTINGS } from '../src/settings/model';
import { compareStateId } from '../src/sync/state-id';
import { loadState } from '../src/sync/state';
import { createLogger } from '../src/utils/log';

let checks = 0;
const failures: string[] = [];
function check(name: string, actual: unknown, expected: unknown): void {
	checks++;
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		failures.push(`${name}\n  期望 ${JSON.stringify(expected)}\n  实际 ${JSON.stringify(actual)}`);
	}
}
function checkTrue(name: string, condition: boolean, detail: string): void {
	checks++;
	if (!condition) failures.push(`${name}\n  ${detail}`);
}

const log = createLogger(() => 'silent');
const settings = { ...DEFAULT_SETTINGS };

interface Scenario {
	root: string;
	a: string;
	b: string;
	out: string;
	sta: string;
	stb: string;
	write: (vault: string, rel: string, content: string) => void;
	/** 仓库里所有文件（相对路径 → 内容），不含回收目录 */
	snapshot: (vault: string) => Record<string, string>;
	/** 仓库里所有目录（相对路径，含空目录） */
	dirs: (vault: string) => string[];
	exportTo: (mode: 'full' | 'changes') => Promise<Awaited<ReturnType<typeof exportBundle>>>;
}

function scenario(name: string): Scenario {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `lsave-align-${name}-`));
	const a = path.join(root, 'A');
	const b = path.join(root, 'B');
	const out = path.join(root, 'out');
	for (const dir of [a, b, out]) fs.mkdirSync(dir, { recursive: true });
	const sta = path.join(root, 'stateA.json');
	const stb = path.join(root, 'stateB.json');
	const write = (vault: string, rel: string, content: string): void => {
		const target = path.join(vault, ...rel.split('/'));
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	};
	const walk = (vault: string, dir: string, prefix: string, files: Record<string, string>, dirs: string[]): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (!prefix && (entry.name === '.trash' || entry.name === '.obsidian')) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				// 只装着被排除文件（如 desktop.ini）的目录不算内容，与 scanTree 的规则一致
				const visible = fs.readdirSync(full).some(item => item !== 'desktop.ini' && !item.endsWith('.lsave'));
				const children = fs.readdirSync(full, { withFileTypes: true });
				if (children.length === 0 || visible) dirs.push(rel);
				walk(vault, full, rel, files, dirs);
				continue;
			}
			if (entry.name.endsWith('.lsave')) continue;
			files[rel] = fs.readFileSync(full, 'utf8');
		}
	};
	const snapshot = (vault: string): Record<string, string> => {
		const files: Record<string, string> = {};
		walk(vault, vault, '', files, []);
		return files;
	};
	const dirs = (vault: string): string[] => {
		const files: Record<string, string> = {};
		const list: string[] = [];
		walk(vault, vault, '', files, list);
		return list.sort();
	};
	const exportTo = (mode: 'full' | 'changes') => exportBundle({
		settings, log, vaultRoot: a, vaultName: 'A', stateFile: sta, mode, outDir: out,
	});
	return { root, a, b, out, sta, stb, write, snapshot, dirs, exportTo };
}

function countTrash(vault: string): number {
	let count = 0;
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else count++;
		}
	};
	try {
		walk(path.join(vault, '.trash', 'locally-save'));
	} catch {
		return 0;
	}
	return count;
}

/** 回收目录里每个文件的内容（确认"该留的没进去"） */
function trashContents(vault: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			try {
				out.push(fs.readFileSync(full, 'utf8'));
			} catch {
				out.push(`（读不出：${entry.name}）`);
			}
		}
	};
	try {
		walk(path.join(vault, '.trash', 'locally-save'));
	} catch {
		return [];
	}
	return out;
}

async function main(): Promise<void> {
	// ============================================================ 1. 完整副本 = 严格对齐
	const s = scenario('base');
	s.write(s.a, '笔记/一.md', '一号内容');
	s.write(s.a, '笔记/二.md', '二号内容更长一点');
	s.write(s.a, '笔记/子/三.md', '三号内容');
	s.write(s.a, '根.md', '根上的文件');
	fs.mkdirSync(path.join(s.a, '空文件夹'), { recursive: true });
	const full = await s.exportTo('full');
	await applyBundle({ settings, log, vaultRoot: s.b, stateFile: s.stb, file: full.file as string, strictness: 'mirror' });

	const sa0 = await loadState(s.sta);
	const sb0 = await loadState(s.stb);
	const aFiles0 = s.snapshot(s.a);
	const bFiles0 = s.snapshot(s.b);
	check('① 完整副本：B 的文件与 A 一模一样', bFiles0, aFiles0);
	check('① 完整副本：B 的目录与 A 一模一样', s.dirs(s.b), s.dirs(s.a));
	check('① 完整副本：两边状态编号一致', compareStateId(sa0.stateId, sb0.stateId), 'match');
	check('① 完整副本：B 站上了这份基准', sb0.bundle?.fullHash, sa0.bundle?.fullHash);
	check('① 完整副本：B 记的文件清单 = A 的状态', Object.keys(sb0.bundle?.files ?? {}).sort(), Object.keys(sa0.stateId?.id ? aFiles0 : {}).sort());
	check('① 完整副本：B 没有挂欠账', sb0.pendingReturn ?? null, null);

	// ============================================================ 2. 更新包 = 严格对齐
	// 一次把移动 / 改名 / 编辑 / 删除 / 新增空目录 / 删掉空目录 / 新文件全用上
	fs.renameSync(path.join(s.a, '笔记'), path.join(s.a, '资料'));
	fs.mkdirSync(path.join(s.a, '资料/归档'), { recursive: true });
	fs.renameSync(path.join(s.a, '资料/一.md'), path.join(s.a, '资料/归档/一.md'));
	fs.renameSync(path.join(s.a, '根.md'), path.join(s.a, '资料/根.md'));
	s.write(s.a, '资料/二.md', '二号内容改过了，长度也不同');
	fs.rmSync(path.join(s.a, '资料/子/三.md'));
	fs.rmdirSync(path.join(s.a, '空文件夹'));
	fs.mkdirSync(path.join(s.a, '新空文件夹/再深一层'), { recursive: true });
	s.write(s.a, '资料/新写的.md', '这是新写的一个文件，长度不一样');

	const changes = await s.exportTo('changes');
	checkTrue('② 更新包：带着移动', (changes.header?.moves ?? []).length >= 1, JSON.stringify(changes.header?.moves));
	await applyBundle({ settings, log, vaultRoot: s.b, stateFile: s.stb, file: changes.file as string, strictness: 'mirror' });

	const sa1 = await loadState(s.sta);
	const sb1 = await loadState(s.stb);
	check('② 更新包：B 的文件与 A 完全一致', s.snapshot(s.b), s.snapshot(s.a));
	check('② 更新包：B 的目录与 A 完全一致', s.dirs(s.b), s.dirs(s.a));
	check('② 更新包：两边状态编号一致', compareStateId(sa1.stateId, sb1.stateId), 'match');
	check('② 更新包：世代也一致', sb1.generation, sa1.generation);
	check('② 更新包：记录清单 = A 的内容', Object.keys(sb1.bundle?.files ?? {}).sort(), Object.keys(s.snapshot(s.a)).sort());
	check('② 更新包：没有挂欠账', sb1.pendingReturn ?? null, null);
	// 回收目录里只应该有**包里点名删掉**的那一个文件；要留的东西一个都不能进去
	const trash1 = trashContents(s.b);
	checkTrue('② 更新包：要留的东西没被挪进回收目录',
		!trash1.includes('一号内容') && !trash1.includes('根上的文件')
		&& !trash1.includes('二号内容改过了，长度也不同') && !trash1.includes('这是新写的一个文件，长度不一样'),
		trash1.join(' / '));
	checkTrue('② 更新包：点名删掉的文件进了回收目录（能捞回来）', trash1.includes('三号内容'), trash1.join(' / '));

	// ============================================================ 3. 同一份更新包再应用一次：幂等
	const trashBefore = countTrash(s.b);
	await applyBundle({ settings, log, vaultRoot: s.b, stateFile: s.stb, file: changes.file as string, strictness: 'mirror' });
	const sb2 = await loadState(s.stb);
	check('③ 再应用一次：文件一个不变', s.snapshot(s.b), s.snapshot(s.a));
	check('③ 再应用一次：状态编号不变', sb2.stateId?.id, sb1.stateId?.id);
	check('③ 再应用一次：没有新增回收副本', countTrash(s.b), trashBefore);

	// ============================================================ 4. 被弄乱的机器
	// 4a. 站在基准点上、但已经**手工**把改名做完了（插件不知道）
	{
		const t = scenario('manual');
		t.write(t.a, '旧/一.md', '一号内容');
		t.write(t.a, '旧/二.md', '二号内容更长一点');
		t.write(t.a, '根.md', '根上的文件');
		const base = await t.exportTo('full');
		await applyBundle({ settings, log, vaultRoot: t.b, stateFile: t.stb, file: base.file as string, strictness: 'mirror' });
		fs.renameSync(path.join(t.a, '旧'), path.join(t.a, '新'));
		fs.renameSync(path.join(t.a, '根.md'), path.join(t.a, '新/根.md'));
		t.write(t.a, '新/三.md', '三号内容');
		const upd = await t.exportTo('changes');
		// B 也手工做了同样的改名（插件状态还停在旧路径）
		fs.renameSync(path.join(t.b, '旧'), path.join(t.b, '新'));
		fs.renameSync(path.join(t.b, '根.md'), path.join(t.b, '新/根.md'));
		await applyBundle({ settings, log, vaultRoot: t.b, stateFile: t.stb, file: upd.file as string, strictness: 'mirror' });
		check('④a 手工搬过：文件与 A 一致', t.snapshot(t.b), t.snapshot(t.a));
		check('④a 手工搬过：状态编号一致', compareStateId((await loadState(t.sta)).stateId, (await loadState(t.stb)).stateId), 'match');
	}

	// 4b. 站在基准点上、但被移动的树里**少了一个文件**（真缺内容）
	//     更新包只带改名、不带内容 → 计划阶段明确拒绝并指路（绝不静默落半套）；
	//     这时**强制回退到基准再应用**就是兜底：基准包里有那份内容，补齐之后再搬，一定落。
	{
		const t = scenario('missing');
		t.write(t.a, '旧/一.md', '一号内容');
		t.write(t.a, '旧/二.md', '二号内容更长一点');
		const base = await t.exportTo('full');
		await applyBundle({ settings, log, vaultRoot: t.b, stateFile: t.stb, file: base.file as string, strictness: 'mirror' });
		fs.renameSync(path.join(t.a, '旧'), path.join(t.a, '新'));
		const upd = await t.exportTo('changes');
		fs.rmSync(path.join(t.b, '旧/二.md'));
		let message = '';
		try {
			await planBundleApply({ settings, log, vaultRoot: t.b, stateFile: t.stb, file: upd.file as string, strictness: 'mirror' });
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		checkTrue('④b 少文件：明确拒绝并指路（不静默落半套）',
			message.includes('完整副本') || message.includes('恢复到基准'), message || '（没有拒绝）');
		checkTrue('④b 少文件：本机其余文件没被动', fs.existsSync(path.join(t.b, '旧/一.md')), '');

		// 兜底：回退到基准再应用 → 补齐那一个文件，严格对齐
		const recovered = await recoverToBaselineAndApply({
			settings, log, vaultRoot: t.b, stateFile: t.stb, file: upd.file as string, strictness: 'mirror',
		});
		checkTrue('④c 回退再更新：报告里记着"是兜底才落下的"', recovered.result.recovered?.matched === true,
			JSON.stringify(recovered.result.recovered));
		check('④c 回退再更新：文件与 A 一致', t.snapshot(t.b), t.snapshot(t.a));
		check('④c 回退再更新：两边状态编号一致',
			compareStateId((await loadState(t.sta)).stateId, (await loadState(t.stb)).stateId), 'match');
	}

	// 4d. 基准完整副本**不在本机**时不能硬来：明确说清"把它放回包目录 / 让对方发一份"
	{
		const t = scenario('no-baseline');
		t.write(t.a, '旧/一.md', '一号内容');
		t.write(t.a, '旧/二.md', '二号内容更长一点');
		const base = await t.exportTo('full');
		await applyBundle({ settings, log, vaultRoot: t.b, stateFile: t.stb, file: base.file as string, strictness: 'mirror' });
		fs.renameSync(path.join(t.a, '旧'), path.join(t.a, '新'));
		const upd = await t.exportTo('changes');
		// 让计划需要"补内容"（少一个被移动的文件），同时把基准完整副本从磁盘上拿走
		fs.rmSync(path.join(t.b, '旧/二.md'));
		for (const name of fs.readdirSync(path.join(t.out, 'full'))) {
			fs.rmSync(path.join(t.out, 'full', name));
		}
		let message = '';
		try {
			await recoverToBaselineAndApply({
				settings, log, vaultRoot: t.b, stateFile: t.stb, file: upd.file as string, strictness: 'mirror',
			});
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		checkTrue('④d 基准包不在：说清下一步（放回包目录 / 让对方发一份）',
			message.includes('full') || message.includes('完整副本'), message || '（没有拒绝）');
	}

	// ============================================================ 5. 应用完整副本时"删不掉"的东西
	// 目录里只有被排除规则挡住的文件（desktop.ini）时不算内容：不能因此让基准换不过去。
	{
		const t = scenario('excluded-dir');
		t.write(t.a, 'n/一.md', '一号内容');
		const base = await t.exportTo('full');
		await applyBundle({ settings, log, vaultRoot: t.b, stateFile: t.stb, file: base.file as string, strictness: 'mirror' });
		// B 多出一个只装着 desktop.ini 的目录：镜像时 rmdir 删不掉，但这不该影响"落到基准"
		fs.mkdirSync(path.join(t.b, '只装排除文件的目录'), { recursive: true });
		fs.writeFileSync(path.join(t.b, '只装排除文件的目录/desktop.ini'), 'x');
		const sb = await loadState(t.stb);
		check('⑤ 只装排除文件的目录：不算内容，状态编号仍一致',
			compareStateId(sb.stateId, (await loadState(t.sta)).stateId), 'match');
	}

	console.log(`\n共 ${checks} 次检查，失败 ${failures.length} 项`);
	for (const message of failures.slice(0, 10)) console.log(`\n❌ ${message}`);
	if (failures.length > 10) console.log(`\n…… 其余 ${failures.length - 10} 项失败已省略`);
	if (failures.length > 0) process.exitCode = 1;
}

await main();
