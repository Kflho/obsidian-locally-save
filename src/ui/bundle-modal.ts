import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type LocallySavePlugin from '../main';
import { executeBundlePlan, isDestructivePlan, planBundleApply } from '../bundle/apply';
import type { ApplyPlan, ApplyResult } from '../bundle/apply';
import type { StateIdInfo } from '../sync/state';
import { describeStateId } from '../bundle/log';
import { exportBundle, parkLocalChangesFor, plannedExportModes } from '../bundle/export';
import { baselineOfFullBundle, listingHashOfFiles } from '../bundle/baseline';
import type { BundleAnchor } from '../bundle/anchor';
import type { FileRecord } from '../sync/types';
import { anchorOptions, listFullAnchorsSync, planAutoStart } from '../bundle/anchor';
import type { AnchorRef, AutoStartPlan, LatestInfo } from '../bundle/anchor';
import { listPointRefsSync } from '../bundle/points';
import { bundleBaseDir, bundleDirForMode } from '../bundle/paths';
import type { BundleMode } from '../bundle/paths';
import { loadStateSync } from '../sync/state';
import { anchorFingerprintOf, coerceAnchorFingerprint } from '../settings/model';
import type { DropdownComponent, TextComponent } from 'obsidian';
import { BundleListView } from './bundle-list';
import { pickBundleFromDrop } from './drop';
import { focusWindow, markDestructive } from './modal-layout';
import { describeExportRange, describeExportStart } from '../bundle/log';
import { formatBytes, formatDuration, formatTime } from '../utils/format';

/** 确认框里最多列多少个会被删的文件 */
const MAX_ROWS = 200;
/** 报告里"包里点名了哪些文件"最多列几条 */
const MAX_LISTED = 50;

/**
 * 导出同步包。
 *
 * 两个选项都能在这里临时改：设置里的默认值只是"平时用哪个"，
 * 偶尔导一份完整包给别人时不该被迫先去改设置。
 */
export class ExportBundleModal extends Modal {
	private plugin: LocallySavePlugin;
	/** 两个**独立**的选项：可以都要（顺序见 plannedExportModes：先完整、后更新） */
	private wantChanges = true;
	private wantFull = false;
	/** 用户自己填的值（可能为空 ＝ 用默认） */
	private outDir: string;
	/** 设置里那个包目录：显示成灰底提示，而不是预先填进输入框 */
	private defaultDir: string;
	/**
	 * 更新包的起点与终点（`''` ＝ 最新，其余是**基准指纹**）。
	 *
	 * 与设置里那两个下拉是**同一项设置**：这里改了会记住（设置面板里也变了）——
	 * "给哪台机器导"是件延续的事，今天选的起点，明天自动留包时也该照它算。
	 */
	private fromState: string;
	private toState: string;
	/**
	 * 「这条线的最新点」——起点留空（默认）时，引擎会自动接在它后面导出。
	 *
	 * 与引擎**共用同一个判断**（`planAutoStart`）：窗口里那句"本次：第 N 代 → 最新"
	 * 就是照它写的，所以不会出现"界面说接线头、实际从本机这一点导"这种对不上的情况。
	 */
	private autoStart: AutoStartPlan | null = null;
	private fromDropdown: DropdownComponent | null = null;
	private toDropdown: DropdownComponent | null = null;
	private statusEl!: HTMLElement;
	private whereEl!: HTMLElement;
	/** 底下那份"已有的同步包"列表：导出完不用另开窗口就能顺手清一清 */
	private list: BundleListView | null = null;

	constructor(app: App, plugin: LocallySavePlugin, options: { wantChanges?: boolean; wantFull?: boolean } = {}) {
		super(app);
		this.plugin = plugin;
		// 允许调用方预置勾选（比如"基准对不上 → 导一份完整副本发过去"那条路）
		if (options.wantChanges !== undefined) this.wantChanges = options.wantChanges;
		if (options.wantFull !== undefined) this.wantFull = options.wantFull;
		// 只显示"用户自己填的"；留空就是留空，别把默认值预先填进去 ——
		// 那样用户一删就变成"没填路径"，还得自己猜默认在哪儿
		this.outDir = plugin.settings.bundleDir.trim();
		this.defaultDir = bundleBaseDir(plugin.settings);
		this.fromState = coerceAnchorFingerprint(plugin.settings.changesFromState);
		this.toState = coerceAnchorFingerprint(plugin.settings.changesToState);
	}

	/** 此刻实际会用的根目录：在这个窗口里改过就用改的，否则就是设置里那个 */
	private effectiveDir(): string {
		return bundleBaseDir({ ...this.plugin.settings, bundleDir: this.outDir });
	}

	/**
	 * 把"本地有哪些状态"填进两个下拉：**有几份完整包就有几个状态**，外加「最新」。
	 *
	 * 用同步那套读法（设置面板里那两个下拉也是它），当场就能列出来 ——
	 * 在窗口里换了包目录也会重新列一遍。读不出来时至少留着「最新」，
	 * 真的选了找不到的状态，导出时引擎会明确报错并列出"现在有哪些"。
	 */
	private fillStateOptions(): void {
		let anchors: AnchorRef[] = [];
		let latest: LatestInfo = { generation: null, hash: null, file: null };
		try {
			const state = loadStateSync(this.plugin.stateFile());
			// 完整副本 ＋ **链条上的点**（每份更新包落出的那一点）：都能当起点 / 终点
			anchors = [
				...listFullAnchorsSync(this.effectiveDir(), state.lineage),
				...listPointRefsSync(this.effectiveDir(), state.lineage),
			];
			latest = {
				generation: state.bundle?.fullGeneration ?? null,
				hash: state.bundle?.fullHash ?? null,
				file: state.bundle?.fullFile ?? null,
			};
		} catch {
			// 状态文件读不到 / 目录不存在：剩下「最新」那一项，导出时再说
		}
		const fill = (dropdown: DropdownComponent | null, end: 'from' | 'to', value: string): void => {
			// 测试替身里没有真的 select（只需要不炸）
			if (!dropdown?.selectEl) return;
			const options = anchorOptions(anchors, end, latest);
			dropdown.selectEl.empty();
			dropdown.addOptions(options);
			// 选中的那份包已经不在目录里了：照样列出来并标一下 ——
			// 悄悄跳回「最新」的话，用户会以为选的还是那一份
			if (value !== '' && !(value in options)) {
				dropdown.addOption(value, `基准 ${value}（这个目录里找不到这一个状态）`);
			}
			dropdown.setValue(value);
		};
		fill(this.fromDropdown, 'from', this.fromState);
		fill(this.toDropdown, 'to', this.toState);
	}

	/** 这两个选择**写回设置**：留包（含自动留包）以后都按它算 */
	private async persistStates(): Promise<void> {
		this.plugin.settings.changesFromState = this.fromState;
		this.plugin.settings.changesToState = this.toState;
		try {
			await this.plugin.saveSettings();
		} catch (error) {
			new Notice(`没记住这次的「从哪个状态 / 到哪个状态」选择：${describe(error)}`, 8000);
		}
	}

