# locally-save 双向同步：问题与计划（草稿，待对面确认）

> 状态：**只读调查 + 计划草稿**，还没改任何代码。
> 先发 relay 给 KAHOTAT 确认流程、环境和三个问题，再补完这页、两边确认，最后才开工。

## 0. 流程（两边都照做）

1. **cd 到仓库再写 temp**：开发哪个仓库，`temp/`、草稿、日志就写哪个仓库里，不混到别的仓库。
2. **开发 skill / 改远程同步前先问对面**：最近在不在开发、dev 状态（未推提交 / 未发布改动）、要不要先同步。
3. **先达成一致再开工**：用 plan mode / 共享计划书；先出计划、复现和测试，再改代码；避免边改边加需求、无限修改。

背景补充：`#11` 的 fetch + 闸门 + 关单是 watcher 的 headless 自动跑的（结果与对面一致）；按第 3 条，后续实质工作改为「通知主会话 → 先出计划 → 再动手」，不让 headless 自动做。

## 1. 环境（对面已回）

- **对面有 vault**（不是只装插件）：`D:\data\online\software\common\obsidian`；
  插件 `0.15.7`，Obsidian `1.8.10`，Windows；最近没在改 locally-save / 远程同步；
- 各库 HEAD（对面，按 name / remote 对齐）：locally-save `bed51d6`、
  kf-personal-development `ce02a4e`、kf-proposal-exports `aa31225`、
  kf-personal-service 源仓 `8aed821`；全部干净、无未推提交；
- 我们这边 `obsidian-locally-save` 的克隆是 `sc_03`，remote
  `ssh://git@ssh.github.com:443/Kflho/obsidian-locally-save.git`；按 name / remote 对齐，
  不拉错目录、不套用对方的本地路径（`references/projects.md`）；
- 对面还没做 A/B/C 定向观察；会先读插件代码 + 本机 `data.json` / 日志，下一条 relay
  发摘要；两边都先不动代码，等计划书。

## 2. 问题 A：收到包要确认，不点确认会怎样

**现象待确认**：用户收到包后要点确认；不点确认时，包是 pending、dismissed，还是阻塞后续同步？下一次节拍/下一次同步还会不会提示？

**要读的代码**：

- `src/bundle/incoming.ts`：`IncomingPolicy`、`pickIncoming`、`sweepIncoming`、`checkIncomingBundles`
- `src/ui/actions.ts`：`incomingPolicy`、`confirmIncomingApply`、`handleIncoming`、`isDestructivePlan`
- `src/ui/bundle-modal.ts`：应用对话框的「应用 / 取消 / 关闭」落什么状态
- `src/sync/state.ts`：`state.incoming` 的 `pending` / `needs-review` / `dismissed` / `failed` 记录

**要回答**：

- 关闭对话框 = 取消还是待办？`state.incoming` 记什么？
- 不确认时，下一拍会不会重复弹？会不会把这个包记成 `dismissed` 再也不挑？
- 手动「立即同步」会不会重挑 `needs-review` / `failed`？`dismissed` 会不会重挑？
- 目标：不确认时**不丢包、不静默、不刷屏**，并且用户之后能一键处理。

## 3. 问题 B：双向同步两边都留更新包，最后怎么清

**现状**（按 `AGENTS.md` 与代码，待复核）：

- `changes/` 默认保留；`removeSupersededChanges` 只删「同一份起点 + 同一形态 + 同一台机器导的」，别的机器 / 别的起点 / 别的形态都留着。
- 因此两边各导各的包，数量会涨；`bundleSizeWarnLimit` 只提醒，不清理。
- `.lsave-peers` 有每台机器的 `stateId/generation/baseline`，但「哪份包可以删」还没有收敛规则。

**要回答**：

- 两边都到达同一 `stateId` 后，旧的更新包能不能自动移到回收站？
- 如果对面离线，删早了它接不上；保留窗口按时间、按「离线机器还用哪份基准」、还是按 peer 状态？
- 谁来决定保留哪一份：总是保留最新、按源头各留一份、还是保留「离每个 peer 的基准最近」的那份？
- 目标：自动同步、用户操作最小；不手动删包、不重复导包。

**候选方向**（先讨论，不写代码）：

1. 收敛后自动 GC：两边 `stateId` 一致且包已被双方应用过，旧包进回收站；保留最近 N 天 / 每个起点最新一份。
2. 以 peer 状态为准：保留「每个 peer 的 `baselineHash` 对应的那份起点包 + 最新落点包」，其余可清。
3. 换基准时用差量包整理：完整包不推，差量包（旧基准→新基准）保留到所有 peer 跟上。

## 4. 问题 C：删包重导后，对面拿到不是同一份，一边领先一个世代

**现象**：用户发现没同步 → 手动删更新包 → 重新导出；对面点同步后包不是同一份，一边领先一个世代，落后那边没同步到最新包。

**要读的代码**：

- `src/bundle/export.ts`：`maxGeneration`、`raiseGeneration`、`removeSupersededChanges`、`generationFloor`
- `src/bundle/incoming.ts`：`sweepIncoming` 的「按基准 + 按源头分组取最新」、`pickIncoming` 的 `retryBlocked`
- `src/bundle/apply.ts`：`checkAncestor`、`targetIsMine`、`viaMine`、`landedOnBaseline`、`state.incoming`
- `src/sync/state.ts`：`state.bundle`、`state.maxGeneration`、`state.incoming`

**假设**（待验证）：

- 手动删包后重导，新包换了 `bundleId` / 起点或落点，但 `stateId` / `generation` 没按预期推进；
- 高水位 `maxGeneration` 让新包号往前跳，落后那边仍还在用旧 `stateId`/旧基准，`checkAncestor` 或分组取最新把它判成「接不上 / 已被取代 / needs-review」；
- `state.incoming` 里已有旧包记录，导致新包被当成「已处理」跳过。

**要的现场材料**（对面 + 我们各一份）：

- 插件版本、操作顺序（删了哪份、重导了哪份、谁点了同步）；
- 包头部：`generation`、`stateId`、`baselineHash`、`targetBaselineHash`、文件名；
- 两边 `data.json` 的 `state.bundle` / `state.incoming` 相关字段（脱敏）；
- 日志：`logLevel=debug` 下 `checkIncomingBundles` / `checkAncestor` / `sweepIncoming` 的结论。

## 5. 调查与验证计划（先读、先复现，不改代码）

1. 读上面列的函数，画一张「收包 → 确认 → 应用 → 记状态 → 清理」的现状图。
2. 用现有测试：
   - `test/incoming-direction.test.ts`：方向策略、确认/拒绝；
   - `test/alignment.test.ts`：基准对齐、回退；
   - `test/bundle.test.ts`：世代、高水位、被取代；
   - `test/moves.test.ts` / `test/download-mirror.test.ts`：包清理与只拉。
3. 先写**失败用例**复现 A/B/C（两个临时库 + 引擎层，不碰真库）。
4. 计划书补「改哪几个函数、为什么、测试怎么守」；两边确认后再改。
5. 真机验证：对面只装插件、没有库，正好验「收包确认 / 自动同步 / 删包重导」的用户路径；我们这边用真库验状态一致性。

## 6. 待对面回复

- 环境与 dev 状态（有没有在改、要不要先同步）；
- A：不点确认时，他们看到的行为；
- B：他们现在手工怎么清包、想保留什么；
- C：两边的包头部字段、操作顺序、日志；
- 是否同意「先计划书、后改代码」，以及计划书里哪些点要补。
