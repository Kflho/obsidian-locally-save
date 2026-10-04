/**
 * 设置面板与设置模型的守卫。
 *
 * Obsidian 1.13 起，只要 PluginSettingTab 实现了 getSettingDefinitions()，
 * 设置面板就由这份定义渲染，它同时也是设置搜索的索引来源；display() 退化成
 * 旧版本的兜底（见 obsidian.d.ts 的说明）。两边一旦漏项，用户就会遇到
 * "某个开关不见了"。这里检查：
 *
 *   1. 每个设置字段都有且只有一条声明式定义（多了少了都算失败）
 *   2. 每条定义都有名字；下拉框的默认值必须在自己的选项里
 *   3. 读取控件值返回的是下拉框认得的合法值（data.json 里可能有旧版本脏数据）
 *   4. 依赖其它开关的 visible / disabled 谓词跟着设置变化
 *   5. 写入控件值时收敛脏数据并存盘
 *   6. settingsFrom（读盘那条路）与字段表用的是同一套收敛规则
 *   7. 面板结构：按功能分页、页内分组有标题且不重名
 */
import type { App } from "obsidian";
import { DEFAULT_SETTINGS, LOG_LEVELS, NewPluginSettingTab, settingsFrom } from "../src/settings";
import type { PluginSettings } from "../src/settings";
import type NewPlugin from "../src/main";

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
type AnyDefinition = {
	name?: string;
	heading?: string;
	desc?: unknown;
	type?: string;
	items?: AnyDefinition[];
	visible?: boolean | (() => boolean);
	control?: {
		type: string;
		key: string;
		options?: Record<string, string>;
		defaultValue?: unknown;
		disabled?: boolean | (() => boolean);
	};
};

/** 造一个只带 settings / saveSettings 的插件替身，不需要真的 onload */
function createTab(overrides?: Partial<PluginSettings>) {
	const settings: PluginSettings = { ...DEFAULT_SETTINGS, ...overrides };
	let saves = 0;
	const plugin = {
		settings,
		saveSettings: async () => { saves++; },
	} as unknown as NewPlugin;
	const tab = new NewPluginSettingTab({} as App, plugin);
	return { tab, settings, saveCount: () => saves };
}

/** 展平定义树：分组 / 分页只提供结构，真正的设置项都挂在 control 上 */
function collectLeaves(items: AnyDefinition[], out: AnyDefinition[] = []): AnyDefinition[] {
	for (const item of items) {
		if (item.items) collectLeaves(item.items, out);
		else out.push(item);
	}
	return out;
}

function defsOf(tab: NewPluginSettingTab): AnyDefinition[] {
	return collectLeaves(tab.getSettingDefinitions() as unknown as AnyDefinition[]);
}

function byKey(defs: AnyDefinition[], key: string): AnyDefinition | undefined {
	return defs.find(def => def.control?.key === key);
}

// -------------------------------------------------------------------- 用例
const { tab, settings } = createTab();
const definitions = defsOf(tab);
const keys = definitions.map(def => def.control?.key);

// 1. 字段覆盖：不多不少
const expectedKeys = Object.keys(DEFAULT_SETTINGS);
const missing = expectedKeys.filter(key => !keys.includes(key));
const unknown = keys.filter(key => !expectedKeys.includes(key as keyof PluginSettings));
check("声明式设置覆盖全部字段（缺项）", missing, []);
check("声明式设置没有多余字段", unknown, []);
check("每个字段只有一条定义", keys.length, new Set(keys).size === keys.length ? keys.length : -1);

// 2. 名字与下拉框选项
check("每条定义都有名字", definitions.filter(def => !def.name).length, 0);