	/**
	 * 看一眼"这条线的最新点"（起点留空 ＝ 自动接在它后面）。
	 *
	 * 与引擎共用 `planAutoStart`：它走一遍包目录里的环，得出"从我站的这一点往后能走到哪一点"。
	 * 我本来就是线头 → `head` 为 null（跟老行为一样，从本机这一点往外导）；
	 * 我落在后面（回退过 / 没跟上）→ 接上线头，界面里那句"本次：第 N 代 → 最新"照它写。
	 */
	private async refreshAutoStart(): Promise<void> {
		if (!this.wantChanges || this.fromState !== '') {
			this.autoStart = null;
			this.renderWhere();
			return;
		}
		try {
			const state = loadStateSync(this.plugin.stateFile());
			this.autoStart = await planAutoStart(this.effectiveDir(), state);
		} catch {
			this.autoStart = null;
		}
		this.renderWhere();
	}

	/** 选中的那一个状态（完整副本或链条上的点），找不到就是 null —— 只用来显示第几代 */
	private pickedAnchor(fingerprint: string): AnchorRef | null {
		if (fingerprint === '') return null;
		try {
			const state = loadStateSync(this.plugin.stateFile());
			const refs: AnchorRef[] = [
				...listFullAnchorsSync(this.effectiveDir(), state.lineage),
				...listPointRefsSync(this.effectiveDir(), state.lineage),
			];
			return refs.find(anchor => anchor.hash === fingerprint) ?? null;
		} catch {
			return null;
		}
	}

	/** 这次更新包「从哪一份到哪一份」那句话（没勾更新包时不显示） */
	private describeRange(): string {
		if (!this.wantChanges) return '';
		// 起点是自动选的时候（我落在后面）：说清"接在这条线的最新点后面"
		if (this.fromState === '' && this.autoStart?.head) {
			const head = this.autoStart.head;
			const mine = this.autoStart.mine;
			return `本次：第 ${head.generation} 代 → 最新（自动接在这条线的最新点后面`
				+ `${mine ? `：你站在第 ${mine.generation} 代` : ''}）`;
		}
		const from = this.pickedAnchor(this.fromState);
		const fromText = this.fromState === ''
			? '我站的这个基准点'
			: `第 ${from?.generation ?? '?'} 代（${this.fromState}）`;
		const to = this.pickedAnchor(this.toState);
		const toText = this.toState === ''
			? '最新'
			: `第 ${to?.generation ?? '?'} 代`;
		const note = this.toState !== ''
			? '内容到那一份为止'
			: (this.fromState !== '' ? '只对站在这一个基准点上的机器是确定的' : '');
		return `本次：${fromText} → ${toText}${note ? `（${note}）` : ''}`;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('locally-save-modal');
		contentEl.createEl('h2', { text: '导出同步包' });
		contentEl.createEl('p', {
			text: '把仓库打包成 .lsave 文件，拷到别的机器上应用。',
			cls: 'locally-save-hint',
		});

		// 两个独立选项，不是互斥的：都要就都勾上（导出时**先导完整副本、再导更新包**）
		new Setting(contentEl)
			.setName('导出更新包')
			.setDesc('只装自上一个基准点以来的新改动（链条上的新一环）。对方站在那一点上就能直接收下')
			.addToggle(toggle => toggle
				.setValue(this.wantChanges)
				.onChange(value => {
					this.wantChanges = value;
					this.renderWhere();
					void this.refreshAutoStart();
				}));

		new Setting(contentEl)
			.setName('导出完整副本')
			.setDesc('整个仓库，也是更新包的基准（对方要先应用它）。体积大、每次都重写一遍')
			.addToggle(toggle => toggle
				.setValue(this.wantFull)
				.onChange(value => {
					this.wantFull = value;
					this.renderWhere();
				}));

		new Setting(contentEl)
			.setName('同步包文件夹')
			.setDesc('默认用设置里那个；在这里改只影响这一次导出')
			.addText(text => text
				.setPlaceholder(this.defaultDir || '先去设置里填「同步包文件夹」')
				.setValue(this.outDir)
				.onChange(value => {
					this.outDir = value.trim();
					this.renderWhere();
					// 换了目录 → 可选的"状态"（＝那个目录里的完整包）也跟着换
					this.fillStateOptions();
					void this.refreshAutoStart();
					this.list?.schedule();
				}));

		// ---------------------------------------------------------- 更新包的起点与终点
		// 两个下拉的选项＝本机那几份完整包（外加「最新」）。与设置里那两个是同一项设置：改了会记住。
		new Setting(contentEl)
			.setName('更新包：从哪个状态')
			.setDesc('接着哪一份完整副本往后算。默认「自动」：你就是线头就从你这一点往外导，'
				+ '你落在后面（比如回退过）就自动接在这条线的最新点后面；对方还停在更老的一份上时，'
				+ '照它「更新记录」里的基准指纹选')
			.addDropdown(dropdown => {
				this.fromDropdown = dropdown;
				dropdown.onChange(value => {
					this.fromState = value;
					void this.persistStates();
					this.renderWhere();
					void this.refreshAutoStart();
				});
			});

		new Setting(contentEl)
			.setName('更新包：到哪个状态')
			.setDesc('默认最新（当前仓库）；选一份完整副本则导到那一刻为止，内容取自那份包')
			.addDropdown(dropdown => {
				this.toDropdown = dropdown;
				dropdown.onChange(value => {
					this.toState = value;
					void this.persistStates();
					this.renderWhere();
				});
			});

		this.fillStateOptions();

		this.whereEl = contentEl.createEl('p', { cls: 'locally-save-hint' });
		this.statusEl = contentEl.createEl('p', { cls: 'locally-save-hint' });
		this.renderWhere();
		void this.refreshAutoStart();

		// 顺手就能管理：包攒多了、看到过时的，不用关掉这个窗再去导入弹窗里删
		this.list = new BundleListView(this.plugin, contentEl, {
			baseDir: () => this.effectiveDir(),
			// 回收站那一行也显示：在**这个**弹窗里删掉的包，得能在这儿看到它去哪了
			showTrash: true,
			// 本机现在那一行：选"从哪个状态"时要拿它跟对方报的指纹对
			showPosition: true,
			emptyText: '这个文件夹里还没有 .lsave 文件',
		});
		void this.list.refresh();

		new Setting(contentEl)
			.addButton(button => button
				.setButtonText('导出')
				.setCta()
				.onClick(() => { void this.run(); }))
			.addButton(button => button
				.setButtonText('取消')
				.onClick(() => this.close()));
	}

