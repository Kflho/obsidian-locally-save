import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import { exportBundle } from '../bundle/export';
import type { ExportOutcome } from '../bundle/export';
import { bundleBaseDir, bundleDirForMode } from '../bundle/paths';
import { advanceWarnThreshold, describeLimit, parseSizeLimit, shouldOfferReset } from '../bundle/size-warn';
import type LocallySavePlugin from '../main';
import { loadState, saveState } from '../sync/state';
import { formatBytes, formatDuration } from '../utils/format';
import { openFolderInExplorer } from './reveal';

/**
 * 「更新包攒得太大了，要不要换一次基准」的弹窗。
 *
 * 为什么要有它：更新包是**自完整副本累积**的，越攒越大；等它大到接近完整副本时，
 * 它最大的好处（传得小）就没了。这时候该换基准：重导一份完整副本，
 * 让更新包从零重新累积。
 *
 * 顺序有讲究，所以这个窗要拦住用户先想一秒：
 * 1. **先把手上这个更新包传过去应用**（它是增量，比完整副本小得多）——
 *    点「打开更新包文件夹」直接跳到它所在的目录去拷；
 * 2. 然后才重导完整副本当新基准。
 *
 * 三个选项：
 * - 「重新导出完整副本」：立刻换基准；提醒线清零（更新包从零累积，涨到 1 倍上限再提醒）。
 *   注意：换基准之后，**被它取代的旧更新包会一并清掉**（新的完整副本里有它们的全部内容）；
 * - 「打开更新包文件夹」：跳过去拷文件，**点完窗口不关**，回来接着选；
 * - 「跳过这次导出」：什么都不做，把提醒线抬高一倍原上限（200MB → 400MB → 600MB…），
 *   等它涨到线上再问。
 */
export class ResetBaselineModal extends Modal {
	private plugin: LocallySavePlugin;
	private fileBytes: number;
	/** 当前这条提醒线（从状态文件里读出来的） */
	private warnedThreshold: number | null;
	/** 弹窗里那个状态行（"正在导出……" / 文件夹路径） */
	private statusEl: HTMLElement | null = null;
	/** 导出中：按钮先禁用，免得连点两次 */
	private busy = false;

	constructor(app: App, plugin: LocallySavePlugin, fileBytes: number, warnedThreshold: number | null = null) {
		super(app);
		this.plugin = plugin;
		this.fileBytes = fileBytes;
		this.warnedThreshold = warnedThreshold;
	}

	/** 同步包根目录（与导出用的是同一套规则：留空跟着目标文件夹走） */
	private baseDir(): string {
		return bundleBaseDir(this.plugin.settings, this.plugin.settings.targetDir);
	}

	private limitBytes(): number {
		return parseSizeLimit(this.plugin.settings.bundleSizeWarnLimit);
	}

	/** 跳过之后，提醒线会抬到哪儿 */
	private nextThreshold(): number {
		return advanceWarnThreshold(this.limitBytes(), this.warnedThreshold);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('locally-save-modal');
		contentEl.createEl('h2', { text: '更新包攒得有点大了' });

		const limit = this.limitBytes();
		contentEl.createEl('p', {
			text: `这个更新包已经有 ${formatBytes(this.fileBytes)}（你设的上限是 ${describeLimit(limit)}）。`,
			cls: 'locally-save-summary',
		});
		contentEl.createEl('p', {
			text: '更新包是**自完整副本累积**的：它越大，说明离上次换基准越久。'
				+ '再攒下去它会赶上完整副本的个头 —— 那时候"传得小"这个好处就没了。'
				+ '该换一次基准了：重导一份完整副本，更新包从零重新累积。',
			cls: 'locally-save-hint',
		});

		contentEl.createEl('h3', { text: '建议的顺序' });
		const steps = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		steps.createEl('li', {
			text: '**先把手上这个更新包传过去应用** —— 它是增量，比完整副本小得多，'
				+ '传一次就到位（点下面的「打开更新包文件夹」直接跳到它所在的目录）',
		});
		steps.createEl('li', {
			text: '然后回来点「重新导出完整副本」换基准。**换完基准，被它取代的旧更新包会一并清掉**'
				+ '（新的完整副本里已经有它们的全部内容），所以那个包要先拷走',
		});
		contentEl.createEl('p', {
			text: `这一轮暂时不换也行：点「跳过这次导出」，更新包继续累积，`
				+ `等它涨到 ${describeLimit(this.nextThreshold())} 时会再问一次。`,
			cls: 'locally-save-hint',
		});

		this.statusEl = contentEl.createEl('p', { cls: 'locally-save-hint' });

		new Setting(contentEl)
			.addButton(button => button
				.setButtonText('重新导出完整副本')
				.setCta()
				.onClick(() => { void this.exportFull(); }))
			.addButton(button => button
				.setButtonText('打开更新包文件夹')
				.onClick(() => this.openFolder()))
			.addButton(button => button
				.setButtonText('跳过这次导出')
				.onClick(() => { void this.skip(); }));
	}

