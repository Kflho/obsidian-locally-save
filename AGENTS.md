# Locally Save —— 本仓库约定（改代码前先读）

Obsidian 插件 **locally-save**（仓库 `Kflho/obsidian-locally-save`，默认分支 `main`）：把仓库打包成单个 `.lsave` 文件来回搬。完整备份是基准，也是还原点；更新包是自某份完整备份算出的差量。导出或应用更新包不推进基准，更新包累积变大后再导一份新的完整备份换基准。

## 先读哪份

| 文件 | 什么时候读 |
|---|---|
| `bin/reference_docs/约定-基准与应用.md` | 改 `bundle/apply.ts` / `sync/diff.ts`：基准模型、三方比对、移动、目录、强制回退、接后续基准、版本号与校验值 |
| `bin/reference_docs/约定-导出与包.md` | 改 `bundle/export.ts` / `format.ts` / `merge.ts` / `manage.ts`：容器、命名、发号、差分更新包、合并、清理、回收站 |
| `bin/reference_docs/约定-传输与界面.md` | 改 `bundle/incoming.ts` / `ui/*` / `git/*`：接收方向、按基准收、一拍顺序、git 远程、通知与状态栏、界面文案 |
| `bin/reference_docs/technical_solution_docs/*-实施计划.md` | 查某次改动的历史与取舍 |
| `README.md` / `ui/help-modal.ts` | 用户手册；界面文案的详细解释放这里 |

## 构建与部署

- 构建链：`src/scripts/esbuild.config.mjs` 把 `src/main.ts` 打进 `bin/exports/main.js`，复制 `manifest.json` 与 `src/styles.css`，再调 `src/scripts/deploy.mjs` 同步到 vault 插件目录（`OBSIDIAN_PLUGIN_DIR` 可覆盖；目录不存在静默跳过）。
- Node 内置模块两种写法都要 external：`fs` 与 `node:fs`。
- 设置面板：字段表是单一数据源，1.13+ 声明式与旧版手写 DOM 都由它生成；加设置项只改 `model.ts` + `fields/`。
- 测试在 `kf-development-project/obsidian-locally-save-test`；`npm test` 在那里跑，`test/run-tests.mjs` 的 `entryPoints` 也登记在测试仓。
- 发版：`version-bump.mjs` 同步 `manifest.json` 与 `versions.json`。
- 热重载：`.obsidian/plugins/hot-reload/` 监听带 `.hotreload` 或 `.git` 的插件目录；`main.js` / `styles.css` 改动后约 0.75 秒自动禁用再启用。部署目录已放 `.hotreload`，hot-reload 要在已启用社区插件里。

## 目录

```
manifest.json / versions.json  Obsidian 元数据（根路径固定）
README.md / LICENSE / AGENTS.md  入口文档
src/                             源码 + npm 工程
  main.ts                        生命周期与装配
  sync/                          diff / disk / exclude / vault / state / hash-cache / state-id
  bundle/                        format / export / apply / manage / baseline / anchor /
                                 chain / merge / incoming / log / paths / rebaseline / stale
  ui/                            导出/应用/包列表/管理/更新记录/帮助、动作层、状态栏
  settings/                      设置模型 + 字段表 + 面板
  scripts/                       构建、部署、发版、体检
bin/exports/                     交付包（构建产物，除 README 外不提交到 Git）
bin/reference_docs/              规范、设计记录、调研（提交到 Git）
data/                            中间产物（除 README 外不提交到 Git）
dev/                             本机草稿、日志（不提交到 Git）
```

测试不在本仓：`kf-development-project/obsidian-locally-save-test`（`src` / `node_modules` 用 junction 指回本仓）。

## 一条通道

包是唯一搬运格式：完整备份 + 更新包。不要再引入文件夹副本、远程端、上传下载、同步方向、双写等第二条通道；共用目录的持续自动同步交给 Remotely Save 一类方案。

## 硬约束

