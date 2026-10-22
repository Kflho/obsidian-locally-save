/**
 * 插件调试日志：把同步失败的异常写进插件目录，MCP / 状态文件都能读。
 *
 * 引擎（bundle/）不 import obsidian，所以这里只留一个可注入的 sink；
 * main.ts 启动时把 sink 接到 app.vault.adapter 上。
 */

export interface DebugLogWriter {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, text: string): Promise<void>;
}

export interface DebugLogOptions {
	writer: DebugLogWriter;
	path: string;
	enabled?: () => boolean;
	maxBytes?: number;
}

export function serializeError(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		const cause = (error as Error & { cause?: unknown }).cause;
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			...(cause === undefined ? {} : { cause: serializeError(cause) }),
		};
	}
	return { message: String(error) };
}

type DebugSink = (event: string, data?: Record<string, unknown>, error?: unknown) => void;

let sink: DebugSink | null = null;

export function setDebugSink(fn: DebugSink | null): void {
	sink = fn;
}

/** 引擎侧调用：没接 sink 时什么都不做，日志失败不影响同步 */
export function debugEvent(event: string, data?: Record<string, unknown>, error?: unknown): void {
	sink?.(event, data, error);
}

export class DebugLog {
	constructor(private readonly options: DebugLogOptions) {}

	async log(event: string, data: Record<string, unknown> = {}, error?: unknown): Promise<void> {
		if (this.options.enabled && !this.options.enabled()) return;
		const line = JSON.stringify({
			at: new Date().toISOString(),
			event,
			...data,
			...(error === undefined ? {} : { error: serializeError(error) }),
		}) + '\n';
		const path = this.options.path;
		const max = this.options.maxBytes ?? 512 * 1024;
		try {
			const exists = await this.options.writer.exists(path);
			let text = exists ? await this.options.writer.read(path) : '';
			if (text.length + line.length > max) {
				await this.options.writer.write(path + '.1', text.slice(-Math.floor(max / 2)));
				text = '';
			}
			await this.options.writer.write(path, text + line);
		} catch (error) {
			// 日志写不进去不能影响同步本身；但也不能完全静默 ——
			// 用户看不到 debug.log 时，控制台里至少要有一行为什么
			console.error('[locally-save] debug.log 写入失败', error);
		}
	}
}
