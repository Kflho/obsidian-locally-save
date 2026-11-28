import { Modal } from 'obsidian';
import { setupModal } from './modal-layout';

/**
 * 「同步包怎么用」说明窗口：插件自带的使用手册。
 *
 * 写法要求：
 * - 用科技语体，一句一个动作或结论；
 * - 只用界面术语：完整备份、更新包、内容编号、版本、回收站；
 * - 不出现内部字段名、函数名、「基准 / 校验值 / 对表」这类内部说法；
 * - 长解释放这里，设置面板里的说明保持一句。
 */
export class BundleHelpModal extends Modal {
	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		setupModal(this);
		contentEl.createEl('h2', { text: '同步包使用说明' });

		contentEl.createEl('h3', { text: '用途' });
		this.paragraph('插件把整个仓库或改动的部分导出为一个 .lsave 文件，复制到另一台电脑应用。'
			+ '传输过程不联网，不需要账号，也不会在后台自动同步。');
		this.paragraph('如果两台电脑需要共用一个文件夹并持续同步，请使用 Remotely Save 等方案；本插件不提供这种用法。');

		contentEl.createEl('h3', { text: '第一次使用' });
		const steps = contentEl.createEl('ol', { cls: 'locally-save-facts' });
		steps.createEl('li', { text: '两台电脑都打开 设置 → 同步包，填写「同步包文件夹」。这个文件夹放在仓库之外。' });
		steps.createEl('li', { text: '在其中一台电脑上打开「导出同步包」，勾选「完整备份」并导出。这份完整备份是之后更新包的起点。' });
		steps.createEl('li', { text: '把 .lsave 文件复制到另一台电脑，拖到 Obsidian 窗口，或打开「应用同步包」并选择这个文件。' });
		steps.createEl('li', { text: '先查看应用结果，确认新增、覆盖、删除的文件数，再点「应用」。' });

		contentEl.createEl('h3', { text: '两种同步包' });
		const kinds = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		kinds.createEl('li', { text: '完整备份：包含整个仓库，存放在 full 文件夹。第一次传输、创建还原点、更换更新包起点时使用。' });
		kinds.createEl('li', { text: '更新包：只包含自上次完整备份以来改动的文件，存放在 changes 文件夹。日常传输使用。' });
		kinds.createEl('li', { text: '更新包必须与接收方使用同一份完整备份；完整备份较大，不通过 Git 传输。' });

		contentEl.createEl('h3', { text: '在两台电脑之间传输' });
		this.paragraph('两台电脑各自只掌握自己的一半改动，因此完整同步需要两趟：');
		const trips = contentEl.createEl('ol', { cls: 'locally-save-facts' });
		trips.createEl('li', { text: 'A 导出同步包，B 应用。' });
		trips.createEl('li', { text: 'B 导出同步包，A 应用。' });
		this.paragraph('B 应用后，插件会记录「本电脑还有 N 处改动没有发出」。下次导出更新包时，这些改动会包含在包中。');

		contentEl.createEl('h3', { text: '确认本电脑与其他电脑内容一致' });
		const check = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		check.createEl('li', { text: '每台电脑都有一个内容编号。两台电脑的内容编号相同时，文件内容一致。' });
		check.createEl('li', { text: '内容编号在导出或应用之后更新。' });
		check.createEl('li', { text: '点击状态栏中的插件状态，或打开「各台电脑的同步状态」，可以查看内容编号与最后上报时间。' });

		contentEl.createEl('h3', { text: '更换完整备份' });
		const rebase = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		rebase.createEl('li', { text: '要让本电脑改用另一份完整备份，在「应用同步包」中选择它并应用。应用后，之后的更新包从这份完整备份算起。' });
		rebase.createEl('li', { text: '其他电脑仍在使用旧完整备份时，先在「管理同步包」中导出一份从旧完整备份到新完整备份的更新包。' });
		rebase.createEl('li', { text: '确认没有电脑再使用旧完整备份后，可以清理它。旧的完整备份移到回收站，可从回收站恢复。' });

		contentEl.createEl('h3', { text: '应用规则' });
		const rules = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		rules.createEl('li', { text: '完整备份：完全按包覆盖本电脑。应用后，仓库内容与包一致。' });
		rules.createEl('li', { text: '更新包：只修改包中提到的文件；包中没有提到的文件保持不变。' });
		rules.createEl('li', { text: '本电脑多出的文件、被覆盖的旧版本与冲突的内容，都移到回收站。' });
		rules.createEl('li', { text: '应用前先显示结果；确认后才改动文件。' });

		contentEl.createEl('h3', { text: '文件关联' });
		this.paragraph('设置「文件关联」后，双击 .lsave 会用 Obsidian 打开并显示应用对话框。'
			+ '关联只写入当前用户的注册表，不需要管理员权限，可以随时解除。');
		this.paragraph('未设置关联时，把文件拖到 Obsidian 窗口，或在「应用同步包」中选择文件。');

		contentEl.createEl('h3', { text: '常见问题' });
		const faq = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		faq.createEl('li', { text: '提示「从哪一份完整备份开始」：其他电脑的更新包基于另一份完整备份。'
			+ '请其他电脑按本电脑当前使用的完整备份重新导出一份更新包，或先交换完整备份。' });
		faq.createEl('li', { text: '更新包越来越大：累积的改动较多。导出一份新的完整备份并在其他电脑上应用，'
			+ '之后的更新包从新的完整备份算起。' });
		faq.createEl('li', { text: '完整备份不通过 Git 传输：文件较大。请用 U 盘、网盘或聊天软件复制。' });
	}

	private paragraph(text: string): void {
		this.contentEl.createEl('p', { text, cls: 'locally-save-hint' });
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
