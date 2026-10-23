import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type LocallySavePlugin from '../main';
import { mergeBundleGroup, planBundleMerges } from '../bundle/merge';
import type { MergePlan } from '../bundle/merge';
import { loadState } from '../sync/state';
import { formatBytes } from '../utils/format';
import { refreshBundlesAction } from './git';

/**
 * 货架相关的两个动作 —— **导出窗与导入窗共用**（用户提的："管理同步包那个窗口我根本不会打开，
 * 功能都移动到导出包和导入包界面"）。
 *
 * 放在这里而不是 `manage-modal.ts`：那个文件反过来要 import 应用对话框（`ApplyBundleModal`），
 * 两边互相 import 就成了循环依赖。
 */
export function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * **合并相邻的更新包**：把连着的一串小包并成一份大的（历史遗留的那些小包）。
 *
 * 一进一出都是"先算后做"：先把"哪几份并成哪一份、省多少"摊开给用户看，
 * 确认了才动手（`mergeBundleGroup`：先写新的、写成了才把那几份小的挪进回收站）。
 */
export async function mergeAdjacentBundles(
	app: App,
	plugin: LocallySavePlugin,
	dir: string,
	onChanged?: () => void | Promise<void>,
): Promise<void> {
	const state = await loadState(plugin.stateFile());
	const { plans, forks } = await planBundleMerges(dir, state.lineage);
	if (plans.length === 0) {
		new Notice(forks > 0
			? '没有可以合并的包：同一个起点分出了几份不同落点的包，插件不替你猜哪条是正路'
			: '没有可以合并的包：这里没有首尾相接的更新包');
		return;
	}
	new ConfirmMergeModal(app, plans, async () => {
		const done: string[] = [];
		const failed: string[] = [];
		for (const plan of plans) {
			try {
				const outcome = await mergeBundleGroup({
					outDir: dir,
					log: plugin.log,
					stateFile: plugin.stateFile(),
					vaultName: plugin.vaultName(),
					onProgress: (count, total, file) =>
						plugin.reportProgress({ done: count, total, path: file, label: '导出中' }),
				}, plan);
				done.push(`${plan.anchorGeneration} → ${plan.targetGeneration} 代（${plan.links.length} 份并成 1 份）`);
				if (outcome.failed.length > 0) {
					failed.push(`${plan.links.length} 份里有 ${outcome.failed.length} 份没能挪进回收站`);
				}
			} catch (error) {
				failed.push(describeError(error));
			} finally {
				plugin.reportProgress(null);
			}
		}
		const parts = [...done];
		if (failed.length > 0) parts.push(`失败：${failed.join('；')}`);
		new Notice(`合并完成：${parts.join('、')}。原来那几份在回收站里，能捞回来。`, 9000);
		await onChanged?.();
	}).open();
}

/**
 * 导出 / 导入窗口底部那一排"货架"按钮：**刷新包（对齐远程）** 与 **合并相邻的更新包…**。
 *
 * 没有开 git 时也照常显示 —— 点下去会由 `refreshBundlesAction` 弹一句"先打开启用 git 传输"，
 * 比把按钮藏起来更好懂（用户会问"我的刷新按钮去哪了"）。
 */
export function renderShelfTools(
	container: HTMLElement,
	app: App,
	plugin: LocallySavePlugin,
	dir: () => string,
	onChanged?: () => void | Promise<void>,
): void {
	new Setting(container)
		.addButton(button => button
			.setButtonText('刷新包（对齐远程）')
			.setTooltip('丢掉本地货架那一段没推的提交，整段对齐远程，把新包拉下来')
			.onClick(() => {
				void refreshBundlesAction(plugin).then(() => onChanged?.());
			}))
		.addButton(button => button
			.setButtonText('合并相邻的更新包…')
			.setTooltip('把连着的一串小更新包并成一份大的，少几个文件要搬')
			.onClick(() => { void mergeAdjacentBundles(app, plugin, dir(), onChanged); }));
}

/**
 * 合并前的确认框：**把账摊开**（哪几份并成哪一份、省多少），
 * 并说清"原来那几份去回收站"与"站在这些包送到的状态上的机器照样收得下"。
 */
class ConfirmMergeModal extends Modal {
	private plans: MergePlan[];
	private onConfirm: () => Promise<void>;

	constructor(app: App, plans: MergePlan[], onConfirm: () => Promise<void>) {
		super(app);
		this.plans = plans;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('locally-save-modal');
		contentEl.createEl('h2', { text: '合并相邻的更新包' });
		contentEl.createEl('p', {
			text: '把连着的一串小更新包并成一份：几份并成一份，少几个文件要搬。'
				+ '起点还是这一串的开头，终点还是末尾，内容一份不少。',
			cls: 'locally-save-hint',
		});

		const facts = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		for (const plan of this.plans) {
			facts.createEl('li', {
				text: `第 ${plan.anchorGeneration} → ${plan.targetGeneration} 代：`
					+ `${plan.links.length} 份并成 1 份，`
					+ `原来那几份一共 ${formatBytes(plan.bytes)}`,
			});
		}
		contentEl.createEl('p', {
			text: '原来那几份会挪进回收站，能捞回来。'
				+ '已经站在这些包送到的状态上的机器，照样收得下合并后的这一份。',
			cls: 'locally-save-hint',
		});

		new Setting(contentEl)
			.addButton(button => button
				.setButtonText('取消')
				.onClick(() => this.close()))
			.addButton(button => {
				button.setButtonText('合并').setCta();
				button.onClick(() => {
					this.close();
					void this.onConfirm();
				});
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
