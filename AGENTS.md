# Locally Save —— 本仓库约定（改代码前先读）

Obsidian 插件 **locally-save**（仓库 `Kflho/obsidian-locally-save`，默认分支 `main`）：
把仓库打包成单个 `.lsave` 文件来回搬 —— **完整备份**是基准（也是还原点），
**更新包**是自某一份完整备份算到另一个状态的差量（只装这段时间里变过的那些文件）。
只有完整备份才算"点"：导出 / 应用更新包都**不推进基准**，所以更新包是**累积**的，
变大了再导一份新的完整备份换基准（插件会提醒）。

骨架来自官方空白模板（obsidian-sample-plugin）与 js_02（note-tidy）。

## 先看哪份文档

| 文件 | 什么时候读 |
|---|---|
| `bin/reference_docs/约定-基准与应用.md` | 改 `bundle/apply.ts` / `sync/diff.ts`：基准模型、三方比对祖先、移动、目录、强制回退、接上后续基准、版本号 / 内容校验值 |
| `bin/reference_docs/约定-导出与包.md` | 改 `bundle/export.ts` / `format.ts` / `merge.ts` / `manage.ts`：容器、命名、起点与发号、差分更新包、合并、清理、回收站 |
| `bin/reference_docs/约定-传输与界面.md` | 改 `bundle/incoming.ts` / `ui/*` / `git/*`：接收方向、按基准收、一拍顺序、git 远程仓库、通知与状态栏、界面文案 |
| `bin/reference_docs/technical_solution_docs/*-实施计划.md` | 想知道某次改动**为什么**这么做（历史与取舍） |
| `README.md` / `ui/help-modal.ts` | 用户手册；界面文案的详细解释放这里，不放界面 |

## 从 js_02 继承来的东西

1. **构建链**：`src/scripts/esbuild.config.mjs` 打在 `src/main.ts` → `bin/exports/main.js`，
   顺手把 `manifest.json` 与 `src/styles.css` 复制进 `bin/exports/`，再调 `src/scripts/deploy.mjs`
   同步到 vault 的插件目录（`OBSIDIAN_PLUGIN_DIR` 可覆盖；目录不存在就静默跳过）。
   Node 内置模块必须是 external 的**两种写法**（`fs` 与 `node:fs`），否则打包会报找不到模块。
2. **设置面板架构**：字段表是**单一数据源**，1.13+ 的声明式定义与 1.13 以下的手写 DOM
   都由它生成。加一个设置项 = 改 `model.ts` + `fields/`，别去手写 DOM。
3. **测试守卫**：测试项目在 `kf-development-project/obsidian-locally-save-test`；
   `npm test` 在那里跑，`test/run-tests.mjs` 的 `entryPoints` 也在测试项目里登记。
4. **发版脚本**：`version-bump.mjs` 同步 `manifest.json` 与 `versions.json`。
5. **开发热重载**（0.16.7 起装在本机 vault）：`.obsidian/plugins/hot-reload/`（pjeby/hot-reload 0.3.1）
   盯着**带 `.hotreload` 文件或 `.git` 子目录**的插件目录，`main.js` / `styles.css` 一改、静置约 0.75 秒
   就自动禁用再启用插件。`locally-save` 的部署目录里已经放了 `.hotreload`；插件加载时崩了也能用：
   再 `npm run build` 一次，它会把插件重新启用起来。（只装在有部署目录的那台机器上，
   `hot-reload` 必须在「已启用的社区插件」里。）
6. **别用 PowerShell 的 `Set-Content` / `Out-File` 改 vault 里的配置 json**
   （`community-plugins.json`、`appearance.json`…）：Windows PowerShell 的 `-Encoding utf8` 会写 **BOM**，
   Obsidian 的 `JSON.parse` 直接读崩，**把整份"已启用插件"列表清成 `[]`**（0.16.7 装热重载时踩过）。
   要写就用 `[System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))`，
   写完用 `node -e "JSON.parse(...)"` 验一遍、并确认首字节不是 `EF BB BF`。
   同理：**别在 Obsidian 开着的时候改它管的 json** —— 退出时会按内存里的状态覆盖回去。

## 只有一条通道（0.8.0 的硬决定，别把第二条请回来）

- **包是唯一的搬运格式**：完整备份（基准 + 还原点）+ 更新包（自某一份完整备份算出的差量）。
  不要再引入「文件夹副本 / 远程端 / 上传下载 / 同步方向 / 双写」那套概念 ——
  那正是 0.8.0 删掉的东西：两条通道各自实现一遍"基准 / 冲突 / 回收 / 删除传播"，
  分叉出的行为差异已经交过一次学费。共用目录那种"一直自动同步"用 Remotely Save 那类方案。