	/** 让用户看清"这次会导出哪些包、落到哪个目录" */
	private renderWhere(): void {
		const modes = this.wantedModes();
		const base = this.effectiveDir();
		if (!base) {
			this.whereEl.setText('还没法确定位置：先去设置里填「同步包文件夹」，或在这里填一个路径。');
			return;
		}
		if (modes.length === 0) {
			this.whereEl.setText('两种都没勾：至少勾一个（更新包或完整副本）。');
			return;
		}
		const targets = modes
			.map(mode => `${mode === 'full' ? '完整副本' : '更新包'} → ${bundleDirForMode(base, mode)}`)
			.join('；');
		const range = this.describeRange();
		// 线头算不出来（缺环 / 缺那份完整副本）时把原因也写出来：这一份会从本机这一点往外导
		const problem = this.wantChanges && this.fromState === '' && this.autoStart?.problem
			? ` ｜ ${this.autoStart.problem}`
			: '';
		this.whereEl.setText(`会写到：${targets}${range ? ` ｜ ${range}` : ''}${problem}`);
	}

	/** 勾了哪几种，以及导出顺序：**先完整副本、后更新包**（见 plannedExportModes） */
	private wantedModes(): BundleMode[] {
		return plannedExportModes({ changes: this.wantChanges, full: this.wantFull });
	}

	private async run(): Promise<void> {
		// 这个窗口里没填就用设置里那个，不是"没填路径"
		const outDir = this.effectiveDir();
		if (!outDir) {
			new Notice('还没法确定位置：先去设置里填「同步包文件夹」，或在这里填一个');
			return;
		}
		const modes = this.wantedModes();
		if (modes.length === 0) {
			new Notice('至少勾一个：更新包或完整副本');
			return;
		}

		const notes: string[] = [];
		let anySuccess = false;
		/** 导出的更新包（攒大了要问"要不要换基准"） */
		/** 这一轮已经导出来的包：导完整包时别把它们当成"被取代的旧包"清掉 */
		const written: string[] = [];
		/** 这一轮导过完整副本了（紧随其后的更新包必然是空的） */
		let fullWritten = false;

		for (const mode of modes) {
			const label = mode === 'full' ? '完整副本' : '更新包';
			this.statusEl.setText(`正在导出${label}……`);
			// 一种失败不影响另一种：第一次用的人往往两个都勾，而"更新包"会因为
			// 还没有基准而失败 —— 不该把"完整副本"也一起带崩
			try {
				const outcome = await exportBundle({
					settings: this.plugin.settings,
					log: this.plugin.log,
					vaultRoot: this.plugin.vaultRoot(),
					vaultName: this.plugin.vaultName(),
					stateFile: this.plugin.stateFile(),
					mode,
					outDir,
					configDir: this.plugin.configDir(),
					// 这个窗口里选的那两个状态（设置里也一起改了，但这里显式传一遍最稳）
					baseFingerprint: anchorFingerprintOf(this.fromState),
					toFingerprint: anchorFingerprintOf(this.toState),
					keepPaths: written,
					onProgress: (done, total, file) => this.plugin.reportProgress({
						done,
						total,
						path: file,
						label: '导出中',
					}),
				});
				this.plugin.reportProgress(null);

				if (!outcome.file) {
					// 没生成的时候要把原因说清：两个都勾时更新包**必然是空的**（完整副本刚导过，
					// 它自己就是最新基准）；差量包则可能是"这一份已经导过了"
					notes.push(`${label}没有生成：${outcome.reason ?? '没有需要导出的内容'}`
						+ (mode === 'changes' && fullWritten && outcome.anchor?.checkpoint !== true
							? '（刚导出的完整副本已经是当前仓库的完整样子，这时的更新包会是空的）'
							: ''));
					continue;
				}
				written.push(outcome.file);
				if (mode === 'full') fullWritten = true;
				anySuccess = true;
				// 没清掉的老更新包要说清为什么 —— 不然用户以为"清理开关没生效"，
				// 或者当成偶发 bug（报过：同一个操作第一遍没清、第二遍清了）
				// 链条上的每一环都要留着（删了，站在那一环上的机器就接不上）——
				// 所以这里不是"没清掉"，而是"本来就要留"，如实列一下让用户心里有数
				const keptNote = outcome.keptChanges.length > 0
					? `；changes 里另有 ${outcome.keptChanges.length} 个包留着（`
						+ `${[...new Set(outcome.keptChanges.map(item => item.why))].join('；')}）`
					: '';
				// 起点是自动接线头时说明一句（"你站在第 39 代、这一份接在第 54 代后面"）——
				// 用户最想确认的就是"顺序没乱、没从老点分岔"
				const startNote = describeExportStart(outcome.anchor?.start);
				notes.push(
					`${label} ${outcome.entryCount} 个文件、${outcome.dirCount} 个文件夹`
					+ `${outcome.emptyDirCount > 0 ? `（其中 ${outcome.emptyDirCount} 个是空的）` : ''}`
					+ `、${formatBytes(outcome.payloadBytes)}（${formatDuration(outcome.durationMs)}）`
					+ `${describeExportRange(outcome)}${startNote ? `（${startNote}）` : ''} → ${outcome.file}`
					+ (outcome.superseded.length > 0
						? `；顺手清掉 ${outcome.superseded.length} 个被它取代的旧更新包`
						: '')
					+ keptNote,
				);
			} catch (error) {
				this.plugin.reportProgress(null);
				const message = describe(error);
				notes.push(`${label}失败：${message}`);
				this.plugin.log.error(`导出${label}失败`, error);
			}
		}

		this.statusEl.setText(notes.join('；'));
		await this.list?.refresh();
		if (!anySuccess) return;
		new Notice(`导出完成：${notes.join('；')}`, 12000);
		/**
		 * **不关这个窗口**（用户要的）。
		 *
		 * 包刚导出来，接下来十有八九就是"对它做点什么"：打开所在文件夹、复制路径拷走、
		 * 觉得不对挪进回收站、或者彻底删掉重导。列表就在下面，一行行都有这些按钮 ——
		 * 以前一导完就关窗，用户还得重新打开一遍、再找那个刚生成的包。
		 * 要接着再导一份（比如完整副本 + 更新包分两次参数导）也直接点「导出」。
		 */
		if (written.length > 0) this.list?.markSelected(written[written.length - 1] as string);
	}

	onClose(): void {
		this.plugin.reportProgress(null);
		this.contentEl.empty();
	}
}

/**
 * 打开同步包并应用 —— **先出报告，再决定应不应用**。
 *
 * 报告里的"同步程度"就是接收方最想知道的那件事：
 * 这个包跟本地差多少、里面有多少是本地也改过的（会留冲突副本）、
 * 会不会删东西、走的是快速通道还是逐文件合并。
 */
