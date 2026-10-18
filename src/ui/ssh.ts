import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * SSH 接入要用的几件事：找密钥 / 生成密钥 / 测 SSH 登录 / 用 GitHub CLI 加公钥。
 *
 * 和 `git/run.ts` 分开：那边只管 git，这边是"让 SSH 能用"的一次性设置。
 * 三条纪律：不经过 shell（execFile 直接传参）、有超时、失败把 stderr 原样交回去给界面看。
 * **不读**用户的私钥内容 —— 只把 `.pub` 显示出来让用户复制。
 */

export interface SshKey {
	privatePath: string;
	publicPath: string;
	/** `.pub` 的全文（贴到 GitHub 用的那一行） */
	publicKey: string;
}

/** 工具执行结果（找不到程序时 `missing` 为 true，别把它当成"命令失败"） */
export interface ToolResult {
	code: number;
	stdout: string;
	stderr: string;
	missing: boolean;
}

/** 依次认这三种密钥名（GitHub 推荐的 ed25519 优先） */
const KEY_NAMES = ['id_ed25519', 'id_ecdsa', 'id_rsa'];

export function sshDir(): string {
	return path.join(os.homedir(), '.ssh');
}

/** 找到第一把已有密钥（优先 ed25519）；没有就 null */
export function findSshKey(): SshKey | null {
	for (const name of KEY_NAMES) {
		const publicPath = path.join(sshDir(), `${name}.pub`);
		try {
			if (!fs.existsSync(publicPath)) continue;
			return {
				privatePath: path.join(sshDir(), name),
				publicPath,
				publicKey: fs.readFileSync(publicPath, 'utf8').trim(),
			};
		} catch {
			// 读不了就试下一把
		}
	}
	return null;
}

/** 生成一把 ed25519（**无口令**：插件要在后台同步，不能每次都问口令）；已有就不覆盖 */
export async function generateSshKey(): Promise<{ key: SshKey | null; error: string | null }> {
	try {
		fs.mkdirSync(sshDir(), { recursive: true });
	} catch (error) {
		return { key: null, error: `建 .ssh 目录失败：${messageOf(error)}` };
	}
	const target = path.join(sshDir(), 'id_ed25519');
	if (fs.existsSync(target) || fs.existsSync(`${target}.pub`)) {
		return { key: findSshKey(), error: null };
	}
	const result = await runTool('ssh-keygen', [
		'-t', 'ed25519',
		'-N', '',
		'-C', `locally-save@${os.hostname()}`,
		'-f', target,
	], 30_000);
	if (result.code !== 0) {
		return { key: null, error: result.missing ? '没找到 ssh-keygen（装 Git for Windows 时一般会带上）' : lastLines(result) };
	}
	return { key: findSshKey(), error: null };
}

/**
 * 这段 SSH 输出算不算"认证成功"。
 *
 * **不能看退出码**：GitHub 不提供 shell，`ssh -T` 认证成功也返回 1
 * （`Hi xxx! You've successfully authenticated, but GitHub does not provide shell access.`）。
 * 所以只认文本 —— 这条规则单独抽出来，`test/ssh.test.ts` 守着。
 */
export function sshAuthSucceeded(text: string): boolean {
	return !/Permission denied/i.test(text)
		&& (/successfully authenticated/i.test(text) || /Welcome to/i.test(text));
}

/** 测一次 SSH 登录（GitHub / Gitee / GitLab 都会回一句认证成功） */
export async function testSshHost(host: string): Promise<{ ok: boolean; text: string; hint?: string }> {
	const result = await runTool('ssh', [
		'-o', 'BatchMode=yes',
		'-o', 'ConnectTimeout=15',
		'-T', `git@${host}`,
	], 25_000);
	const text = (result.stderr || result.stdout).trim();
	const ok = !result.missing && sshAuthSucceeded(text);
	const hint = ok
		? null
		: /host key verification failed/i.test(text)
			? '这台机器还没确认过远程主机的指纹：先在终端跑一次 ssh -T git@' + host
				+ '，看到 "successfully authenticated" 之后再点测试'
			: null;
	return { ok, text: text || `ssh 退出码 ${result.code}`, ...(hint ? { hint } : {}) };
}

