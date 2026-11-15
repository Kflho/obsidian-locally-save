# Locally Save

> 中文说明：[README.zh-CN.md](README.zh-CN.md)

## English overview

**Locally Save** is a desktop-only Obsidian plugin (its interface is in Chinese) that moves a vault
between machines **without network access**. Every `.lsave` file is either a full snapshot of the
vault or a diff computed from one of your full snapshots. You carry it on a USB drive, in a cloud
folder, or through a chat app, then apply it on the other machine.

- **Full copy**: the whole vault. It is both a baseline (changes bundles are always computed from one
  of your full copies) and a restore point. Applying it mirrors it: files the bundle does not contain
  go to a trash folder inside the vault, and locally modified files are replaced by the bundle's
  version (the old ones also go to trash). The vault then equals that bundle, and the full copy
  becomes your baseline.
- **Changes bundle**: a diff computed from one of your full snapshots. There are exactly two kinds:
  one full snapshot to another (to move the other machine onto your newer full copy without shipping
  the whole vault), and one full snapshot to your current vault (the everyday case). It carries only
  what changed since that full snapshot, so it **grows as you keep working**; exporting or applying a
  changes bundle does not move the baseline. The plugin reminds you when one has grown big enough to
  justify a fresh full copy. A changes bundle normally needs the receiving machine to stand on the
  same full snapshot. A bundle whose computed landing state matches the receiver's current content is
  also accepted, which is what makes a recovery bundle usable after the two baselines have drifted.
  Anything else is rejected with concrete next steps.
- **Applying is always a strict sync** (there is no mode to pick): files named in the bundle win (your
  version goes to trash), deletions named in the bundle are performed, and local files that the
  bundle's target state does not contain go to trash. In bidirectional use your own pending changes
  are packed into a changes bundle first; if that cannot be written, nothing is touched. In pull-only
  mode there is no "your half": edits on paths the bundle does not name are restored from the baseline
  full snapshot, so the resulting state id matches the sender's.
- Each bundle carries a payload checksum, a generation number, a baseline fingerprint, and a content
  **state id** ("are the two sides actually identical?"). A bundle corrupted in transit is rejected
  instead of being written into your vault. Opening a bundle is read-only: you get a full report
  (what will be added, overwritten, deleted) before anything is written.
- **Automatic modes** are off by default: keep a bundle on a schedule or after edits, and apply
  incoming bundles. The sync direction decides the policy: pull-only applies full copies and
  destructive updates, bidirectional asks first, and without git only non-destructive changes bundles
  are applied automatically.
- **Optional git transport** (off by default, desktop plus system `git`): the bundle folder itself can
  be a git worktree. New bundles are committed and pushed, the other machine's are pulled and applied,
  and each machine publishes a tiny status file (`.lsave-peers/`) with its state id, generation,
  baseline and host name. The status bar separates the git result (`已推送 / 已拉取 / 远程已是最新`)
  from per-machine content status (`一致 / 不同步 / 待上报`). Full copies are never pushed; you still
  carry the first one on a USB drive.
- **Install** from the Obsidian community plugin browser, or download `main.js`, `manifest.json` and
  `styles.css` from [Releases](https://github.com/Kflho/obsidian-locally-save/releases) and put them
  in `<vault>/.obsidian/plugins/locally-save/`. Requires Obsidian 1.7+ on desktop.

### Privacy and permissions

- **No network requests unless you turn on the optional git transport.** There is no telemetry, no
  account and no server. Git mode runs the `git` you installed against the remote you configured;
  credentials stay in your system git, the plugin never stores them. Everything else only touches your
  vault, the bundle folder you configured, and its own state file inside the plugin directory.
- **Filesystem access outside the vault** is the core feature. It copies files to and from the bundle
  folder you pick, and moves replaced or deleted files into a trash folder inside the vault.
- **Shell execution** happens only in optional features: associating `.lsave` with Obsidian (Windows
  only, runs `reg.exe`), the git transport (`git`), and the SSH setup (`ssh-keygen` / `ssh`, plus `gh`
  only if GitHub CLI is installed and logged in). None of them runs unless you click the
  corresponding button or turn git on.
- **Clipboard**: the copy-path and copy-fingerprint buttons write to the system clipboard. Nothing is
  ever read from it.

The full Chinese guide (install, three-step flow, package types, git transfer, notices and privacy) is in [README.zh-CN.md](README.zh-CN.md).

## Install

1. Download `main.js`, `manifest.json`, and `styles.css` from [Releases](https://github.com/Kflho/obsidian-locally-save/releases).
2. Put them in `.obsidian/plugins/locally-save/`.
3. Enable **Locally Save** in Settings → Community plugins.

## Documentation

- [README.zh-CN.md](README.zh-CN.md) — 完整中文说明（安装、三步上手、两种同步包、git 传输、通知与隐私）。
- [LICENSE](LICENSE) — MIT.