- **命令 ID 一个都没改**（用户快捷键认它），但语义换了：`sync-now` → 「立即导出」，
  `sync-preview` → 「预览：这次会导出什么包」；`upload-to-copy` / `download-from-copy`
  **暂时还注册着**，只弹指路通知，**这两个 ID 下一版再删**（直接删会让用户的快捷键静默失效）。
- **删设置项可以，但要守两条**：**语义不能悄悄变**、**别把该留的能力删掉**。
  0.8.0 删了 `targetDir` / `syncDirection`，迁移规则写在 `settingsFrom` 里：
  老 `data.json` 只有 `targetDir`、没填过 `bundleDir` → `bundleDir` 迁到 `<旧 targetDir>/.lsave/bundles`。
- **`bundleDir` 是必填项**：留空时导出 / 应用按钮是灰的并提示去填 —— 包放哪儿必须由用户说了算。
- 三个自动触发的**字段名不变**（`syncOnStartup` / `autoSyncInterval` / `syncAfterSaveDelay`），
  语义是"自动导出的时机"；两个「自动导出」开关都关着时，触发了什么都不做、不弹错。

## 改代码前必须知道的硬约束（细节都在上面那三份文档里）

1. **引擎不许 import obsidian**：`src/sync/` 与 `src/bundle/` 里没有任何 `from 'obsidian'`。
   仓库路径 / 状态文件 / 配置目录 / 日志 / 进度回调都由调用方传进去（见 `ExportOptions`），
   所以测试能拿临时目录直接跑。碰 `node:fs` 的只有三处：`sync/disk.ts`（扫描 / 删除 / 回收 / 哈希）、
   `bundle/format.ts`（读写容器）、`bundle/apply.ts`（落盘与移文件）。
2. **先算后做**：`planBundleApply()` / `planSync()` / `planBundleExport()` 只读不写，
   用户看过报告才 `executeBundlePlan()` / `writeBundle`。「打开包」可以随便点，不会碰文件。
3. **删除必须过 base 检查**，没有例外：本地改过的东西不删，宁可留着。
   **更新包只按它点名的删除清单删**（`header.deleted`）——"没提到"不等于"被删了"，
   照三方比对结果翻译会变成"删除一万个"（用户报过的 bug）。完整备份才是完整清单。
   **删除清单是累积的**（`state.bundle.ghosts`，0.17）：base 之后新建、后来又删掉的路径，
   每一份更新包都要点名 —— 只点一次的话，没应用中间那一份、直接应用最新包的机器**永远删不掉它**
   （真机：`live/implement` 反反复复被重建）。换基准或路径又出现时才清掉（见导出文档 6.2）。
4. **`src/sync/diff.ts` 是三方比对引擎**（`planSync` + `sameRecord` + `dirsContainingFiles`）：
   `apply.ts` 的 `normal` 档借"仅下载"方向 + `directionDecidesConflict: false` 走它。
   **副本通道没了不等于它能删** —— `test/diff.test.ts` 的整套矩阵就是给它守的。
5. **判"变了没有"用大小 + 修改时间，mtime 有 2 秒容差**（FAT/exFAT），导出挑成员与应用比对都用它。
   写测试时注意：**同一秒内改同样长度**的文件会被当成没动过（换内容长度，或把时间拉开）。
6. **`.lsave` 容器**：头部先写、偏移量提前算好（不回写）；尾部是 `[标记][JSON][长度]`，
   读的时候先看文件末尾 4 字节 —— 写读顺序必须一致。文件名与命名规则见导出文档。
7. **基准 ＝ 完整备份**（0.14 起的核心模型）：改基准 / 应用 / 导出前先读
   `bin/reference_docs/约定-基准与应用.md` 第 1、2 节。**别退回"导出更新包也把基准往前推"**，
   也**别加"两端同步推进"的逻辑**。
8. **应用的三条硬规矩**：更新包只能往前走（更旧的包不许整体替换）；完整备份一律完全镜像
   （仓库 == 包）；更新包必须与本机同一份基准（三个例外见文档）。
   **三方比对的祖先 ＝ 我上次跟对方交换到的样子**，包自带的旧 `base` 不许顶掉它
   （0.16.14：本机删除被累积包撤回的根因）。
9. **接收按「方向」分**（`upload` 不看接收文件夹 / `download` 收到就镜像应用 / `both` 先确认，
   无人值守走 `normal + keep-both`）。方向是硬边界，不只是提示文案。
10. **用户交互文字只显示两类：当前状态、要求用户操作**（0.16.14）：
    例行的后台同步 / 自动导出 / 自动接收**不弹通知**（状态栏一句、悬停详情、日志、更新记录承载）；
    只有"删了本机文件 / 恢复误改 / 强制回退 / 需要用户动手 / 出错"才弹。细节见传输与界面文档第 0 节。
