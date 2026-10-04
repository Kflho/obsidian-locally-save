/**
 * 「用 Obsidian 直接打开同步包」这条通路。
 *
 * 两件事要钉住：
 * 1. 协议里的路径既要认 URL 编码的（我们自己生成的链接），也要认系统文件关联塞进来的
 *    原始 Windows 路径（反斜杠、带引号、带空格）；
 * 2. 文件关联**必须调起 URI**，不能把路径直接丢给 Obsidian.exe —— 后者到不了插件。
 */
import { bundleLink, normalizeProtocolPath, PROTOCOL_ACTION } from "../src/ui/protocol";
import { installCommands, openCommandLine, uninstallCommands, associationSupported } from "../src/ui/associate";

// -------------------------------------------------------------------- 断言
let checks = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
	checks++;
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		failures.push(`[期望不符] ${name}\n  期望 ${JSON.stringify(expected)}\n  实际 ${JSON.stringify(actual)}`);
	}
}

function checkTrue(name: string, condition: boolean, detail: string): void {
	checks++;
	if (!condition) failures.push(`[断言失败] ${name}\n  ${detail}`);
}

// -------------------------------------------------------------------- 协议路径
// 我们自己生成的链接是编码过的
check('解码 URL 编码的路径', normalizeProtocolPath('D%3A%5C%E5%A4%87%E4%BB%BD%5Ca.lsave'), 'D:\\备份\\a.lsave');
// 系统文件关联塞进来的 `%1` 是原始路径
check('原始 Windows 路径原样用', normalizeProtocolPath('D:\\备份\\a.lsave'), 'D:\\备份\\a.lsave');
check('带空格也认', normalizeProtocolPath('C:\\My Notes\\a.lsave'), 'C:\\My Notes\\a.lsave');
check('两头带引号也认', normalizeProtocolPath('"D:\\a.lsave"'), 'D:\\a.lsave');
check('两边空白去掉', normalizeProtocolPath('  D:\\a.lsave  '), 'D:\\a.lsave');
// 路径里带 % 之类不是合法编码的字符时不能炸
check('不是合法编码时原样返回', normalizeProtocolPath('D:\\100%\\a.lsave'), 'D:\\100%\\a.lsave');

// -------------------------------------------------------------------- 链接
check('链接用了约定的 action', bundleLink('D:\\a.lsave').startsWith(`obsidian://${PROTOCOL_ACTION}?`), true);
checkTrue(
	'链接里的路径是编码过的（空格、反斜杠都不会破坏 URI）',
	bundleLink('C:\\My Notes\\a.lsave').includes('bundle=C%3A%5CMy%20Notes%5Ca.lsave'),
	bundleLink('C:\\My Notes\\a.lsave'),
);
checkTrue(
	'**不用 `path` 当参数名** —— Obsidian 会拿它去找"哪个 vault 包含这个路径"，我们的包在仓库外，会直接报 vault 找不到',
	!bundleLink('D:\\a.lsave').includes('path='),
	bundleLink('D:\\a.lsave'),
);
checkTrue(
	'带上 vault 参数（Obsidian 靠它决定把 URI 交给哪个 vault）',
	bundleLink('D:\\a.lsave', '我的笔记').includes('vault=%E6%88%91%E7%9A%84%E7%AC%94%E8%AE%B0'),
	bundleLink('D:\\a.lsave', '我的笔记'),
);
checkTrue(
	'链接能被解析回来',
	decodeURIComponent(bundleLink('D:\\备份\\a.lsave').split('bundle=')[1] ?? '') === 'D:\\备份\\a.lsave',
	'',
);

// -------------------------------------------------------------------- 文件关联
checkTrue(
	'关联命令调起的是 URI，而不是把路径丢给 Obsidian.exe',
	openCommandLine('C:\\App\\Obsidian.exe', '我的笔记').includes('obsidian://'),
	openCommandLine('C:\\App\\Obsidian.exe', '我的笔记'),
);
checkTrue(
	'而且带上了裸的 %1（编码成 %251 的话系统就换不出路径了）',
	openCommandLine('C:\\App\\Obsidian.exe', 'v').includes('bundle=%1"'),
	openCommandLine('C:\\App\\Obsidian.exe', 'v'),
);
checkTrue(
	'关联里也带 vault（少了它 Obsidian 会报 "Unable to find a vault for the URL"）',
	openCommandLine('C:\\App\\Obsidian.exe', '我的笔记').includes('vault='),
	openCommandLine('C:\\App\\Obsidian.exe', '我的笔记'),
);
checkTrue(
	'可执行文件路径带引号（Program Files 里有空格）',
	openCommandLine('C:\\Program Files\\Obsidian\\Obsidian.exe', 'v').startsWith('"C:\\Program Files'),
	'',
);

const install = installCommands('C:\\App\\Obsidian.exe', '我的笔记');
checkTrue('装关联动了三处（扩展名 / ProgID / 打开命令）', install.length === 3, `实际 ${install.length}`);
checkTrue('全都走 HKCU（不需要管理员权限）', install.every(c => c.args.some(a => a.startsWith('HKCU\\'))), '');
checkTrue('用的是 reg.exe', install.every(c => c.file === 'reg.exe'), '');
const uninstall = uninstallCommands();
check('拆关联删两处', uninstall.length, 2);
checkTrue(
	'拆的时候只删我们自己的 ProgID，不碰别人的',
	uninstall.every(c => c.args.some(a => a.includes('.lsave') || a.includes('LocallySave.Bundle'))),
	'',
);
checkTrue('平台判断有返回值', typeof associationSupported() === 'boolean', '');

console.log(`\n共 ${checks} 次检查，失败 ${failures.length} 项`);
for (const message of failures.slice(0, 10)) console.log("\n❌ " + message);
if (failures.length > 0) process.exitCode = 1;
