---
sidebar_position: 1
---

# WeWork 官方插件

`curated-plugins/wework/<slug>` 是 WeWork 自研并维护的官方插件源码目录。
发布后的目录身份统一为 `source_type=native`、`source_provider=wework`。

第三方开源插件不进入该目录。它们应注册为需要审核的云端镜像，仓库只在
Backend 保留确定性适配器；每个批准后的不可变 Release 存入插件对象存储。

## English

`curated-plugins/wework/<slug>` is the source of truth for plugins developed and
maintained by WeWork. Publish these packages with `source_type=native` and
`source_provider=wework`.

Third-party open-source plugins do not belong in this directory. Register them
as reviewed cloud mirrors, keep only their deterministic adapter in Backend,
and store each approved immutable release in the configured plugin object
storage.
