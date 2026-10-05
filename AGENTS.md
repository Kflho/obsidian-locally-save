# Locally Save —— 本仓库约定（改代码前先读）

Obsidian 插件 **locally-save**（仓库 `Kflho/obsidian-locally-save`，默认分支 `main`）：
把仓库同步到本地文件夹副本，并把改动/整份副本打包成单个 `.lsave` 文件来回搬。

骨架来自**官方空白模板**（obsidian-sample-plugin）与 **js_02（note-tidy）**。

## 从 js_02 继承来的四样东西

1. **构建链**：`esbuild.config.mjs` 打在 `src/main.ts` → `main.js`，打完自动调 `deploy.mjs`
   同步到 vault 的插件目录（`OBSIDIAN_PLUGIN_DIR` 可覆盖；目录不存在就静默跳过）。
   Node 内置模块必须是 external 的**两种写法**（`fs` 与 `node:fs`），否则打包会报找不到模块。
2. **设置面板架构**：字段表是**单一数据源**，1.13+ 的声明式定义与 1.13 以下的手写 DOM
   都由它生成。加一个设置项 = 改 `model.ts` + `fields/`，别去手写 DOM。
3. **测试守卫**：`node test/run-tests.mjs`（esbuild 打包测试后在本进程跑，无框架），
   加测试文件要登记到 `test/run-tests.mjs` 的 `entryPoints`。
4. **发版脚本**：`version-bump.mjs` 同步 `manifest.json` 与 `versions.json`。

## 本插件自己的硬约束

- **引擎不许 import obsidian**：`src/sync/` 与 `src/bundle/` 通过 `SyncHost` 接口拿
  「仓库路径 / 状态文件 / 配置目录 / 进度回调」，所以能在测试里拿临时目录直接跑。
  `disk.ts` 是**唯一**碰 `node:fs` 的地方（fs 操作都收在这里）。
- **先算后做**：改文件之前一律先出计划（`planSync` / `planBundleApply`），
  预览与"打开包"都只读不写。执行阶段逐条 catch，一条失败不影响其它条。
- **删除必须过 base 检查**，没有例外：本地改过的东西不删，宁可留着。
- **移动不能当成"删 + 加"**：会两边各留一份。识别条件是「新路径确实是新出现的 +
  旧路径在基准里 + 对侧那份自基准以来没动过 + 大小与修改时间完全一致」，
  四条缺一不可（`src/sync/diff.ts` 的 `detectMoves`）。
- **复制后必须对齐 mtime**（`copyFilePreservingMtime`）：不对齐的话每轮都误判成改过，反复重传。
- **mtime 有 2 秒容差**（FAT/exFAT）。写测试时要注意：**同一秒内改同样长度的文件，
  引擎会认为没变过**，测试里要把修改时间拉开。
- **配置目录名不能写死**：用户可能改过，运行时用 `Vault#configDir`（`SyncHost.configDir()`）；
  默认排除规则里的 `.obsidian/` 只是兜底。
- **`.lsave` 容器**：头部先写、偏移量提前算好（不回写，回写最容易断电写坏）；
  尾部布局是 `[标记][JSON][长度]`，读的时候先看文件末尾 4 字节 —— 写读顺序必须一致。
- **文件名要带包 ID 前几位**：时间戳只到秒，同秒连导两个包会互相覆盖。
- **上次同步的结果必须落盘**：存在 `sync-state.json` 的 `lastSync`（结构化数据，
  由 `recordFromOutcome` 写入、`statusBarText`/`describeRecord` 负责显示），
  启动时 `restoreLastSync()` 读回来。以前只存内存，重启后状态栏变回"尚未同步"——
  用户会以为同步记录丢了（这是报过的 bug，别再犯）。
