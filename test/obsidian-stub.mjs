/**
 * 测试用的 obsidian 模块替身。
 *
 * 测试运行器（test/run-tests.mjs）通过 esbuild 的 alias 把 `obsidian` 指到这里，
 * 这样插件真的能 onload 一遍：注册的命令、左侧栏图标、状态栏文字都记下来供断言。
 *
 * 继承自 js_02（note-tidy）的替身，按本插件用到的 API 裁剪过。
 */

/**
 * 测试跑在 Node 里，没有 window；插件用到的只有 setInterval（自动同步的节拍）。
 * 这里有兜底，源码里就不用为了测试写 `typeof window` 判断。
 */
if (typeof globalThis.window === 'undefined') {
	globalThis.window = { setInterval: () => 0, clearInterval: () => {} };
}

/** Obsidian 提供的当前窗口文档（插件用它挂全局拖放） */
if (typeof globalThis.activeDocument === 'undefined') {
	globalThis.activeDocument = makeEl();
}

export class TAbstractFile {}
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}
export class Component {}
export class MarkdownView {}

/** 桌面端适配器替身：插件靠 instanceof 判断"是不是能拿到真实路径" */
export class FileSystemAdapter {
	constructor(basePath = '/vault') {
		this.basePath = basePath;
	}
	getBasePath() {
		return this.basePath;
	}
}

export class Vault {
	constructor() {
		this.adapter = new FileSystemAdapter();
		this.configDir = '.obsidian';
		this.listeners = [];
	}
	on(name, callback) {
		this.listeners.push({ name, callback });
		return { name, callback };
	}
	getName() {
		return 'test-vault';
	}
	/** 测试里手动触发事件（模拟"保存了笔记"） */
	emit(name) {
		for (const listener of this.listeners) {
			if (listener.name === name) listener.callback();
		}
	}
}

export class Workspace {
	constructor() {
		this.readyCallbacks = [];
	}
	onLayoutReady(callback) {
		this.readyCallbacks.push(callback);
	}
}

export class App {
	constructor() {
		this.vault = new Vault();
		this.workspace = new Workspace();
	}
}

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

/** 设置项替身：旧版 DOM 路径与按钮渲染用得到（声明式路径不碰它） */
export class Setting {
	constructor(containerEl) {
		this.containerEl = containerEl;
		this.buttons = [];
	}
	setName() { return this; }
	setDesc() { return this; }
	setHeading() { return this; }
	setDisabled() { return this; }
	addToggle() { return this; }
	addText() { return this; }
	addTextArea() { return this; }
	addDropdown() { return this; }
	/** 按钮：真的执行回调，测试才能核对"按钮文字对不对、点了会不会炸" */
	addButton(build) {
		return this.addComponent(build);
	}
	addExtraButton(build) {
		return this.addComponent(build);
	}
	addComponent(build) {
		const button = {
			text: '',
			cta: false,
			disabled: false,
			setButtonText(text) { this.text = text; return this; },
			setIcon(icon) { this.icon = icon; return this; },
			setCta() { this.cta = true; return this; },
			setDisabled(value) { this.disabled = value; return this; },
			setTooltip() { return this; },
			onClick(handler) { this.handler = handler; return this; },
		};
		build?.(button);
		this.buttons.push(button);
		return this;
	}
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
	const listeners = [];
	return {
		classes,
		text: "",
		children: [],
		listeners,
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
		createSpan(options) {
			return this.createEl("span", options);
		},
		addEventListener(name, handler) { listeners.push({ name, handler }); },
		removeEventListener(name, handler) {
			const index = listeners.findIndex(item => item.name === name && item.handler === handler);
			if (index >= 0) listeners.splice(index, 1);
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
		this.domEvents = [];
		this.protocolHandlers = [];
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
	/** 记下挂过的 DOM 事件：测试要核对"全局拖放到底注册没有" */
	registerDomEvent(el, name, handler, options) {
		const ref = { el, name, handler, options };
		this.domEvents.push(ref);
		return ref;
	}
	/** 记下注册的 obsidian:// 协议 action */
	registerObsidianProtocolHandler(action, handler) {
		this.protocolHandlers.push({ action, handler });
	}
	registerInterval() {}
	register() {}
	async loadData() { return this.stubData; }
	async saveData(data) { this.saved.push(JSON.parse(JSON.stringify(data))); }
}

export const Platform = { isWin: true, isMacOS: false, isLinux: false, isMobile: false, isDesktop: true };

/**
 * 图标清单：真实 Obsidian 里是内置的 Lucide 全集。
 * 测试里给几个名字，让 pickIcon 有机会命中；没命中就用兜底名。
 */
export function getIconIds() {
	return ['refresh-cw', 'package', 'package-open', 'hard-drive', 'archive', 'import', 'save', 'download', 'upload', 'file'];
}

export function normalizePath(p) {
	return p;
}
