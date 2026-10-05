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
			text: '在那台机器上应用：**直接把 .lsave 拖到 Obsidian 窗口上**，会自动打开应用对话框并填好路径；'
				+ '在设置里点一次「设置关联」之后，**双击 .lsave 也能直接打开**；'
				+ '也可以点下面的「打开同步包并应用…」再选文件 → 先看报告 → 再点应用',
		});

		contentEl.createEl('h3', { text: '两种包，什么时候用哪个' });
		const pick = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		pick.createEl('li', {
			text: '完整副本：整个仓库。第一次给对方时用，也是所有更新包的**基准**',
		});
		pick.createEl('li', {
			text: '更新包：自上次完整副本以来**累积**的全部改动。对方永远只需要应用最新的那一个 —— '
				+ '跳过中间几个也不会少内容，也不会留下冲突副本（它认得出"这是我以前发过的版本"）',
		});
		pick.createEl('li', {
			text: '更新包会随改动越攒越大（笔记型仓库通常几 MB 就到顶）。定期导一次完整副本，累积就清零了',
		});
		pick.createEl('li', {
			text: '**旧的更新包会被新的取代**：导出成功后，`changes` 里只留最新那一个（同血脉的），'
				+ '完整包保留不动（那是你的还原点）。所以包里不会越攒越多',
		});
		pick.createEl('li', {
			text: '更新包攒到**你设的大小**（默认 200MB）时会弹窗提醒"该换基准了"：'
				+ '建议先把手上这个更新包传过去应用（它是增量，传得快），再重导一份完整副本当新基准。'
				+ '弹窗里三个选项：**重新导出完整副本** / **打开更新包文件夹**（去把包拷走）/ **跳过这次导出**。'
				+ '跳过之后提醒线按原上限整数倍往上抬（200 → 400 → 600MB），换过基准就清零',
		});
		pick.createEl('li', {
			text: '两个自动开关各自独立，可以只开"更新包"，也可以都开。都开时**先导完整包、后导更新包** ——'
				+ '完整包刚把整个仓库装走，这时的更新包必然是空的，所以不会生成它（状态栏会说明一句）。'
				+ '想要一个小文件传出去，就只开"更新包"',
		});

		contentEl.createEl('h3', { text: '包攒多了怎么清' });
		const clean = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		clean.createEl('li', {
			text: '导出对话框、打开包对话框、以及命令面板里的 `管理同步包…` 都会列出包文件夹里的所有包：'
				+ '完整还是更新、多大、什么时候导的。选中一行可以**应用… / 打开所在文件夹 / 复制路径 / '
				+ '挪进回收站 / 彻底删除**',
		});
		clean.createEl('li', {
			text: '「**挪进回收站**」只是挪走：默认落在"目标文件夹/.lsave/bundles-trash/时间戳"'
				+ '（跟 bundles 平级，不再套一层 .lsave），包没有真的消失，想反悔去那个目录里手动捞回来就行'
				+ '（弹窗里也会把完整路径写出来）',
		});
		clean.createEl('li', {
			text: '「**彻底删除**」是**真删**：单独确认一次，删完捞不回来。只想扔掉某一个没用的包时用它，'
				+ '不必为它清空整个回收站',
		});
		clean.createEl('li', {
			text: '列表**上方**那一行是回收站汇总：还剩几个包、占多大；点「清空回收站」把攒下的一起清掉',
		});
		clean.createEl('li', {
			text: '读不出头部的 .lsave（传坏了、或不是本插件的包）也会列出来、标一个"？" —— 看得见才删得掉',
		});

		contentEl.createEl('h3', { text: '两台机器来回搬要"两趟"' });
		contentEl.createEl('p', {
			text: '更新包是"自上次完整副本以来**累积**"的，所以**每台机器手上只有自己这半** ——'
				+ 'A 的包里没有 B 改过的东西，反之亦然。所以流程是：A 导包 → B 应用 →'
				+ '**B 再导一个更新包发回给 A** → A 应用。两边各导一次、互相应用一次，两个仓库才收敛。'
				+ '（B 那一趟**不用手动准备**：应用完只是记一笔"还欠 N 个改动没发出去"，'
				+ '下次导出更新包时自然一起带上，不会一应用就自动生成、和对方来回套娃。）',
			cls: 'locally-save-hint',
		});
		contentEl.createEl('p', {
			text: '不用怕漏发：报告里会写着「你这边还有 N 个改动是对方没有的」，'
				+ '那就是要回传的东西。前提是这台机器**应用过完整副本**（更新包要有基准才导得出来）。',
			cls: 'locally-save-hint',
		});
		contentEl.createEl('p', {
			text: '**两边是不是接着同一份完整副本，工具会替你对账**：完整副本自带"基准指纹"，'
				+ '更新包带着"我基于的那份的指纹"。一致 → 报告写「✓ 同一份完整副本」，接着应用是确定的；'
				+ '不一致 → 写「⚠ 基准对不上」并给出两个指纹，给你一个「导出一份完整副本发过去…」的按钮 ——'
				+ '两边互导一次完整副本就重新对齐。只看世代号是不够的：两台各自 +1 会碰号，内容对不上也看不出来。',
			cls: 'locally-save-hint',
		});

		contentEl.createEl('p', {
			text: '想看"**从哪份完整副本开始、中间收发过什么**"：命令面板里的 `同步包更新记录…` ——'
				+ '像 git log 一样按时间倒序列出来（导出还是应用、包里几个文件、世代走到哪、'
				+ '来自哪个仓库），顶部还写着"我现在站在哪份基准上"。',
			cls: 'locally-save-hint',
		});
		contentEl.createEl('p', {
			text: '**"两边内容到底一不一样"，看更新记录里的「状态」编号**：每导出一个包，'
				+ '"导出完那一刻的编号"会写进包里；应用别人的包之后这边算一个自己的跟它比 ——'
				+ '一样就是两边文件完全一致（空文件夹也算在内），不一样就差你这边还没发出去的改动。'
				+ '两台机器日志里最后一条编号相同 ＝ 同步完了。（那个编号记的是上次导出 / 应用那一刻，'
				+ '之后改了文件要等下一次才刷新；「第 N 代」只是节奏号，两台各自 +1 会碰号，别拿它比内容。）',
			cls: 'locally-save-hint',
		});

		contentEl.createEl('h3', { text: '打开包那一步是只读的' });
		contentEl.createEl('p', {
			text: '选中包之后，插件先算一遍再给你看：同步程度（本地与包已经一致的比例）、'
				+ '会新增 / 覆盖 / 冲突 / 删除各几个、走快速通道还是逐文件合并、中间有没有漏包。'
				+ '这一整步不会碰你的文件；确认无误，"应用"按钮才可点。',
			cls: 'locally-save-hint',
		});

		contentEl.createEl('h3', { text: '「应用方式」：完整副本与更新包各有一套选项' });
		contentEl.createEl('p', {
			text: '为什么两套不一样：**"包里没有某个文件"在两种包里意思完全不同** ——'
				+ '完整副本是完整清单（包里没有 ＝ 对方删过它），更新包只装了变过的那些（包里没有 ＝ 什么也不代表）。'
				+ '所以选中包之后，下拉框会换成一整套它该有的选项，而不是把不合适的灰在那里。',
			cls: 'locally-save-hint',
		});
		const modeList = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		modeList.createEl('li', {
			text: '**完整副本**：按设置（安全）/ **以包为准**（分歧一律听包的，对方删过的也跟着删）/ '
				+ '**完全镜像**（包里没有的本地文件全删，仓库 = 包）',
		});
		modeList.createEl('li', {
			text: '**更新包**：按设置（安全）/ **以包为准**（包里点名的文件一律用包里的版本，'
				+ '你改过的那份进回收目录；包里没提到的一个不动）/ **两边都留**（最保险）/ **以我为准**',
		});
		contentEl.createEl('p', {
			text: '一句话选法：**想让包里点名的文件一律听包的**（自己改坏了要退回对方那一版，也算这种）→'
				+ ' 更新包 + 「以包为准」；'
				+ '**对面大删大改过、想让这台机器跟包一模一样** → 完整副本 + 「以包为准 / 完全镜像」。',
			cls: 'locally-save-hint',
		});
		contentEl.createEl('p', {
			text: '另外，真要删文件或覆盖本地改动之前，还会再弹一次确认框，'
				+ '把"删哪几个、覆盖了几个本地改动、东西去哪儿了"摊开给你看。',
			cls: 'locally-save-hint',
		});

		contentEl.createEl('h3', { text: '应用完，本地副本要不要跟上？' });
		contentEl.createEl('p', {
			text: '对话框里有一项「应用后顺便同步到本地副本」（填了目标文件夹时默认开着）：'
				+ '应用完再跑一次正常同步，把这次的改动推到副本。'
				+ '不这么做的话，备份会在应用完包之后悄悄落后一截 —— 你以为它是新的，其实不是。',
			cls: 'locally-save-hint',
		});
		contentEl.createEl('p', {
			text: '顺序上有个讲究：包里删掉的文件，会先从副本里也清掉、再把基准划掉，然后才同步。'
				+ '否则常规同步会把它们当成"本地缺了、该从副本取回"，刚删掉的文件又长回仓库。',
			cls: 'locally-save-hint',
		});

		contentEl.createEl('h3', { text: '应用时按什么规则处理' });
		contentEl.createEl('p', {
			text: '和本地副本同步**同一套规则**（就是设置里那两个开关），没有"三种模式"那种死板的东西：',
			cls: 'locally-save-hint',
		});
		const rules = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		rules.createEl('li', {
			text: '两边都改过 → 按「两边都改了怎么办」：默认留两份，**新的那份占原名**，'
				+ '输的那份挪进回收目录的「冲突」文件夹（`.trash/locally-save/冲突`），不留在仓库里',
		});
		rules.createEl('li', {
			text: '本地有、包里没有、但基准里也有 → 对方删过它 → 按「同步删除」处理（关掉就取回来）。'
				+ '**这条只对完整副本成立**：完整副本是"完整清单"，而更新包只装变过的文件，'
				+ '"没提到"什么也不代表 —— 更新包只按它**点名**的删除清单删，其余文件一律不动',
		});
		rules.createEl('li', { text: '本地有、包里没有、基准里也没有 → 我独有的文件 → **一律保留**' });
		rules.createEl('li', { text: '对方改了名 → 本地跟着改名，不重传内容' });
		contentEl.createEl('p', {
			text: '对话框里可以临时覆盖冲突与删除这两条（默认「跟随设置」）。真要删东西之前还会再弹一次确认框。',
			cls: 'locally-save-hint',
		});

		contentEl.createEl('h3', { text: '文件夹（包括空文件夹）也一起搬' });
		const dirs = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		dirs.createEl('li', {
			text: '空文件夹会跟着走：对面没有的文件夹会建出来。装进包里的空目录记在包的头部，'
				+ '应用时一并补建（报告里会写"要补建几个"）',
		});
		dirs.createEl('li', {
			text: '删除也传得过去，但要**过基准检查**：只有"上次同步时两边都有过"的文件夹，'
				+ '才会因为对面没了而跟着删 —— 刚新建的文件夹绝不会被当成"对面删过它"。'
				+ '这条与文件的删除规矩完全一致，也受「同步删除」开关管',
		});
		dirs.createEl('li', {
			text: '删的方式是 `rmdir`：**里面但凡还有东西就删不动**。所以哪怕判断错了，'
				+ '最坏也只是"没删掉"，绝不会连带删掉还有内容的目录',
		});
		dirs.createEl('li', {
			text: '「完全镜像」（让仓库与包完全一致）连"本机新建的空文件夹"也会删掉 —— 这是唯一会这么干的一档；'
				+ '「以包为准」与按设置只删"对方删过的"那几个',
		});
		dirs.createEl('li', {
			text: '文件夹与同名文件撞车（本地是文件夹、包里是文件，或反过来）：默认档**如实报失败、不动那个文件夹**；'
				+ '只有强制档才会把它挪进回收目录腾位置',
		});

		contentEl.createEl('h3', { text: '双击 .lsave 直接用 Obsidian 打开' });
		contentEl.createEl('p', {
			text: '同步包是本插件自己的容器格式。**直接**把 .lsave 关联到 `Obsidian.exe "%1"` 是通不了的 ——'
				+ 'Obsidian 收到一个陌生路径只会当成未知文件，压根到不了插件。能到插件的通路只有 URI 协议：'
				+ '设置里那个「设置关联」会往注册表写一条"双击就调起 obsidian:// 链接"的关联，'
				+ '链接里写明交给哪个 vault，插件收到之后直接弹出应用对话框。'
				+ '不想设关联也行 —— 把包**拖到 Obsidian 窗口上**，或者在这里选它，效果一样。',
			cls: 'locally-save-hint',
		});
		contentEl.createEl('p', {
			text: '关联写在本机注册表里、内容是写死的（当时的 vault 名），所以**每台电脑要各设一次**；'
				+ '换过仓库文件夹名之后也要重设一次。不想要了就点「解除关联」，不会留下别的东西。',
			cls: 'locally-save-hint',
		});
		contentEl.createEl('p', {
			text: '插件读包只看绝对路径，跟你系统里 .lsave 关联到哪个程序完全无关；'
				+ '默认排除规则里也有 *.lsave，万一包进了仓库也不会跟着同步出去。',
			cls: 'locally-save-hint',
		});

		contentEl.createEl('h3', { text: '会不会把我的东西弄丢' });
		const safe = contentEl.createEl('ul', { cls: 'locally-save-facts' });
		safe.createEl('li', {
			text: '按设置（默认）：本地也改过的文件留成「冲突副本」，两份都在；包里要求删、但本地改过的不删',
		});
		safe.createEl('li', {
			text: '以包为准 / 完全镜像：被覆盖或被删掉的本地版本会先进回收目录（仓库/.trash/locally-save），仍然捞得回来',
		});
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
