import { execFile } from 'node:child_process';

/**
 * 跑一次 git 的薄封装。
 *
 * 三条纪律（后面写 git 相关的代码都靠它们）：
 * - **不经过 shell**：参数原样交给 `execFile` —— 路径里带空格、中文、引号都不用操心，
 *   也没有"把用户输入拼进命令行"这种口子；
 * - **"命令失败"不当异常抛**：git 的失败里有一大半是正常情况（远程还是空的、已经最新、
 *   推送被另一台机器抢先），所以把退出码与输出原样返回，由调用方判断该重试还是该报错；
 *   只有"连 git 都找不到"才抛（那是环境问题，再试也没用）；
 * - **一定带超时**：凭据提示 / SSH 问密码会把进程挂住，插件不能跟着卡死。
 */
export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
	/** 超时被杀掉的（这时 `code` 是 -1，输出多半是空的） */
	timedOut: boolean;
}

/** 找不到 git 程序：和"命令跑失败了"分开，界面上要教用户去装 / 去填路径 */
export class GitMissingError extends Error {
	readonly gitPath: string;

	constructor(gitPath: string) {
		super(`没找到 git 程序：${gitPath}`);
		this.name = 'GitMissingError';
		this.gitPath = gitPath;
	}
}

export interface GitRunOptions {
	/** 在哪个目录里跑（货架根目录） */
	cwd: string;
	/** git 程序路径；留空 ＝ 从 PATH 里找 */
	gitPath?: string;
	/** 超时（毫秒）：本地命令与网络命令要分开传 */
	timeoutMs?: number;
	/** 额外的环境变量（覆盖默认值） */
	env?: NodeJS.ProcessEnv;
}

/** 输出上限：`git status` / `ls-tree` 这类命令在包多的时候也就几百 KB，32 MB 足够 */
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * 默认环境变量：
 * - `GIT_TERMINAL_PROMPT=0`：绝不让 git 在插件进程里问用户名密码（没有 TTY，问就是卡死）；
 * - `LC_ALL=C`：git 自己那句错误信息保持英文（路径输出不受影响，读包不靠它）；
 * - `GIT_SSH_COMMAND`：用户自己配过就不动；没配过时加 `BatchMode`，别让 ssh 停下来问口令。
 */
function defaultEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		GIT_TERMINAL_PROMPT: '0',
		LC_ALL: 'C',
	};
	if (!process.env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = 'ssh -oBatchMode=yes';
	return env;
}

/** 跑一次 git：**不抛"命令失败"**，只有找不到程序才抛 `GitMissingError` */
export function runGit(args: string[], options: GitRunOptions): Promise<GitResult> {
	const gitPath = options.gitPath?.trim() || 'git';
	return new Promise<GitResult>((resolve, reject) => {
		execFile(
			gitPath,
			args,
			{
				cwd: options.cwd,
				timeout: options.timeoutMs ?? 10_000,
				maxBuffer: MAX_BUFFER,
				windowsHide: true,
				encoding: 'utf8',
				env: { ...defaultEnv(), ...options.env },
			},
			(error, stdout, stderr) => {
				if (!error) {
					resolve({ code: 0, stdout, stderr, timedOut: false });
					return;
				}
				const failure = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
				if (failure.code === 'ENOENT') {
					reject(new GitMissingError(gitPath));
					return;
				}
				resolve({
					code: typeof failure.code === 'number' ? failure.code : -1,
					stdout: stdout ?? '',
					stderr: stderr ?? '',
					timedOut: failure.killed === true,
				});
			},
		);
	});
}

/** 把一次命令失败变成一句人话（只取最后几行：git 的报错前面常有一堆 To/From 噪声） */
export function gitFailure(what: string, result: GitResult): Error {
	const detail = [result.stderr, result.stdout]
		.map(text => text.trim())
		.filter(text => text !== '')
		.join('\n')
		.split(/\r?\n/)
		.slice(-3)
		.join(' ');
	const reason = result.timedOut
		? '超时（网络或凭据卡住了）'
		: (detail || `退出码 ${result.code}`);
	return new Error(`${what}失败：${reason}`);
}
