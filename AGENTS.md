# Obsidian plugin —— 本仓库约定（改代码前先读）

本仓库是 **js_03** 的新插件（`manifest.json` 里的 id 暂为占位值 `new-plugin`，功能待定）。

骨架有两条来源：**官方空白模板**（obsidian-sample-plugin）与 **js_02（note-tidy）**。
从 js_02 继承来的、必须照着走的东西都在下面。

## 从 js_02 继承来的四样东西

1. **构建链**：`esbuild.config.mjs` 打在 `src/main.ts` → `main.js`，打完自动调 `deploy.mjs`
   同步到 vault 的插件目录。目标目录取 `OBSIDIAN_PLUGIN_DIR`，否则用 `deploy.mjs` 里的
   `DEFAULT_PLUGIN_DIR`；**目录不存在就静默跳过**（CI 上跑 build 不该失败）。
2. **设置面板架构**：字段表是**单一数据源**，Obsidian 1.13+ 的声明式定义与 1.13 以下的
   手写 DOM 都由它生成。加一个设置项 = 改 `model.ts` + `fields/`，别去手写 DOM。
3. **测试守卫**：`node test/run-tests.mjs`（esbuild 打包测试后在本进程跑，无测试框架），
   其中 `test/settings.test.ts` 守住"每个设置字段有且只有一条定义、下拉默认值合法、
   收敛规则生效"。
4. **发版脚本**：`version-bump.mjs` 同步 `manifest.json` 与 `versions.json`
   （判的是版本号本身有没有记过，不是 minAppVersion）。

## 目录结构

```
src/
  main.ts                    入口：只做生命周期（读设置、装配、注册命令与设置面板）
  settings/
    model.ts                 设置接口 + DEFAULT_SETTINGS + 取值收敛
    fields/index.ts          SETTINGS_SECTIONS / FIELD_INDEX / ALL_FIELDS
    fields/<分区>.ts         各分区的字段表（一个分区一个文件）
    tab.ts                   设置面板（声明式 + 旧版 DOM）
  commands/index.ts          命令注册
  ui/                        弹窗 / 视图
test/                        测试
```

## 加东西时的规矩

- **加一个设置项**：`settings/model.ts` 加字段与默认值 → `settings/fields/` 加一条
  （`key` 必须与设置字段名一致）→ `npm test` 核对完整性。**只改这两处**。
- **加一条命令**：`commands/` 里实现，`addCommand({ id, name, callback })` 注册。
  **命令 ID 一旦发布就是稳定接口，不许改名**。
- **设置字段名同样是稳定接口**（用户 `data.json` 里存着它），改名前要写迁移。
- **`main.ts` 保持精简**：功能逻辑放各自模块，入口别超过 ~100 行。
- 用 `this.register*`（`registerEvent` / `registerDomEvent` / `registerInterval` / `register`）
  挂一切需要清理的东西，保证卸载不泄漏。

## 还没有做的事（定了功能再补）

- [ ] 定插件 `id` / `name` / 描述：改 `manifest.json`、`package.json`、
      `deploy.mjs` 的 `DEFAULT_PLUGIN_DIR`，以及 `styles.css` 里的类名前缀。
- [ ] 按功能写 `src/` 下的模块与对应测试。
- [ ] 补 `README.md` 的功能说明与隐私说明（**要发社区就必须写清联网行为**）。

## 环境

- 源码在 `projects/js_03`，**不在 vault 里**；vault 的 `.obsidian/plugins/<id>/` 只放运行用文件。
- Node 18+、npm、esbuild（模板技术栈，别换成 rollup 除非连带改脚本）。
- 联网行为遵守 Obsidian 开发者政策：默认本地离线、不做隐藏遥测、不执行远程代码。