11. **界面文案按"正常插件"写**：设置项是**一行名字 + 一句话说明**，别把界面当说明书；
    长解释进制 `README.md` / `ui/help-modal.ts`；报数行一行一项。
12. **命令 ID 与设置字段名是稳定接口**，不许改名（改要写迁移）。**UI 上别撞社区规矩**
    （不用废弃 API、不写死 `.obsidian`、定时器用 `window.setTimeout`、README 留英文概览）——
13. **换基准之后仍在使用旧完整备份的电脑，靠差分更新包接上**（0.18，`bundle/rebaseline.ts`）：
    完整备份不进远程仓库，按每台报的 `baselineHash` 逐个导「它那份 → 我这份」的差分更新包；
    它一律**按严格镜像应用**（合并档会把新基准令牌记成祖先那一版 → 之后再也不一致）。
    **收下之后那台机器自己要再留一份这个基准的完整备份**（`planBaselineCopy`：先核对
    校验值，对得上才补 —— 不一致就是另一个基准），这样两边各持一份同一份。
    清理判据只有一条：**起点已经没有任何电脑在用** —— 更新包/差分更新包自动移到回收站，
    **完整备份永远手动**（`bundle/stale.ts`，它是还原点）。见
    `bin/reference_docs/technical_solution_docs/换基准整理-实施计划.md`。

细节、理由、踩过的坑、以及每条对应的守护用例，都在 `bin/reference_docs/约定-*.md` 里。

## 目录结构

目录按 `kf-personal-development` 的 `docs.md` 整理：**仓库根只放「仓库必需」的东西**
（`manifest.json` / `versions.json` 是 Obsidian 固定读根路径的配置，`README.md` / `LICENSE`
是 GitHub 入口，`AGENTS.md` 是 agent 约定），代码与工具都进 `src/`，资料与产物进 `bin/`。

```
manifest.json / versions.json  Obsidian 插件元数据（根路径固定，不能搬）
README.md / LICENSE / AGENTS.md  入口文档
src/                            源码 + npm 工程（package.json / 锁 / tsconfig / styles.css / scripts）
  main.ts          入口：生命周期与装配（仓库路径 / 状态文件 / 配置目录 / 进度回调）
  sync/            公共件：diff（三方比对）/ disk（唯一扫盘的地方）/ exclude / vault /
                   state（状态文件）/ hash-cache / state-id（内容校验值）
  bundle/          .lsave 容器（format）、导出（export）、应用（apply）、
                   包管理（manage）、基准校验值（baseline）、完整备份的选择与命名（anchor）、
                   串联（chain，引擎留着）、合并相邻更新包（merge）、
                   自动接收（incoming）、更新记录（log）、路径（paths）、
                   换基准的差分更新包（rebaseline）、旧完整备份的清理（stale）
  ui/              导出弹窗与预览、应用弹窗、包列表、管理 / 更新记录 / 帮助弹窗、
                   动作层（actions）、差分更新包与清理入口（rebaseline）、状态栏、命令动作
  settings/        设置模型 + 字段表 + 面板
  scripts/         构建 / 部署 / 发版 / 体检：esbuild.config.mjs、deploy.mjs、
                   version-bump.mjs、eslint.config.mts、check-bom.mjs
bin/exports/      交付包（构建产物：main.js + manifest.json + styles.css；除 README 外不进 git）
bin/reference_docs/  规范、设计记录、调研（进 git）
  research/            实测记录、调研
  technical_solution_docs/  实施计划、分析与优化
data/             中间产物（除 README 外不进 git）
dev/              本机草稿、日志、失败尝试（不进 git；多机各写各的）
.github/          CI / release 工作流
```

> 测试不在本仓：`kf-development-project/obsidian-locally-save-test`（`src` / `node_modules`
> 用 junction 指回本仓，`test/` 与 `test/run-tests.mjs` 都住在那儿）。

## 改代码的流程

npm 工程根在 `src/`，命令都在 `src/` 下跑（或者从仓库根用 `--prefix src`）：

```bash
cd src
npm run build     # tsc + esbuild → bin/exports/，顺带部署到 vault
npm run lint      # eslint（obsidianmd 插件规则）—— 0 error 才算过
npm run check-bom # BOM / 旧名 / JSON 能解析（发布前跑）
```

测试在私有测试仓里跑（那边有 `test/` 与 `test/run-tests.mjs`）：

```bash
cd <kf-development-project>/obsidian-locally-save-test
npm test          # 全量用例（31 个文件）；改比对算法必跑（test/diff.test.ts 是完整矩阵）
```

`test/auto-export.test.ts` 与 `test/auto-apply.test.ts` 是两条链路的端到端（插件装配 +
真实临时目录）：前者管"导出"，后者管"接收 → 安全边界 → 自动应用"，
改动自动导出 / 自动应用 / 状态栏 / 通知文案时要一起看它们。

