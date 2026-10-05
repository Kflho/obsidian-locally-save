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
 *   4. 依赖其它开关的谓词（visible / disabled）跟着设置变化
 *   5. 写入控件值时收敛脏数据并存盘
 *   6. settingsFrom（读盘那条路）与字段表用的是同一套收敛规则；老字段的迁移也要对
 *   7. 面板结构：按功能分页、页内分组有标题且不重名
 */
import type { App } from "obsidian";
import { DEFAULT_SETTINGS, ALL_ACTIONS, ALL_FIELDS, LOG_LEVELS, LocallySaveSettingTab, placeholderOf, settingsFrom } from "../src/settings";
import type { PluginSettings } from "../src/settings";
import type LocallySavePlugin from "../src/main";

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
	} as unknown as LocallySavePlugin;
	const tab = new LocallySaveSettingTab({} as App, plugin);
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

function defsOf(tab: LocallySaveSettingTab): AnyDefinition[] {
	return collectLeaves(tab.getSettingDefinitions() as unknown as AnyDefinition[]);
}

function byKey(defs: AnyDefinition[], key: string): AnyDefinition | undefined {
	return defs.find(def => def.control?.key === key);
}

// -------------------------------------------------------------------- 用例
const { tab, settings } = createTab();
// 叶子结点里既有设置项也有动作行（按钮）；动作没有 control，字段覆盖只数设置项
const leaves = defsOf(tab);
const definitions = leaves.filter(def => def.control);
const keys = definitions.map(def => def.control?.key);

// 1. 字段覆盖：不多不少
const expectedKeys = Object.keys(DEFAULT_SETTINGS);
const missing = expectedKeys.filter(key => !keys.includes(key));
const unknown = keys.filter(key => !expectedKeys.includes(key as keyof PluginSettings));
check("声明式设置覆盖全部字段（缺项）", missing, []);
check("声明式设置没有多余字段", unknown, []);
check("每个字段只有一条定义", keys.length, new Set(keys).size === keys.length ? keys.length : -1);

// 2. 名字与下拉框选项
check("每条定义都有名字（含动作行）", leaves.filter(def => !def.name).length, 0);

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

// 4. 依赖其它开关的谓词：0.8.0 砍掉副本通道之后，「删除前先备份」不再跟着
//    「包里删掉的文件，这边也删」变灰 —— 应用包时回收是独立的一件事
//    （强制两档更是必然备份，不看这一项）
check("「删除前先备份」不再依赖别的开关", byKey(definitions, 'deletedToTrash')?.control?.disabled, undefined);
check("删除开关本身不设 disabled", byKey(definitions, 'propagateDeletions')?.control?.disabled, undefined);

// 5. 写入时收敛脏数据并保存
const { tab: writeTab, settings: written, saveCount } = createTab();
await writeTab.setControlValue('logLevel', '不是合法值');
check("下拉脏数据收敛为默认值", written.logLevel, DEFAULT_SETTINGS.logLevel);
await writeTab.setControlValue('logLevel', 'debug');
check("下拉合法值原样写入", written.logLevel, 'debug');
await writeTab.setControlValue('enabled', 'yes');
check("开关脏数据收敛为默认值", written.enabled, DEFAULT_SETTINGS.enabled);
await writeTab.setControlValue('bundleDir', 'D:/我的同步包');
check("普通字段直接写入", written.bundleDir, 'D:/我的同步包');
checkTrue("写入后触发存盘", saveCount() >= 4, `saveSettings 调用 ${saveCount()} 次`);
check("默认设置未被测试污染", settings.bundleDir, DEFAULT_SETTINGS.bundleDir);

// 6. settingsFrom：读盘那条路与字段表共用收敛规则
check("settingsFrom(默认值) 原样返回", settingsFrom(DEFAULT_SETTINGS), DEFAULT_SETTINGS);
check("settingsFrom(null) 得到默认值", settingsFrom(null), DEFAULT_SETTINGS);
check("settingsFrom(缺字段) 补齐默认值", settingsFrom({ enabled: false }), { ...DEFAULT_SETTINGS, enabled: false });
check(
	"settingsFrom(脏数据) 全部收敛",
	settingsFrom({ enabled: 'yes', logLevel: 'xyz', syncAfterSaveDelay: 7, bundleSizeWarnLimit: '999TB', ribbonIcon: null, showStatusBar: 'on' }),
	DEFAULT_SETTINGS,
);
checkTrue("settingsFrom 不把未知字段带进来", !('legacyField' in settingsFrom({ legacyField: 1 })), '多余的键会写回 data.json');
check("日志级别白名单", [...LOG_LEVELS], ['silent', 'error', 'debug']);

// 6b. 迁移：老 data.json 是「保存后同步」开关 + 间隔两项，现在合成一个下拉（0 ＝ 不同步）。
// **关着的时候必须落到 0** —— 不然原本没开自动同步的人，升级后会因为存着的 30 秒突然开始写盘。
check(
	"老配置：保存后同步是关的 → 落到「不同步」",
	settingsFrom({ syncAfterSave: false, syncAfterSaveDelay: 30 }).syncAfterSaveDelay,
	0,
);
check(
	"老配置：开着的话，原来的间隔保留",
	settingsFrom({ syncAfterSave: true, syncAfterSaveDelay: 300 }).syncAfterSaveDelay,
	300,
);
check(
	"已经被删掉的设置项不会残留（读盘时直接丢掉）",
	Object.keys(settingsFrom({ startupNotice: true, greeting: '你好', rememberFingerprints: false, pruneSupersededBundles: false })),
	Object.keys(DEFAULT_SETTINGS),
);
// 更新包大小提醒：以前是自由文本（认 200MB / 500KB / 1GB / 留空 / 0），现在只认下拉里那几个
check("大小提醒：下拉选项外的值收敛到默认", settingsFrom({ bundleSizeWarnLimit: '300MB' }).bundleSizeWarnLimit, '');
check("大小提醒：选项内的值原样保留", settingsFrom({ bundleSizeWarnLimit: '1GB' }).bundleSizeWarnLimit, '1GB');

