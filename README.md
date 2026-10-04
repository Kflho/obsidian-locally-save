# New Plugin（占位名）

Obsidian 插件，**功能待定** —— 目前是"空白模板 + 可直接开工的骨架"。

底子来自两处：

- **官方空白模板** [obsidianmd/obsidian-sample-plugin](https://github.com/obsidianmd/obsidian-sample-plugin)：`manifest.json`、`.github/`、`LICENSE`、发版流程；
- **js_02（note-tidy）**：构建链（esbuild + 自动部署）、**字段表驱动的设置面板**、测试守卫。

> ⚠️ `manifest.json` 的 `id` / `name` 和 `package.json` 的 `name` 还是占位值 `new-plugin`，
> 定了功能后要一起改（还有 `deploy.mjs` 里的 `DEFAULT_PLUGIN_DIR` 目录名）。见 `AGENTS.md`。

## 开发

```bash
npm install
npm run dev      # 监听改动，打包完自动同步到 vault 的插件目录
npm run build    # 类型检查 + 生产打包
npm test         # 设置面板完整性等守卫
npm run lint
```

改完在 Obsidian 里 **设置 → 第三方插件** 重新加载即可。

## 目录

```
src/
  main.ts              插件入口：只管生命周期与装配
  settings/
    model.ts           设置字段、默认值、收敛规则
    fields/            字段表（设置面板的单一数据源）
    tab.ts             设置面板：声明式 + 旧版 DOM 两条路都由字段表生成
  commands/            命令注册
  ui/                  弹窗等界面
test/                  测试（Node 直跑，无需框架）
```