	/** 跳过去把包拷走。**不关窗**：拷完还要回来选下一步 */
	private openFolder(): void {
		const base = this.baseDir();
		if (!base) {
			this.statusEl?.setText('还没设置「同步包文件夹」或「目标文件夹」，没有可以打开的目录');
			return;
		}
		const dir = bundleDirForMode(base, 'changes');
		openFolderInExplorer(dir, this.app as unknown as { openWithDefaultApp?: (path: string) => void });
		this.statusEl?.setText(`更新包文件夹：${dir}`);
	}

	/**
	 * 跳过：把提醒线抬高一倍原上限。
	 *
	 * 记"提醒线"而不是"包多大"：这个体积附近就别再问了，等它再攒出一个上限那么多
	 * （200MB → 400MB → 600MB…）再说 —— 比按百分比判断好懂也好交代。
	 */
	private async skip(): Promise<void> {
		const next = this.nextThreshold();
		await this.saveThreshold(next);
		new Notice(`好，这次不重导。更新包继续累积，涨到 ${describeLimit(next)} 之上时再提醒你`, 7000);
		this.close();
	}

	/** 换基准：导一份完整副本 */
	private async exportFull(): Promise<void> {
		if (this.busy) return;
		const base = this.baseDir();
		if (!base) {
			this.statusEl?.setText('还没设置「同步包文件夹」或「目标文件夹」，没法导出');
			return;
		}
		this.busy = true;
		this.statusEl?.setText('正在导出完整副本……（大仓库要一会儿）');
		try {
			const outcome = await exportBundle({
				settings: this.plugin.settings,
				log: this.plugin.log,
				vaultRoot: this.plugin.vaultRoot(),
				vaultName: this.plugin.vaultName(),
				stateFile: this.plugin.stateFile(),
				mode: 'full',
				outDir: base,
				configDir: this.plugin.configDir(),
			});
			if (!outcome.file) {
				this.statusEl?.setText(`没能导出：${outcome.reason ?? '没有内容'}`);
				this.busy = false;
				return;
			}
			// 换了基准 = 更新包从零重新累积，提醒线也清零
			await this.saveThreshold(null);
			const cleaned = outcome.superseded.length > 0
				? `；被它取代的旧更新包清掉了 ${outcome.superseded.length} 个`
				: '';
			new Notice(
				`已换新基准：完整副本 ${formatBytes(outcome.fileBytes)}`
				+ `（${formatDuration(outcome.durationMs)}）→ ${outcome.file}${cleaned}`,
				12000,
			);
			this.close();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.statusEl?.setText(`导出失败：${message}`);
			new Notice(`重新导出完整副本失败：${message}`, 9000);
			this.plugin.log.error('重新导出完整副本失败', error);
			this.busy = false;
		}
	}

	/** 记下提醒线；传 null ＝ 清零（换过基准） */
	private async saveThreshold(value: number | null): Promise<void> {
		try {
			const state = await loadState(this.plugin.stateFile());
			if (state.bundle) {
				if (value === null) delete state.bundle.warnedThreshold;
				else state.bundle.warnedThreshold = value;
			}
			await saveState(this.plugin.stateFile(), state);
		} catch (error) {
			// 记不上只影响"下次还问不问"，不值得打断用户
			this.plugin.log.debug(`记下提醒线失败：${String(error)}`);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * 检查"更新包是不是该换基准了"，是就弹窗问。
 *
 * 两个调用点共用：手动导出（导出窗关掉之后）与同步后自动留包。
 * 只在**更新包**上判断 —— 完整包不参与（它就是基准本身）。
 */
export async function offerBaselineReset(
	plugin: LocallySavePlugin,
	outcome: Pick<ExportOutcome, 'cumulative' | 'fileBytes'>,
): Promise<void> {
	if (!outcome.cumulative || outcome.fileBytes <= 0) return;
	try {
		const limit = parseSizeLimit(plugin.settings.bundleSizeWarnLimit);
		const state = await loadState(plugin.stateFile());
		const warned = state.bundle?.warnedThreshold ?? null;
		if (!shouldOfferReset(limit, outcome.fileBytes, warned)) return;
		new ResetBaselineModal(plugin.app, plugin, outcome.fileBytes, warned).open();
	} catch (error) {
		// 这只是个提醒，判断不了就当没这回事
		plugin.log.debug(`判断"要不要换基准"失败：${String(error)}`);
	}
}