- **同步包默认放在副本的 `.lsave/bundles` 下**：`.lsave` 在扫描副本时是**整个跳过**的，
  包才不会被当成"副本新增文件"同步回仓库。完整包与更新包分 `full` / `changes` 两个子目录
  （`src/bundle/paths.ts`）。两个自动留包的开关**各自独立**，导出顺序由
  `plannedExportModes()`（`bundle/export.ts`）一处说了算，两条调用链（导出弹窗 / 同步后自动留包）
  都用它：**先完整副本、后更新包**。完整副本一写完，它自己就是最新基准 → 更新包按它算**必然是空的**，
  这时**不写空包**，只提示一句（"更新包没有生成：刚导出的完整副本已经是当前仓库的完整样子"）。
  旧顺序（先更新、后完整）演的是另一幕：先按老基准算出更新包（顺手把上一个更新包清掉）、
  再导完整副本 —— 用户看到的是"我那个包没了，然后又生出来一个一模一样的"（报过的）。
  要"一个小文件传出去"就只勾更新包，别同时勾完整副本。
- **导出进度就是"打包了多少个文件"**：`done / total` ＝ **已经写进包里的文件数 / 总文件数**，
  从 0 数到总数，多一个含义都不许有。`writeBundle` 每搬完一个文件回调一次；开跑先报一次 0，
  并 `await yieldToUi()` **强制让一帧**（DOM 写进去得等浏览器拿到渲染机会，不然第一帧会被
  后面的循环挤掉，用户看到的第一个数就不是 0 了）。
  **别把内部步骤编进数字**：算指纹是给接收方做三方合并用的，跟用户没关系 —— 曾经拆成
  "算指纹一半、写包一半"（total ＝ 文件数 × 2）还配上阶段字样，被用户骂画蛇添足。
  那一步现在不报进度（它慢，数字就停在 0，这是老实的）；纯 CPU 的长循环仍按**时间**让帧
  （`utils/async.ts` 的 `yieldIfDue`，不是按项数的 `YIELD_EVERY` —— 一万项可能只要几毫秒），
  否则界面会僵住。状态栏那句动词由 `SyncProgress.label` 给（同步中 / 导出中 / 应用中）。
- **删除同步包 ＝ 挪进回收站**（`bundle/manage.ts` 的 `trashBundles`）：落脚点是
  `bundleTrashRoot()` 算出来的**离包最近的那个 `.lsave` 里的 `bundles-trash/<时间戳>/`** ——
  默认布局是 `<目标文件夹>/.lsave/bundles-trash`，**跟 `bundles` 平级**。
  不许塞进 `bundles` 里面：那会变成 `.lsave/bundles/.lsave/bundles-trash`，两层 `.lsave` 套着
  （用户报过）；老位置仍然会被 `readBundleTrash` / `emptyBundleTrash` 认（`legacyTrashRoot`），
  否则用户之前删掉的包会"人间蒸发"。用 `.lsave` 这个名字是因为它整个不参与扫描，
  包文件夹就算设在副本里也不会被同步回仓库。
  **真删只有两条路**：「**彻底删除**」（行内按钮，`manage.ts` 的 `deleteBundles` → `removeFile`，
  一次一个包，单独确认）与「清空回收站」（`disk.ts` 的 `removeDirRecursive`，rm -rf 语义，
  只准传插件自己算出来的回收站路径）；别的删除一律是"挪进回收站"。
  列表 / 删除 / 回收站都在 `bundle/manage.ts`（不 import obsidian，测试直接跑临时目录），
  界面是 `ui/bundle-list.ts` 那一套列表 —— 导出弹窗、导入弹窗、管理弹窗**共用**，
  别让"这边能删、那边不能"；行内按钮是**应用… / 文件夹 / 复制路径 / 挪进回收站 / 彻底删除**，
  两个删除并排（用户提的：只有"挪进回收站"时，想真删一个包就得清空整个回收站）；
  **回收站那一行三处都要有**，而且放在列表**上面**
  （放下面会被"最多 40vh 的滚动列表"顶出视野，用户翻不到就会问"删掉的包去哪了"）。
