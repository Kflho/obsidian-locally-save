# Locally Save

把整个仓库（或只把自某一份完整副本以来改动的那部分）打包成**一个 `.lsave` 文件**，
用 U 盘、网盘、聊天软件搬到另一台电脑上应用。

**不联网、不要账号、没有服务器、不做后台同步。** 它只干一件事：**离线单文件搬运**（外加还原点）。

- **换电脑 / 重装系统**：一份包搬过去，笔记连同文件夹结构一起回来；
- **两台电脑轮流用**：日常只搬"变了的那部分"（从你最近导的那份完整副本算起），通常几十 KB 到几 MB；
- **想留个还原点**：随时把当前仓库整份打成一份包放着，哪天改坏了应用回去就回到那一刻。

> 想要"两台电脑通过一个共用目录（网盘 / NAS / U 盘）一直自动保持一致"，那不是这个插件要做的事 ——
> 那种连续同步用走云的方案（例如 Remotely Save + WebDAV / 坚果云）更合适。
> 这里守住的是**离线搬运 + 还原点**：包能校验、能对账，搬过去应用完两边文件一模一样。

## English overview

**Locally Save** is a desktop-only Obsidian plugin (the interface is in Chinese) that moves a vault
between machines **without any network access**: every `.lsave` file is either a full snapshot of the
vault or a diff computed from one of your full snapshots. It packs that into a single file which you
carry on a USB drive, a cloud folder or a chat app, and applies it on the other machine.

- **Full copy**: the whole vault. It is a **baseline** — changes bundles are always computed from one
  of your full copies — and your restore point. Applying it is a **mirror**: files the bundle does not
  contain are moved to a trash folder inside the vault, locally modified files are replaced by the
  bundle's version (the old ones also go to the trash). After applying, the vault *is* that bundle,
  and that full copy becomes your baseline.
- **Changes bundle**: a diff computed from one of your full snapshots. There are exactly two kinds —
  a diff from one full snapshot to another full snapshot (use it to move the other machine onto your
  newer full copy without shipping the whole vault), or a diff from one full snapshot to your current
  vault (the everyday case). It carries only what changed since that full snapshot, so it **grows as
  you keep working**: exporting or applying a changes bundle does **not** move your baseline. The
  plugin tells you when one has grown big enough that you should export a fresh full snapshot as the
  new baseline. A changes bundle is accepted only when the receiving machine stands on the **exact
  same full snapshot** (equal baseline fingerprint); otherwise it is rejected with concrete next
  steps (re-export from your baseline, send the full copy it is based on, or send a full copy
  instead).
- **Applying is always a strict sync** (there is no mode to choose): files listed in the bundle win
  (your version goes to the trash), deletions listed in the bundle are performed, and local files the
  bundle's target state does not contain are moved to the trash too. Your own pending changes are
  packed into a changes bundle first — if that cannot be written, nothing is touched.
- Each bundle carries a payload checksum, a generation number, a baseline fingerprint and a content
  **state id** ("are the two sides actually identical?"). A bundle corrupted in transit is rejected
  instead of being written into your vault.
- **Opening a bundle is read-only**: a full report (what will be added, overwritten, deleted) is
  computed first; nothing is written until you press Apply.
- **Automatic modes** (off by default): auto-keep a bundle on a schedule / after edits, and
  auto-apply an incoming changes bundle — the latter only when it would not delete or overwrite
  anything you already have. Full copies are never applied automatically.