export class ApplyBundleModal extends Modal {
	private plugin: LocallySavePlugin;
	/** 用户自己填的值（可能为空 ＝ 用默认） */
	private dir: string;
	/** 留空时会用的默认位置：显示成灰底提示 */
	private defaultDir: string;
	private current: string | null = null;
	private plan: ApplyPlan | null = null;
	/**
	 * **应用方式没得选**（0.11 起）：完整副本与更新包都走**严格同步** ——
	 * 包里点名的文件一律用包里的版本、`header.deleted` 点名的照删、
	 * 本地多出来的文件也挪进回收目录，应用完**仓库 == 包送到的状态**。
	 * 想"合着来"的旧档位（按设置 / 以我为准 / 两边都留）在链条模型下只会合出一个
	 * 谁都不是的状态，界面不再提供（引擎里还剩 `normal` 给自动收包那条保守的路用）。
	 */
	private pathInput: TextComponent | null = null;
	/** 拖放的监听：Modal 不继承 Component，得自己挂、自己摘 */
	private dropHost: HTMLElement | null = null;
	private dropBindings: { name: string; handler: (event: Event) => void }[] = [];
	/** 包列表（与导出弹窗、管理弹窗共用一套：选中、打开文件夹、复制路径、删除） */
	private list: BundleListView | null = null;
	private reportEl!: HTMLElement;
	private applyButton: { setDisabled(disabled: boolean): unknown } | null = null;

	constructor(app: App, plugin: LocallySavePlugin, initialPath?: string) {
		super(app);
		this.plugin = plugin;
		// 只显示"用户自己填的"，留空就是留空（灰字提示设置里那个包目录）
		this.dir = plugin.settings.bundleDir.trim();
		this.defaultDir = bundleBaseDir(plugin.settings);
		// 拖进来的包（或命令带过来的路径）：打开就直接检查它
		this.current = initialPath?.trim() ? initialPath.trim() : null;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('locally-save-modal');
		// 双击 .lsave 进来的：Obsidian 可能还在别的窗口后面 —— 把它叫到前台，
		// 别让"点了没反应"。**不动窗口大小**（以前有个"最大化"开关，删了：
		// 进度有状态栏，插件不该替用户决定窗口多大）
		focusWindow();
		contentEl.createEl('h2', { text: '打开同步包' });
		contentEl.createEl('p', {
			text: '选一个 .lsave 文件，这里会先算一遍"应用之后会变成什么样"，确认无误再动手。',
			cls: 'locally-save-hint',
		});

		// 拖放区：从资源管理器直接把包拖进来，等同于在下面粘路径
		const dropZone = contentEl.createDiv({ cls: 'locally-save-drop' });
		dropZone.createSpan({ text: '把 .lsave 同步包拖到这里' });
		dropZone.createSpan({ text: '（等同于在下面粘路径）', cls: 'locally-save-drop-sub' });
		this.wireDropTarget(contentEl, dropZone);

		new Setting(contentEl)
			.setName('同步包文件夹')
			.setDesc('默认用设置里那个「同步包文件夹」。会列出它的 full（完整副本）与 changes（更新包）两个子目录')
			.addText(text => text
				.setPlaceholder(this.defaultDir || '先去设置里填「同步包文件夹」')
				.setValue(this.dir)
				.onChange(value => {
					this.dir = value.trim();
					this.list?.schedule();
				}))
			.addExtraButton(button => button
				.setIcon('refresh-cw')
				.setTooltip('重新列出')
				.onClick(() => { void this.list?.refresh(); }));

		new Setting(contentEl)
			.setName('包文件路径')
			.setDesc('也可以直接粘一个完整路径')
			.addText(text => {
				this.pathInput = text;
				text
					.setPlaceholder('D:\\传输\\我的笔记-更新-32代到37代-状态3f9a2c1d4e5f6a7b-5f4807.lsave')
					.onChange(value => {
						const path = value.trim();
						if (path) void this.select(path);
					});
			});

		// ---------------------------------------------------------- 应用方式
		// **没有可选项**（0.11 起）：完整副本与更新包都走严格同步 ——
		// "应用完这个仓库就是包里的样子"是唯一一条能保证两边状态编号当场一致的语义，
		// 所以这一段只是一个说明，不是控件。
		contentEl.createEl('p', {
			text: '应用方式：严格同步 —— 包里点名的文件一律用包里的版本，'
				+ '包里点名删掉的照删，本地多出来的也挪进回收目录。应用完这个仓库就是包送到的样子；'
				+ '被换掉的本地版本进回收目录，捞得回来',
			cls: 'locally-save-hint',
		});

		// 列表与导入弹窗、管理弹窗共用：点一行就检查它，行内还能打开所在文件夹 / 复制路径 / 删除
		this.list = new BundleListView(this.plugin, contentEl, {
			baseDir: () => this.effectiveDir(),
			actionLabel: '检查',
			onAction: item => { void this.select(item.file); },
			onSelect: item => { void this.select(item.file); },
			// 选中的包被挪走了：报告留着只会让人以为它还在，清掉并说明一句
			onRemove: file => {
				if (this.current !== file) return;
				this.current = null;
				this.plan = null;
				this.applyButton?.setDisabled(true);
				this.reportEl.setText('刚选中的那个包已经被挪进回收站了，重新选一个吧。');
			},
			// 回收站那一行也显示：在这里删掉的包，得能在这儿看见、也能在这儿清掉
			showTrash: true,
			// 「本机现在基于第几代、状态编号是什么」：判断"这个包该不该应用"要拿它跟包里的编号对
			showPosition: true,
			emptyText: '这个文件夹里没有 .lsave 文件',
		});
		this.reportEl = contentEl.createDiv({ cls: 'locally-save-report' });
		this.reportEl.setText('还没有选择同步包。');

		new Setting(contentEl)
			.addButton(button => {
				this.applyButton = button
					.setButtonText('应用')
					.setCta()
					.setDisabled(true)
					.onClick(() => { void this.apply(); });
				return button;
			})
			.addButton(button => button
				.setButtonText('关闭')
				.onClick(() => this.close()));

		void this.list.refresh();

		// 拖进来的 / 命令带过来的包：先填进输入框（让人看清是哪个文件），再直接检查
		if (this.current) {
			this.pathInput?.setValue(this.current);
			this.list.markSelected(this.current);
			void this.select(this.current);
		}
	}

	/** 此刻实际要去找的根目录：在这个窗口里改过就用改的，否则就是设置里那个 */
	private effectiveDir(): string {
		return bundleBaseDir({ ...this.plugin.settings, bundleDir: this.dir });
	}

	/** 选中一个包：只读地算一遍，把报告画出来 */
	private async select(file: string): Promise<void> {
		this.current = file;
		// 高亮同步到列表上（拖进来 / 粘路径进来的包不在"点一行"这条路上）
		this.list?.markSelected(file);
		this.plan = null;
		this.applyButton?.setDisabled(true);
		this.reportEl.empty();
		this.reportEl.setText('正在检查这个包……');
		await this.replan();
	}

	/**
	 * 把整个对话框变成放置目标（拖到哪儿都行），拖着东西悬在上面时高亮那个提示框。
	 *
	 * Modal 并不继承 Component（见 obsidian.d.ts），所以没有 registerDomEvent，
	 * 用原生监听、并在关闭时自己摘掉。
	 *
	 * `dragover` 必须 preventDefault，否则浏览器根本不会派发 drop —— 拖放最常见的坑。
	 */
	private wireDropTarget(container: HTMLElement, dropZone: HTMLElement): void {
		this.dropHost = container;
		const bind = (name: string, handler: (event: Event) => void) => {
			container.addEventListener(name, handler);
			this.dropBindings.push({ name, handler });
		};

		bind('dragover', (event: Event) => {
			event.preventDefault();
			dropZone.addClass('is-over');
		});
		bind('dragleave', () => dropZone.removeClass('is-over'));
		bind('drop', (event: Event) => {
			event.preventDefault();
			dropZone.removeClass('is-over');
			this.handleDrop(event as DragEvent);
		});
	}