- **应用同步包的"强硬程度"有四档**（`ApplyStrictness`：`normal` / `listed-wins` / `bundle-wins` / `mirror`）：
  - `normal` 走 `planSync` 三方比对（借"仅下载"方向 + `directionDecidesConflict: false`）；
  - **`listed-wins`（界面叫「回退到包里那一版」）**：走强制那条路，但**只动包里点名的文件** ——
    条目以包为准（本地改过的那份进回收目录的「冲突」文件夹）、`header.deleted` 点名的照删，
    **包里没提到的一个不动**。以前更新包只开放 `normal`，"我改坏了想退回对方那一版"根本做不到
    （本地改过的一律保留，用户报过）；因为它不动没提到的文件，更新包也能安全地开放它；
  - **强制两档不走三方比对**，直接两侧比 —— 因为"只有本地改了、包里没改"时三方比对会判成
    "上传"（本地说了算），在包的方向上被过滤掉，那样就不叫"以包为准"了；
  - 强制两档**必然先备份**（`keepBackup` 忽略用户设置）：关掉回收 + 强制 = 不可恢复的批量删除，不给这个组合留口子；
  - `mirror` 会删掉"本机新建的文件"，所以界面上必须额外确认，且它是唯一会这么干的一档。
  - **下拉框按包的类型换一整套选项**（`APPLY_CHOICES`，界面 `renderChoices`）：完整副本给
    "按设置 / 以包为准 / 完全镜像"；更新包给"按设置 / 回退 / 两边都留 / 以我为准"。
    **不是把不合适的选项灰掉留一个孤零零的可用项** —— 包里没有某个文件，在完整副本里
    ＝"对方删过它"，在更新包里＝"什么也不代表"，两套选项本来就该不一样（用户要求）。
  - 引擎层仍然兜底：把 `bundle-wins` / `mirror` 传给更新包会 clamp 成 `normal`
    （`strictnessDowngraded` 标出来）。这条不能只靠界面（用户可能先选方式、再换包）。
- **应用有模块级串行锁**（`bundle/apply.ts` 里的 `applying`）：同步那边有 plugin 层锁，应用这边以前没有，
  两个对话框一起点会互相踩着写同一批文件。
- **目录（含空文件夹）要建，也要删 —— 但删必须过基准检查**：`scanTree` 除了文件还要收 `dirs`；
  `planSync` 出 `folders`（对面没有、基准里也没有 → 建；按 `allowsUpload/allowsDownload` 过滤）与
  `removedFolders`（对面没有、**基准里有** → 那一侧把它删了 → 跟着删；还要看「同步删除」开关）。
  基准是 `TargetState.dirs`（`rebuildDirs` 只记**两边都有**的目录，与文件同一条规矩），
  老状态文件没有这一项 → 升级后第一轮谁都不删。
  **目录的删除只能走 `removeEmptyDir`（`rmdir`）**：非空必然失败，所以清单漏看了文件
  （被排除规则挡住的那种）也只会"没删掉"。里面有文件的目录一律不归目录规则管（`dirsContainingFiles`），
  交给文件规则；被文件删除腾空的目录由 `pruneEmptyDirsDetailed` 顺手收拾。
  **删除清单必须"深的排前面"**（`byDepthDesc`）：父子都要删时先删父目录会被"非空"挡住，
  一轮只清掉最深的一层 —— 用户看到的就是"应用一次删不干净、每次多删几个"（报过的 bug）。
  **计划里的空目录还要按磁盘复核**（`pickRemovableEmptyDirs`）：扫描清单看不见被排除规则挡住的东西
  （`*.lsave`、`desktop.ini`…），`rmdir` 却会失败；复核时**从深到浅累计**，一个目录算"能删"
  要么本来就空、要么里面的东西全是这次要删的子目录。复核不掉的**如实报出来**
  （`SyncOutcome.keptFolders` / `ApplyReport.foldersKept`，通知里也写一句原因），
  并把它记进目录基准 —— 否则下一轮会把它当"新目录"重新建到对面去（用户明明删过它）。
  已经要写文件的目录会被 `copyFilePreservingMtime` 里的 `ensureDir` 顺带建出来，
  所以 `folders` 要跳过这些（`receivingSide()` + `implied`），否则界面上会重复报数。
  同步包那头：包里的目录集 = `header.emptyDirs` ＋ 条目的上级目录（`dirsInBundle`）；
  `mirror` 删掉本地所有"包里没有"的空目录（它的承诺就是完全一致）、
  `bundle-wins` / `normal` 只删 `state.bundle.dirs` 里记过的（＝对方删过它，`normal` 还要看开关）。
  应用/导出后 `state.bundle.dirs` 只记**两边都见过**的目录。目录位置杵着同名文件时**报失败不硬来**。
  **「删父目录」与「建新子目录」不许同时发生**（`removableDirs`）：对面把 `A` 删了、而你这边刚在 `A`
  里加了 `A/B`（不在基准里）时，父目录必须留着 —— 一个目录能删，除「基准里有 ＋ 底下没文件」之外，
  还得**底下的每个子目录也都能删**。否则一轮里「删 A」和「把 A/B 建过去」打架，用户看到的是
  「第一次删了又建了一部分、第二次才彻底同步成功」（报过的 bug）。判断按**深的在前**递归做：
  子目录的结论先算好，父目录再引用。
  报告里**文件与文件夹都要报**（包里几个、本地几个、一致几个、要建几个、要删几个、留着几个）——
  只报文件的话，用户永远不知道目录这边差多少。
