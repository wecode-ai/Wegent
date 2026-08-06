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
- `capabilities/bundled-marketplaces/`：内置插件市场缓存。
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
- 新旧目录同时存在时，递归合并不冲突的内容；`~/.wework` 中的现有文件始终优先。
- 同名冲突的旧内容归档到 `~/.wework/.legacy-migration-conflicts/<来源>/`，不会覆盖或丢失数据。
- 迁移完成后旧目录会被移除，运行期不再读取旧路径。