	private unwireDropTarget(): void {
		if (!this.dropHost) return;
		for (const { name, handler } of this.dropBindings) this.dropHost.removeEventListener(name, handler);
		this.dropBindings = [];
		this.dropHost = null;
	}

	/** 拖进来的文件：能认出路径就当作"用户填了这个路径" */
	private handleDrop(event: DragEvent): void {
		const files = event.dataTransfer?.files;
		const { path, error } = pickBundleFromDrop(files as unknown as ArrayLike<{ name: string; path?: string }>);
		if (!path) {
			if (error) new Notice(error, 9000);
			return;
		}
		// 同步更新输入框：让用户看清"拖进来的到底是哪个文件"
		this.pathInput?.setValue(path);
		void this.select(path);
	}

	/**
	 * 重新算一遍（换包、换目录都走这里）。
	 *
	 * **只算不写**：算完把报告画出来，用户看过才点「应用」。
	 * 应用方式固定严格同步（`strictness: 'mirror'`）：包的类型这会儿才知道，
	 * 但两种类型走同一套语义 —— 应用完仓库就是包送到的状态。
	 */
	private async replan(): Promise<void> {
		const file = this.current;
		if (!file) return;
		this.applyButton?.setDisabled(true);
		try {
			const plan = await planBundleApply({
				settings: this.plugin.settings,
				log: this.plugin.log,
				vaultRoot: this.plugin.vaultRoot(),
				stateFile: this.plugin.stateFile(),
				file,
				configDir: this.plugin.configDir(),
				strictness: 'mirror',
			});
			this.plan = plan;
			this.renderReport(plan);
			this.applyButton?.setDisabled(false);
		} catch (error) {
			this.reportEl.empty();
			this.reportEl.setText(`打不开这个包：${describe(error)}`);
		}
	}