- **Install** from the Obsidian community plugin browser, or download `main.js`, `manifest.json` and
  `styles.css` from [Releases](https://github.com/Kflho/obsidian-locally-save/releases) and put them
  in `<vault>/.obsidian/plugins/locally-save/`. Requires Obsidian 1.7+ on desktop.

### Privacy and permissions

- **No network requests at all.** No telemetry, no account, no server. The only things it reads and
  writes are your vault, the bundle folder you configure, and its own state file inside the plugin
  directory.
- **Filesystem access outside the vault** is the core feature (that is what `isDesktopOnly` is for):
  it copies files to/from the bundle folder you pick, and moves replaced or deleted files into a
  trash folder inside the vault.
- **Shell execution**: only one feature uses it — the optional *"associate `.lsave` with Obsidian"*
  button (Windows only), which writes a per-user file association under `HKCU\Software\Classes` by
  running `reg.exe`. It never runs unless you click that button.
- **Clipboard**: the *"copy path"* button writes a file path to the system clipboard; nothing is ever
  read from it.
- Every action that modifies files is off by default and asks for confirmation before it runs;
  replaced or deleted files go to the trash folder inside the vault, not away.

The rest of this document is in Chinese (the plugin's UI language).

## 安装

**从插件市场安装（推荐）**

1. Obsidian → **设置 → 第三方插件 → 浏览**；
2. 搜索 **Locally Save** → **安装** → **启用**。

**手动安装**

1. 到 [Releases](https://github.com/Kflho/obsidian-locally-save/releases) 下载最新一版的
   `main.js`、`manifest.json`、`styles.css`；
2. 放进 `<仓库>/.obsidian/plugins/locally-save/`（没有这个目录就新建）；
3. 在 **设置 → 第三方插件 → 已安装插件** 里把它打开。

**系统要求**：桌面版 Obsidian 1.7 或更高（Windows / macOS / Linux）。手机端用不了 ——
包要写到仓库之外的文件夹，Obsidian 的手机端没有这个权限。

## 三步上手

1. **先填包目录**：设置 → Locally Save → **同步包** → 「同步包文件夹」填一个仓库之外的目录
   （比如 `D:\笔记同步包`、U 盘上的目录）。**这是必填项**，没填时导出 / 应用按钮是灰的。
2. **A 机导出一份完整副本**：点「导出同步包…」→ 勾上「完整副本」→ 导出。
3. **B 机应用**：把那个 `.lsave` 文件拷过去（U 盘、网盘、聊天软件都行），
   **直接拖到 Obsidian 窗口上** → 看一眼报告 → 点「应用」。

之后日常来回搬就用**更新包**（只装自那份完整副本以来变了的那部分），见下面「日常来回搬」。

> 第一次给别人机器搬家时用**完整副本**；对方应用完，两台机器就站在同一个**基准点**上，
> 从此互相发更新包才对得上号。

## 两种同步包

| | 完整副本 | 更新包 |
|---|---|---|
| 里面装什么 | 整个仓库 | 只装自它基于的那份完整副本以来变过的文件（含一份删除清单） |
| 什么时候用 | 第一次给对方 / 想留还原点 / 攒大了换基准 | 日常来回搬 |
| 通常多大 | 跟仓库一样大 | 刚换过基准时几十 KB 到几 MB，之后随改动累积 |
| 应用后 | 本机变成那份包的样子，它也成为本机的基准 | 本机的内容变成包送到的状态（基准不动） |
| 放在哪 | `<同步包文件夹>/full` | `<同步包文件夹>/changes` |

导出的两个勾选是**各自独立**的，可以都要。两个都勾时**先导完整副本、后导更新包** ——
完整副本刚把整个仓库装走，这时的更新包按它算必然是空的，所以**不会生成空包**，
结果里会说明一句。想要"传一个小文件过去"，就只勾更新包。

### 基准点：只有完整副本才算

- 一个**基准点**就是**一份完整副本**（它同时是你的还原点）。**更新包不产生基准点。**
- 更新包只有两种形态，都是**自某一份完整副本算出来的差量**：
  - **完整副本 → 最新状态**：日常那种，只装自那份完整副本以来你改过的东西；
  - **完整副本 → 另一份完整副本**（差量包）：把对方从一份完整副本带到另一份，
    不用重传整个仓库。
- **导出 / 应用更新包都不换基准**：你还是站在同一份完整副本上，所以更新包是**累积**的 ——
  改得越久它越大。攒大了插件会提醒你**导一份新的完整副本换基准**（之后的更新包从它重新算起，
  又变小了）。想多留一个还原点，也随时在「导出同步包…」里勾「完整副本」。
- 更新包必须发到**正站在它那份完整副本上**的机器，否则缺的那部分它根本带不了。
- **号永远往前走**：同一个号底下不会再出现两份不同内容。例：这条线走到第 54 代，
  你应用一份老完整副本**回退**到第 39 代、又改了东西，这时导出的是 **`39 → 55`**
  （起点是你站的那份完整副本，号从用过的最大值往后发），不是历史上早用过的 `39 → 40`。
- 两份完整副本对不上（对方漏发了中间那份）→ 插件**明确拒绝**并说清从哪一份重来，**绝不猜着合**。

## 日常来回搬（两台电脑）

假设笔记本 A 和台式机 B 要轮流用同一份笔记。

### 第一次：A → B（完整副本）

1. **A 机**：`导出同步包…` → 勾「完整副本」→ 导出；
2. 把生成的 `.lsave` 拷到 B 机；
3. **B 机**：把文件**拖到 Obsidian 窗口上**（或 `打开同步包并应用…` 里选它）→ 看报告 → 点「应用」。

> B 机第一次装机时仓库通常是空的，没什么可动的。已经有内容时，先看一眼报告里
> 「删除 N 个」那一行 —— 完整副本是**镜像**：B 机里包里没有的文件会挪进回收目录。

### 之后：日常来回搬（更新包）

1. **A 机**：`导出同步包…`（只勾「更新包」）→ 或者点左侧栏第一个图标「立即留包」；
2. 拷到 B 机 → 打开并应用。B 机没动过的话，报告会显示同步程度 100%；
3. **B 机把自己这半也导出来发回给 A**，A 应用 —— 这样 A 才拿得到 B 那边的改动。

### 为什么要来回两趟

**每台机器手上只有自己这半**：A 那份更新包里没有 B 改过的东西，反之亦然。两边各导一次、
互相应用一次，两个仓库才收敛。

好在**两边的基准始终是同一份完整副本**：B 应用完，基准没变，它再导出的更新包还是"从这份
完整副本到最新"，A 站在同一份上直接收得下。B 那一趟不用手动准备 —— 应用完插件只是记一笔
"你这边还有 N 个改动没发出去"，下次导出更新包时自然一起带上（不会一应用就自动生成一个包，
和对方来回套娃）。

> 报告里那句「你这边还有 N 个改动是对方没有的」，就是要回传的东西。

### 两台都改过了怎么办

最常见的一轮是顺序做：两台都站在第 55 代那份完整副本上，A 改完导出发给 B（`55 → 56`），
B 收到后接着改再导出发回给 A（`55 → 57`）—— 两趟之后两台都停在 57 上，内容一致、状态编号一样。
（两份包的起点都是那份完整副本 —— 更新包就是这么累积的。）

如果 **B 在收到 A 的包之前就已经改了自己的东西**：应用 A 的包时，B 那边的改动会被严格同步
挪进回收目录，但插件**在动手之前已经把它们存成了一个包**（包列表里那份 `第 56 → 57 代`：
起点正是 A 的包送到的状态，内容只有 B 自己动过的文件）：

- **B 自己应用它** → B 的仓库变成「A 的改动 ＋ B 的改动」；
- **把它发给 A 应用** → A 那边同样凑齐，两台回到一致。

一个边界要说清：**两台改到了同一个文件**时，以你应用的那一版为准，另一版在回收目录里
（`<仓库>/.trash/locally-save/`），不会自动合 —— 需要的话自己捞出来看一眼。

### 怎么确认两边内容一模一样：状态编号

每个包都带一个**状态编号**（整个仓库内容的短指纹，空文件夹也算在里面）：

- 每导出一个包，"导出完那一刻"的编号会写进包里，也记在更新记录里；
- 应用别人的包之后，本机会重新算一个自己的跟它比：
  - **一样** → 通知与报告里写「✓ 跟对方完全一致」；
  - **不一样** → 会写明还差什么（多半是你这边还没发出去的改动）。

打开命令 **「同步包更新记录…」**：顶部一行是你现在的编号，下面每条记录也带着当时的编号。
**两台机器记录里最后一条编号相同 ＝ 文件内容一致。**

> 编号是"上次导出 / 应用那一刻"算的；之后又改了文件，要等下一次导出 / 应用才刷新，
> 所以那一行也写着它是什么时候算的。单个超过 64MB 或读不出内容的文件会如实标出
> 「其中 N 个没能校验内容」。

### 包被拒收时怎么办

更新包要求"起点正好是本机站的那份完整副本"。对不上时插件不猜着合（猜着合的代价是本机一大批
文件会被当成"对方删过它们"），而是给出三条出路：

1. **让对方从你这份完整副本重导**：应用对话框里有个「复制指纹发给对方」按钮，
   把你这边的基准指纹发过去，对方导出时把设置里「更新包」→「从哪个状态开始」选成那一项；
2. **让对方导一份完整副本**：完整清单自带基准，随时能接（但它会镜像覆盖本机内容）；
3. **让对方导一份"从你那份完整副本到他那份完整副本"的差量包**：中间缺的那一段一次带过来。

有一种情况是**白跑一趟**：对方那份包要送到的地方**正好就是你现在站的基准点** ——
说明包里没有你缺的内容，应用它一个文件都不会改。这时按第 1 条让对方重导即可。

## 会不会弄丢东西

### 应用 = 严格同步（没有可选项）

包里点名的文件一律用包里的版本、包里点名删掉的照删、**本地多出来的也挪进回收目录**。
应用完**仓库就是包送到的样子**，两边的状态编号当场可比。

| 情况 | 会怎么处理 |
|---|---|
| 本地没动过、包里有 | 按包写入 |
| 两边都改过 | 用包里那一版覆盖，你改过的那份挪进回收目录 |
| 包里点名删掉的 | 照删（本地那份进回收目录） |
| 本地有、但包送到的状态里没有它 | 挪进回收目录（自己新建的、对方删过的都一样） |
| 包里有、本地这份只是旧版本 | 覆盖（不算冲突） |
| 对方改名 / 挪了位置 | 跟着改名，不重传内容 |
| 空文件夹 | 包里记着的补建出来；包送到的状态里没有的本地空目录清掉 |
| 本地是文件夹、包里是同名文件 | 挪进回收目录腾位置 |

> 为什么只有这一种方式：合并会有无穷多种结果（本机改的算谁的、独有的留不留、删除传不传播），
> 每一种都能配出一个"既不等于包、又不等于本机"的仓库，之后互发更新包时基准就对不上了。
> 严格同步保证"应用完两边一样"，也保证下一次的更新包一定接得上。

### 东西去哪儿了：回收目录

被覆盖、被删掉、被挪走的本地版本一律进 **`<仓库>/.trash/locally-save/`**（仓库自带的回收站里，
带时间戳的子目录），随时能手动捞回来。**没有"直接消失"这回事。**

### 应用之前，先把你这一半存成一个包

严格同步会覆盖 / 挪走本地东西，所以动手之前插件会先把你这边"对方还没有的改动"存成一个更新包；
**存不下就不动手**（宁可这次不应用）。那个包的起点是"这份包送到的状态"，所以：

- **你自己应用它** ＝ 在那个状态上把你的改动加回来；
- **发给对方**（他应用完也停在同一状态上）应用 ＝ 你的改动叠到他的新版本上。

### 传输过程弄坏了？

包尾部记着整段内容的校验和。传输中弄坏的包会在应用前被拒绝（而不是写进仓库）。
「应用前校验完整性」这个开关默认打开，大包会多花几秒。

## 自动功能

### 自动留包（默认关）

- **留哪种包**在「同步包」页：`留更新包`（推荐，几乎不额外花时间）/ `留完整包`（每次都把整个仓库
  重写一遍，大库会明显变慢）。两个开关各自独立。
- **什么时候留**在「自动留包」页：启动后一次 / 定时（每 5 分钟到 3 小时）/ 保存后停顿若干秒。
- **自上次留包以来没有任何变化时，一个包都不写**，只如实说一句。
- 第一次必须先导一次完整副本 —— 更新包要有起点才算得出来。

### 自动应用收到的包（默认关）

打开后，插件每 30 秒看一眼「同步包文件夹」，有人把包放进去就自己处理。边界是硬的：

- **只在完全不会动到本地已有东西时才自己应用**：不删文件、不删空文件夹、不覆盖你改过的内容。
  要删东西或两边都改过时，只提示一句，让你用「打开同步包并应用…」自己看；
- **完整副本从来不自动应用**（它可能删掉你本机独有的文件），只提示一句；
- **按基准收**：只自动应用"起点正好是本机站的那份完整副本"的包；同一份基准上每个来源只取
  最新那一份，别的先搁着；
- 同一个包只处理一次，不会每 30 秒弹一遍。

### 状态栏

- 平时显示**更新记录里最后一条**：`上次留包 <时间> · 更新包 N 个文件（含 M 个删除）`；
- 导出 / 应用进行中显示进度（已经装进包 / 写进仓库几个文件，一共几个）；
- 不想要这一格就在「界面与交互」页关掉。

### 三个左侧栏图标

每个都能在设置里单独关掉：

| 图标 | 点一下 |
|---|---|
| 包裹加号 | **立即留包**（按两个「自动留包」开关留一次） |
| 包裹 | **导出同步包**（打开导出对话框） |
| 开箱 | **打开同步包并应用**（选包 → 看报告 → 再应用） |

### 拖放与双击

- **把 `.lsave` 拖到 Obsidian 窗口上** → 直接打开应用对话框并填好路径。
  只拦 `.lsave`，往笔记里拖图片、拖别的附件照旧。不想要这个行为可以在设置里关掉。
- **双击 `.lsave` 直接用 Obsidian 打开**（仅 Windows，需要点一次「设置关联」）：
  设置 → 同步包 → 「用 Obsidian 直接打开」→ 设置关联。它会写一条当前用户的文件关联
  （`HKCU\Software\Classes`，不需要管理员权限，会覆盖你现有的 `.lsave` 关联；不想要了点「解除关联」）。
  关联是**每台电脑各自设置**的，换机器后要在那台机器上重新点一次；换过仓库文件夹名也要重设。

### `.lsave` 不是 Obsidian 能直接打开的格式

除非你按上面设过关联，否则不要用「用 Obsidian 打开」去双击它 —— 那只会被当成一个未知文件
塞进仓库。正确用法是**把它拖到 Obsidian 窗口上**，或者用插件里的对话框选它。
万一包进了仓库也没关系：默认排除规则里有 `*.lsave`，它不会被打进下一个包。

## 命令

命令面板（`Ctrl+P`）里搜 "Locally Save" 或命令名。**给命令设了快捷键的话，快捷键会一直有效**
（插件不会给命令改名）。

| 命令 | 干什么 |
|---|---|
| 立即留包 | 按两个「自动留包」开关立即留一次；都没开时提示去设置里选一种 |
| 预览：这次会留什么包 | 列出这次会装进包里的文件、点名要删的清单、约多大。**只算不写** |
| 导出同步包… | 打开导出对话框（完整副本与更新包两个独立勾选） |
| 打开同步包并应用… | 选包 → 先看报告 → 再点应用 |
| 管理同步包… | 列出所有包：应用 / 打开文件夹 / 复制路径 / 挪进回收站 / 彻底删除 / 清空回收站 |
| 同步包更新记录… | 像 git log 一样列出每次导出 / 应用 |
| 启用 / 停用插件 | 总开关（关掉后上面的入口都不干活，设置面板还能打开） |

> 命令面板里那两条带「旧功能，已移除」的命令，是很早以前一个功能的残留（只为让老快捷键不出错）。
> 现在要用的就是上面那两条：导出同步包 / 打开同步包并应用。

## 管理已有的包

导出对话框、打开包对话框、命令 `管理同步包…` 都会列出包文件夹里的所有包，
**按类型分组**（更新包一组、完整副本一组、读不出内容的一组），组内从新到老。
每行写着认包要用的信息（第几代 → 第几代 · 状态编号 · 大小 · 时间），鼠标停在行上是完整路径。

选中一行可以：

- **应用… / 检查**：打开应用对话框，先出报告；
- **文件夹 / 复制路径**；
- **挪进回收站**：只是挪走，落在 `<同步包文件夹>/.lsave/bundles-trash/时间戳/`，能手动捞回来；
- **彻底删除**：真删，单独确认一次，删完捞不回来。

列表上方那一行是回收站汇总（还剩几个包、占多大、完整路径），点「清空回收站」把攒下的一起清掉。

> `changes` 目录里的更新包默认**都留着**：删错一份，还站在它那份完整副本上的机器、或者另一台
> 机器那一半改动就没了。只有"同一份起点 ＋ 同一种形态 ＋ 也是这台机器导的"才会用新的那份取代
> 旧的；别的起点、别的形态、别的机器导的一律留着。

### 合并相邻的更新包

如果你在两份完整副本之间分段搬过（先导一份「F0 → F1」的差量包，再导一份「F1 → F2」），
`changes` 里就会串成一串。「管理同步包…」里的 **「合并相邻的更新包…」** 会把这样的一串并成
一份「F0 → F2」：起点还是段首那份完整副本、落点还是段末那一份，中间那几份不再单独留着。

- **正好停在中间那一份上的机器照样收得下合并后的这一份**；
- 合并后装的是整段路上所有变过的文件，一份都不少；
- 原来那几份**挪进回收站**（不是真删，捞得回来）；
- 同一个起点往外分过岔（有好几份不同落点的包）时**不动**：哪条是正路只有你清楚，插件不猜。

### 更新包可以指定「从哪个状态开始、到哪个状态为止」

两个下拉里列的都是**你手里那几份完整副本**。「从哪个状态开始」默认是**你现在站的那一份**；
「到哪个状态为止」默认是**最新**（你现在的仓库）。

- 对方还停在一份更老的完整副本上时，把「从哪个状态开始」选成**对方报给你的那一份**，
  他收到就是确定的更新（不必先要一份完整副本，也不必一段一段补）；
- 反过来，把「到哪个状态为止」选成**另一份完整副本**，导出的就是一份"把对方从起点送到那一份"
  的差量包：内容取自那份包，不是你现在的仓库（所以这一趟不会改变你自己的状态）。

**认基准指纹，别只看"第几代"**：世代号是每台机器各数各的节奏号，两边的"第 32 代"完全可能是
两份不同的完整副本。让对方打开「同步包更新记录…」，把顶上那行「基准：第 N 代 · 指纹 xxxx」念给你，
照着那个**指纹**选。

## 设置说明

设置按"你要干什么"分成四页：

| 页 | 里面有什么 |
|---|---|
| **通用** | 启用插件 · 日志级别 |
| **同步包** | 包放在哪（同步包文件夹 · 不进包的文件）· 自动留包（留更新包 / 留完整包）· 更新包（从哪个状态开始 · 到哪个状态为止 · 攒大了提醒立新基准）· 手动导出 · 管理 · 应用同步包（自动应用收到的更新包 · 拖入 .lsave 即打开 · 应用前校验完整性）· 用 Obsidian 直接打开 · 看说明 |
| **自动留包** | 触发时机：启动后留包一次 · 定时留包 · 保存后留包 |
| **界面与交互** | 左侧栏三个图标 · 状态栏 |

几个容易忽略的：

- **同步包文件夹**：必填。留空时导出 / 应用按钮是灰的，并提示去填；
- **不进包的文件**：写法同 `.gitignore`（`目录/`、`*.tmp`、`a/**/*.md`），
  默认已排除配置目录、回收目录、`*.lsave` 与系统垃圾文件。想连插件与快捷键一起搬，
  把默认那行删掉即可；
- **应用前校验完整性**：读一遍整个包算校验和，确认传输没把文件弄坏（大包会多花几秒）。

## 常见问题

**它会自动帮我同步吗？**
不会。留包（写文件）与应用（改仓库）默认都是关的，要你自己打开或点一下。

**包有多大？**
完整副本跟仓库差不多大；更新包只装"自它那份完整副本以来"变的那部分，刚换过基准时通常
几十 KB 到几 MB，之后随改动累积。**攒大了插件会提醒你导一份新的完整副本换基准** ——
换完之后的更新包又从小的重新算起。想长期搬来搬去，日常只导更新包就行。

**手机上能用吗？**
不能，插件是桌面端专用（包要写到仓库之外）。

**"删除同步包"是真删吗？**
默认是**挪进回收站**（`<同步包文件夹>/.lsave/bundles-trash/`），能手动捞回来。
真删只有两条路：行内的「彻底删除」（单独确认一次）与「清空回收站」。

**双击 `.lsave` 没反应？**
关联是每台电脑各自设置的，换机器后要在那台机器上重新点一次「设置关联」；
不想设关联就直接把包拖到 Obsidian 窗口上。

**应用完报告说"还差一点"？**
包里没提到、而你又改过的文件，包里没有它的字节 —— 差的就是它们。
它们已经进了"应用前替你存下的那个包"，那个包被应用之后两边就一致了。

**能只应用包里的某几个文件吗？**
不能。应用是整包语义（严格同步），为的是保证应用完两边内容一致、下一次的更新包接得上。
只想看某个文件在不在包里，可以展开报告里的文件清单。

**状态文件和插件配置在哪？**
插件的配置在 `<仓库>/.obsidian/plugins/locally-save/`（`data.json` 是设置，
`sync-state.json` 是基准、世代、更新记录与状态编号）。删掉 `sync-state.json` 等于"当作第一次"，
不会动仓库里的文件 —— 但下次导更新包会要求先立基准（导一份、或应用别人一份完整副本）。

## 已知限制

- **只支持桌面端**：读写仓库之外的文件必须走文件系统；
- **判据是「大小 + 修改时间」**，修改时间带 2 秒容差（FAT/exFAT 只精确到 2 秒）。
  同一个文件在 2 秒内被改成同样长度，这一轮可能看不出来。想确认"两边内容一不一样"，
  看**状态编号**（那是按内容指纹算的）；
- **排除规则挡住的东西不进包**：默认是配置目录、`.trash/`、`*.lsave` 与系统垃圾文件；
- 包带来的改名是**文件系统层面**的：仓库里指向它的链接不会跟着更新（Obsidian 只跟踪应用内的改名）；
- **删不掉的空目录**：目录里只有被排除规则挡住的东西时（`*.lsave`、`desktop.ini`…），
  插件看不见它们、也就删不动，这时会**明确报出来**，而不是反复尝试；
- **打开包文件夹**依赖系统文件管理器，拿不到时会弹一条含路径的通知让你手动复制；
- 打开同步包对话框时只会**把 Obsidian 叫到前台**，不会动你的窗口大小与位置；
- **接收端默认要手动点一下**：想省这一步就打开「自动应用收到的更新包」（见上面那节）。

## 隐私

**这个插件不发起任何网络请求。** 没有遥测，没有账号，不上传任何东西。

它碰的东西只有三处：

- **仓库之外的文件**：这正是它的功能（包要写到仓库外、被替换的文件要挪进回收目录），
  所以它用 Node 的文件系统读写。它只会碰你指定的**同步包文件夹**、仓库本身、
  以及仓库里的 `.trash/locally-save` 回收目录；
- **系统命令**：只有一处 —— 「把 .lsave 关联到 Obsidian」按钮（仅 Windows），
  跑 `reg.exe` 往 `HKCU\Software\Classes` 写一条当前用户的文件关联。**不点这个按钮就不会执行**，
  也不需要管理员权限，不想要了点「解除关联」；
- **剪贴板**：只有「复制路径」「复制指纹发给对方」会往里写一句话，从不读剪贴板。

所有**会改文件**的动作默认都是关的（自动留包、自动应用都如此），真正动手之前还有确认框。

## 许可

[MIT](LICENSE)
