# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/) 格式，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.3] - 2026-09-10

### Fixed

- **`@path` 引用导致会话历史永久无法加载（严重）**：注入的 `user/message` 把路径写进了 `source`（`{ kind: 'at-file-mention', relative: '…' }`）。`MessageSourceMap` 的「可合并扩展」只是**类型层**承诺；会话日志边界会**逐键校验** `source`。于是两种形状各以不同方式被拒绝：
  - `{ kind: 'at-file-mention', relative }` —— `at-file-mention` 不是已登记的 source kind，报 `cannot safely transform unclassified message source`；
  - `{ kind: 'plugin', relative }`（缺少 `plugin` 名、多出 `relative`）—— 报 `@deepseek-ai/dsh-session-format-v0-to-v1 refuses this format v0 Session: user/message <seq> source has unexpected member "relative"`；

  两种都会让**整份会话产物**被迁移拒绝（`source v0 artifact remains unchanged`）。因此**只要用过一次 `@` 引用，该会话历史就再也打不开**——不是单条消息降级，而是整份会话不可读。`pluginSourceValue` 对 `kind: 'plugin'` 只接受 `kind` + `plugin`（外加 `form`/`sections`/`summary`，以及 `plugin === 'compact'` 时的 `compactionId`/`sourceCommandId`）。
  - 现在注入 `{ kind: 'plugin', plugin: 'dsh-at-any' }`：删除自造的 `at-file-mention` 类型合并与 `relative` 成员。
  - 引用路径并未丢失：它本来就完整存在于消息内容里（`<workspace-reference path="…" kind="file|directory" />`）。
  - `AGENTS.md` 契约条目与 `tests/mention.spec.ts` 断言同步更新，并新增回归用例（`source` 键必须恰为 `['kind','plugin']`，且序列化后不得包含路径），防止再次漂移。
  - 新增 `tools/repair-session-sources.mjs`：按 `--check` / `--dry-run` / `--apply` 修复已被旧版写坏的会话产物。只改 `source`，先做**逐字节校验的备份**，再经过**真实迁移链验证**才落盘；无 Harness 迁移目录时拒绝执行（fail closed）而非降级为无验证写入。`--self-test` 在临时目录用合成坏会话验证上述保证（含 `--check`/`--dry-run` 绝不写入、备份与原件逐字节一致、以及按代际命名 `session.v<N>.jsonl.zstd` 的发现与「后端实际加载哪一代」的判定）。
  - README 新增 Troubleshooting：如何确认会话是否已被旧版损坏，以及修复/备份方式。
- 同步 `README.md` 安装命令与版本号到 v0.1.3（此前仍停留在 v0.1.0），`dsh.plugin.json` 版本号对齐 `package.json`（此前滞后于 0.1.1）。

### Migration

- 升级必须：旧版本写入的坏 `source` 已落盘，仅升级插件不会让这些历史自动恢复，需按 README Troubleshooting 归一化后才能加载。新写入的会话不再受影响。

[0.1.3]: https://github.com/hatsuyuki0103/dsh-at-any/releases/tag/v0.1.3

## [0.1.2] - 2026-09-02

### Fixed

- **适配 dsh-settings 0.1.2-rc.1 移除 `settingsNamespace()` 导出**：新版删除了 `settingsNamespace()` 工厂函数（改用 `SettingsNamespaceInput` 裸字符串收窄——`register/get/update` 直接接受字符串）。`src/settings.ts` 的 `AT_FILE_NAMESPACE = settingsNamespace('at-file')` 改为 `'at-file'`，移除对已删除导出的 import；否则插件加载即抛 `settingsNamespace is not a function` 导致整个 dsh 启动失败（用户从生效配置摘除后恢复）。同步更新 lib 产物（index.js/invariant.js/client.js）与契约测试。
- build.mjs：`@deepseek-ai/schemastery` 加入 external（插件 node_modules 的本地 schemastery 为 src-only 无 lib 产物，运行时由 dsh profile 提供，与 `@deepseek-ai/dsh-*` 一致）。

[0.1.2]: https://github.com/hatsuyuki0103/dsh-at-any/releases/tag/v0.1.2

## [0.1.1] - 2026-08-18

### Fixed

- **`bin/` 目录被默认忽略导致同名文件只显示一个**：`bin` 从 `DEFAULT_IGNORE_DIRS` 移除——许多项目把可运行脚本（`bin/*.sh`、`bin/*.bat`）放在 `bin/`，全格式索引承诺下它必须可见。此前 `bin/run-*.sh` 被静默跳过，而 `sh/run-*.sh` 被索引，用户 @ 时只看到其中一个。
- 同步更新 lib 产物（index.js/client.js/类型声明）与契约测试（`bin` 不再在忽略断言中，新增"bin 目录被索引 + 同名文件共存"用例）。

[0.1.1]: https://github.com/hatsuyuki0103/dsh-at-any/releases/tag/v0.1.1

## [0.1.0] - 2026-08-18

### Added

- **dsh-at-any 首发**：fork 自 dsh-at-file v0.6.0（MIT），修复 @ 选择器的索引截断问题并支持所有格式源文件。
- 索引上限默认值从 5000 提升到 1,000,000（`DEFAULT_MAX_INDEXED_FILES`）：原默认值会导致超过 5000 个源文件的工作区（如 11k 文件的 Spring Boot + Vue 项目）中 `.java`/`.vue` 等大量文件在 @ 候选里不可见。
- 运行时并发去重：同一工作区的并发 `search` 调用共享一次遍历（输入框快速连击不会重复全量索引）。
- 契约测试 `tests/no-truncation.spec.ts`：锁定"全格式收录（.java/.vue/PDF/图片/无扩展名/隐藏文件）+ 产物目录跳过 + 默认上限 ≥1M"。

### Fixed

- 源文件被 @ 选择器遗漏（原 dsh-at-file 默认 5000 截断）。

### Changed

- 插件名/包名/bundle id/typert package 全部改为 `dsh-at-any`；与 dsh-at-file 使用相同 `atFile` 服务命名空间，**二者不能同时启用**（替换关系，README 有迁移步骤）。

[0.1.0]: https://github.com/hatsuyuki0103/dsh-at-any/releases/tag/v0.1.0