	private renderReport(plan: ApplyPlan): void {
		const { report } = plan;
		this.reportEl.empty();
		this.reportEl.createEl('h3', { text: '这个包里有什么' });

		const info = this.reportEl.createEl('ul', { cls: 'locally-save-facts' });
		const add = (text: string) => info.createEl('li', { text });
		add(`来源：${report.bundle.vault}，导出于 ${formatTime(report.bundle.created)}`);
		add(`类型：${report.bundle.mode === 'full' ? '完整副本' : '更新包'}`
			+ `，${report.bundle.entryCount} 个文件、${formatBytes(report.bundle.payloadBytes)}`);
		if (report.bundle.deletedCount > 0) add(`包里标记了 ${report.bundle.deletedCount} 个删除`);
		// 文件夹也要说清楚：只报文件的话，用户永远不知道目录这边差多少
		add(`文件夹：包里 ${report.bundleDirCount} 个 · 本地 ${report.localDirCount} 个`
			+ ` · 两边都有 ${report.foldersInSync} 个`
			+ `${report.bundle.emptyDirCount > 0 ? `（其中 ${report.bundle.emptyDirCount} 个是空文件夹）` : ''}`
			+ `${report.bundleDirsUnknown ? '（旧版包没记空文件夹，只能数到有文件的那些）' : ''}`);

		// 两种包都说清"应用完会变成什么样"：严格档下这是确定的
		// （更新包的起点必须与本机站的基准点完全相等，`checkAncestor` 拦在前面）
		if (report.bundle.mode !== 'full') {
			this.reportEl.createEl('p', {
				text: '更新包：只装自起点那一点以来变过的文件。应用方式是严格同步 —— '
					+ '包里点名的用包里的版本、点名的删除照删，其余按"你站的基准点 ＋ 这些条目 − 这些删除"补全'
					+ '（不在这份状态里的本地文件挪进回收目录）。',
				cls: 'locally-save-hint',
			});
		} else {
			this.reportEl.createEl('p', {
				text: '完整副本：完全镜像 —— 包里没有的本地文件全挪进回收目录，'
					+ '仓库会变成和那个包一模一样（本机改过的、自己新建的都不留）。',
				cls: 'locally-save-hint',
			});
		}

		// 旧版本导的包：它没记空文件夹，所以这次目录只建不删（否则会删错）
		if (report.bundleDirsUnknown) {
			this.reportEl.createEl('p', {
				text: '⚠ 旧版本导的包（没记空文件夹）：文件夹这次只建不删',
				cls: 'locally-save-warn',
			});
		}

		// 基准：两台机器互相发包时，"是不是接着同一份完整副本"决定了这次应用确不确定。
		const baseGen = plan.info.header.baseGeneration;
		const baseGenText = baseGen === null ? '第 ? 代' : `第 ${baseGen} 代`;
		if (report.bundle.mode !== 'full') {
			if (report.viaMine) {
				// 合并相邻更新包之后常见：链条上只剩两端的点，而我站在被吞掉的某一个点上
				this.reportEl.createEl('p', {
					text: `✓ 这个包从第 ${baseGenText} 送到第 ${plan.info.header.targetGeneration} 代，`
						+ '你站的这一点正好在它的路线上：应用它会直接把你送到终点（中间那几环不用补）。',
					cls: 'locally-save-hint',
				});
			} else if (report.baselineMatch === 'match') {
				this.reportEl.createEl('p', {
					text: `基准：✓ 与这个包同一份完整副本（${baseGenText}）—— 接着应用是确定的`,
					cls: 'locally-save-hint',
				});
			} else if (report.targetIsMine) {
				// 这个包要送到的地方**正好就是我现在的基准**：它点名要送的东西我全都有。
				// 实测遇到过：对方把"32 → 36"的包发给一台已经站在 36 上的机器，
				// 那边只看到"基准对不上"，看不出其实是白跑一趟 —— 这里说清并给出下一步。
				this.reportEl.createEl('p', {
					text: `✓ 这个包要送到的那份完整副本（第 ${plan.info.header.targetGeneration} 代 · 基准 ${report.targetBaseline}）`
						+ '就是你这边的基准：里面没有你缺的内容，应用它不会改动任何文件。'
						+ `要拿对方后来的改动，让他按你这边的基准指纹 ${report.myBaseline ?? '未知'} 重新导一份`,
					cls: 'locally-save-hint',
				});
			} else if (report.baselineMatch === 'mismatch') {
				this.reportEl.createEl('p', {
					text: `⚠ 基准对不上：包基于「${report.bundleBaseline}」，你这边是「${report.myBaseline}」。`
						+ '应用完你会落到这个包送到的状态，而不是从你现在的基准往外延伸。'
						+ `让对方按你这边的基准指纹 ${report.myBaseline ?? '未知'} 重导一份（认指纹，别只看第几代）`,
					cls: 'locally-save-warn',
				});
				const actions = this.reportEl.createDiv({ cls: 'locally-save-bundle-actions' });
				const copy = actions.createEl('button', { text: '复制指纹发给对方', cls: 'locally-save-mini' });
				copy.addEventListener('click', () => {
					void copyLine(
						`我这边的基准指纹是 ${report.myBaseline ?? '未知'}（仓库「${this.plugin.vaultName()}」）。`
						+ '你导更新包时把「从哪个状态开始」选成这个指纹那一项。',
					);
				});
				const align = actions.createEl('button', {
					text: '导出一份完整副本发过去…',
					cls: 'locally-save-mini',
				});
				align.addEventListener('click', () => {
					new ExportBundleModal(this.app, this.plugin, { wantChanges: false, wantFull: true }).open();
				});
			} else {
				this.reportEl.createEl('p', {
					text: '基准：说不清（旧版包没记指纹，或本机还没应用过完整副本）—— 这次逐文件合并',
					cls: 'locally-save-hint',
				});
			}
		} else {
			this.reportEl.createEl('p', {
				text: `基准：应用之后，你这台就以这份完整副本为基准（第 ${plan.info.header.targetGeneration} 代）。`
					+ '完整副本是镜像，不合并：包里没有的本地文件会挪进回收目录（捞得回来），'
					+ '本机改过的会被包里那一版覆盖（旧的同样进回收目录）—— 应用完这个仓库就是那个包。'
					+ '这样两边的基准是同一份东西，之后互发更新包才不会对不上。',
				cls: 'locally-save-hint',
			});
		}

		// 状态编号：包里记着"导出方导完那一刻整个仓库长什么样"。应用完这边会算一个自己的跟它比，
		// **一样就是两边文件内容一致** —— 世代号（只说第几版）和基准指纹（只说明祖先是同一份）
		// 都回答不了这句话，用户专门提过要这么个编号。
		if (report.peerStateId) {
			this.reportEl.createEl('p', {
				text: `包里的状态编号：${describeStateId(report.peerStateId)} —— 应用完算一个自己的跟它比，一样就是完全一致`,
				cls: 'locally-save-hint',
			});
		} else {
			this.reportEl.createEl('p', {
				text: '旧版包没记状态编号，应用完没法对账',
				cls: 'locally-save-hint',
			});
		}

		// 没有可做的事就**大声说出来**：用户看到"写入 0、跳过 1"很容易以为应用失败了
		// （报过：拿到对方发来的包、打开一看"没应用"，其实本地早就是那一版了）
		if (plan.actions.length === 0 && plan.foldersToRemove.length === 0) {
			this.reportEl.createEl('p', {
				text: `✓ 包里的东西你这边都已经有了（${report.synchronized}/${report.bundle.entryCount} 个文件一致），`
					+ '应用它不会改动任何文件',
				cls: 'locally-save-hint',
			});
		}

		// 包里**点名了哪些文件**：折叠着列出来。
		// 为什么值得占这块地方：用户报过"更新里明明写了 X，却没应用" ——
		// 一看这个列表就知道"包里压根没有那个文件"，不用去猜是应用失败还是对方没打包。
		const entries = plan.info.header.entries;
		const deletedNames = plan.info.header.deleted.map(item => item.path);
		if (entries.length > 0 || deletedNames.length > 0) {
			const details = this.reportEl.createEl('details', { cls: 'locally-save-details' });
			const listed = Math.min(entries.length, MAX_LISTED);
			details.createEl('summary', {
				text: `包里点名了这 ${entries.length} 个文件`
					+ `${deletedNames.length > 0 ? `，另有 ${deletedNames.length} 个删除` : ''}`
					+ '（展开看清单 —— 找不到你关心的那个，就是对方没打包它）',
			});
			const list = details.createEl('ul', { cls: 'locally-save-facts' });
			for (const entry of entries.slice(0, listed)) {
				list.createEl('li', { text: `${entry.path}（${formatBytes(entry.size)}）` });
			}
			if (entries.length > listed) {
				list.createEl('li', { text: `…… 其余 ${entries.length - listed} 个已省略`, cls: 'locally-save-more' });
			}
			for (const path of deletedNames.slice(0, MAX_LISTED)) {
				list.createEl('li', { text: `删除：${path}`, cls: 'locally-save-warn' });
			}
			if (deletedNames.length > MAX_LISTED) {
				list.createEl('li', { text: `…… 其余 ${deletedNames.length - MAX_LISTED} 个删除已省略`, cls: 'locally-save-more' });
			}
		}

		// 同步程度：接收方最关心的一个数（文件与文件夹分开说，别只报文件）
		this.reportEl.createEl('h3', { text: `同步程度 ${report.syncPercent}%` });
		this.reportEl.createEl('p', {
			text: `${report.synchronized} / ${report.bundle.entryCount} 个文件已经和本地一致`
				+ `；文件夹 ${report.foldersInSync} / ${report.bundleDirCount} 个已经在两边都有`,
			cls: 'locally-save-hint',
		});

		const detail = this.reportEl.createEl('ul', { cls: 'locally-save-facts' });
		const line = (text: string) => detail.createEl('li', { text });
		line(`新增 ${report.adds} 个`);
		line(`覆盖 ${report.overwrites} 个`);
		if (report.forcedOverwrites > 0) {
			line(`其中 ${report.forcedOverwrites} 个是本地也改过的（严格同步用包里那一版覆盖，本地那份进回收目录）`);
		}
		if (report.historyMatches > 0) {
			line(`其中 ${report.historyMatches} 个：本地停在对方发过的中间版本上，直接覆盖`);
		}
		if (report.conflicts > 0) line(`本地也改过、会留冲突副本的：${report.conflicts} 个`);
		if (report.deletes > 0) line(`删除 ${report.deletes} 个（本地未改动过的）`);
		if (report.keptDeletes > 0) line(`包里要求删、但本地改过所以保留的：${report.keptDeletes} 个`);
		if (report.extraDeletes > 0) line(`本地有、包里没有、且对方删过的：${report.extraDeletes} 个`);
		if (report.moves > 0) line(`改名 / 移动 ${report.moves} 个`);
		if (report.foldersToCreate > 0) line(`补建 ${report.foldersToCreate} 个文件夹`);
		if (report.foldersToRemove > 0) line(`删掉 ${report.foldersToRemove} 个本地空文件夹`);
		if (report.foldersKept > 0) line(`留着 ${report.foldersKept} 个本地文件夹：磁盘上还有东西（多半被排除规则挡住了）`);

		// 两台机器互相发包时，每台只握着改动的一半 —— 应用前就把"我这半还剩多少"摊开
		if (report.pendingChanges !== null && (report.pendingChanges > 0 || (report.pendingDeletes ?? 0) > 0)) {
			line(`你这边还有 ${report.pendingChanges} 个改动`
				+ `${(report.pendingDeletes ?? 0) > 0 ? `、${report.pendingDeletes} 个删除` : ''}`
				+ '是对方没有的 —— 下次导出更新包会一起带过去');
		}

		// 走哪条路、按什么规则处理
		this.reportEl.createEl('h3', { text: '会怎么处理' });
		this.reportEl.createEl('p', {
			text: '严格同步：包里点名的文件一律用包里的版本、点名的删除照删、'
				+ '本地多出来的（包送到的状态里没有的）也挪进回收目录；'
				+ '动到的东西全在回收目录里（仓库/.trash/locally-save），捞得回来。',
			cls: 'locally-save-hint',
		});

		const mode = this.reportEl.createEl('p');
		if (report.mode === 'fast') {
			mode.setText('方式：按包直接写入（你与这个包站在同一份基准上）');
		} else {
			mode.setText('方式：逐文件比对（逐个确认本地那一份是不是还停在包所基于的版本上）');
		}
		mode.addClass('locally-save-hint');

		if (!report.sameLineage) {
			this.reportEl.createEl('p', {
				text: '注意：这个包不是接着你现在的基准点长的（多半来自另一台独立打包的机器）。'
					+ '应用它之后，你会以它为准。',
				cls: 'locally-save-warn',
			});
		}
		if (!report.parentMatches && report.bundle.mode === 'changes') {
			this.reportEl.createEl('p', {
				text: '这个包不是接在你上次应用的那一点后面（中间少了那几环）。链条断了插件不猜着合 —— 先把缺的包补齐。',
				cls: 'locally-save-hint',
			});
		}
		if (report.generationGap !== null && report.generationGap > 0) {
			this.reportEl.createEl('p', {
				text: `⚠ 本机还没站到这个包所基于的那个基准点上（差 ${report.generationGap} 代）。`
					+ '链条中间断了插件会直接拒绝；请对方把中间缺的那几环一起发过来（或从本机这个点重导一份）。',
				cls: 'locally-save-warn',
			});
		}
	}