/** GitHub CLI 的登录情况（加公钥需要 `admin:public_key`，缺了就会 404） */
export interface GhStatus {
	installed: boolean;
	authed: boolean;
	hasPublicKeyScope: boolean;
	text: string;
}

export async function ghStatus(): Promise<GhStatus> {
	const result = await runTool('gh', ['auth', 'status'], 15_000);
	const text = [result.stdout, result.stderr].map(line => line.trim()).filter(line => line !== '').join('\n');
	if (result.missing) {
		return { installed: false, authed: false, hasPublicKeyScope: false, text: '没找到 GitHub CLI（gh）' };
	}
	return {
		installed: true,
		authed: result.code === 0,
		hasPublicKeyScope: /admin:public_key/.test(text),
		text: text || `gh 退出码 ${result.code}`,
	};
}

/** 缺权限时给用户的那条命令（要在终端里跑：它要开浏览器 + 粘一次性验证码） */
export const GH_REFRESH_COMMAND = 'gh auth refresh -h github.com -s admin:public_key';

/** 用 GitHub CLI 把公钥加到账户（需要 admin:public_key 权限） */
export async function addKeyWithGh(key: SshKey): Promise<{ ok: boolean; text: string; hint?: string }> {
	const result = await runTool('gh', [
		'ssh-key', 'add', key.publicPath,
		'--title', `Locally Save (${os.hostname()})`,
	], 20_000);
	const text = (result.stdout || result.stderr).trim();
	if (result.code === 0) return { ok: true, text: text || '已添加到 GitHub' };
	const hint = result.missing
		? '没找到 GitHub CLI（gh）：直接复制公钥到 GitHub 网页也行'
		: /404|403|not found|forbidden|missing.*scope/i.test(text)
			? `gh 的 token 缺 admin:public_key 权限：在终端跑 ${GH_REFRESH_COMMAND} 之后再试；或者直接复制公钥到网页`
			: null;
	return {
		ok: false,
		text: result.missing ? '没找到 GitHub CLI（gh）' : (text || `gh 退出码 ${result.code}`),
		...(hint ? { hint } : {}),
	};
}

/** 从远程地址里取主机名（`git@github.com:…` / `ssh://git@host/…` / `https://host/…`） */
export function hostOfRemote(remote: string): string | null {
	const value = remote.trim();
	// 先认 https：否则下面那条 scp 形式的正则会把 `https` 当成主机名（踩过）
	const http = /^https?:\/\/([^/]+)/i.exec(value);
	if (http?.[1]) return http[1];
	const scp = /^(?:ssh:\/\/)?(?:[^@/]+@)?([^:/]+)[:/]/.exec(value);
	return scp?.[1] ?? null;
}

/** 这个地址是不是 SSH 形式（HTTPS 的话 SSH 密钥帮不上忙） */
export function isSshRemote(remote: string): boolean {
	const value = remote.trim();
	return value.startsWith('ssh://') || /^[^/@\s]+@[^:/\s]+:/.test(value);
}

function runTool(file: string, args: string[], timeoutMs: number): Promise<ToolResult> {
	return new Promise(resolve => {
		execFile(file, args, {
			timeout: timeoutMs,
			windowsHide: true,
			encoding: 'utf8',
			env: {
				...process.env,
				// SSH 要能问到主机指纹 / 口令时，宁可失败也别把插件挂住
				GIT_TERMINAL_PROMPT: '0',
			},
		}, (error, stdout, stderr) => {
			if (!error) {
				resolve({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '', missing: false });
				return;
			}
			const failure = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
			if (failure.code === 'ENOENT') {
				resolve({ code: -1, stdout: '', stderr: `没找到程序：${file}`, missing: true });
				return;
			}
			resolve({
				code: typeof failure.code === 'number' ? failure.code : -1,
				stdout: stdout ?? '',
				stderr: stderr ?? '',
				missing: false,
			});
		});
	});
}

function lastLines(result: ToolResult): string {
	return [result.stderr, result.stdout]
		.map(text => text.trim())
		.filter(text => text !== '')
		.join('\n')
		.split(/\r?\n/)
		.slice(-3)
		.join(' ');
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
