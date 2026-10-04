/**
 * 插件装配的冒烟测试：真的 onload 一遍，看它注册了什么。
 *
 * 命令 ID 是**对用户可见的稳定接口**（快捷键认它），改名 / 漏注册会直接
 * 让用户配好的快捷键失效，所以这里钉死。
 */
import type { PluginManifest } from "obsidian";
import { App, Notice } from "obsidian";
import LocallySavePlugin from "../src/main";

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
	id: 'locally-save',
	name: 'Locally Save',
	version: '0.1.0',
	minAppVersion: '1.7.0',
	description: 'test',
	author: 'test',
	dir: '.obsidian/plugins/locally-save',
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
function createPlugin(data: unknown = null): { plugin: LocallySavePlugin; stub: Stub } {
	const plugin = new LocallySavePlugin(new App(), MANIFEST);
	const stub = plugin as unknown as Stub;
	stub.stubData = data;
	return { plugin, stub };
}

// -------------------------------------------------------------------- 用例
// 1. onload 之后注册了哪些东西
noticeLog.length = 0;
const { plugin, stub } = createPlugin({ logLevel: 'silent', greeting: '你好' });
await plugin.onload();

check("命令 ID 是稳定接口", stub.commands.map(c => c.id), [
	'sync-now',
	'sync-preview',
	'upload-to-copy',
	'download-from-copy',
	'export-bundle',
	'apply-bundle',
	'toggle-enabled',
]);
check("每条命令都有名字", stub.commands.filter(c => !c.name).length, 0);
check("左侧栏图标", stub.ribbonItems.map(item => item.icon), ['hard-drive']);
check("状态栏占一格", stub.statusBarItems.length, 1);
check("状态栏初始文案", stub.statusBarItems[0]?.text, '尚未同步');
check("设置面板已挂上", stub.settingTabs.length, 1);
check("加载时按设置弹提示", noticeLog.length, 1);
checkTrue("提示文案来自设置", noticeLog[0]?.includes('你好') === true, `实际：${noticeLog[0]}`);

// 2. 路径解析：状态文件放在插件目录里，跟 data.json 做邻居
check("仓库根路径来自适配器", plugin.vaultRoot(), '/vault');
checkTrue(
	"状态文件放在插件目录里",
	plugin.stateFile().includes('locally-save/sync-state.json'),
	plugin.stateFile(),
);

// 3. 没设置目标文件夹时，报错要说得像人话（而不是抛个栈）
let message = '';
try {
	await plugin.runSync({ dryRun: true });
} catch (error) {
	message = error instanceof Error ? error.message : String(error);
}
checkTrue("没设目标文件夹时提示去设置里填", message.includes('目标文件夹'), message);

// 4. 同步串行：同一时间只跑一轮
const first = plugin.runSync({ dryRun: true }).catch(() => null);
const second = await plugin.runSync({ dryRun: true });
check("上一轮没跑完时直接返回 null", second, null);
await first;

// 5. 「启用 / 停用」命令会翻转设置并存盘
const toggle = stub.commands.find(c => c.id === 'toggle-enabled');
await toggle?.callback?.();
check("停用后设置翻转", plugin.settings.enabled, false);
check("翻转后存盘", (stub.saved.at(-1) as { enabled: boolean })?.enabled, false);

// 6. 总开关关掉后，入口不干活但会说明原因
noticeLog.length = 0;
check("停用时 isActive 为假", plugin.isActive(), false);
checkTrue("并且说明原因", noticeLog.some(m => m.includes('已停用')), `实际：${noticeLog.join(' / ')}`);

// 7. 关掉启动提示就不弹通知
noticeLog.length = 0;
const { plugin: quiet } = createPlugin({ logLevel: 'silent', startupNotice: false });
await quiet.onload();
check("关掉启动提示后不弹通知", noticeLog.length, 0);

// 8. data.json 是脏数据也照样能起来（走 settingsFrom 收敛）
const { plugin: dirty } = createPlugin({ enabled: 'yes', logLevel: 42, syncDirection: 'sideways' });
await dirty.onload();
check("脏数据回落默认值", dirty.settings.enabled, true);
check("脏日志级别回落默认值", dirty.settings.logLevel, 'error');
check("脏同步方向回落默认值", dirty.settings.syncDirection, 'both');

// 9. 入口显隐跟着设置走
for (const [key, target] of [['ribbonIcon', 'ribbon'], ['showStatusBar', 'status']] as const) {
	const { plugin: p, stub: s } = createPlugin({ logLevel: 'silent', startupNotice: false, [key]: false });
	await p.onload();
	const el = target === 'ribbon' ? s.ribbonItems[0]?.el : s.statusBarItems[0];
	checkTrue(`关掉 ${key} 后对应入口被隐藏`, el?.classes.has('locally-save-hidden') === true, '没有加上隐藏类');
}

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
