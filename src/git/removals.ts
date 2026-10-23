import fs from 'node:fs';
import path from 'node:path';

/**
 * **哪些包是"插件主动撤下"的**（记号），同步时据此区分两种删除：
 *
 * 1. **插件里点的「挪进回收站 / 彻底删除」**、以及**被新包取代掉的老包**
 *    （`removeSupersededChanges`）—— 这些是**有意的**：要提交、要推到对面，
 *    不然对面下一次拉取又把它带回来了（用户拍板："删包要同步，保证两边一致"）；
 * 2. **用户自己在资源管理器 / 别处删掉的** —— 那不是"撤下"，是"我这份副本丢了"：
 *    同步时应当**从货架（HEAD / 远程）把它恢复回来**。
 *    用户的现场：包弄乱了就删掉，想从远程重新拉最新的 —— 结果插件把删除当改动推上去，
 *    还因为本地多了一笔提交而卡在"不能快进"，于是**一直拉不下来**。
 *
 * 记号放在货架根目录的一个小 JSON 里（`.lsave-removals.json`）：不进仓库（货架的
 * `.gitignore` / `info/exclude` 只放行 `*.lsave`）、每台机器各记各的，不污染远程。
 */
const REMOVALS_FILE = '.lsave-removals.json';
const LIMIT = 500;

interface RemovalsFile {
	format: 'locally-save-removals';
	version: 1;
	/** 货架相对路径（正斜杠） */
	paths: string[];
	at: number;
}

function fileOf(baseDir: string): string {
	return path.join(path.resolve(baseDir), REMOVALS_FILE);
}

/** 货架相对路径（正斜杠）：外部传绝对路径也认 */
export function shelfRelative(baseDir: string, file: string): string {
	const rel = path.relative(path.resolve(baseDir), path.resolve(file));
	return rel.split(path.sep).join('/');
}

/** 记一笔"这些包是我撤下的"（下次同步要把删除提交上去，别当成"本地丢了"恢复回来） */
export function noteBundleRemoved(baseDir: string, files: string[]): void {
	if (!baseDir || files.length === 0) return;
	const rels = files
		.map(file => shelfRelative(baseDir, file))
		.filter(rel => rel !== '' && !rel.startsWith('..'));
	if (rels.length === 0) return;
	const current = readRemovals(baseDir);
	for (const rel of rels) current.add(rel);
	write(baseDir, [...current].slice(-LIMIT));
}

/** 读记号（货架相对路径） */
export function readRemovals(baseDir: string): Set<string> {
	try {
		const raw = JSON.parse(fs.readFileSync(fileOf(baseDir), 'utf8')) as Partial<RemovalsFile>;
		const paths = Array.isArray(raw.paths) ? raw.paths.filter(item => typeof item === 'string') : [];
		return new Set(paths);
	} catch {
		return new Set();
	}
}

/** 清掉记号（删除已经提交进仓库了，再留着只会挡住以后"本地删了要恢复"的那种） */
export function clearRemovals(baseDir: string): void {
	try {
		fs.rmSync(fileOf(baseDir), { force: true });
	} catch {
		// 删不掉不影响正确性：下一次同步还会再看见它，但那时文件早已在 HEAD 里
	}
}

function write(baseDir: string, paths: string[]): void {
	const payload: RemovalsFile = {
		format: 'locally-save-removals',
		version: 1,
		paths,
		at: Date.now(),
	};
	try {
		fs.writeFileSync(fileOf(baseDir), `${JSON.stringify(payload)}\n`, 'utf8');
	} catch {
		// 写不进去只影响"撤下"那一次的传播，不影响包本身
	}
}