for (const def of definitions) {
	const control = def.control;
	if (!control) {
		checkTrue(`设置项 ${def.name} 有控件`, false, `缺少 control：${JSON.stringify(def)}`);
		continue;
	}
	if (control.type !== 'dropdown') continue;
	const options = Object.keys(control.options ?? {});
	checkTrue(
		`${def.name}：默认值在下拉选项里`,
		options.includes(String(control.defaultValue)),
		`默认值 ${String(control.defaultValue)} 不在选项 ${options.join(' / ')} 中`,
	);
	// 3. 读取控件值返回合法选项（旧 data.json 可能是脏数据）
	const value = tab.getControlValue(control.key);
	checkTrue(
		`${def.name}：读到的值在选项里`,
		options.includes(String(value)),
		`读到 ${String(value)}，选项 ${options.join(' / ')}`,
	);
}

// 4. 依赖其它开关的谓词：「提示文案」跟着「加载时弹出提示」走
const greetingVisible = (s: Partial<PluginSettings>) =>
	(defsOf(createTab(s).tab).find(def => def.control?.key === 'greeting')?.visible as () => boolean)();
check("提示文案：默认（开启动提示）显示", greetingVisible({ startupNotice: true }), true);
check("提示文案：关掉启动提示后不显示", greetingVisible({ startupNotice: false }), false);
check("启动提示开关本身不设 visible", byKey(definitions, 'startupNotice')?.visible, undefined);

// 5. 写入时收敛脏数据并保存
const { tab: writeTab, settings: written, saveCount } = createTab();
await writeTab.setControlValue('logLevel', '不是合法值');
check("下拉脏数据收敛为默认值", written.logLevel, DEFAULT_SETTINGS.logLevel);
await writeTab.setControlValue('logLevel', 'debug');
check("下拉合法值原样写入", written.logLevel, 'debug');
await writeTab.setControlValue('enabled', 'yes');
check("开关脏数据收敛为默认值", written.enabled, DEFAULT_SETTINGS.enabled);
await writeTab.setControlValue('greeting', '自定义文案');
check("普通字段直接写入", written.greeting, '自定义文案');
checkTrue("写入后触发存盘", saveCount() >= 4, `saveSettings 调用 ${saveCount()} 次`);
check("默认设置未被测试污染", settings.greeting, DEFAULT_SETTINGS.greeting);

// 6. settingsFrom：读盘那条路与字段表共用收敛规则
check("settingsFrom(默认值) 原样返回", settingsFrom(DEFAULT_SETTINGS), DEFAULT_SETTINGS);
check("settingsFrom(null) 得到默认值", settingsFrom(null), DEFAULT_SETTINGS);
check("settingsFrom(缺字段) 补齐默认值", settingsFrom({ enabled: false }), { ...DEFAULT_SETTINGS, enabled: false });
check(
	"settingsFrom(脏数据) 全部收敛",
	settingsFrom({ enabled: 'yes', logLevel: 'xyz', startupNotice: 1, greeting: 42, ribbonIcon: null, showStatusBar: 'on' }),
	DEFAULT_SETTINGS,
);
checkTrue("settingsFrom 不把未知字段带进来", !('legacyField' in settingsFrom({ legacyField: 1 })), '多余的键会写回 data.json');
check("日志级别白名单", [...LOG_LEVELS], ['silent', 'error', 'debug']);

// 7. 面板结构：按"用户要干什么"分页，页内同类的事挨在一起
const pages = tab.getSettingDefinitions() as unknown as AnyDefinition[];
check("顶层都是页面（按功能分页，不平铺一堆组）",
	pages.map(page => page.type), pages.map(() => 'page'));
check("每个页面都有名字与说明", pages.filter(page => !page.name || !page.desc).length, 0);
check("每个页面都有分组", pages.filter(page => (page.items ?? []).length === 0).length, 0);
for (const page of pages) {
	const headings = (page.items ?? []).map(group => group.heading);
	check(`「${page.name}」页里没有重名的分组`, headings.filter((h, i) => headings.indexOf(h) !== i), []);
	check(`「${page.name}」页里每个分组都有标题`, headings.filter(h => !h), []);
	check(`「${page.name}」页里的分组都标成 group`, (page.items ?? []).filter(item => item.type !== 'group').length, 0);
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
