# bin/exports：交付包

`npm run build` 的产物目录 —— **Obsidian 能直接加载的那一份**。整个目录可以原样复制到
`<vault>/.obsidian/plugins/locally-save/`，或者作为 release 的资产上传。

| 文件 | 谁生成的 |
| --- | --- |
| `main.js` | `src/scripts/esbuild.config.mjs` 把 `src/main.ts` 打成一个 CJS 文件 |
| `manifest.json` | 构建时从**仓库根**复制（Obsidian 校验固定读根路径） |
| `styles.css` | 构建时从 `src/styles.css` 复制 |

除本 README 外都在 `.gitignore` 里：它们是构建产物，随时能重新生成。
`npm run build` 打完还会顺手同步到本机的插件目录（见 `src/scripts/deploy.mjs`）。

`data.json` 不在这里：那是 Obsidian（用户设置）自己写在插件目录里的文件。