- **目录 / 文件冲突**（本地同路径是文件夹、包里是文件）：`normal` 档报成明确失败、**不动那个文件夹**；
  强制两档才把它挪进回收目录腾位置。
- **上一次应用的结果必须落盘**：`state.bundle.files` 只记**两边都见过、且这次真的写成了一致**的路径 ——
  绝不能写成"当前仓库的完整清单"（那会把我独有的文件也记进基准，下次应用就被当成"对方删过它"删掉，这是报过的 bug）。
- **冲突输的那一份必须挪进回收目录的「冲突」文件夹**（`disk.ts` 的 `CONFLICT_TRASH_DIR`，
  本地侧 `.trash/locally-save/冲突/时间戳/`、副本侧 `.lsave/trash/冲突/时间戳/`），
  **不要留在原地** —— 留在仓库里的冲突副本会跟着同步传到对面去，两边各滚一份、越滚越多。
  两条通道（副本同步 / 应用同步包）都要守这条。
- **更新包只按它点名的删除清单删文件**（`header.deleted`）：**"没提到"不等于"被删了"** ——
  更新包只装自完整副本以来变过的文件，其余文件在包里根本不出现；照三方比对的结果翻译
  `delete-local` 的话，接收方每个没被提到的文件都会被判成"对方删过它"（1 万文件的仓库 +
  只改 1 个文件的更新包 → "删除 10203 个"，用户报过的 bug）。完整包才是"完整清单"，
  那时"基准里有、包里没有"确实是对方删过它。目录那侧不受影响：更新包的 `emptyDirs`
  是导出方**全部空文件夹**的清单（不是增量），所以"对方删了某个空文件夹"仍能正确识别。
- **更新包是以完整包为基准累积的**（`state.bundle.fullFiles` / `fullGeneration` / `history`）：
  成员按"自完整包以来变过"挑，但每个条目的 `base` 用**上次导出**时的样子 ——
  这样按顺序应用的人零冲突；`history` 则是为了认出"对方跳过了几个包、手里是我发过的中间版本"。
  没有基准（没导过完整包）时**拒绝**导更新包，不要悄悄退化成旧的"相对上次导出"语义。
- **`changes/` 里只留最新那一个更新包**（`removeSupersededChanges`）：导出成功后，把同血脉、
  世代更小的旧更新包删掉 —— 任何更新的更新包或更新的完整副本都包含它们的全部内容，
  留着只是占地，还会让人以为"包越攒越多、是不是漏应用了什么"（用户报过）。
  **只在写包成功、状态落盘之后**才动手（旧包是"目前唯一的改动备份"）；
  完整包（还原点）、别的血脉的包、读不出头部的一律不碰；
  `keepPaths` 用来排掉"同一次里先导出来的那个包"（现在顺序是先完整、后更新，
  它也够不着 changes 目录，所以只是一道保险：哪天有调用方反过来先导更新包，
  完整包那一步不至于把它当成"被取代的旧包"删掉）。
  **没删掉的必须如实报出来**（`SupersededReport.kept` → `ExportOutcome.keptChanges` →
  弹窗里那句话）：是别的血脉、还是世代不比新包小。悄悄留着会被当成"清理开关没生效"，
  或者更糟 —— 当成偶发 bug（用户报过："同一个操作第一遍没清、第二遍清掉了"）。
  开关是设置里的 `pruneSupersededBundles`。
