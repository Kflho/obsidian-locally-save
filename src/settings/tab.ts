import { PluginSettingTab, Setting } from 'obsidian';
import type { App, SettingDefinitionItem } from 'obsidian';
import type NewPlugin from '../main';
import { DEFAULT_SETTINGS } from './model';
import type { PluginSettings } from './model';
import { FIELD_INDEX, SETTINGS_SECTIONS } from './fields';
import type { FieldSpec } from './fields';

/**
 * 设置面板。
 *
 * 两种渲染路径，**同一份字段表**（见 fields/）：
 * - `getSettingDefinitions()`：Obsidian 1.13+ 的声明式定义，面板与设置搜索都由它渲染；
 * - `display()`：1.13 以下的手写 DOM（只要定义返回非空数组，1.13+ 就不再调用它）。
 *
 * 这套骨架继承自 js_02（note-tidy）：以前两条路各写一遍，加一个设置项要改两处、
 * 漏一处用户就看不见那个开关 —— test/settings.test.ts 就是为堵这个洞写的。
 */

/**
 * 设置面板里的小标题（分组用）。
 *
 * Obsidian 的 `Setting.setHeading()` 只有一级，而这里的层级是
 * 「功能分页 → 子分组」，所以子分组自己造一个 h4，用 classes 控制样式（见 styles.css）。
 */
function addSubHeading(containerEl: HTMLElement, text: string) {
	const wrapper = containerEl.createDiv({ cls: 'new-plugin-settings-subheading' });
	wrapper.createEl('h4', { text });
}

export class NewPluginSettingTab extends PluginSettingTab {
	plugin: NewPlugin;

	constructor(app: App, plugin: NewPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Obsidian 1.13 以下走这里：手写 DOM。
	 * 1.13 起只要 getSettingDefinitions() 返回非空数组，Obsidian 就不再调用
	 * display()（见 obsidian.d.ts 的说明），而是按声明式定义渲染。
	 * 两边必须一一对应 —— test/settings.test.ts 会检查每个设置项都有定义。
	 */
	display(): void {
		this.renderSettings();
	}

	/** 1.13 以下的手写渲染。切换某项会改变其它项的可见 / 可用状态，所以整块重画 */
	private renderSettings(): void {
		const { containerEl } = this;
		containerEl.empty();
		const settings = this.plugin.settings;

		for (const section of SETTINGS_SECTIONS) {
			// 顶层分区用一级标题
			new Setting(containerEl).setName(section.heading).setHeading();

			if (section.fields) {
				for (const field of section.fields) {
					this.renderField(containerEl, field, settings);
				}
				continue;
			}
			for (const group of section.groups ?? []) {
				addSubHeading(containerEl, group.heading);
				for (const field of group.fields) {
					this.renderField(containerEl, field, settings);
				}
			}
		}
	}

	/** 画一条设置项 */
	private renderField(containerEl: HTMLElement, field: FieldSpec, settings: PluginSettings): void {
		// 用不上 / 不显示的项直接不画（声明式那边是 visible 谓词）
		if (field.visible && !field.visible(settings)) return;

		const setting = new Setting(containerEl).setName(field.name);
		if (field.desc) setting.setDesc(field.desc);
		if (field.disabled) setting.setDisabled(field.disabled(settings));

		const write = async (value: unknown): Promise<void> => {
			await this.setControlValue(field.key, value);
			// 这一项会改变别的项的显示 / 可用状态时整块重画（声明式由 visible / disabled 自己重新求值）
			if (field.rerenderOnChange) this.renderSettings();
		};

		switch (field.control.type) {
			case 'dropdown': {
				const options = field.control.options;
				setting.addDropdown(dropdown => dropdown
					.addOptions(options)
					.setValue(String(this.getControlValue(field.key)))
					.onChange(write));
				return;
			}
			case 'text': {
				const value = this.getControlValue(field.key);
				setting.addText(text => text
					.setPlaceholder(field.control.type === 'text' ? field.control.placeholder : '')
					.setValue(typeof value === 'string' ? value : '')
					.onChange(write));
				return;
			}
			case 'textarea': {
				const value = this.getControlValue(field.key);
				setting.addTextArea(text => text
					.setPlaceholder(field.control.type === 'textarea' ? field.control.placeholder : '')
					.setValue(typeof value === 'string' ? value : '')
					.onChange(write));
				return;
			}
			case 'toggle':
				setting.addToggle(toggle => toggle
					.setValue(Boolean(this.getControlValue(field.key)))
					.onChange(write));
				return;
		}
	}

	/**
	 * 声明式设置（Obsidian 1.13+）。
	 * 定义里的 key 就是 settings 的字段名，读写走下面的 getControlValue / setControlValue。
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return SETTINGS_SECTIONS.map(section => section.type === 'group'
			? {
				type: 'group',
				heading: section.heading,
				items: (section.fields ?? []).map(field => this.buildDefinition(field)),
			} as SettingDefinitionItem
			: {
				type: 'page',
				name: section.heading,
				desc: section.desc,
				items: (section.groups ?? []).map(group => ({
					type: 'group',
					heading: group.heading,
					items: group.fields.map(field => this.buildDefinition(field)),
				})),
			} as SettingDefinitionItem
		);
	}

	/**
	 * 把字段表的一条组装成声明式定义。
	 *
	 * 断言的那一下：字段表里的 `toggle / text / textarea / dropdown` 与 obsidian 的
	 * SettingControl 联合类型一一对应，但联合类型没法按字符串变量收窄，只能显式断言 ——
	 * 形状由 test/settings.test.ts 逐条校验（有没有名字、下拉默认值在不在选项里…）。
	 */
	private buildDefinition(field: FieldSpec): SettingDefinitionItem {
		const settings = () => this.plugin.settings;
		const control = {
			type: field.control.type,
			key: field.key,
			defaultValue: DEFAULT_SETTINGS[field.key],
			...(field.control.type === 'dropdown' ? { options: field.control.options } : {}),
			...(field.control.type === 'text' ? { placeholder: field.control.placeholder } : {}),
			...(field.control.type === 'textarea' ? { placeholder: field.control.placeholder, rows: field.control.rows } : {}),
			...(field.disabled ? { disabled: () => field.disabled?.(settings()) === true } : {}),
		};
		const definition = {
			name: field.name,
			...(field.desc ? { desc: field.desc } : {}),
			...(field.visible ? { visible: () => field.visible?.(settings()) === true } : {}),
			control,
		};
		return definition as unknown as SettingDefinitionItem;
	}

	/**
	 * 读取控件当前值。
	 * data.json 里可能存着旧版本没有的字段或手工改坏的值，
	 * 这里按字段表里的收敛规则返回，免得下拉框显示成空白。
	 */
	getControlValue(key: string): unknown {
		const raw = (this.plugin.settings as unknown as Record<string, unknown>)[key];
		const coerce = FIELD_INDEX.get(key)?.coerce;
		return coerce ? coerce(raw) : raw;
	}

	/** 写入控件值：先收敛，再存盘，最后让其它设置项的 visible / disabled 重新求值 */
	async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.settings as unknown as Record<string, unknown>;
		const coerce = FIELD_INDEX.get(key)?.coerce;
		settings[key] = coerce ? coerce(value) : value;
		await this.plugin.saveSettings();
		const tab = this as unknown as { refreshDomState?: () => void };
		tab.refreshDomState?.();
	}
}
