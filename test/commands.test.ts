/**
 * 插件装配的冒烟测试：真的 onload 一遍，看它注册了什么。
 *
 * 命令 ID 是**对用户可见的稳定接口**（快捷键认它），改名 / 漏注册会直接
 * 让用户配好的快捷键失效，所以这里钉死。
 */
import type { PluginManifest } from "obsidian";
import { App, Notice } from "obsidian";
import LocallySavePlugin from "../src/main";
import { ApplyBundleModal } from "../src/ui/bundle-modal";

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
	domEvents: { name: string; options?: { capture?: boolean } }[];
	protocolHandlers: { action: string; handler: (params: Record<string, string>) => void }[];
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
check(
	"左侧栏三个图标：同步 / 导出包 / 应用包",
	stub.ribbonItems.map(item => item.icon),
	['refresh-cw', 'package', 'package-open'],
);
checkTrue(
	"每个左侧栏图标都有说明文字",
	stub.ribbonItems.every(item => item.title.includes('Locally Save')),
	stub.ribbonItems.map(item => item.title).join(' | '),
);
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

// 2b. 全局拖放：onload 时挂了窗口级处理，而且要挂在捕获阶段
// （不挂 dragover 的话浏览器根本不派发 drop；不在捕获阶段就抢不到 .lsave）
checkTrue(
	"注册了窗口级 dragover（否则 drop 不会派发）",
	stub.domEvents.some(event => event.name === 'dragover'),
	JSON.stringify(stub.domEvents.map(event => event.name)),
);
const dropHandlers = stub.domEvents.filter(event => event.name === 'drop');
checkTrue("注册了窗口级 drop", dropHandlers.length > 0, '没注册');
checkTrue(
	"drop 挂在捕获阶段（要抢在 Obsidian 把包当附件导入之前）",
	dropHandlers.every(event => event.options?.capture === true),
	JSON.stringify(dropHandlers.map(event => event.options)),
);

// 2c. 用 Obsidian 直接打开包：注册了 obsidian:// 协议，而且点了不炸
check('注册了协议 action', stub.protocolHandlers.map(item => item.action), ['locally-save']);
for (const item of stub.protocolHandlers) {
	try {
		item.handler({ path: 'D:\\传输\\a.lsave' });
		item.handler({});
		checkTrue(`协议 ${item.action} 能处理（带路径 / 不带路径）`, true, '');
	} catch (error) {
		checkTrue(`协议 ${item.action} 能处理`, false, String(error));
	}
}

// 2d. 打开包时把 **Obsidian 窗口本身**顶到最大 + 叫到前台
// （不是把对话框撑满窗口 —— 用户要的是窗口最大化）
const stubWindow = window as unknown as {
	require?: unknown;
	resizedTo?: [number, number];
	movedTo?: [number, number];
};
check('默认会把窗口拉满（走 @electron/remote 不可用时的兜底路径）', stubWindow.resizedTo, [1920, 1080]);
check('顺便挪到左上角', stubWindow.movedTo, [0, 0]);

// 有 @electron/remote 时优先用它（更规矩：走 BrowserWindow.maximize）
const fakeWindowState = { maximized: false, calls: 0 };
stubWindow.require = (name: string) => {
	check('只问 @electron/remote', name, '@electron/remote');
	return {
		getCurrentWindow: () => ({
			isMaximized: () => fakeWindowState.maximized,
			isFullScreen: () => false,
			isMinimized: () => false,
			maximize: () => { fakeWindowState.calls++; fakeWindowState.maximized = true; },
		}),
	};
};
new ApplyBundleModal(new App(), plugin).open();
check('走 BrowserWindow.maximize()', fakeWindowState.calls, 1);
new ApplyBundleModal(new App(), plugin).open();
check('已经最大化了就不再点一次（免得窗口来回跳）', fakeWindowState.calls, 1);

// 关掉开关：不碰窗口，但仍然只把 Obsidian 叫到前台
fakeWindowState.calls = 0;
plugin.settings.bundleWindowMaximize = false;
stubWindow.resizedTo = undefined;
new ApplyBundleModal(new App(), plugin).open();
check('关掉之后不动窗口', [fakeWindowState.calls, stubWindow.resizedTo], [0, undefined]);
plugin.settings.bundleWindowMaximize = true;
delete stubWindow.require;

// 2e. 进度更新要节流：每个文件写一次 DOM，一万个文件就够把界面拖顿
const barEl = stub.statusBarItems[0] as { text: string };
plugin.statusBar.showProgress({ done: 1, total: 100, path: 'a.md' });
const firstTick = barEl.text;
plugin.statusBar.showProgress({ done: 2, total: 100, path: 'b.md' });
check('接得太近的两次进度只写一次 DOM', barEl.text === firstTick, true);
plugin.statusBar.showProgress({ done: 100, total: 100, path: 'z.md' });
check('最后那一次一定要写（否则进度永远停在 1/100）', barEl.text, '同步中 100/100');
plugin.statusBar.showProgress(null);
checkTrue('收工后回到结果文案', barEl.text !== '同步中 100/100', barEl.text);

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

// 9. 左侧栏图标点了不能炸（导出 / 应用那两个会开对话框）
for (const item of stub.ribbonItems) {
	try {
		item.callback();
		checkTrue(`左侧栏「${item.title}」能点`, true, '');
	} catch (error) {
		checkTrue(`左侧栏「${item.title}」能点`, false, String(error));
	}
}

// 10. 入口显隐跟着设置走：三个图标 + 状态栏各管各的
const ribbonTargets = [
	['ribbonSyncIcon', 'ribbon', 0],
	['ribbonExportIcon', 'ribbon', 1],
	['ribbonApplyIcon', 'ribbon', 2],
	['showStatusBar', 'status', 0],
] as const;
for (const [key, target, index] of ribbonTargets) {
	const { plugin: p, stub: s } = createPlugin({ logLevel: 'silent', startupNotice: false, [key]: false });
	await p.onload();
	const el = target === 'ribbon' ? s.ribbonItems[index]?.el : s.statusBarItems[index];
	checkTrue(`关掉 ${key} 后对应入口被隐藏`, el?.classes.has('locally-save-hidden') === true, '没有加上隐藏类');
	// 关掉一个入口，其余入口（三个图标 + 状态栏）都不该被连累
	const others = [
		...s.ribbonItems.map((item, i) => ({
			title: item.title,
			hidden: item.el.classes.has('locally-save-hidden'),
			shouldBeOff: target === 'ribbon' && i === index,
		})),
		...s.statusBarItems.map((item, i) => ({
			title: `状态栏${i}`,
			hidden: item.classes.has('locally-save-hidden'),
			shouldBeOff: target === 'status' && i === index,
		})),
	].filter(entry => !entry.shouldBeOff);
	checkTrue(
		`关掉 ${key} 不影响别的入口`,
		others.every(entry => !entry.hidden),
		`被连累的：${others.filter(entry => entry.hidden).map(entry => entry.title).join(' / ')}`,
	);
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
