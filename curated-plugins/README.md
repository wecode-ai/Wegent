---
sidebar_position: 1
---

# WeWork 官方插件

`curated-plugins/wework/<slug>` 是 WeWork 自研并维护的官方插件源码目录。
发布后的目录身份统一为 `source_type=native`、`source_provider=wework`。

第三方开源插件不进入该目录。它们应注册为云端镜像，仓库只在 Backend 保留
确定性适配器；每个扫描通过并发布的不可变 Release 存入插件对象存储。镜像
默认扫描后自动发布，也可按上游切换为人工审核。

## English

`curated-plugins/wework/<slug>` is the source of truth for plugins developed and
maintained by WeWork. Publish these packages with `source_type=native` and
`source_provider=wework`.

Third-party open-source plugins do not belong in this directory. Register them
as cloud mirrors, keep only their deterministic adapter in Backend, and store
each scanned immutable release in the configured plugin object storage. Mirrors
publish automatically after scanning by default and may opt into human review.
