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

## 桌面 Executor 身份

桌面受管和独立 Executor 均遵循“持久化身份优先，缺失才生成”的规则。

Electron 主机先读取本机持久化的 `desktop-device-id`，保留旧版本保存的 ID。
仅在文件不存在时，使用机器硬件 UUID 与当前应用标识（默认 `io.wecode.wework`）
的 SHA-256 哈希生成并保存 `electron-<hash>`。没有已有身份时，同一机器与应用
生成相同 ID。硬件 UUID 不会作为设备 ID 明文发送，也不会写入身份文件或日志。

受管 Executor 使用主机 ID 作为本机 IPC 和云端的 `app_device_id`。
受管和独立 Executor 均优先使用 `device-config.json` 中持久化的 `device_id`、
`runtime_instance_id`。启动参数只为缺失字段提供初始值：受管 Executor 分别使用
`device-<app_device_id>`、`runtime-<app_device_id>`，独立 Executor 在没有初始值时生成新 ID。
新身份会写入配置，后续重启不再覆盖。这三种身份仍保留各自的路由职责；
账号权限、会话令牌和记录级路由继续由认证和注册协议控制，硬件哈希不授予权限。

身份读取不会搬动会话数据、改写会话引用，也不从旧工作树推断身份。
已有身份文件为空或不可读时启动报错，不会静默替换。仅生成新桌面身份时才要求有效硬件 UUID。
隔离验证仍可通过 `WEGENT_APP_IPC_DEVICE_ID` 显式指定 ID，且不覆盖正常身份文件。

## Home 迁移中的目录扫描

迁移旧 Codex Home 到工作台目录时，相对符号链接扫描使用目录枚举提供的类型信息，
只递归目录并校验符号链接，不额外读取普通文件的元数据。因此，后台 Git 操作在枚举
后删除临时锁文件不会阻止启动；无法解析的相对符号链接仍会阻止迁移。

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
