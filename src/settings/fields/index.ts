import { AUTO_SECTION } from './auto';
import { GENERAL_SECTION } from './general';
import { INTERFACE_SECTION } from './interface';
import { SYNC_SECTION } from './sync';
import type { FieldSection, FieldSpec } from './types';

/**
 * 设置面板的完整结构：顺序 = 面板上从上到下的顺序。
 *
 * 两条规矩（继承自 js_02）：
 * - **按"用户要干什么"分页，不按代码模块分页**（`src/` 下的文件结构是给维护者看的）；
 * - 一个页面里**同类的事必须挨着**，并且用小标题说清是哪一类；每个设置项只属于一处
 *   （test/settings.test.ts 会核对不多不少）。
 *
 * 加一个设置项只需要在对应分区的文件里加一条，
 * 声明式定义与旧版手写 DOM 会同时长出来。
 */
export const SETTINGS_SECTIONS: FieldSection[] = [
	GENERAL_SECTION,
	SYNC_SECTION,
	AUTO_SECTION,
	INTERFACE_SECTION,
];

/** key → 字段，供读取 / 写入控件值时查收敛规则 */
export const FIELD_INDEX: Map<string, FieldSpec> = (() => {
	const index = new Map<string, FieldSpec>();
	for (const section of SETTINGS_SECTIONS) {
		const groups = section.fields ? [{ heading: section.heading, fields: section.fields }] : section.groups ?? [];
		for (const group of groups) {
			for (const field of group.fields) {
				index.set(field.key, field);
			}
		}
	}
	return index;
})();

/**
 * 平面化的字段清单（按面板顺序）。
 * 测试用它核对"每个设置字段都有且只有一条定义"。
 */
export const ALL_FIELDS: FieldSpec[] = [...FIELD_INDEX.values()];

export type { FieldGroup, FieldSection, FieldSpec, ControlSpec } from './types';
