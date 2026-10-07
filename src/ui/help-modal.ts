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

		contentEl.createEl('h3', { text: '它只干一件事：离线搬仓库' });
		contentEl.createEl('p', {
			text: '把整个仓库（或只把上次之后改动的那部分）装进一个 .lsave 文件，'
				+ '用 U 盘 / 网盘 / 聊天软件搬到另一台电脑上应用。全程不联网：没有账号、没有服务器、'
				+ '也不会在后台替你同步。',
			cls: 'locally-save-hint',
		});
		contentEl.createEl('p', {
			text: '想要"两台机器通过一个共用目录（网盘 / NAS / U 盘）一直自动保持一致"，'
				+ '那不是这个插件要做的事 —— 那种连续同步用走云的方案（例如 Remotely Save + WebDAV / 坚果云）'
				+ '更合适。这里是离线搬运 + 还原点。',
			cls: 'locally-save-hint',
		});

		contentEl.createEl('h3', { text: '三步走' });
		const steps = contentEl.createEl('ol', { cls: 'locally-save-facts' });
		steps.createEl('li', {
			text: '两台机器都先在设置里填「同步包文件夹」（仓库之外的一个目录，U 盘上的文件夹也行）',
		});
		steps.createEl('li', {
			text: '这台机器导出：下面的「导出同步包…」按钮，或命令面板里的同名命令。'
				+ '第一次给对方要勾「完整副本」，之后日常只勾「更新包」',
		});
		steps.createEl('li', {
			text: '把生成的 .lsave 拷到另一台机器，然后在那台机器上应用：'
				+ '把文件拖到 Obsidian 窗口上最省事（自动打开应用对话框并填好路径）；'
				+ '也可以点下面的「打开同步包并应用…」再选文件 → 先看报告 → 再点应用',
		});

		contentEl.createEl('h3', { text: '两种包，什么时候用哪个' });
		const pick = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		pick.createEl('li', {
			text: '完整副本：整个仓库。第一次给对方时用；它同时也是一份还原点 —— '
				+ '哪天改坏了，应用回去就回到那一刻。放在包目录的 full 子目录里',
		});
		pick.createEl('li', {
			text: '更新包：只装自它起点那份完整副本以来变过的文件，日常来回搬用它，通常几十 KB 到几 MB。'
				+ '只有两种：从一份完整副本到另一份完整副本（内容取自后者），'
				+ '或者从一份完整副本到你现在的仓库。放在 changes 子目录里',
		});
		pick.createEl('li', {
			text: '两个勾选各自独立，可以都要。都勾时会先导完整副本、后导更新包 —— '
				+ '完整副本刚把整个仓库装走，这时的更新包必然是空的，所以不会生成它。'
				+ '想要一个小文件传出去，就只勾更新包',
		});
		pick.createEl('li', {
			text: '只有完整副本会改变"你站在哪一份上"：导出或应用一份完整副本之后，你就站在它上面，'
				+ '之后的更新包都从它算起；导出、应用更新包都不动它。'
				+ '这正是两边能一直互发更新包的原因 —— 谁也不必先重导一份几百 MB 的完整副本',
		});
		pick.createEl('li', {
			text: '更新包是自起点那份完整副本累积的：来回搬得多了它会变大。'
				+ '攒到「同步包」页里设的那个大小上限时，插件会提醒你导一份新的完整副本当基准，'
				+ '之后从新的那份重新累积',
		});
		pick.createEl('li', {
			text: '包目录 changes 里的更新包不会乱删：完整副本会清掉它取代得了的那些；'
				+ '别的机器发来的那一份留着（那是它那一半改动）。同一份起点重导一遍时，旧的那份才多余',
		});

		contentEl.createEl('h3', { text: '两台机器来回搬要"两趟"' });
		contentEl.createEl('p', {
			text: '每台机器手上只有自己这半 —— 你这边的更新包里没有对方改过的东西，反之亦然。'
				+ '所以流程是：A 导包 → B 应用 → B 再导一份发回给 A → A 应用，两边才收敛。'
				+ '好在两边的完整副本始终是同一份：B 应用完、改完自己的东西再导一份，起点还是它，A 收得下。',
			cls: 'locally-save-hint',
		});
		contentEl.createEl('p', {
			text: 'B 那一趟不用手动准备：应用完插件只记一笔"你这边还有 N 个改动没发出去"，'
				+ '下次导出更新包时自然一起带上（不会一应用就自动生成一个包，和对方来回套娃）。',
			cls: 'locally-save-hint',
		});
		contentEl.createEl('p', {
			text: '报告里那句「你这边还有 N 个改动是对方没有的」，就是要回传的东西。',
			cls: 'locally-save-hint',
		});
		contentEl.createEl('p', {
			text: '要是对方在收到你的包之前就已经改了自己的东西：应用你这包时，它那边的改动会被'
				+ '严格同步挪进回收目录 —— 不过插件动手前已经先把它存成了一个包'
				+ '（列表里多出来的那一份更新包，起点正是你这包送到的状态，内容只有它自己动过的文件）。'
				+ '它自己应用那一份、或者发给你应用，两边的东西就凑齐了。'
				+ '只有"两台改到同一个文件"时不会自动合：以你包的版本为准，另一版在回收目录里，捞得回来。',
			cls: 'locally-save-hint',
		});

		contentEl.createEl('h3', { text: '两边内容一不一样：看状态编号' });
		contentEl.createEl('p', {
			text: '每个包都带一个状态编号（整个仓库内容的短指纹，空文件夹也算在内）。'
				+ '应用完别人的包，这边会算一个自己的跟它比：一样就是文件内容完全一致（通知里会写'
				+ '「✓ 跟对方完全一致」）；不一样会写明还差什么（多半是你这边还没发出去的改动）。',
			cls: 'locally-save-hint',
		});
		contentEl.createEl('p', {
			text: '命令「同步包更新记录…」里，顶部一行是你现在的编号，每条记录也带着当时的编号 —— '
				+ '两台机器记录里最后一条编号相同，就说明两边内容一致。（编号是上次导出 / 应用那一刻算的，'
				+ '之后改了文件要等下一次才刷新；「第 N 代」只说内容走到第几版，认"是不是同一份基准"要看指纹。）',
			cls: 'locally-save-hint',
		});

		contentEl.createEl('h3', { text: '打开包那一步是只读的' });
		contentEl.createEl('p', {
			text: '选中包之后，插件先算一遍给你看：同步程度、会新增 / 覆盖 / 删除各几个、'
				+ '会挪走哪些本地文件、包里点名了哪些文件。这一整步不会碰你的文件；'
				+ '确认无误，「应用」按钮才可点，真要动到本地已有的东西时还会再确认一次。',
			cls: 'locally-save-hint',
		});

		contentEl.createEl('h3', { text: '应用只有一种方式：严格同步' });
		contentEl.createEl('p', {
			text: '包里点名的文件一律用包里的版本（你改过的那份先进回收目录）、包里点名删掉的照删、'
				+ '本地多出来的文件也挪进回收目录 —— 应用完这个仓库就是包送到的样子，'
				+ '两边的状态编号当场可比。没有"应用方式"可选：合并会合出一个"既不等于包、又不等于本机"的仓库，'
				+ '下一次的更新包就对不上基准了。',
			cls: 'locally-save-hint',
		});
		contentEl.createEl('p', {
			text: '动手前插件会先把你这一半存成一个包（你确实有对方没有的改动时才存；存不下就不动手）。'
				+ '那个包从"这份包送到的状态"算起：你自己应用它，就等于把改动加到新状态上；'
				+ '发给对方（他正好也在同一个状态上）应用，你的改动就叠到他的新版本上。',
			cls: 'locally-save-hint',
		});

		contentEl.createEl('h3', { text: '会不会把东西弄丢' });
		const safe = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		safe.createEl('li', {
			text: '被覆盖、被删掉、被挪走的本地版本一律进回收目录（仓库里的 .trash/locally-save），'
				+ '随时能手动捞回来 —— 没有"直接消失"这回事',
		});
		safe.createEl('li', {
			text: '动手之前，你这边对方还没有的改动会先存成一个更新包；存不下就不应用（宁可这次不干）',
		});
		safe.createEl('li', {
			text: '包在传输中弄坏了：尾部有整段内容的校验和，对不上直接拒绝，不会写进仓库',
		});
		safe.createEl('li', {
			text: '自动收包那条路更保守：只应用不会动到本地已有东西的更新包；'
				+ '要删东西、或者两边都改过时只提示一句，让你自己看',
		});

		contentEl.createEl('h3', { text: '包被拒收、提示"基准对不上"怎么办' });
		contentEl.createEl('p', {
			text: '更新包要求"起点正好是你站的那份完整副本"。对不上时插件不猜着合（猜着合的代价是'
				+ '本机一大批文件会被当成"对方删过它们"），而是给出三条出路：',
			cls: 'locally-save-hint',
		});
		const ways = contentEl.createEl('ol', { cls: 'locally-save-facts' });
		ways.createEl('li', {
			text: '让对方照你站的那一份重导：对话框里有个「复制指纹发给对方」按钮，把你这边的基准指纹发过去，'
				+ '对方导出时把「更新包：从哪个状态」选成那一项',
		});
		ways.createEl('li', {
			text: '让对方把他用的那份完整副本发过来：应用它之后你就站在同一份上了（它会镜像覆盖本机内容）',
		});
		ways.createEl('li', {
			text: '让对方导一份新的完整副本：完整清单自带基准，随时能接（同样会镜像覆盖本机内容）',
		});
		contentEl.createEl('p', {
			text: '有一种情况是白跑一趟：对方那份包要送到的地方正好就是你现在站的这份完整副本 —— '
				+ '说明包里没有你缺的内容，应用它一个文件都不会改。这时按第 1 条让对方重导即可。',
			cls: 'locally-save-hint',
		});

		contentEl.createEl('h3', { text: '包多了怎么管' });
		const clean = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		clean.createEl('li', {
			text: '导出对话框、打开包对话框、以及命令「管理同步包…」都会列出包目录里的所有包：'
				+ '按类型分组（更新包 / 完整副本 / 读不出内容的一组），组内从新到老。'
				+ '鼠标停在某一行上是它的完整路径',
		});
		clean.createEl('li', {
			text: '每行的操作：应用… / 文件夹 / 复制路径 / 挪进回收站 / 彻底删除',
		});
		clean.createEl('li', {
			text: '「挪进回收站」只是挪走：落在同步包文件夹里的 .lsave/bundles-trash/时间戳，'
				+ '包没有真的消失，想反悔去那个目录里手动捞回来就行（弹窗里会写出完整路径）',
		});
		clean.createEl('li', {
			text: '「彻底删除」是真删：单独确认一次，删完捞不回来。只想扔掉某一个没用的包时用它，'
				+ '不必为它清空整个回收站',
		});
		clean.createEl('li', {
			text: '列表上方那一行是回收站汇总：还剩几个包、占多大；点「清空回收站」把攒下的一起清掉',
		});
		clean.createEl('li', {
			text: '手里还留着以前那些小更新包时，可以在「管理同步包…」里把连着的一串并成一份：'
				+ '几份并成一份，少几个文件要搬；原来那几份挪进回收站，'
				+ '已经站在它们送到的某个状态上的机器照样收得下合并后的这一份',
		});

		contentEl.createEl('h3', { text: '谁什么时候动手' });
		const automation = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		automation.createEl('li', {
			text: '自动留包：「同步包」页选留哪种包（留更新包 / 留完整包），「自动留包」页选什么时候留'
				+ '（启动后 / 定时 / 保存后）。自上次留包以来没有变化时一个包都不写',
		});
		automation.createEl('li', {
			text: '自动应用收到的包（默认关）：别人把包放进同步包文件夹后，插件每 30 秒看一眼 —— '
				+ '只在完全不会动到本地已有东西时才自己应用（不删文件、不覆盖你改过的内容）；'
				+ '完整副本从来不自动应用（它可能删掉你本机独有的文件）',
		});
		automation.createEl('li', {
			text: '两件事都是会往磁盘写东西的动作，默认全关；真正动手之前还有确认框',
		});

		contentEl.createEl('h3', { text: '双击 .lsave 直接用 Obsidian 打开' });
		contentEl.createEl('p', {
			text: '设置里那个「设置关联」（仅 Windows）会写一条当前用户的文件关联：'
				+ '之后双击 .lsave 就用 Obsidian 打开并直接弹出应用对话框。不需要管理员权限，'
				+ '会覆盖你现有的 .lsave 关联；不想要了点「解除关联」，不会留下别的东西。',
			cls: 'locally-save-hint',
		});
		contentEl.createEl('p', {
			text: '关联是每台电脑各自设置的，所以换机器后要在那台机器上重新点一次；'
				+ '换过仓库文件夹名之后也要重设一次。不想设关联也行 —— 把包拖到 Obsidian 窗口上，'
				+ '或者在这里选它，效果一样。',
			cls: 'locally-save-hint',
		});
		contentEl.createEl('p', {
			text: '另外：包是插件自己的格式，别用"用 Obsidian 打开"去双击它（除非按上面设过关联），'
				+ '那只会被当成一个未知文件塞进仓库。默认排除规则里有 *.lsave，'
				+ '万一包进了仓库也不会跟着同步出去。',
			cls: 'locally-save-hint',
		});

		contentEl.createEl('h3', { text: '想留一个还原点' });
		contentEl.createEl('p', {
			text: '在「导出同步包…」里勾上「完整副本」：插件按你现在的仓库写一份包，'
				+ '你也从此站在它上面（仓库里的文件一个都不动）。这份包同时是一份备份。'
				+ '想反过来用别人的完整副本当自己的基准：在「打开同步包并应用…」里选那份包，'
				+ '走的是应用那条路（先出报告、再动手），应用完你的仓库就是那个包。',
			cls: 'locally-save-hint',
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
