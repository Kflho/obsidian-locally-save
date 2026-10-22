import { Modal } from 'obsidian';

/**
 * 「同步包怎么用」说明窗口 —— 插件自带的使用手册。
 *
 * 为什么专门做个窗口：同步包是**跨机器**用的，光看设置里那几行说明很难拼出完整流程
 * （在哪台机器上点哪个、包里到底装了什么、什么时候该用完整副本）。
 * 与其让人去翻 README，不如在设置面板里直接放个按钮。
 *
 * 写作要求（评审与用户都看这一份）：
 * - 这里全是**用户视角**的话：不出现内部字段名、函数名、"通道 / 血脉 / 档位"这类术语；
 * - `createEl` 的 text 是纯文本，**不渲染 markdown** —— 要强调就用句子本身，
 *   别写 `**这样**`（会原样显示成一串星号）；
 * - 长解释放这里，设置面板里那几行保持一句话。
 */
export class BundleHelpModal extends Modal {
	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('locally-save-modal');
		contentEl.createEl('h2', { text: '同步包怎么用' });

		contentEl.createEl('h3', { text: '离线搬仓库' });
		contentEl.createEl('p', {
			text: '把一个仓库（或自上次以来改动的那部分）装进一个 .lsave 文件，'
				+ '用 U 盘、网盘或聊天软件搬到另一台电脑上应用。不联网，没有账号，也不会在后台同步。',
			cls: 'locally-save-hint',
		});
		contentEl.createEl('p', {
			text: '如果你要的是“两台机器共用一个目录、一直自动保持一致”，这个插件不做那件事。'
				+ '那种用法交给 Remotely Save + WebDAV 之类的方案更合适。',
			cls: 'locally-save-hint',
		});

		contentEl.createEl('h3', { text: '三步走' });
		const steps = contentEl.createEl('ol', { cls: 'locally-save-facts' });
		steps.createEl('li', {
			text: '两台机器都在设置里填「同步包文件夹」：仓库之外的一个目录，U 盘上的文件夹也行。',
		});
		steps.createEl('li', {
			text: '这台机器导出：用命令「导出同步包…」，或设置里那个按钮。'
				+ '第一次给对方勾「完整副本」，之后日常勾「更新包」。',
		});
		steps.createEl('li', {
			text: '把 .lsave 拷到另一台机器，把文件拖到 Obsidian 窗口上（会自动打开应用对话框并填好路径），'
				+ '或者在「打开同步包并应用…」里选它，先看报告再点应用。',
		});

		contentEl.createEl('h3', { text: '两种包' });
		const pick = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		pick.createEl('li', {
			text: '完整副本：整个仓库，放在 full 子目录。第一次给对方、想留还原点、更新包攒大了换基准，都导它。',
		});
		pick.createEl('li', {
			text: '更新包：只装自起点那份完整副本以来变过的文件，放在 changes 子目录。日常来回搬用它，'
				+ '通常几十 KB 到几 MB。它只有两种：完整副本 → 另一份完整副本（内容取自后者），'
				+ '或者完整副本 → 当前仓库。',
		});
		pick.createEl('li', {
			text: '两个勾选各自独立。都勾时先导完整副本、后导更新包；完整副本刚装走整个仓库，'
				+ '这时的更新包必然是空的，所以不会生成。只想传一个小改动，就只勾更新包。',
		});
		pick.createEl('li', {
			text: '只有完整副本会改变你站的那一份：导出或应用完整副本之后，你就站在它上面，'
				+ '之后的更新包从它算起；导出、应用更新包都不动它。',
		});
		pick.createEl('li', {
			text: '更新包自起点累积，来回搬多了会变大。攒到「高级」页设的大小上限时，'
				+ '插件会提醒你导一份新的完整副本当基准，之后的更新包从新的那份重新算起。',
		});
		pick.createEl('li', {
			text: 'changes 里的更新包默认都留着：完整副本会清掉它取代得了的那些；'
				+ '别的机器发来的那一份留着，那是它那一半改动。',
		});

