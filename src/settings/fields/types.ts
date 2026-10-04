import type LocallySavePlugin from '../../main';
import type { PluginSettings } from '../model';

/**
 * 设置项字段表的类型（见同目录下的数据文件）。
 *
 * 这张表是设置面板的**单一数据源**：Obsidian 1.13+ 的声明式定义与
 * 1.13 以下的手写 DOM 都由它生成，加一个设置项只改一处。
 *
 * 这套骨架继承自 js_02（note-tidy），区别是把设置类型抽成了泛型参数 `T`，
 * 换插件时只需换 `T`（默认就是本插件的 PluginSettings）。
 */

/** 控件形态：决定渲染成下拉框 / 开关 / 输入框，也决定声明式定义里的 control.type */
export type ControlSpec =
	/** 开关 */
	| { type: 'toggle' }
	/** 单行输入框 */
	| { type: 'text'; placeholder: string }
	/** 多行输入框（一行的列表用它，如"每行一个菜单项"） */
	| { type: 'textarea'; placeholder: string; rows: number }
	/** 下拉框：取值 → 显示文案 */
	| { type: 'dropdown'; options: Record<string, string> };

/** 一条设置项 */
export interface FieldSpec<T = PluginSettings> {
	/** 设置字段名，同时也是声明式定义的 control.key 与 getControlValue/setControlValue 的 key */
	key: keyof T & string;
	/** 面板上显示的名字 */
	name: string;
	/** 说明文字（旧版 DOM 走 setDesc，声明式走 desc） */
	desc?: string;
	control: ControlSpec;
	/**
	 * 取值收敛：data.json 里可能是旧版本没有的字段或手工改坏的值。
	 * 读（getControlValue）与写（setControlValue）都过这一套，免得下拉框显示成空白。
	 */
	coerce?: (value: unknown) => unknown;
	/**
	 * 改变后整块重画面板。
	 *
	 * 旧版 DOM 需要它：这一项会影响**别的项**的显示或可用状态，
	 * 不重画就看不到变化（例如关掉「启动时提示」后「提示文案」要消失）。
	 * 声明式走 visible / disabled，由 Obsidian 自己重新求值，用不上这个标记。
	 */
	rerenderOnChange?: boolean;
	/** 声明式：这一项当前是否显示（旧版 DOM 直接照此跳过渲染） */
	visible?: (settings: T) => boolean;
	/** 声明式：这一项当前是否可用（旧版 DOM 走 setDisabled） */
	disabled?: (settings: T) => boolean;
}

/** 一节里的一小组（面板上的次级小标题，如「基本」「启动提示」） */
export interface FieldGroup<T = PluginSettings> {
	heading: string;
	fields: FieldSpec<T>[];
	/** 这一组底下的按钮（可选，排在设置项后面） */
	actions?: ActionSpec<T>[];
}

/**
 * 一个「动作」：不是设置项，而是一行按钮（导出同步包、打开包、看说明这类）。
 *
 * 单独一类而不是塞进 FieldSpec：动作没有 key、不存进 data.json，
 * 也不参与"每个设置字段都必须有定义"的那套核对。
 */
export interface ActionSpec<T = PluginSettings> {
	/** 行标题。声明式定义里 name 是必填的（设置搜索要用），所以这里也必须给 */
	name: string;
	/** 行说明 */
	desc?: string;
	/** 按钮上的字 */
	button: string;
	/** 主按钮（强调色） */
	cta?: boolean;
	/** 点了干什么 */
	run: (plugin: LocallySavePlugin) => void;
	/** 当前是否不可用（比如两个目录都没填时） */
	disabled?: (settings: T) => boolean;
}

/**
 * 一个分区。
 *
 * - `group`：直接铺在面板上的顶层小节；
 * - `page`：Obsidian 1.13+ 的可展开一页，1.13 以下平铺成一个小节 + 若干小标题。
 *
 * 本插件的页面都按"用户要干什么"分，不按代码模块分。
 */
export interface FieldSection<T = PluginSettings> {
	type: 'group' | 'page';
	heading: string;
	/** 页面描述，只有 page 在 1.13+ 显示（旧版 DOM 忽略） */
	desc?: string;
	/** 顶层小节直接挂设置项 */
	fields?: FieldSpec<T>[];
	/** page 下面按小标题分组 */
	groups?: FieldGroup<T>[];
}
