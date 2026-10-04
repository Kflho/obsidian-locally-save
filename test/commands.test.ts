/**
 * 插件装配的冒烟测试：真的 onload 一遍，看它注册了什么。
 *
 * 命令 ID、左侧栏图标、状态栏文字都是**对用户可见的稳定接口**，
 * 改名 / 漏注册会直接影响用户已经配好的快捷键，所以这里钉死。
 */
import type { App, PluginManifest } from "obsidian";
import { Notice } from "obsidian";
import NewPlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings";

/** 替身 Notice 记下的消息（真实类型里没有 messages，这里显式取一次） */
const noticeLog = (Notice as unknown as { messages: string[] }).messages;

// -------------------------------------------------------------------- 断言
let checks = 0;
const failures: string[] = [];

function checkTrue(name: string, condition: boolean, detail: string): void {
	checks++;
	if (!condition) failures.push(`[断言失败] ${name}\n  ${detail}`);
}

function check(name: string, actual: unknown, expected: unknown): void {
	checks++;
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		failures.push(`[期望不符] ${name}\n  期望 ${JSON.stringify(expected)}\n  实际 ${JSON.stringify(actual)}`);
	}
}

// ---------------------------------------------------------------- 测试替身
const MANIFEST = {
	id: 'new-plugin',
	name: 'New Plugin',
	version: '0.1.0',
	minAppVersion: '1.7.0',
	description: 'test',
	author: 'test',
} as PluginManifest;

type Stub = {
	commands: { id: string; name: string; callback?: () => unknown }[];
	ribbonItems: { icon: string; title: string; callback: () => void; el: { classes: Set<string> } }[];
	statusBarItems: { text: string; classes: Set<string> }[];
	settingTabs: unknown[];
	saved: unknown[];
	stubData: unknown;
};

/** 造一个插件：stubData 就是喂给 loadData() 的 data.json 内容 */
function createPlugin(data: unknown = null): { plugin: NewPlugin; stub: Stub } {
	const plugin = new NewPlugin({} as App, MANIFEST);
	const stub = plugin as unknown as Stub;
	stub.stubData = data;
	return { plugin, stub };
}

// -------------------------------------------------------------------- 用例
// 1. onload 之后注册了哪些东西
noticeLog.length = 0;
const { plugin, stub } = createPlugin({ logLevel: 'silent', greeting: '你好' });
await plugin.onload();

check("命令 ID 是稳定接口", stub.commands.map(c => c.id), ['open-main-modal', 'toggle-enabled']);
check("每条命令都有名字", stub.commands.filter(c => !c.name).length, 0);
check("左侧栏图标", stub.ribbonItems.map(item => item.icon), ['dice']);
check("状态栏占一格", stub.statusBarItems.length, 1);
check("设置面板已挂上", stub.settingTabs.length, 1);
check("加载时按设置弹提示", noticeLog.length, 1);
checkTrue("提示文案来自设置", noticeLog[0]?.includes('你好') === true, `实际：${noticeLog[0]}`);

// 2. 状态栏文字跟着设置走
check("状态栏显示插件名与状态", stub.statusBarItems[0]?.text, 'New Plugin：已启用');
check("默认不隐藏入口", [...(stub.statusBarItems[0]?.classes ?? [])].includes('new-plugin-hidden'), false);

// 3. 命令真的能跑（「启用 / 停用」会改状态，留到下一步单独测）
for (const command of stub.commands.filter(c => c.id !== 'toggle-enabled')) {
	try {
		await command.callback?.();
		checkTrue(`命令 ${command.id} 可执行`, true, '');
	} catch (error) {
		checkTrue(`命令 ${command.id} 可执行`, false, String(error));
	}
}

// 4. 「启用 / 停用」命令会翻转设置并存盘
const toggle = stub.commands.find(c => c.id === 'toggle-enabled');
await toggle?.callback?.();
check("停用后设置翻转", plugin.settings.enabled, false);
check("翻转后存盘", (stub.saved.at(-1) as { enabled: boolean })?.enabled, false);
check("状态栏文字跟着变", stub.statusBarItems[0]?.text, 'New Plugin：已停用');

// 5. 总开关关掉后，入口不干活但会说明原因
noticeLog.length = 0;
await stub.commands.find(c => c.id === 'open-main-modal')?.callback?.();
checkTrue("停用后点入口会说明原因", noticeLog.some(m => m.includes('已停用')), `实际：${noticeLog.join(' / ')}`);

// 6. 设置里的两个开关控制入口显隐
for (const [key, hidden] of [['ribbonIcon', 'ribbon'], ['showStatusBar', 'status']] as const) {
	const { plugin: p, stub: s } = createPlugin({ logLevel: 'silent', startupNotice: false, [key]: false });
	await p.onload();
	const el = hidden === 'ribbon' ? s.ribbonItems[0]?.el : s.statusBarItems[0];
	checkTrue(`关掉 ${key} 后对应入口被隐藏`, el?.classes.has('new-plugin-hidden') === true, '没有加上隐藏类');
}

// 7. 关掉启动提示就不弹通知
noticeLog.length = 0;
const { plugin: quiet } = createPlugin({ logLevel: 'silent', startupNotice: false });
await quiet.onload();
check("关掉启动提示后不弹通知", noticeLog.length, 0);

// 8. data.json 是脏数据也照样能起来（走 settingsFrom 收敛）
const { plugin: dirty } = createPlugin({ enabled: 'yes', logLevel: 42, greeting: null });
await dirty.onload();
check("脏数据回落默认值", dirty.settings.enabled, true);
check("脏日志级别回落默认值", dirty.settings.logLevel, DEFAULT_SETTINGS.logLevel);

console.log(`\n共 ${checks} 次检查，失败 ${failures.length} 项`);
for (const message of failures.slice(0, 10)) {
	console.log("\n❌ " + message);
}
if (failures.length > 10) {
	console.log(`\n…… 其余 ${failures.length - 10} 项失败已省略`);
}
if (failures.length > 0) {
	process.exitCode = 1;
}