		contentEl.createEl('h3', { text: '两台机器来回搬要两趟' });
		contentEl.createEl('p', {
			text: '每台机器手上只有自己这半，所以流程是：A 导包 → B 应用 → B 再导一份发回给 A → A 应用，'
				+ '两边才收敛。两边的完整副本始终是同一份：B 应用完、改完自己的东西再导一份，起点还是它，A 收得下。',
			cls: 'locally-save-hint',
		});
		contentEl.createEl('p', {
			text: 'B 那一趟不用手动准备：应用完插件只记一笔“你这边还有 N 个改动没发出去”，'
				+ '下次导出更新包会一起带上，不会一应用就自动生成回礼包。'
				+ '报告里那句「你这边还有 N 个改动是对方没有的」，就是要回传的东西。',
			cls: 'locally-save-hint',
		});
		contentEl.createEl('p', {
			text: '如果 B 在收到包之前已经改了自己的东西：应用时那些改动会被严格同步挪进回收目录，'
				+ '但插件动手前已经先把它们存成了一个更新包（起点是这份包送到的状态，内容只有 B 动过的文件）。'
				+ 'B 自己应用它，或发给 A 应用，两边的改动就凑齐了。'
				+ '两台改到同一个文件时不会自动合并：以包的版本为准，另一版在回收目录里。',
			cls: 'locally-save-hint',
		});

		contentEl.createEl('h3', { text: '怎么确认两边一致：状态编号' });
		contentEl.createEl('p', {
			text: '每个包带一个状态编号（整个仓库内容的短指纹，空文件夹也算）。'
				+ '应用完会再算一个跟它比：一样就是文件内容完全一致（通知里写“跟对方完全一致”）；'
				+ '不一样会写明还差什么，多半是你这边还没发出去的改动。',
			cls: 'locally-save-hint',
		});
		contentEl.createEl('p', {
			text: '命令「同步包更新记录…」顶部一行是现在的编号，每条记录也带着当时的编号。'
				+ '两台记录里最后一条相同，就说明内容一致。编号是上次导出或应用那一刻算的，'
				+ '之后改了文件要等下一次才刷新。世代只说内容走到第几版；认是不是同一份完整副本，看基准指纹。',
			cls: 'locally-save-hint',
		});

		contentEl.createEl('h3', { text: '打开包是只读的' });
		contentEl.createEl('p', {
			text: '选中包后先算一遍：同步程度、会新增、覆盖、删除几个、哪些本地文件会被挪走、'
				+ '包里点名了哪些文件。这一步不碰文件；确认无误，「应用」才可点。'
				+ '真要动到本地已有的东西时，还会再确认一次。',
			cls: 'locally-save-hint',
		});

		contentEl.createEl('h3', { text: '应用只有一种方式：严格同步' });
		contentEl.createEl('p', {
			text: '包里的版本覆盖本地，包里点名删的照删，本地多出来的文件也挪进回收目录。'
				+ '应用完仓库就是包送到的样子，两边的状态编号当场可比。'
				+ '没有“应用方式”可选：合并会合出一个既不等于包、又不等于本机的仓库，'
				+ '下一次的更新包就对不上基准了。',
			cls: 'locally-save-hint',
		});
		contentEl.createEl('p', {
			text: '动手前会先把你的改动存成一个包（确实有对方没有的改动时才存；存不下就不动手）。'
				+ '那个包从“这份包送到的状态”算起：自己应用它，就把改动加回来；'
				+ '发给对方（他也在同一个状态上）应用，改动就叠到他的新版本上。',
			cls: 'locally-save-hint',
		});

		contentEl.createEl('h3', { text: '会不会把东西弄丢' });
		const safe = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		safe.createEl('li', {
			text: '被覆盖、被删掉、被挪走的本地版本一律进回收目录（仓库里的 .trash/locally-save），随时能捞回来。',
		});
		safe.createEl('li', {
			text: '动手前，你这边对方没有的改动会先存成一个更新包；存不下就不应用。',
		});
		safe.createEl('li', {
			text: '包在传输中弄坏了，尾部校验和对不上会被拒绝，不会写进仓库。',
		});
		safe.createEl('li', {
			text: '自动收包按方向走：仅拉收到就应用（本机被覆盖或删掉的进回收目录，也不导出包）；'
				+ '双向先确认、应用完回传本机改动；仅推不收。'
				+ '没开 git 时只自动应用不会动本地已有东西的更新包。',
		});