	private async apply(): Promise<void> {
		const plan = this.plan;
		const file = this.current;
		if (!plan || !file) return;

		// 防呆第三层：真要删文件 / 覆盖本地改动之前，把账摊开让人再点一次
		if (isDestructivePlan(plan)) {
			new ConfirmApplyModal(this.app, plan, () => { void this.runApply(); }).open();
			return;
		}
		await this.runApply();
	}

	/**
	 * 应用完的一句话：**我这台的状态编号 vs 包里记的那个**。
	 *
	 * 相同 ＝ 两边的文件内容一致（用户要的就是这个结论）；不同 ＝ 多半是我这边还有对方没有的
	 * 改动（那笔"欠回传"，报告里也列了）；旧包没记 → 如实说"比不了"，不硬下结论。
	 */
	private stateIdSentence(result: ApplyResult, peer: StateIdInfo | null): string {
		const mine = `状态 ${result.stateId.id}`;
		switch (result.stateIdCompare) {
			case 'match':
				return `✓ 跟对方完全一致（${mine}）`;
			case 'mismatch':
				// 严格档下"差"的原因很具体：包没提到、而你又改过的那些文件（包里没有它们的字节）
				// —— 它们会随你下次导出的更新包过去，对方应用完两边就一致了
				return `${mine}，跟对方导出时的 ${peer?.id ?? '?'} 还差一点`
					+ '（包没提到、而你又改过的那些文件；下次导出更新包会带上，对方应用完就一致了）';
			default:
				return `${mine}（对方那个包没记编号，比不了）`;
		}
	}

	/**
	 * **动手前先把"我这边的东西"存成一个包**（用户要的："本地最新更新保存为一个更新包"）。
	 *
	 * 引擎那边负责起点与内容（`export.ts` 的 `parkLocalChangesFor`）：
	 * 起点＝**这份包送到的那一点**，内容＝我现在的仓库，并且不推进我这边 ——
	 * 于是这一环就是「**新点 → 新点 ＋ 我的东西**」：本地改过/删过/新建而在包里没提到的那些，
	 * 全在里面。我自己应用它＝在新点上把东西加回来，发给对方（他正站在同一点上）＝同理。
	 *
	 * **返回 null ＝ 我这边跟那个点没有任何差别，没什么可存的**（不是失败）。
	 */
	private async parkLocalChanges(plan: ApplyPlan): Promise<string | null> {
		const outcome = await parkLocalChangesFor({
			settings: this.plugin.settings,
			log: this.plugin.log,
			vaultRoot: this.plugin.vaultRoot(),
			vaultName: this.plugin.vaultName(),
			stateFile: this.plugin.stateFile(),
			mode: 'changes',
			outDir: this.effectiveDir(),
			configDir: this.plugin.configDir(),
			onProgress: (done, total, path) => this.plugin.reportProgress({ done, total, path, label: '导出中' }),
		}, { header: plan.info.header, pointBefore: plan.pointBefore });
		return outcome.file;
	}

