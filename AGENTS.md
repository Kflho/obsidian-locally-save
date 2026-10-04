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
  （`src/bundle/paths.ts`）。两个自动留包的开关**各自独立**，导出顺序必须是
  **先更新包、后完整包** —— 完整包会把"上次导出的样子"更新成当前仓库，反过来更新包就没内容可装了。
- **冲突输的那一份必须挪进回收目录的「冲突」文件夹**（`disk.ts` 的 `CONFLICT_TRASH_DIR`，
  本地侧 `.trash/locally-save/冲突/时间戳/`、副本侧 `.lsave/trash/冲突/时间戳/`），
  **不要留在原地** —— 留在仓库里的冲突副本会跟着同步传到对面去，两边各滚一份、越滚越多。
  两条通道（副本同步 / 应用同步包）都要守这条。
- **更新包是以完整包为基准累积的**（`state.bundle.fullFiles` / `fullGeneration` / `history`）：
  成员按"自完整包以来变过"挑，但每个条目的 `base` 用**上次导出**时的样子 ——
  这样按顺序应用的人零冲突；`history` 则是为了认出"对方跳过了几个包、手里是我发过的中间版本"。
  没有基准（没导过完整包）时**拒绝**导更新包，不要悄悄退化成旧的"相对上次导出"语义。

## 目录结构

```
src/
  main.ts          入口：生命周期与装配（实现 SyncHost）
  sync/            同步引擎（diff/exclude 是纯逻辑，disk 是唯一碰 fs 的）
  bundle/          .lsave 容器、导出、应用
  ui/              预览窗口、同步包界面、状态栏、命令动作
  settings/        设置模型 + 字段表 + 面板
test/              测试（exclude / diff / sync / bundle / settings / commands）
```

## 命令与设置是稳定接口

- **命令 ID 不许改名**（用户快捷键认它）：`sync-now`、`sync-preview`、`upload-to-copy`、
  `download-from-copy`、`export-bundle`、`apply-bundle`、`toggle-enabled`。
- **设置字段名不许改名**（用户 `data.json` 里存着它），改名前要写迁移。
- `test/commands.test.ts` 会把命令 ID 列表钉死；`test/settings.test.ts` 守住
  字段表完整性。

## 改代码的流程

```bash
npm test        # 356 项检查；改比对算法必跑（test/diff.test.ts 是完整矩阵）
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

## 还没做的事

- [ ] 移动端：目前 `isDesktopOnly: true`（同步到仓库外必须用 fs）
- [ ] 大仓库的性能：扫描是元数据遍历，几百 MB 没问题；几万文件时值得再做增量扫描
