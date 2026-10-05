/**
 * 插件装配的冒烟测试：真的 onload 一遍，看它注册了什么。
 *
 * 命令 ID 是**对用户可见的稳定接口**（快捷键认它），改名 / 漏注册会直接
 * 让用户配好的快捷键失效，所以这里钉死。
 */
import type { PluginManifest } from "obsidian";
import { App, Modal, Notice } from "obsidian";
import LocallySavePlugin from "../src/main";
import { exportBundlesNow } from "../src/ui/actions";
import { ApplyBundleModal, ExportBundleModal } from "../src/ui/bundle-modal";
import { BundleManagerModal } from "../src/ui/manage-modal";

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
const { plugin, stub } = createPlugin({ logLevel: 'silent' });
await plugin.onload();

check("命令 ID 是稳定接口", stub.commands.map(c => c.id), [
	'sync-now',
	'sync-preview',
	'upload-to-copy',
	'download-from-copy',
	'export-bundle',
	'apply-bundle',
	'manage-bundles',
	'bundle-log',
	'toggle-enabled',
]);
check("每条命令都有名字", stub.commands.filter(c => !c.name).length, 0);
check(
	"左侧栏三个图标：留包 / 导出包 / 应用包",
	stub.ribbonItems.map(item => item.icon),
	['archive', 'package', 'package-open'],
);
checkTrue(
	"每个左侧栏图标都有说明文字",
	stub.ribbonItems.every(item => item.title.includes('Locally Save')),
	stub.ribbonItems.map(item => item.title).join(' | '),
);
check("状态栏占一格", stub.statusBarItems.length, 1);
check("状态栏初始文案", stub.statusBarItems[0]?.text, '尚未留包');
check("设置面板已挂上", stub.settingTabs.length, 1);
// 启动**不弹通知**：以前那一条"插件已加载（v0.6.0）"没有任何信息量，设置项连它一起删了
check("加载时不弹通知", noticeLog.length, 0);

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

// 2d. 打开包时把 Obsidian 窗口**叫到前台**（窗口缩在别的窗口后面时，用户会以为"点了没反应"）。
// 刻意**不再动窗口大小 / 位置**：那个"打开包时最大化窗口"的开关已经删掉 ——
// 进度有状态栏，插件不该替用户决定窗口多大。这两条断言就是盯着"别再动它"。
const stubWindow = window as unknown as {
	focused?: number;
	resizedTo?: [number, number];
	movedTo?: [number, number];
};
check('没去动窗口大小与位置', [stubWindow.resizedTo, stubWindow.movedTo], [undefined, undefined]);
const focusBefore = stubWindow.focused ?? 0;
new ApplyBundleModal(new App(), plugin).open();
checkTrue('打开包时把窗口叫到前台', (stubWindow.focused ?? 0) > focusBefore, `focus 调用次数没变：${focusBefore}`);

// 2e. 进度更新要节流：每个文件写一次 DOM，一万个文件就够把界面拖顿
const barEl = stub.statusBarItems[0] as { text: string };
plugin.statusBar.showProgress({ done: 1, total: 100, path: 'a.md' });
const firstTick = barEl.text;
plugin.statusBar.showProgress({ done: 2, total: 100, path: 'b.md' });
check('接得太近的两次进度只写一次 DOM', barEl.text === firstTick, true);
plugin.statusBar.showProgress({ done: 100, total: 100, path: 'z.md' });
check('最后那一次一定要写（否则进度永远停在 1/100）', barEl.text, '处理中 100/100');
plugin.statusBar.showProgress({ done: 100, total: 100, path: 'z.md', label: '导出中' });
check('动词由调用方给：导出时不该写着"处理中"', barEl.text, '导出中 100/100');
plugin.statusBar.showProgress(null);
checkTrue('收工后回到结果文案', barEl.text !== '导出中 100/100', barEl.text);

// 2f. 三个同步包弹窗都开一遍：包列表是共用组件，谁的那套 DOM 写坏了都要当场炸出来
// （还没配「同步包文件夹」时列表只显示一句提示，不会碰磁盘）
const modalInstances = (Modal as unknown as { instances: { opened: boolean }[] }).instances;
const openedBefore = modalInstances.length;
new ExportBundleModal(new App(), plugin).open();
new BundleManagerModal(new App(), plugin).open();
new ApplyBundleModal(new App(), plugin, 'D:\\传输\\某台机器-full-20261004-153000-abc123.lsave').open();
check('导出 / 管理 / 导入弹窗都能打开', modalInstances.length - openedBefore, 3);
check(
	'弹窗都是"打开"状态（onOpen 真的跑到底了）',
	modalInstances.slice(openedBefore).every(item => item.opened),
	true,
);

// 3. 留包的两道门：两个开关都没开时说清去哪一页选；开了却没填包目录时说清去哪填
noticeLog.length = 0;
await exportBundlesNow(plugin);
checkTrue(
	"两个留包开关都没开时说清去哪一页选",
	noticeLog.some(m => m.includes('留更新包') && m.includes('留完整包')),
	noticeLog.join(' / '),
);

const { plugin: noDir } = createPlugin({ logLevel: 'silent', autoExportChanges: true });
await noDir.onload();
noticeLog.length = 0;
await exportBundlesNow(noDir);
checkTrue("开了留包却没填包目录时提示去设置里填", noticeLog.some(m => m.includes('同步包文件夹')), noticeLog.join(' / '));

// 4. 留包串行：同一时间只跑一轮（标记挂在插件上，定时留包的节拍也看它）
noticeLog.length = 0;
plugin.bundleBusy = true;
await exportBundlesNow(plugin, '测试留包');
checkTrue("上一轮没跑完时不重入、如实说一句", noticeLog.some(m => m.includes('还没跑完')), noticeLog.join(' / '));
check("忙碌标记不会被这一轮误清", plugin.bundleBusy, true);
plugin.bundleBusy = false;

// 5. 「启用 / 停用」命令会翻转设置并存盘
const toggle = stub.commands.find(c => c.id === 'toggle-enabled');
await toggle?.callback?.();
check("停用后设置翻转", plugin.settings.enabled, false);
check("翻转后存盘", (stub.saved.at(-1) as { enabled: boolean })?.enabled, false);

// 6. 总开关关掉后，入口不干活但会说明原因
noticeLog.length = 0;
check("停用时 isActive 为假", plugin.isActive(), false);
checkTrue("并且说明原因", noticeLog.some(m => m.includes('已停用')), `实际：${noticeLog.join(' / ')}`);

// 7. 启用 / 停用的入口：停用时命令不让跑，并说明原因
noticeLog.length = 0;
const { plugin: quiet } = createPlugin({ logLevel: 'silent' });
await quiet.onload();
check("正常加载不弹提示", noticeLog.length, 0);

// 8. data.json 是脏数据也照样能起来（走 settingsFrom 收敛）
const { plugin: dirty } = createPlugin({ enabled: 'yes', logLevel: 42, bundleSizeWarnLimit: '999TB' });
await dirty.onload();
check("脏数据回落默认值", dirty.settings.enabled, true);
check("脏日志级别回落默认值", dirty.settings.logLevel, 'error');
check("脏的大小提醒回落默认值", dirty.settings.bundleSizeWarnLimit, '');

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
	const { plugin: p, stub: s } = createPlugin({ logLevel: 'silent', [key]: false });
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