	private async runApply(): Promise<void> {
		const plan = this.plan;
		const file = this.current;
		if (!plan || !file) return;
		this.reportEl.setText('正在应用……');
		try {
			/**
			 * 严格档会覆盖 / 挪走我这边的东西 → 先把"我这一半"存成一个包。
			 *
			 * **每次都试着存**（不再看 `pendingChanges` 那个数）：那个数是"相对我自己的点"算的，
			 * 完整副本那一趟会漏（见 `parkLocalChanges`）；真没什么可存时这一趟只是白扫一遍，
			 * 会直接告诉我们"没有差别"（返回 null），不写空包。
			 */
			const strict = plan.report.strictness === 'mirror' || plan.report.strictness === 'bundle-wins';
			let parked: string | null = null;
			if (strict) {
				this.reportEl.setText('正在把你这边的东西先存成一个包……');
				parked = await this.parkLocalChanges(plan);
				this.reportEl.setText('正在应用……');
			}
			const result = await executeBundlePlan(plan, {
				settings: this.plugin.settings,
				log: this.plugin.log,
				vaultRoot: this.plugin.vaultRoot(),
				stateFile: this.plugin.stateFile(),
				file,
				configDir: this.plugin.configDir(),
				keepBackup: plan.options.keepBackup,
				onProgress: (done, total, path) => this.plugin.reportProgress({ done, total, path, label: '应用中' }),
			});
			this.plugin.reportProgress(null);
			this.plugin.statusBar.setSummary(
				`同步包已应用（写入 ${result.written}`
				+ `${result.foldersCreated > 0 ? `、文件夹 ${result.foldersCreated}` : ''}）`,
			);

			const parts = [`写入 ${result.written}`, `跳过 ${result.skipped}`];
			if (result.conflicts > 0) parts.push(`冲突 ${result.conflicts}`);
			if (result.deleted > 0) {
				parts.push(`删除 ${result.deleted}`
					+ (plan.report.localExtras > 0 ? `（其中 ${plan.report.localExtras} 个是你本地多出来的）` : ''));
			}
			const overwritten = plan.report.forcedOverwrites;
			if (overwritten > 0) parts.push(`覆盖你改过的 ${overwritten} 个（你那一版挪进了回收目录）`);
			if (result.moved > 0) parts.push(`改名 ${result.moved}`);
			if (result.foldersCreated > 0) parts.push(`新建文件夹 ${result.foldersCreated}`);
			if (result.foldersRemoved > 0) parts.push(`清理空文件夹 ${result.foldersRemoved}`);
			if (result.failed.length > 0) {
				// 失败的要**列出来**，只说"失败 N 个"等于没说
				const shown = result.failed.slice(0, 5).map(item => `${item.path}（${item.error}）`);
				const more = result.failed.length > shown.length ? ` …… 等 ${result.failed.length} 个` : '';
				parts.push(`失败 ${result.failed.length}：${shown.join('；')}${more}`);
			}

			// 欠账式回传：**不立刻生成回礼包**（对方收到又生成一个，两边互相套娃 —— 用户报过）。
			// 只在通知里提一句"你这边还有 N 个改动没发出去"，它们会随下次导出更新包一起带过去。
			// （`parked` 那条路例外：改动已经进包了，说"没发出去"没意义）
			const owed = (plan.report.pendingChanges ?? 0) + (plan.report.pendingDeletes ?? 0);
			if (owed > 0 && !parked) parts.push(`你这边还有 ${owed} 个改动没发出去（下次导出更新包会一起带上）`);

			// 我这一半的去处：存下来的那一环**起点就是刚应用到的这个点**，
			// 所以我自己应用它＝把东西加回来，发给对方（他站在同一点上）应用＝同理
			if (parked) {
				parts.push(`你这边的改动已存成 ${parked}（接在刚应用到的这个基准点上：`
					+ '你自己应用它就加回来，发给对方、他站在同一点上应用也一样）');
			} else if (strict) {
				parts.push('你这边跟那个点本来就没有差别，所以没有另存包');
			}

			// 状态编号那句话必须进通知：应用完这个窗口就关了，报告里的字用户看不到 ——
			// "两边到底一不一样"就是他最想知道的那句。
			const sameSentence = this.stateIdSentence(result, plan.report.peerStateId);

			// 什么都没写 / 没删 / 没建：说明本来就已经是包里那一版了，
			// 别报成"写入 0、跳过 N"那样让人以为应用失败了
			const didNothing = result.written === 0 && result.deleted === 0 && result.moved === 0
				&& result.foldersCreated === 0 && result.foldersRemoved === 0;
			if (didNothing && result.failed.length === 0) {
				new Notice(
					`同步包里的内容本来就已经在本地了（${result.skipped} 个文件一致），没有改动任何东西`
					+ `；${sameSentence}`,
					8000,
				);
			} else {
				new Notice(`同步包已应用：${parts.join('、')}；${sameSentence}`, 9000);
			}
			this.close();
		} catch (error) {
			this.plugin.reportProgress(null);
			const message = error instanceof Error ? error.message : String(error);
			this.reportEl.setText(`应用失败：${message}`);
			new Notice(`应用同步包失败：${message}`, 8000);
			this.plugin.log.error('应用同步包失败', error);
		}
	}

	onClose(): void {
		this.unwireDropTarget();
		this.plugin.reportProgress(null);
		this.contentEl.empty();
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 复制一句话到剪贴板（**只写不读**，跟列表里那个「复制路径」同一条路子）。
 * 用途：基准对不上时，把这边的指纹原样发给对方 —— 让他照着选起点，比来回描述省事。
 */
async function copyLine(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		new Notice(`已复制：${text}`, 12000);
	} catch {
		new Notice(`没能写进剪贴板，这句话是：${text}`, 15000);
	}
}

/**
 * 应用前的确认框。
 *
 * 只在"真会动到本地已有的东西"时才弹（删文件 / 覆盖本地改动）——
 * 平时应用一个纯新增的包不该被打断。弹的时候把账摊开：删几个、覆盖几个、去哪了。
 */
class ConfirmApplyModal extends Modal {
	private plan: ApplyPlan;
	private onConfirm: () => void;

	constructor(app: App, plan: ApplyPlan, onConfirm: () => void) {
		super(app);
		this.plan = plan;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		const { report } = this.plan;
		contentEl.empty();
		contentEl.addClass('locally-save-modal');
		contentEl.createEl('h2', { text: '确认应用：会动到本地已有的文件' });

		const deleting = this.plan.actions.filter(action => action.kind === 'delete').map(action => action.path);
		const paths = deleting;

		const facts = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		facts.createEl('li', {
			text: `两边都改过的：${report.conflicts} 个（用包里那一版覆盖，你改过的那份挪进回收目录）`,
		});
		if (report.forcedOverwrites > 0) {
			facts.createEl('li', { text: `会覆盖 ${report.forcedOverwrites} 个本地改动过的文件` });
		}
		if (paths.length > 0) {
			facts.createEl('li', {
				text: `会删除 ${paths.length} 个本地文件`
					+ (report.localExtras > 0
						? `（其中 ${report.localExtras} 个是你本地多出来的：包里送到的状态里没有它们）`
						: ''),
			});
		}
		if (this.plan.foldersToRemove.length > 0) {
			facts.createEl('li', {
				text: `会删掉 ${this.plan.foldersToRemove.length} 个本地空文件夹（包里没有它们）`,
			});
		}
		facts.createEl('li', {
			text: report.keepBackup
				? '被覆盖 / 删掉 / 冲突输掉的本地版本都会进回收目录（仓库/.trash/locally-save），还能捞回来'
				: '⚠ 回收目录已关：被覆盖 / 删掉的本地版本会直接消失',
		});

		if (paths.length > 0) {
			contentEl.createEl('h3', { text: '会被删掉的文件' });
			const list = contentEl.createDiv({ cls: 'locally-save-list' });
			for (const item of paths.slice(0, MAX_ROWS)) {
				list.createDiv({ text: item, cls: 'locally-save-row is-delete' });
			}
			if (paths.length > MAX_ROWS) {
				list.createDiv({ text: `…… 其余 ${paths.length - MAX_ROWS} 个已省略`, cls: 'locally-save-more' });
			}
		}

		if (this.plan.foldersToRemove.length > 0) {
			contentEl.createEl('h3', { text: '会被删掉的空文件夹' });
			const list = contentEl.createDiv({ cls: 'locally-save-list' });
			for (const item of this.plan.foldersToRemove.slice(0, MAX_ROWS)) {
				list.createDiv({ text: `${item}/`, cls: 'locally-save-row is-delete' });
			}
			contentEl.createEl('p', {
				text: '只删空的：里面但凡还有东西就删不动（用的是 rmdir，不是递归删除）。',
				cls: 'locally-save-hint',
			});
		}

		new Setting(contentEl)
			.addButton(button => button
				.setButtonText('取消')
				.onClick(() => this.close()))
			.addButton(button => {
				button.setButtonText('确认应用');
				markDestructive(button);
				button.onClick(() => {
					this.close();
					this.onConfirm();
				});
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