		contentEl.createEl('h3', { text: '基准对不上怎么办' });
		contentEl.createEl('p', {
			text: '更新包要求起点正好是你站的那份完整副本。对不上时插件不猜着合'
				+ '（猜着合的代价是本机一批文件被当成“对方删过它们”），而是给出三条出路：',
			cls: 'locally-save-hint',
		});
		const ways = contentEl.createEl('ol', { cls: 'locally-save-facts' });
		ways.createEl('li', {
			text: '让对方照你站的这份重导：应用对话框里有「复制指纹发给对方」按钮，'
				+ '对方导出时把「更新包：从哪个状态」选成那一项。',
		});
		ways.createEl('li', {
			text: '让对方把他用的那份完整副本发过来：应用它之后你就站在同一份上了。',
		});
		ways.createEl('li', {
			text: '让对方导一份新的完整副本：完整清单自带基准，随时能接。',
		});
		contentEl.createEl('p', {
			text: '后两条都会镜像覆盖本机内容。还有一种情况是白跑一趟：包要送到的地方正好是你站的这份完整副本，'
				+ '说明包里没有你缺的内容，应用不会改动文件；按第 1 条让对方重导即可。',
			cls: 'locally-save-hint',
		});

		contentEl.createEl('h3', { text: '包多了怎么管' });
		const clean = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		clean.createEl('li', {
			text: '导出、打开包、以及命令「管理同步包…」都会列出所有包，按类型分组，组内从新到老。'
				+ '鼠标停在行上是完整路径。',
		});
		clean.createEl('li', {
			text: '每行有：应用…、文件夹、复制路径、挪进回收站、彻底删除。',
		});
		clean.createEl('li', {
			text: '「挪进回收站」落在同步包文件夹里的 .lsave/bundles-trash/时间戳，能捞回来。',
		});
		clean.createEl('li', {
			text: '「彻底删除」是真删，单独确认一次；只想扔掉某一个没用的包时用它，不必清空整个回收站。',
		});
		clean.createEl('li', {
			text: '列表上方那一行是回收站汇总：还剩几个包、占多大；点「清空回收站」把攒下的一起清掉。',
		});
		clean.createEl('li', {
			text: '以前那些小更新包可以在「管理同步包…」里合并：几份并成一份，少几个文件要搬。'
				+ '原来那几份挪进回收站，已经站在它们送到的状态上的机器照样收得下合并后的这一份。',
		});

		contentEl.createEl('h3', { text: '谁什么时候动手' });
		const automation = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		automation.createEl('li', {
			text: '自动留包：「自动留包」页选时机（启动后、定时同步、保存后）和类型（更新包、完整包）。'
				+ '「定时同步」一个选项同时管留包和 git 推拉；自上次留包以来没有变化时，一个包都不写。',
		});
		automation.createEl('li', {
			text: '收包：仅拉直接应用；双向先确认；仅推不收。'
				+ '没开 git 时看「自动应用收到的更新包」，且只应用不会动本地已有东西的更新包。',
		});
		automation.createEl('li', {
			text: '会写磁盘的动作默认全关；除了「仅拉」，真正动手之前还有确认框。',
		});

		contentEl.createEl('h3', { text: '双击 .lsave 用 Obsidian 打开' });
		contentEl.createEl('p', {
			text: '设置里的「设置关联」（仅 Windows）会写一条当前用户的文件关联：'
				+ '之后双击 .lsave 就用 Obsidian 打开并弹出应用对话框。不需要管理员权限，'
				+ '会覆盖现有的 .lsave 关联；不想要了点「解除关联」，不会留下别的东西。',
			cls: 'locally-save-hint',
		});
		contentEl.createEl('p', {
			text: '关联是每台电脑各自设置的，换机器或改过仓库文件夹名之后要重设。'
				+ '不想设也行：把包拖到 Obsidian 窗口上，或者在对话框里选它。',
			cls: 'locally-save-hint',
		});
		contentEl.createEl('p', {
			text: '包是插件自己的格式。没设关联时别用“用 Obsidian 打开”去双击它，'
				+ '那只会被当成未知文件塞进仓库。默认排除规则里有 *.lsave，万一进了仓库也不会跟着同步出去。',
			cls: 'locally-save-hint',
		});

		contentEl.createEl('h3', { text: '想留一个还原点' });
		contentEl.createEl('p', {
			text: '在「导出同步包…」里勾「完整副本」：插件按现在的仓库写一份包，'
				+ '你也从此站在它上面，仓库文件一个不动。'
				+ '想用别人的完整副本当自己的基准：在「打开同步包并应用…」里选它，先看报告再应用。',
			cls: 'locally-save-hint',
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