1. **引擎不 import `obsidian`**：`src/sync/` 与 `src/bundle/` 里没有 `from 'obsidian'`；仓库路径、状态文件、配置目录、日志、进度回调由调用方传入。碰 `node:fs` 的只有 `sync/disk.ts`、`bundle/format.ts`、`bundle/apply.ts`。
2. **先算后做**：`planBundleApply()` / `planSync()` / `planBundleExport()` 只读；用户看过报告后才 `executeBundlePlan()` / `writeBundle`。
3. **删除过 base 检查**：本地改过的内容不删；更新包只按 `header.deleted` 的清单删，“没提到”不等于“被删”。删除清单累积在 `state.bundle.ghosts`，每份更新包都点名；换基准或路径重新出现时才清。
4. **三方比对引擎**：`src/sync/diff.ts` 的 `planSync` + `sameRecord` + `dirsContainingFiles`；`apply.ts` 的 `normal` 档借“仅下载”方向 + `directionDecidesConflict: false` 走它。`test/diff.test.ts` 是完整矩阵。
5. **判断变化用大小 + mtime，mtime 容差 2 秒**（FAT/exFAT）。测试时同一秒内改同样长度会被当成没变；换内容长度或拉开时间。
6. **`.lsave` 容器**：头部先写、偏移量提前算好不回写；尾部是 `[标记][JSON][长度]`；读时先看末尾 4 字节。写读顺序必须一致。
7. **基准 = 完整备份**：导出更新包不推进基准，也不加“两端同步推进”逻辑。改基准 / 应用 / 导出前先读基准文档第 1、2 节。
8. **应用规则**：更新包只能往前走；完整备份完全镜像；更新包必须与本机同一基准；三方比对的祖先是我上次跟对方交换到的样子，包自带旧 `base` 不顶掉它。接收按方向分：`upload` 不看接收文件夹、`download` 收到就镜像、`both` 先确认，无人值守走 `normal + keep-both`。
9. **换基准接续**：仍在使用旧完整备份的机器靠 `bundle/rebaseline.ts` 的差分更新包接上；它按严格镜像应用，收下后本机再留一份该基准的完整备份。清理判据：起点已没有任何电脑在用；更新包进回收站，完整备份永远手动。
10. **命令 ID 与设置字段名是稳定接口**：`sync-now` / `sync-preview` 语义已改但 ID 保留；`upload-to-copy` / `download-from-copy` 暂留指路通知，下一版删。删设置项要守语义不悄悄变、能力不丢，迁移写在 `settingsFrom`。
11. **`bundleDir` 必填**；留空时导出/应用按钮灰显并提示。三个自动触发字段名不变，语义是自动导出的时机；两个自动导出开关都关时触发了不做事、不报错。
12. **界面文字只写当前状态与要求用户操作**：例行后台同步/自动导出/自动接收不弹通知；只有删本机文件、恢复误改、强制回退、需要用户动手、出错才弹。设置项一行名字 + 一句话说明；长解释进 README / 帮助弹窗；报数一行一项。
13. **UI 守社区规矩**：不用废弃 API、不硬编码 `.obsidian`、定时器用 `window.setTimeout`、README 留英文概览。

## 命令

```bash
cd src
npm run build      # tsc + esbuild → bin/exports/，顺带部署到 vault
npm run lint       # eslint；0 error 才算过
npm run check-bom  # BOM / 旧名 / JSON 可解析；发布前跑
```

测试：

```bash
cd <kf-development-project>/obsidian-locally-save-test
npm test
```

`test/auto-export.test.ts` 与 `test/auto-apply.test.ts` 是自动导出、接收 → 安全边界 → 自动应用的端到端；改自动导出/自动应用/状态栏/通知文案时一起看。改行为就改守护用例，按内容找用例号。

## 发版

改 `manifest.json` 版本 → `cd src && npm version x.y.z`（`postversion` 会跑 `npm run build`）→ push `main` → 在 `main` 打同名 tag（不带 `v`）→ CI 校验 tag 与 manifest 版本并在 `src/` 构建。

## 工具与测试

- 批量文本处理用 Node（UTF-8）；不要用 PowerShell `Get-Content` / `Set-Content` 批量改本仓，中文会乱码。
- 测试跨平台：路径用 `path.join` / `toNative`，不写字面量 Windows 路径。
- 提交信息不用 ASCII 双引号（用 `「」`）；长消息写文件用 `git commit -F`。
- 覆盖类改动先写用例：覆盖本地已有内容时，本地那份先进回收目录，判据是“包里这条比本机基准旧”；同一版本只接收最新的一份。
- 跑整套测试，不只跑一个文件；`stale-baseline` / `anchor-start` / `baseline-anchor` 用 `N/M checks passed` 汇总。

## 用词

界面、文档、注释都直接写动作与对象，不用比喻术语。例：`血脉` → `分支`；`站在那份完整备份上` → `以那份完整备份为基准`；`落到新基准上` → `换到新基准上`；`挪进回收站` → `移到回收站`；`收口` → `整理`。注释同样按这个标准写。

## 发布

打 tag → push tag；Release 工作流自己创建 release 并挂三个资产。不要手动 `gh release create`；手动先建会与工作流冲突。误建时：`gh release delete <tag> --yes` → `gh run rerun <run-id>`。

## 未完成

- `upload-to-copy` / `download-from-copy` 下一版删除。
- 移动端：当前 `isDesktopOnly: true`。
- 大仓库性能：几万文件时再做增量扫描。
- 自动应用每 30 秒轮询；秒级响应需 `fs.watch`，但要处理网盘分块写与半个文件。