**改行为就改测试**：测试是效果的唯一证据。新增 / 改一条行为，要同时改到守护它的用例；
用例号会随迁移调整，按内容找。

发版：改 `manifest.json` 的版本 → `cd src && npm version x.y.z` → push `main` → 在 `main` 上打同名 tag
（tag 不带 `v` 前缀；CI 会校验 tag 与 manifest 版本一致，并在 `src/` 里构建）。
`npm version` 的 **`postversion` 会顺带跑一次 `npm run build`**：不然 vault 里那份
`manifest.json` 会仍显示旧版本号（代码新、版本号旧），复制到另一台机器装出来就是旧版本。

## 工具使用上的教训（别再踩）

- **不要用 PowerShell 的 `Get-Content` / `Set-Content` 批量改这个仓库的文件**：
  它会按系统代码页读、按 UTF-8 写，中文注释会整片变成乱码（本项目已经因此坏过一次）。
  批量文本处理用 **Node**（默认 UTF-8），单文件改动用编辑工具。
- **测试必须跨平台**（CI 在 ubuntu 上跑，本机是 Windows）：路径一律 `path.join` / `toNative` 拼，
  **别写字面量的 Windows 路径**（踩过：`path.basename('Z:\\...\\missing.lsave')` 在 Linux 上
  原样返回整串，CI 直接红、本机却全绿）。
- **提交信息里别带 ASCII 双引号**（用 `「」`）：PowerShell 传参会被拆开，`git commit -m` 会报
  `pathspec ... did not match`；长消息写成文件用 `git commit -F` 最稳。
- **覆盖类改动先写用例**：2026-10-26 两起真机事故 —— 「镜像覆盖没备份，把用户新版盖成旧版」
  与「同版本的另一份包把已删文件复活」。规矩：① 覆盖本地已有内容时，本地那份**先进回收目录**，
  判据是「包里这条比本机基准旧」（往回写），不是「本地相对基准改没改」——基准自己也会被更新；
  ② **同一版本只接收最新的那一份**（`hasNewerSameGenerationSibling`）。两条都有回归用例
  （`alignment.test.ts` ⑥、`incoming-forward.test.ts`）。
- **跑整套测试，别只跑一个文件**：`stale-baseline` / `anchor-start` / `baseline-anchor` 用的是
  `N/M checks passed` 汇总，不跟其他文件一样打「共 N 次检查」——只 grep 后者会漏掉它们的红。

## 用词（写界面、文档、注释都按这个来）

用户点过名：**别用比喻式的术语**，也别生造动词搭配。写的时候直接说动作与对象。

| 别写 | 写成 |
|---|---|
| 血脉 / 同一条血脉 | 分支 / 同一条分支（字段名 lineage 不变） |
| 站在那份完整备份上 / 基准是第 961 代 | 以那份完整备份为基准 / 基准是第 961 版 |
| 落到新基准上 / 落地 | 换到新基准上 / 应用完成 |
| 挪进回收站 / 挪走 | 移到回收站 / 移走 |
| 收口 | 整理 / 收尾 |

界面上只写当前状态与要用户做什么（第 10 条）；比喻、行话留在实现文档里也不行 ——
**注释是下一次生成的输入**，写在那里就会被照着写出来。

## 发布：别手动建 release（2026-10-26 踩过）

- 打 tag → push tag 就够了：Release 工作流自己 gh release create 并挂三个资产；
- 手动先建会撞车：工作流报  release with the same tag name already exists → Release 红；
- 补救：gh release delete <tag> --yes（保留 tag）→ gh run rerun <run-id>，让 CI 重新产出。

## 还没做的事

- [ ] **串联的界面：不再计划**。0.14 起"链条上的中间点"不存在了（`bundle/points.ts` 已删、
      `planAutoStart` 也删了）。`src/bundle/chain.ts`（`planChain()` 只读分析 / `runChain()`
      按顺序应用 + 保住本机改动）**只作为引擎留着**，不 import obsidian；测试仓里的
      `test/chain.test.ts` 还在。
- [ ] `upload-to-copy` / `download-from-copy` 两条过渡命令的删除（下一版）。
- [ ] 移动端：目前 `isDesktopOnly: true`（读写仓库之外的文件必须用 fs）。
- [ ] 大仓库的性能：扫描是元数据遍历，几百 MB 没问题；几万文件时值得再做增量扫描。
- [ ] 自动应用目前**每 30 秒轮询一次**。真要"秒级响应"得上 `fs.watch`，但要处理一堆平台差异
      （网盘同步目录的写入是分块的，容易看到半个文件）；包目录本来就允许"还没传完的包"，
      所以轮询 + 头部校验这套更稳。
