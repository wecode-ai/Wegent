---
sidebar_position: 22
---

# 本地数据目录

## 目录结构

桌面版默认使用 `~/.wegent/workbench/wework/<namespace>`。安装包决定命名空间，未指定时为
`default`。Electron 应用数据存放在该目录下的 `user-data/`，可通过
`WEWORK_USER_DATA_DIR` 覆盖。启动直接使用当前目录。仅存在于旧目录中的任务和本地设置
不会显示在默认工作台中，原文件保留在原处。

桌面 Executor Home 默认为同一命名空间目录，独立 Executor 默认使用 `~/.wework`。
Executor Home 中包含以下数据，桌面工作区默认设在 `~/.wegent/workspace`。

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

未设置显式验证覆盖参数时，Electron 主机先读取本机持久化的 `desktop-device-id`，保留旧版本保存的 ID。
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
未设置覆盖参数时，已有身份文件为空或不可读会导致启动报错，不会静默替换。仅生成新桌面身份时才要求有效硬件 UUID。
隔离验证可通过非空的 `WEGENT_APP_IPC_DEVICE_ID` 显式指定有效 ID；该参数优先于文件读取和硬件查询，且不覆盖正常身份文件。

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

## 启动读取与写入隔离

已初始化的 `data/tasks.sqlite` 在读取前只检查当前 schema、历史表与索引、默认任务项目，
不等待任务库初始化互斥锁，也不重新设置 WAL。首次建库、schema 迁移、历史结构补建及默认项目修复
仍在真正修改数据时串行执行。

助理设置的界面读取使用同一只读 WAL 快照，在内存中规范化旧格式并绑定当前设备，
不把读取当作保存。执行器的持久化协调只有旧格式迁移或设备重绑确实改变数据时才申请
写事务，并在事务内重新读取。显式保存保留版本、权限与设备归属校验。旧角色在只读
视图和后续迁移中使用相同的稳定标识。
已有代码项目的目录刷新只读其存在和归档状态，不补写执行环境；首次导入仍是写操作。
模型选择器读取不写自定义目录、不同步创建配置、不等待 Codex 重启；执行准备仍负责
在使用模型前完成目录协调。已启用的自定义模型在目录尚未协调时仍可被选择。

Electron 单实例、文件快照一致性、数据库连接互斥和实际写事务的锁仍保护各自操作，
不能为了显示就绪而绕过。`startup-fault-isolation` 桌面检查点增加真实数据库写事务占用
期间的重载、项目与任务读取、助理读取及释放后的保存覆盖；测试不会修改个人数据库。

任务索引更新先发布内存与持久化状态，再在索引锁外记录遥测，并使用入队时捕获的事件时间；SQLite 锁等待不能占用任务列表的索引锁。遥测队列读取通过查询过滤保留期和条数上限，清理由追加或配置写入负责。

配额恢复的原生账户查询在任务发送锁外执行，状态发布前重新加锁并核对执行归属，因此取消不必等待账户查询返回。

工作台挂载后，本地运行时初始化器在后台准备执行恢复与默认插件。界面读取不等待该阶段；准备失败通过已有运行时提示提供重试入口。

遥测策略按用户持久化统计起算时间，在写事务内拒绝早于该时间的排队事件。附加策略数据只在真实写入时初始化，读取不创建表。任务结束状态先写入索引，再释放执行归属；执行控制互斥锁不覆盖遥测落库。

异步释放并发槽位按原生执行归属核对，问题或目标等元数据更新不会遗留槽位占用。
