import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import {
	addKeyWithGh,
	findSshKey,
	generateSshKey,
	GH_REFRESH_COMMAND,
	ghStatus,
	hostOfRemote,
	isSshRemote,
	testSshHost,
} from './ssh';
import type { GhStatus, SshKey } from './ssh';

/**
 * 「SSH 接入」窗口：找 / 生成密钥、复制公钥、用 GitHub CLI 添加、测 SSH 登录。
 *
 * 能做到哪一步说清楚：**密钥在插件里生成、公钥能一键复制（GitHub 登录过 gh 的话还能一键添加）**；
 * 但"把公钥贴进网页"这一步仍然由用户点（插件不碰用户账号的密码 / token）。
 *
 * 私钥永远不出插件：这里只读 `.pub`。
 */
export class SshKeyModal extends Modal {
	private remote: string;
	private key: SshKey | null = null;
	private gh: GhStatus | null = null;
	private statusEl!: HTMLElement;

	constructor(app: App, remote: string) {
		super(app);
		this.remote = remote.trim();
	}

	onOpen(): void {
		// 先画出来（找密钥是同步的）；gh 的状态是异步的，查到之后补上"一键添加"
		this.key = findSshKey();
		this.render();
		void this.loadGh();
	}

	/** gh 在不在、登录没有、token 有没有 admin:public_key（缺了会 404，得先 gh auth refresh） */
	private async loadGh(): Promise<void> {
		this.gh = await ghStatus();
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'SSH 接入' });

		if (!isSshRemote(this.remote)) {
			contentEl.createEl('p', {
				text: this.remote === ''
					? '还没填「远程地址」：先填一个 SSH 地址（形如 git@github.com:you/repo.git）。'
					: '现在填的是 HTTPS 地址，不需要 SSH 密钥。想用 SSH 的话，把「远程地址」改成 git@… 那种形式。',
			});
			new Setting(contentEl).addButton(button => button
				.setButtonText('关闭')
				.onClick(() => this.close()));
			return;
		}

		const host = hostOfRemote(this.remote) ?? 'github.com';
		contentEl.createEl('p', { text: `远程主机：${host}` });

		if (!this.key) {
			contentEl.createEl('p', { text: '没有找到 SSH 密钥（~/.ssh/id_ed25519 等）。' });
			new Setting(contentEl)
				.setName('生成一把密钥')
				.setDesc('ed25519、无口令。插件在后台同步，不能每次问口令。')
				.addButton(button => button
					.setButtonText('生成')
					.setCta()
					.onClick(() => { void this.generate(); }));
		} else {
			contentEl.createEl('p', { text: `已找到密钥：${this.key.publicPath}` });
			const box = contentEl.createEl('textarea', {
				cls: 'locally-save-ssh-key',
				attr: { readonly: 'true', rows: '4', spellcheck: 'false' },
			});
			box.value = this.key.publicKey;

			new Setting(contentEl)
				.setName('复制公钥')
				.setDesc('粘到 GitHub → Settings → SSH and GPG keys → New SSH key')
				.addButton(button => button
					.setButtonText('复制')
					.setCta()
					.onClick(() => { void this.copyKey(); }));

			if (this.gh?.authed && host === 'github.com') {
				if (this.gh.hasPublicKeyScope) {
					new Setting(contentEl)
						.setName('用 GitHub CLI 添加')
						.setDesc('用已经登录的 gh 把公钥加到你的 GitHub 账户')
						.addButton(button => button
							.setButtonText('添加')
							.onClick(() => { void this.addWithGh(); }));
				} else {
					new Setting(contentEl)
						.setName('用 GitHub CLI 添加')
						.setDesc('gh 已登录，但 token 缺 admin:public_key（添加会报 404）。'
							+ '先在这台机器的终端跑下面这条，然后关掉窗口重开；也可以直接复制公钥到网页。')
						.addButton(button => button
							.setButtonText('复制命令')
							.onClick(() => { void this.copyText(GH_REFRESH_COMMAND); }));
				}
			}

			new Setting(contentEl)
				.setName('测试 SSH 登录')
				.setDesc('只测这把密钥能不能登录远程主机，不改任何东西。'
					+ 'GitHub 不提供 shell，认证成功也可能返回退出码 1，所以这里只看输出里的 '
					+ '“successfully authenticated”。')
				.addButton(button => button
					.setButtonText('测试')
					.onClick(() => { void this.test(host); }));
		}

		if (this.key) {
			contentEl.createEl('p', {
				cls: 'locally-save-hint',
				text: '第一次连接可能会问主机指纹：先在终端里跑一次 ssh -T git@' + host + '，'
					+ '或者点「测试」看报错。',
			});
		}

		this.statusEl = contentEl.createEl('p', { cls: 'locally-save-hint' });
		new Setting(contentEl).addButton(button => button
			.setButtonText('关闭')
			.onClick(() => this.close()));
	}

	private async generate(): Promise<void> {
		this.setStatus('正在生成密钥…');
		const result = await generateSshKey();
		if (result.error) {
			this.setStatus(`生成失败：${result.error}`);
			return;
		}
		this.key = result.key;
		this.render();
		this.setStatus('密钥已生成。把上面的公钥贴到 GitHub（或用 gh 添加），再点「测试」。');
	}

	private async copyKey(): Promise<void> {
		if (!this.key) return;
		await this.copyText(this.key.publicKey, '公钥已复制');
	}

	private async copyText(text: string, message = '命令已复制'): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			new Notice(message);
		} catch (error) {
			this.setStatus(`复制失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async addWithGh(): Promise<void> {
		if (!this.key) return;
		this.setStatus('正在用 gh 添加公钥…');
		const result = await addKeyWithGh(this.key);
		this.setStatus(result.ok
			? `已添加：${result.text}`
			: `添加失败：${result.text}${result.hint ? ` · ${result.hint}` : ''}`);
	}

	private async test(host: string): Promise<void> {
		this.setStatus('正在测试 SSH 登录…');
		const result = await testSshHost(host);
		this.setStatus(result.ok
			? `SSH 登录通过：${result.text}`
			: `SSH 登录没通过：${result.text}${result.hint ? ` · ${result.hint}` : ''}`);
	}

	private setStatus(text: string): void {
		this.statusEl?.setText(text);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
