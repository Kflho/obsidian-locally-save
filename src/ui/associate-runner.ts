import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installCommands, uninstallCommands } from './associate';
import type { AssociationCommand } from './associate';

/**
 * 真正去改文件关联。
 *
 * 只动 `HKCU\Software\Classes`（当前用户），**不需要管理员权限**，也不碰系统级设置。
 * 每个命令都是 `reg.exe` 的 add/delete，失败时把 stderr 原样抛给界面看。
 */

const run = promisify(execFile);

async function runCommands(commands: AssociationCommand[]): Promise<void> {
	for (const command of commands) {
		await run(command.file, command.args);
	}
}

/** 装上关联：双击 .lsave → 调起 URI → 插件打开应用对话框 */
export async function applyFileAssociation(vaultName: string): Promise<void> {
	await runCommands(installCommands(process.execPath, vaultName));
}

/** 拆掉关联 */
export async function removeFileAssociation(): Promise<void> {
	await runCommands(uninstallCommands());
}

/** 命令失败时给一句人话（reg.exe 的报错常在 stderr 里） */
export function describeCommandError(error: unknown): string {
	if (typeof error === 'object' && error !== null) {
		const stderr = (error as { stderr?: unknown }).stderr;
		if (typeof stderr === 'string' && stderr.trim() !== '') return stderr.trim();
	}
	return error instanceof Error ? error.message : String(error);
}