// 6c. 迁移：0.8.0 砍掉了「同步到本地副本」通道（targetDir / syncDirection 一起删了）。
//     老用户的包原本就放在 `<目标文件夹>/.lsave/bundles` —— 把包目录迁到那个位置，
//     包还在原处，用户不必重新找一遍；自己填过包目录的照旧不动。
check(
	'老配置：只有目标文件夹 → 包目录迁到原来放包的地方',
	settingsFrom({ targetDir: 'D:/备份/我的笔记' }).bundleDir,
	'D:/备份/我的笔记/.lsave/bundles',
);
check(
	'老配置：自己填过包目录 → 照旧，不被目标文件夹覆盖',
	settingsFrom({ targetDir: 'D:/备份/我的笔记', bundleDir: 'E:/同步包' }).bundleDir,
	'E:/同步包',
);
check(
	'老配置：目标文件夹是空白 → 包目录还是空的（界面上提示去填）',
	settingsFrom({ targetDir: '   ' }).bundleDir,
	'',
);
checkTrue(
	'被删掉的老字段不带进内存（也不会写回 data.json）',
	!('targetDir' in settingsFrom({ targetDir: 'D:/x', syncDirection: 'both' })),
	'老字段又冒出来了',
);

// 6d. 「更新包从哪个状态到哪个状态」：留空 ＝ 最新（默认），其余必须是**基准指纹**
//      （不是世代号 —— 世代号两台机器会碰号，用户实测按代选会选错那一份完整副本）。
//      选项是**渲染那一刻**扫包目录算出来的，所以这里只查"至少留着「最新」那一项"。
check('从哪个状态：留空 ＝ 最新', settingsFrom({ changesFromState: '' }).changesFromState, '');
check('从哪个状态：基准指纹原样保留', settingsFrom({ changesFromState: '7a22d790635332a0' }).changesFromState, '7a22d790635332a0');
check('大写也认，统一成小写', settingsFrom({ changesToState: '7A22D790635332A0' }).changesToState, '7a22d790635332a0');
check('到哪个状态：乱填 → 回落成"最新"', settingsFrom({ changesToState: 'abc' }).changesToState, '');
check(
	'位数不对、带别的字符都回落',
	['32', '7a22d790635332a', '7a22d790635332a0ff', ' 7a22d790635332ag'].map(value =>
		settingsFrom({ changesToState: value }).changesToState),
	['', '', '', ''],
);
const fromOptions = byKey(definitions, 'changesFromState')?.control?.options ?? {};
const toOptions = byKey(definitions, 'changesToState')?.control?.options ?? {};
checkTrue('「从哪个状态」至少有「最新」那一项', '' in fromOptions, JSON.stringify(fromOptions));
checkTrue('「到哪个状态」至少有「最新」那一项', '' in toOptions, JSON.stringify(toOptions));
checkTrue(
	'两项的"最新"文案不一样（一个是"最新那份完整副本"，一个是"当前仓库"）',
	fromOptions[''] !== toOptions[''],
	`${fromOptions['']} / ${toOptions['']}`,
);

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

// 8. 动作按钮：字段表里声明的每一条，两条渲染路径都得画得出来
checkTrue("字段表里有动作（按钮）", ALL_ACTIONS.length > 0, "一条动作都没有");
for (const action of ALL_ACTIONS) {
	checkTrue(`动作「${action.name}」有标题`, typeof action.name === "string" && action.name !== "", "");
	checkTrue(`动作「${action.name}」有按钮文字`, typeof action.button === "string" && action.button !== "", "");
	checkTrue(`动作「${action.name}」有 run`, typeof action.run === "function", "");
}

// 声明式那边：动作是带 render 的行，数量与名字都要对得上
const renderRows = leaves.filter(def => typeof (def as { render?: unknown }).render === "function");
check("声明式里的动作行数量与字段表一致", renderRows.length, ALL_ACTIONS.length);
check(
	"声明式里的动作行名字对得上",
	renderRows.map(row => row.name).sort(),
	ALL_ACTIONS.map(action => action.name).sort(),
);

// 旧版 DOM 那条路：整块画一遍不能炸（替身里的按钮回调会真的跑）
try {
	createTab().tab.display();
	checkTrue("旧版 DOM 路径能画出按钮", true, "");
} catch (error) {
	checkTrue("旧版 DOM 路径能画出按钮", false, String(error));
}

// 9. 灰底提示（placeholder）：「同步包文件夹」是**必填**，所以灰字只是给个路径例子 ——
//    0.8.0 之前它有个"留空跟着目标文件夹走"的隐藏默认值，那条通道砍掉之后没有了
const bundleDirField = ALL_FIELDS.find(field => field.key === 'bundleDir');
checkTrue('字段表里有「同步包文件夹」', bundleDirField !== undefined, '没找到');
const bundleDirControl = bundleDirField?.control;
checkTrue(
	'它是个输入框，灰字给一个路径例子',
	bundleDirControl?.type === 'text',
	'类型不对',
);
if (bundleDirControl) {
	check('灰底提示是个例子', placeholderOf(bundleDirControl, DEFAULT_SETTINGS), 'D:\\备份\\同步包');
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
