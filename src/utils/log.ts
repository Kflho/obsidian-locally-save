import type { LogLevel } from '../settings/model';

/**
 * 跟着设置走的日志器。
 *
 * 级别从低到高：`silent` < `error` < `debug` —— 只有不高于当前级别的消息才输出。
 * 传进来的是**取级别的函数**而不是值：设置随时会改，闭包里读到的永远是最新值。
 *
 * 只有两个输出口，是因为 obsidianmd 的 no-console 规则只放行
 * `console.warn / error / debug`（`log` 与 `info` 会判为"没必要的日志"）。
 * 所以常规信息也走 `console.debug` —— 反正它同样由「日志级别」设置控制。
 */

const LEVEL_RANK: Record<LogLevel, number> = { silent: 0, error: 1, debug: 2 };

export interface Logger {
	error(message: string, ...rest: unknown[]): void;
	debug(message: string, ...rest: unknown[]): void;
}

/** 日志前缀：一眼看出是哪个插件打的 */
const PREFIX = '[Locally Save]';

export function createLogger(getLevel: () => LogLevel): Logger {
	const write = (
		level: Exclude<LogLevel, 'silent'>,
		sink: (message: string, ...rest: unknown[]) => void,
	) => (message: string, ...rest: unknown[]): void => {
		if (LEVEL_RANK[getLevel()] < LEVEL_RANK[level]) return;
		sink(`${PREFIX} ${message}`, ...rest);
	};

	return {
		error: write('error', (message, ...rest) => { console.error(message, ...rest); }),
		debug: write('debug', (message, ...rest) => { console.debug(message, ...rest); }),
	};
}
