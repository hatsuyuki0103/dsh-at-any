# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/) 格式，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
