---
sidebar_position: 20
---

# Rust 后台任务与切换验证

`brz-schedule` 提供持久化执行、周期触发、重试、续跑、租约和协作退出。核心只依赖 provider 接口；Redis 实现位于独立的 `brz-schedule-redis` 包。Wegent 的任务注册、业务锁键、SQL、权限和外部服务协议留在本仓库。业务数据继续使用原 MySQL 表和 Redis 游标，不迁移 Celery 的内部状态机。

## 部署与执行范围

| 配置 | 默认 | 含义 |
| --- | --- | --- |
| `SCHEDULED_TASKS_ENABLED` | `true` | 在本 Rust 进程中生产 allowlist 允许的周期与启动任务 |
| `EMBEDDED_CELERY_ENABLED` | `true` | 在本 Rust 进程中启用 worker，消费 allowlist 允许的原生持久化任务 |
| `WEGENT_RS_JOB_ALLOWLIST` | 空 | 限制 Rust 执行范围的完整 kind 列表，以逗号分隔；不支持 `*`，拼写错误在启动时失败 |
| `WEGENT_RS_JOBS_SHUTDOWN_GRACE_SECONDS` | `30` | 停止取任务后允许协作退出的时间 |

Rust 复用 Python 已有的两个开关名称与默认值。`EMBEDDED_CELERY_ENABLED` 在 Rust 中只控制本进程的原生 worker，不会启动 Celery。allowlist 默认为空，因此即使两个开关为 `true`，Rust 也不会生产或消费任务。只提供 API 的 Rust 进程可以设置 allowlist，并将两个运行开关设为 `false`。

allowlist 只限制 Rust 允许执行的任务，不表示独占任务类型。Python 保留全部 Celery 发布与消费行为，不读取这个 allowlist，也不会把任务转投 Rust。两个进程可分别配置同名开关；部署时应避免同一执行族由 Python 和 Rust 并行调度。

公共任务运行于 `backend-rs`。部署专属任务与视频扩展由应用注入并注册。保留原业务功能开关，例如 `EXTERNAL_DOC_SYNC_ENABLED`、DingTalk 自动同步、内部通知和告警开关；Rust allowlist 不会绕过它们。

定时任务使用 UTC 持久化时间；Cron 显式配置时区。Python Beat 使用 UTC，项目自动化使用资源自身时区与 DOM/DOW Or；APScheduler 风格 Cron 使用 DOM/DOW And。原即时循环、首次运行延迟、开始期限及业务锁由应用注册，而非写入通用框架。

## 业务覆盖

以下是执行族，具体 kind 以 `background_jobs` 和内部注册函数为准，HTTP 路由所有权仍只由活动 route table 决定。

| 执行族 | 入口及验证重点 |
| --- | --- |
| 订阅 | due 扫描、执行任务、CodeWiki 定时更新；检查 Task/Workspace 创建、历史复用、执行记录、收件箱和完成通知 |
| 项目自动化 | due 扫描、incoming event、pending event、event subscription、managed execution；检查同一事件只产生一个 run、权限撤销、协作组和 runtime continuation |
| Robot 队列 | 5 秒扫描和开始期限；检查队列占位、撤权取消、过期 claim、长时间无输出、终态与 revision 投影 |
| 知识处理 | 索引、外部导入、文档摘要、知识库摘要、过期扫描、附件孤儿清理；检查 generation、转换回调、旧正文快照和迟到回写 |
| 外部知识同步 | Wiki 每日增量游标、DingTalk 扫描/刷新、Xiaoxin 快照；检查源健康、非重试版本、权限和缓存计数 |
| 视频/异步卡片 | provider job 创建、持久化轮询、取消、上传、Socket.IO、两阶段启动恢复；普通等待不消耗失败重试次数 |
| 插件镜像 | 每 6 小时同步明确启用的 upstream；检查 HTTPS/ZIP 安全、不可变版本、审核、最新版本和管理员下架状态 |
| 公共维护 | `repository_update`、`executor_cleanup`、`device_heartbeat_monitor`；检查缓存更新、归档先于删除、旧 Redis 游标和设备掉线处理 |
| 内部维护 | hourly unread、daily summary email、grading、orphan pod、cloud device/IP sync、OpenClaw token monitor；检查原功能开关、告警去重、归档、超时和内部服务协议 |

