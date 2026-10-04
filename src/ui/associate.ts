import { Platform } from 'obsidian';
import { PROTOCOL_ACTION } from './protocol';

/**
 * 让"双击 .lsave 就用 Obsidian 打开并应用"。
 *
 * Windows 上不需要管理员权限：写 `HKCU\Software\Classes` 就够了。
 * 别的平台各有各的做法（macOS 要写 LaunchServices、Linux 看桌面环境），
 * 这里只做 Windows，其他平台在界面上给出手工指引。
 *
 * 关键点：关联命令必须**调起 URI**（`obsidian://locally-save?path=%1`），
 * 而不是把文件路径直接丢给 `Obsidian.exe` —— 后者到不了插件（原因见 protocol.ts）。
 */

/** 我们注册的 ProgID */
const PROGID = 'LocallySave.Bundle';
const EXT_KEY = 'HKCU\\Software\\Classes\\.lsave';
const PROGID_KEY = `HKCU\\Software\\Classes\\${PROGID}`;
const COMMAND_KEY = `${PROGID_KEY}\\shell\\open\\command`;

export interface AssociationCommand {
	/** 要执行的程序 */
	file: string;
	args: string[];
}

/** 当前平台能不能一键设置关联 */
export function associationSupported(): boolean {
	return Platform.isWin;
}

/**
 * 调起 URI 的命令行。
 *
 * `%1` 由 Windows 换成被双击的文件路径 —— 所以这里**必须写裸的 `%1`**，
 * 不能过 `encodeURIComponent`（那会变成 `%251`，系统就换不出路径了）。
 * 路径本身不需要编码：`normalizeProtocolPath` 两种都认。
 */
export function openCommandLine(execPath: string): string {
	return `"${execPath}" "obsidian://${PROTOCOL_ACTION}?path=%1"`;
}

/** 装上关联要跑的命令 */
export function installCommands(execPath: string): AssociationCommand[] {
	return [
		{ file: 'reg.exe', args: ['add', EXT_KEY, '/ve', '/d', PROGID, '/f'] },
		{ file: 'reg.exe', args: ['add', PROGID_KEY, '/ve', '/d', 'Locally Save 同步包', '/f'] },
		{ file: 'reg.exe', args: ['add', COMMAND_KEY, '/ve', '/d', openCommandLine(execPath), '/f'] },
	];
}

/** 拆掉关联要跑的命令 */
export function uninstallCommands(): AssociationCommand[] {
	return [
		{ file: 'reg.exe', args: ['delete', EXT_KEY, '/f'] },
		{ file: 'reg.exe', args: ['delete', PROGID_KEY, '/f'] },
	];
}

/** 读一下现在 `.lsave` 关联到哪儿（用来提示"会覆盖你现有的关联"） */
export function queryCurrentCommand(): AssociationCommand {
	return { file: 'reg.exe', args: ['query', EXT_KEY, '/ve'] };
}