- **世代（`state.generation`）只增不减**：应用一个**更老的**包时绝不能把它拨回去
  （`bundle/apply.ts` 里是 `Math.max`）。它记的是"这份副本见过这条血脉的哪一段"，
  不是"我此刻的内容像哪一代"。拨回去的后果就是上面那条：`removeSupersededChanges` 判
  "新包取代了旧包"靠的是「世代**严格更小**」，世代一倒退，同一个"导出完整包 + 更新包"的动作
  会第一遍清不掉、第二遍才清（用户报成偶发 bug，`test/bundle.test.ts` 第 36 组钉住了）。
- **更新包攒到上限要提醒"换基准"**（`bundle/size-warn.ts` + `ui/reset-baseline-modal.ts`）：
  上限是设置 `bundleSizeWarnLimit`（认 `200MB` / `500KB` / 1GB，不带单位按 MB；留空＝默认 200MB，
  填 0 ＝ 关掉）。到线弹窗，三个选项：**重新导出完整副本** / **打开更新包文件夹** / **跳过这次导出**。
  顺序上建议"先把更新包传过去应用、再换基准"（增量传得快），所以弹窗必须写清**换基准会清掉旧更新包**。
  「跳过」把**提醒线**记进 `state.bundle.warnedThreshold`，并按原上限整数倍往上抬
  （200 → 400 → 600…，不是按百分比）；换过基准则清零 —— 这样不会每轮同步都弹。
  判定与阈值都在 `size-warn.ts`（纯函数，测试钉死），弹窗只管显示与执行。

## 目录结构

```
src/
  main.ts          入口：生命周期与装配（实现 SyncHost）
  sync/            同步引擎（diff/exclude 是纯逻辑，disk 是唯一碰 fs 的）
  bundle/          .lsave 容器、导出、应用、包管理（manage.ts：列表 / 回收站）
  ui/              预览窗口、同步包界面（bundle-modal / bundle-list / manage-modal）、
                   状态栏、命令动作
  settings/        设置模型 + 字段表 + 面板
test/              测试（exclude / diff / sync / bundle / settings / commands）
```

## 命令与设置是稳定接口

- **命令 ID 不许改名**（用户快捷键认它）：`sync-now`、`sync-preview`、`upload-to-copy`、
  `download-from-copy`、`export-bundle`、`apply-bundle`、`manage-bundles`、`toggle-enabled`。
- **设置字段名不许改名**（用户 `data.json` 里存着它），改名前要写迁移。
- `test/commands.test.ts` 会把命令 ID 列表钉死；`test/settings.test.ts` 守住
  字段表完整性。

## 改代码的流程

```bash
npm test        # 629 项检查；改比对算法必跑（test/diff.test.ts 是完整矩阵）
npm run build   # tsc + esbuild，顺带部署到 vault
npm run lint    # eslint（obsidianmd 插件规则）
```

发版：改 `manifest.json` 的版本 → `npm version x.y.z` → push `main` → 在 `main` 上打同名 tag
（tag 不带 `v` 前缀；CI 会校验 tag 与 manifest 版本一致并跑测试）。

## 工具使用上的教训（别再踩）

**不要用 PowerShell 的 `Get-Content` / `Set-Content` 批量改这个仓库的文件**：
它会按系统代码页读、按 UTF-8 写，中文注释会整片变成乱码（本项目已经因此坏过一次，
靠 `git checkout` 与重写才救回来）。批量文本处理用 **Node**（默认就是 UTF-8），
单文件改动用编辑工具。

**测试必须跨平台**（CI 在 ubuntu 上跑，本机是 Windows）：路径一律 `path.join` / `toNative` 拼，
**别写字面量的 Windows 路径**。踩过一次：`deleteBundles(['Z:\\definitely\\missing.lsave'])` 断言
`basename` 是 `missing.lsave` —— 在 Linux 上反斜杠不是分隔符，`path.basename` 原样返回整串，
CI 直接红（本机却全绿）。发版流程里的 `npm test` 就是这道闸。

**提交信息里别带 ASCII 双引号**（用 `「」`）：PowerShell 传参会被拆开，`git commit -m` 会报
`pathspec ... did not match`；长消息写成文件用 `git commit -F` 最稳。

## 还没做的事

- [ ] 移动端：目前 `isDesktopOnly: true`（同步到仓库外必须用 fs）
- [ ] 大仓库的性能：扫描是元数据遍历，几百 MB 没问题；几万文件时值得再做增量扫描