原 Python 的 managed Team queue 没有可达的服务端消费者；本迁移保留该边界，不额外构造消费路径。已有 Task 的 managed execution 仍按原任务入口执行。

## 数据与失败语义

业务表、Task/Subtask JSON、文档 generation、现有游标、取消标记和业务锁完整键保持兼容。Rust 原生任务存储使用独立命名空间 `wegent:rs:schedule:v1`。Python 任务继续进入原有 Celery 队列，Rust worker 不消费这些队列，也不解释 Celery 消息协议；Celery worker 不消费 Rust 原生任务存储。

执行至少一次。provider 的 owner token 保护确认与续租；业务锁通过独立 `LockProvider` 提供，token 比较后续租与释放。它不能撤销外部系统已经接受的副作用，因此仍需 SQL claim、generation、事件唯一身份及业务状态校验。Redis 连接错误会向运行时传播，不转为本地内存任务。

正常轮询通过 `ContinueAt` 保存下一次执行时间和输入。失败重试有独立预算。启动期限控制排队任务能否开始，整体执行超时沿用应用配置；常驻维护可不设置整体超时，但保留 HTTP 超时、业务锁续租和退出取消。停止时先停止生产与取任务，等待正在执行的任务协作退出，超出宽限期的 claim 不确认，由租约恢复。

## 手工验证与调度切换

1. 先部署 Rust 代码，保持 allowlist 为空，确认服务正常启动。两个已有开关默认均为 `true`，空 allowlist 仍会阻止 Rust 任务运行。
2. 按执行族安排周期调度进程，避免 Python 与 Rust 并行调度同一执行族。如果改由 Rust 调度，先通过部署配置暂停相应的 Python 定时生产者或常驻循环，并检查旧 Celery queued、reserved、active 工作已排空。Rust allowlist 不会自动关闭 Python Beat 或 APScheduler，也不限制 Python 接收的任务类型。
3. 只在选定 Rust 部署配置 allowlist，列出要验证的完整 kind。视频恢复需要同时列入 `video.recover_jobs` 与 `app.tasks.video_tasks.poll_video_job`。Python 无需配置 allowlist，也无需排除 Rust 已支持的任务类型。
4. 先启动 `EMBEDDED_CELERY_ENABLED=true` 的 Rust worker，再让选定调度进程的 `SCHEDULED_TASKS_ENABLED=true`。同一进程可以同时启用两者；分阶段启动时先显式将调度开关设为 `false`。检查触发、业务结果、完成通知，以及任务失败能否被观察。
5. 在无外部破坏性副作用的测试数据上终止 worker，确认重启后从原业务状态继续；对视频、外部文档和项目事件验证重复投递及旧 generation 不覆盖新结果。
6. 停用 Rust 调度时，将该 Rust 进程的 `SCHEDULED_TASKS_ENABLED` 设为 `false`，保留 worker 排空原生任务，再将 allowlist 置空或停止 worker。按部署安排恢复 Python 对应调度；Python Celery 队列无需迁移到 Rust。不要删除持久化队列或用清空 Redis 代替排空。

## 验证方式

通用库通过共享 provider 契约、内存 provider、真实 Redis、运行时并发/退出和 Cron 测试。Wegent 的纯业务测试可运行 `cargo test --lib background_jobs`；隔离 MySQL 事务测试由 CI 显式运行，验证竞争 claim、generation、回滚、快照与项目 run 投影。内部测试由 `backend-rs-intra` 的单元测试执行。

这些检查覆盖调度和持久化契约；真实 SMTP、IM、视频 provider、知识运行时、Kubernetes 和内部设备服务仍需按上表使用测试账号手工验证。本次切换不自动启用任何生产任务。
