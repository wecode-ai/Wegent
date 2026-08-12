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
适用于隔离会话、测试和自定义部署。

## 自动清理与保留策略

Wework 启动后会立即在后台执行一次存储维护，之后每 30 分钟重复执行。维护过程只处理
Wework 明确拥有的临时数据，不会按时间删除用户项目或仍需恢复的托管工作树：

- `app-runtime/wework-<pid>-<timestamp>/`：隔离 Executor 实例超过 14 天且确认不活跃后
  删除。持有 `.instance.lock` 的实例始终保留；兼容旧版本无锁目录时，还会检查目录名中的
  PID，避免删除仍在运行的实例。旧版 `wework-dev-*` 目录遵循相同规则。
- `logs/` 中超过 14 天的日志，以及反馈暂存和内置浏览器临时目录中超过 24 小时的文件，
  会按批次清理；当前进程日志和符号链接不会删除。
- `codex/.tmp/marketplaces/.staging/` 中超过 7 天的
  `marketplace-add-*`、`marketplace-upgrade-*` 中间目录会删除。该规则同时覆盖
  `~/.wework/codex` 和 `~/.wework/apps/<namespace>/codex`，不会删除已安装的
  marketplace。

`workspace/worktrees/` 是任务数据，不属于临时缓存。其清理由归档任务和 Worktree 保留
设置驱动，并在删除前保存 Git 快照；存储维护线程不会直接删除这些目录。
