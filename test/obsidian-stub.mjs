/**
 * 测试用的 obsidian 模块替身。
 *
 * 测试运行器（test/run-tests.mjs）通过 esbuild 的 alias 把 `obsidian` 指到这里，
 * 这样插件真的能 onload 一遍：注册的命令、左侧栏图标、状态栏文字都记下来供断言。
 *
 * 继承自 js_02（note-tidy）的替身，按本插件用到的 API 裁剪过。
 */

export class TAbstractFile {}
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}
export class App {}
export class Component {}
export class MarkdownView {}

/** 弹窗替身：open() 后依次调用 onOpen()，与真实行为一致（便于测 onOpen 不炸） */
export class Modal {
	constructor(app) {
		this.app = app;
		this.contentEl = makeEl();
		this.opened = false;
	}
	open() {
		this.opened = true;
		this.onOpen?.();
	}
	close() {
		this.opened = false;
		this.onClose?.();
	}
}

/** 通知替身：只记录消息，便于断言"操作结果有提示" */
export class Notice {
	constructor(message) {
		this.message = message;
		Notice.messages.push(message);
	}
}
Notice.messages = [];

/** 设置项替身：声明式路径用不到它，这里只为 import 能成立 */
export class Setting {
	constructor(containerEl) {
		this.containerEl = containerEl;
	}
	setName() { return this; }
	setDesc() { return this; }
	setHeading() { return this; }
	setDisabled() { return this; }
	addToggle() { return this; }
	addText() { return this; }
	addTextArea() { return this; }
	addDropdown() { return this; }
}

export class PluginSettingTab {
	constructor(app, plugin) {
		this.app = app;
		this.plugin = plugin;
		this.containerEl = makeEl();
	}
}

/** 造一个只有本插件用到的那几个方法的元素替身（并记下写入的文字 / 类名） */
function makeEl() {
	const classes = new Set();
	return {
		classes,
		text: "",
		children: [],
		empty() { this.children = []; },
		createEl(tag, options) {
			const child = makeEl();
			child.tag = tag;
			child.text = options?.text ?? "";
			child.cls = options?.cls ?? "";
			this.children.push(child);
			return child;
		},
		createDiv(options) {
			return this.createEl("div", options);
		},
		setText(text) { this.text = text; },
		addClass(name) { classes.add(name); },
		removeClass(name) { classes.delete(name); },
		toggleClass(name, on) {
			if (on === false) classes.delete(name);
			else classes.add(name);
		},
		setAttribute() {},
	};
}

/**
 * 插件基类替身：记录 addCommand / addRibbonIcon / addStatusBarItem / addSettingTab 的结果。
 *
 * `stubData` 是喂给 loadData() 的 `data.json` 内容（测试里先设它再 onload），
 * `saved` 收集 saveData() 存下去的快照。
 */
export class Plugin {
	constructor(app, manifest) {
		this.app = app;
		this.manifest = manifest;
		this.commands = [];
		this.settingTabs = [];
		this.statusBarItems = [];
		this.ribbonItems = [];
		this.events = [];
		this.stubData = null;
		this.saved = [];
	}
	addCommand(command) {
		this.commands.push(command);
		return command;
	}
	addStatusBarItem() {
		const el = makeEl();
		this.statusBarItems.push(el);
		return el;
	}
	addRibbonIcon(icon, title, callback) {
		const el = makeEl();
		this.ribbonItems.push({ icon, title, callback, el });
		return el;
	}
	addSettingTab(tab) {
		this.settingTabs.push(tab);
	}
	registerEvent(event) {
		this.events.push(event);
	}
	registerDomEvent() {}
	registerInterval() {}
	register() {}
	async loadData() { return this.stubData; }
	async saveData(data) { this.saved.push(JSON.parse(JSON.stringify(data))); }
}

export const Platform = { isWin: true, isMacOS: false, isLinux: false, isMobile: false, isDesktop: true };

export function normalizePath(p) {
	return p;
}
