import { Modal } from 'obsidian';
import type { App } from 'obsidian';

/**
 * 「同步包怎么用」说明窗口。
 *
 * 为什么要专门做个窗口：同步包是**跨机器**用的，光看设置里那几行说明很难拼出
 * 完整流程（在哪台机器上点哪个、包里到底装了什么、什么时候该用完整副本）。
 * 与其让人去翻 README，不如在设置面板里直接放个按钮。
 */
export class BundleHelpModal extends Modal {
	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('locally-save-modal');
		contentEl.createEl('h2', { text: '同步包怎么用' });

		contentEl.createEl('h3', { text: '两条通道，别混' });
		const channels = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		channels.createEl('li', {
			text: '本地同步：同一台机器上，仓库 ↔ 某个文件夹副本。走文件系统，几百 MB 只要几秒',
		});
		channels.createEl('li', {
			text: '同步包：把仓库（或改动）装进**一个文件**，用 U 盘 / 网盘 / 聊天软件搬到另一台机器上应用',
		});

		contentEl.createEl('h3', { text: '三步走' });
		const steps = contentEl.createEl('ol', { cls: 'locally-save-facts' });
		steps.createEl('li', {
			text: '在这台机器上导出：下面的「导出同步包…」按钮，或命令面板里的同名命令',
		});
		steps.createEl('li', {
			text: '把生成的 .lsave 文件拷到另一台机器（U 盘、网盘、聊天软件，怎么拷都行）',
		});
		steps.createEl('li', {
			text: '在那台机器上应用：下面的「打开同步包并应用…」按钮 → 选中文件 → 先看报告 → 再点应用',
		});

		contentEl.createEl('h3', { text: '两种包，什么时候用哪个' });
		const pick = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		pick.createEl('li', {
			text: '完整副本：整个仓库。第一次给对方、或者对方那边搞乱了要整份恢复时用。体积大，每次都要重写一遍',
		});
		pick.createEl('li', {
			text: '仅改动：只装自上次导出后变过的文件，外加一份删除清单。天天来回搬用这个，通常只有几十 KB 到几 MB',
		});
		pick.createEl('li', {
			text: '两个自动开关各自独立，可以只开"改动包"，也可以都开（都开时先导改动包、再导完整包）',
		});

		contentEl.createEl('h3', { text: '打开包那一步是只读的' });
		contentEl.createEl('p', {
			text: '选中包之后，插件先算一遍再给你看：同步程度（本地与包已经一致的比例）、'
				+ '会新增 / 覆盖 / 冲突 / 删除各几个、走快速通道还是逐文件合并、中间有没有漏包。'
				+ '这一整步不会碰你的文件；确认无误，"应用"按钮才可点。',
			cls: 'locally-save-hint',
		});

		contentEl.createEl('h3', { text: '会不会把我的东西弄丢' });
		const safe = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		safe.createEl('li', { text: '本地也改过的文件：留成「冲突副本」，两份都在，新的那份占原名' });
		safe.createEl('li', { text: '包里要求删、但本地改过的：**不删**（删除必须过基准检查，没有例外）' });
		safe.createEl('li', { text: '完整包应用时"删除多余文件"：只删比包旧的，比包新的不动 —— 那多半是这边刚写的' });
		safe.createEl('li', { text: '包在传输中弄坏了：尾部有整段负载的校验和，对不上直接拒绝，不会写进仓库' });

		contentEl.createEl('h3', { text: '为什么有时提示"漏了包"' });
		contentEl.createEl('p', {
			text: '每个包都记着它是从第几代导出的。对方跳过了一个包、直接应用后面的，插件会看出一代对不上，'
				+ '于是**降级成逐文件合并**（而不是拒绝服务）：能安全写的就写，本地也改过的留冲突副本。'
				+ '想彻底对齐，让对方导一份完整副本即可。',
			cls: 'locally-save-hint',
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
