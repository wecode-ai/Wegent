---
sidebar_position: 22
---

# 本地数据目录

Wework 的本地运行时数据统一存放在用户主目录下的 `~/.wework`，不再使用
`~/.wecode/wegent-executor` 或 `~/.wegent-executor`。

## 目录结构

默认 Executor Home 为 `~/.wework`，主要内容包括：

- `codex/`：Wework 独立的 Codex home（可通过 `WEGENT_CODEX_HOME` 覆盖）。
- `workspace/projects/`、`workspace/worktrees/`：本地项目与托管工作树。
- `workspace/chats/`：本地任务会话。
- `workspace/attachments/draft/`：本地附件草稿。
- `capabilities/store/plugins/`：插件市场托管插件包的唯一权威 Store。
- `capabilities/bundled-marketplaces/`：内置插件市场缓存。
- `capabilities/plugin-state/`：本地插件与已发布云端插件之间的持久身份映射。
- `logs/`：Executor 日志（例如 `logs/executor.log`）。
- `runtime/`：运行时桥接等进程内状态。
- `device-config.json`、`device_id`：本机设备标识。

`WEGENT_EXECUTOR_HOME` 环境变量可以覆盖默认 Executor Home。显式设置该变量时，
Wework 不会对默认目录执行迁移，用于隔离会话、测试和自定义部署。

## 旧目录迁移

首次以默认目录启动时，Wework 会自动把旧数据迁移到 `~/.wework`：

1. 优先迁移 `~/.wegent-executor`。
2. 再合并更早的 `~/.wecode/wegent-executor`。

迁移规则：

- `~/.wework` 不存在时，直接重命名整个旧目录，保留文件属性、目录结构和软链接。
- 新旧目录同时存在时，递归合并不冲突的内容；普通文件以 `~/.wework` 中的现有文件优先。
- 同名冲突的旧内容归档到 `~/.wework/.legacy-migration-conflicts/<来源>/`，不会覆盖或丢失数据。
- 对 manifest 仍引用的旧 `capabilities/store/plugins` 包，桌面目录迁移不会提前归档。Executor 会以 manifest 引用的插件包为准复制到 `~/.wework/capabilities/store/plugins`，原子更新插件 `store_path`，成功后再删除旧包。
- 如果旧目录已经整体移动，Executor 会在新插件 Store 中确认包存在后直接修正插件 `store_path`。
- 插件迁移可重复执行；升级失败不会先删除仍被 manifest 使用的旧插件包。Skill 和 MCP 不参与此迁移。

新版 Wework 运行期只向 `~/.wework/capabilities/store/plugins` 写入托管插件包。短暂降级到仍使用
`~/.wegent-executor` 的旧版可能重新创建旧目录；再次启动新版后会按上述规则收敛，
不会把两个目录同时作为权威插件 Store。
