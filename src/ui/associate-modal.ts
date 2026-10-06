import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import { associationSupported, installCommands } from './associate';
import { applyFileAssociation, describeCommandError, removeFileAssociation } from './associate-runner';
import { bundleLink } from './protocol';

/**
 * 「用 Obsidian 直接打开同步包」的设置窗口。
 *
 * 把要做的事**明明白白摊开**：改哪两处注册表、跑哪几条命令、需不需要管理员权限。
 * 让人对着命令点"确定"，而不是点一个黑盒按钮。
 */
export class AssociateModal extends Modal {
	/** 当前 vault 名：必须写进 URI，Obsidian 靠它决定交给哪个 vault */
	private vaultName: string;
	private statusEl: HTMLElement | null = null;

	constructor(app: App, vaultName: string) {
		super(app);
		this.vaultName = vaultName;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('locally-save-modal');
		contentEl.createEl('h2', { text: '用 Obsidian 直接打开同步包' });

		contentEl.createEl('p', {
			text: '设置之后，双击 .lsave 文件就会用 Obsidian 打开、直接弹出应用对话框。',
		});
		contentEl.createEl('p', {
			text: '注意：单纯把 .lsave「用 Obsidian 打开」是不通的 —— Obsidian 收到一个陌生路径只会'
				+ '当成未知文件，压根到不了插件。能到插件的只有 URI 链接，'
				+ '而且链接里必须写明交给哪个 vault（插件属于某个 vault）：',
			cls: 'locally-save-hint',
		});
		contentEl.createEl('p', { text: bundleLink('%1', this.vaultName), cls: 'locally-save-path' });
		contentEl.createEl('p', {
			text: `这次会关联到 vault「${this.vaultName}」。换 vault 或者改过仓库文件夹名的话，重新点一次即可。`,
			cls: 'locally-save-hint',
		});

		if (!associationSupported()) {
			contentEl.createEl('p', {
				text: '当前平台不支持一键设置（这里只做了 Windows）。macOS / Linux 请手工把 .lsave '
					+ '关联到上面这个链接；也可以直接把包拖到 Obsidian 窗口上，效果一样。',
				cls: 'locally-save-warn',
			});
			new Setting(contentEl).addButton(button => button
				.setButtonText('关闭')
				.onClick(() => this.close()));
			return;
		}

		contentEl.createEl('h3', { text: '会改什么' });
		const facts = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		facts.createEl('li', { text: '只写当前用户的注册表（HKCU\\Software\\Classes），不需要管理员权限' });
		facts.createEl('li', { text: '会覆盖你现有的 .lsave 关联；解除时可以再拆掉' });
		facts.createEl('li', { text: '不碰系统级设置，也不影响别的文件类型' });

		contentEl.createEl('h3', { text: '要跑的命令' });
		const list = contentEl.createDiv({ cls: 'locally-save-list' });
		for (const command of installCommands(process.execPath, this.vaultName)) {
			list.createDiv({
				text: `${command.file} ${command.args.join(' ')}`,
				cls: 'locally-save-row',
			});
		}

		this.statusEl = contentEl.createEl('p', { cls: 'locally-save-hint' });

		new Setting(contentEl)
			.addButton(button => button
				.setButtonText('设置关联')
				.setCta()
				.onClick(() => { void this.install(); }))
			.addButton(button => button
				.setButtonText('解除关联')
				.onClick(() => { void this.uninstall(); }))
			.addButton(button => button
				.setButtonText('关闭')
				.onClick(() => this.close()));
	}

	private async install(): Promise<void> {
		this.statusEl?.setText('正在写注册表……');
		try {
			await applyFileAssociation(this.vaultName);
			this.statusEl?.setText('设置完成：现在双击 .lsave 就会用 Obsidian 打开并弹出应用对话框');
			new Notice('已把 .lsave 关联到 Obsidian：双击即可打开同步包', 8000);
		} catch (error) {
			const message = describeCommandError(error);
			this.statusEl?.setText(`设置失败：${message}`);
			new Notice(`设置关联失败：${message}`, 9000);
		}
	}

	private async uninstall(): Promise<void> {
		this.statusEl?.setText('正在解除关联……');
		try {
			await removeFileAssociation();
			this.statusEl?.setText('已解除：.lsave 现在回到"没有关联"的状态');
			new Notice('已解除 .lsave 的文件关联', 6000);
		} catch (error) {
			const message = describeCommandError(error);
			this.statusEl?.setText(`解除失败：${message}`);
			new Notice(`解除关联失败：${message}`, 9000);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
