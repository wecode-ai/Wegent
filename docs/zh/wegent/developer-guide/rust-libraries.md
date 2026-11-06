---
sidebar_position: 45
---

# Rust 库与构建边界

Backend 和 Executor 分别编译、测试和发布，保留各自的 Cargo 锁文件。共享源码通过本地路径依赖复用，不依赖另一个应用的二进制，也不建立全仓 Cargo workspace。

## 库职责

| 位置                                  | crate                          | 职责                                                       |
| ------------------------------------- | ------------------------------ | ---------------------------------------------------------- |
| `shared/rust/protocol`                | `wegent-protocol`              | Backend dispatch 组装、Executor 请求解码、任务状态与协议值 |
| `shared/rust/crypto`                  | `wegent-crypto`                | 显式 key/IV 的 AES-CBC 原语与严格 PKCS#7                   |
| `backend-rs/crates/python-compat`     | `wegent-python-compat`         | Python JSON 序列化、值转换与整数集合顺序兼容               |
| `backend-rs/crates/http-compat`       | `wegent-http-compat`           | Breeze HTTP 服务的 FastAPI 错误响应兼容                    |
| `backend-rs/crates/storage`           | `wegent-storage`               | S3 签名、对象路径编码与共享 MinIO HTTP 客户端              |
| `shared/rust/filesystem`              | `wegent-filesystem`            | 文件租约、目录链接、平台路径和带权限保留的原子写入         |
| `backend-rs/crates/config`            | `wegent-backend-config`        | Backend 环境与连接配置                                     |
| `backend-rs/crates/persistence`       | `wegent-backend-persistence`   | 请求事务、SQL 值、路由键与连接池策略                       |
| `backend-rs/crates/identity`          | `wegent-identity`              | 会话认证、JWT、用户读取和仓库凭据编码                      |
| `backend-rs/crates/access`            | `wegent-access`                | 实体与组成员查询、角色继承和公共模型白名单                 |
| `backend-rs/crates/directory`         | `wegent-directory`             | 员工目录提供者接口与数据类型                               |
| `backend-rs/crates/celery`            | `wegent-celery`                | Celery 协议与队列交互                                      |
| `backend-rs/crates/job-runtime`       | `wegent-job-runtime`           | 后台任务注册、调度、租约和取消                             |
| `backend-rs/crates/socket-events`     | `wegent-socket-events`         | Socket.IO 事件封装与 RPC 等待者生命周期                    |
| `backend-rs/crates/network-policy`    | `wegent-network-policy`        | 出站信任与目标地址策略                                     |
| `backend-rs/crates/resource-store`    | `wegent-resource-store`        | CRD 投影、资源引用、Kind 查询和决策模型 schema             |
| `backend-rs/crates/task-store`        | `wegent-task-store`            | 任务/子任务持久化、原子 pipeline 推进及任务文档            |
| `backend-rs/crates/capabilities`      | `wegent-capabilities`          | 统一技能目录、任务技能解析、Kind 缓存及授权                |
| `backend-rs/crates/models`            | `wegent-models`                | 模型目录聚合、授权与响应投影                               |
| `backend-rs/crates/runtime-check`     | `wegent-runtime-check`         | 已授权任务的运行检查点与流状态                             |
| `backend-rs/crates/git-repositories`  | `wegent-git-repositories`      | 仓库目录、分支查询、缓存和凭据提供者                       |
| `backend-rs/crates/sites`             | `wegent-sites`                 | Sites 目录路由与上游集成                                   |
| `backend-rs/crates/test-support`      | `wegent-backend-test-support`  | SQL 协议夹具与 JSON 基线断言，仅用于测试                   |
| `executor/crates/config`              | `wegent-runtime-config`        | 设备、Home、工作区及原生命令路径配置                       |
| `executor/crates/logging`             | `wegent-runtime-logging`       | Executor 结构化事件与滚动日志                              |
| `executor/crates/execution-contracts` | `wegent-execution-contracts`   | 执行、命令、IPC 和事件通知契约                             |
| `executor/crates/subprocess`          | `wegent-subprocess`            | 进程启动、环境规范化、输出收集与平台进程树生命周期         |
| `executor/crates/hooks`               | `wegent-hooks`                 | Hook 发现、受限命令执行和 rollout 观察                     |
| `executor/crates/workspace`           | `wegent-workspace`             | 工作区文件、原生 Git、环境准备、构建缓存与变更跟踪         |
| `executor/crates/automation`          | `wegent-automation`            | 自动化定义、运行记录和重复调度策略                         |
| `executor/crates/task-store`          | `wegent-local-task-store`      | 本地任务、项目和执行队列的事务持久化                       |
| `executor/crates/model-proxy`         | `wegent-model-proxy`           | 本地模型路由、协议转换、模型目录和能力上下文               |
| `executor/crates/test-support`        | `wegent-executor-test-support` | 测试环境隔离与共享环境锁                                   |
| `backend-rs/crates/executor-manager`  | `wegent-executor-manager`      | Executor Manager 客户端、超时策略与响应投影                |
| `backend-rs/crates/media`             | `wegent-media`                 | 媒体策略与视频结果 URL 刷新扩展契约                        |
| `backend-rs/crates/remote-workspace`  | `wegent-remote-workspace`      | 远程工作区授权、状态、文件传输与任务投影                   |
| `executor/crates/plugin-packages`     | `wegent-plugin-packages`       | 插件包发布、能力配置、恢复与激活                           |
| `executor/crates/execution-stream`    | `wegent-execution-stream`      | 有序事件投递、增量合并、错误传播与 flush                   |
| `backend-rs/crates/users`             | `wegent-backend-users`         | 用户资料、账号设置、运行配置和目录查询                     |
| `backend-rs/crates/authentication`    | `wegent-authentication`        | 密码登录、桌面设备授权及令牌刷新                           |
| `backend-rs/crates/oidc`              | `wegent-oidc`                  | Web/CLI OIDC 登录、提供者缓存及用户供应                    |
| `backend-rs/crates/onboarding`        | `wegent-onboarding`            | 新用户默认资源校验与逐资源事务写入                         |
| `executor/crates/multimodal`          | `wegent-multimodal`            | 附件解码、视觉输入预处理和知识提示组装                     |
| `executor/crates/mcp-runtime`         | `wegent-mcp-runtime`           | MCP 配置、延迟交互及运行环境绑定                           |
| `executor/crates/native-home`         | `wegent-native-home`           | 原生会话目录、执行租约、会话归档及恢复                     |
| `executor/crates/claude-harness`      | `wegent-claude-harness`        | Claude 命令规划、续接、重试及流事件转换                    |

`shared/rust` 库不读取应用环境变量，不访问数据库，不决定权限；应用专属领域库可依赖其明确声明的配置、持久化和授权接口。应用负责解析配置、选择密钥、发送请求，以及将算法错误映射为原有业务响应。S3 库的当前时间辅助函数只读取时钟。

`dispatch::ExecutionRequest` 是 Backend 解析资源后的生产端投影；根模块的 `ExecutionRequest` 是 Executor 的容错消费端投影。它们的字段和默认值不同，不能机械合并。协议契约测试验证生产端组装的 JSON 能被消费端解码。消费端的 `agent_home_runtime_task_id` 是受信任的本地元数据，不从请求反序列化。

`wegent-crypto::decrypt_cbc` 严格检查 PKCS#7。仅历史 MCP provider 路径使用 `decrypt_cbc_blocks` 后按原协议移除填充；原语本身不验证或移除填充，该路径的差异由回归测试约束。Executor Git token 和订阅加密保留各自原有的 AES-256 限制。空值处理、配置错误和解密失败策略继续由应用决定。

## 开发与验证

从仓库根目录运行：

```bash
# Backend 应用和专属库；使用 backend-rs/Cargo.lock
cargo check --manifest-path backend-rs/Cargo.toml --locked --tests --examples
cargo test --manifest-path backend-rs/Cargo.toml --locked

# Executor；使用 executor/Cargo.lock
cargo check --manifest-path executor/Cargo.toml --locked --all-targets --all-features
cargo test --manifest-path executor/Cargo.toml --locked --all-features

# 共享库及生产端到消费端的协议契约；使用 shared/rust/Cargo.lock
cargo test --manifest-path shared/rust/Cargo.toml --locked
```

Backend 与 Executor 各自 workspace 的默认成员包含应用和专属库。共享 workspace 独立维护用于库测试的锁文件；依赖它的应用仍按各自锁文件解析依赖。应用的 `cargo test` 不会自动执行外部依赖的单测，因此现有 Backend CI 测试任务另外运行共享库的格式、测试和 Clippy 检查。

共享源码变化必须触发 Backend、Executor 及其既有集成验证。Docker 构建的依赖层和应用层都需要共享源码；依赖镜像指纹、运行时镜像指纹以及 macOS/Windows 构建指纹均包含共享库和应用专属库。新增本地 crate 时同步维护这些输入，避免复用旧二进制。

## 继续拆分的判断标准

一个库应拥有完整的状态、事务或协议生命周期，而不是只把文件搬出应用。库不能依赖应用入口、全量 AppState 或反向调用上层模块。只有跨边界消费者需要的接口才公开。持有同一事务连接的任务、协调和队列更新应保留在同一库中；角色规则、默认值或错误策略不同的协议不能因名称相似而合并。

HTTP 领域库注册自身路由，由应用合并。`registered_routes()` 从实际 registry 推导路径和方法，供有效路由表契约检查使用，不维护第二份手写 API 清单。客户端、缓存、通知去重和后台 worker 继续共享原来的进程级实例。

## 状态所有权与停止边界

OIDC 的 metadata/JWKS 缓存只属于一个进程级服务；用户、认证及 OIDC 路由在部署注入完成后接收已有连接、配置和扩展接口。新用户初始化保留逐资源事务、savepoint、提交后刷新和部分成功，不增加包围整个批次的事务。

Claude 库通过 `ClaudeLaunchContext` 接收可信任务身份和指令，应用决定个人控制指令的适用资格；工具关闭时不追加运行指令。`ChildEnvironment` 在每次实际启动、续接及重试时读取当前凭据，依次合并宿主环境、Git broker、命令覆盖及插件账号 broker，避免保存过期快照。

目录、插件激活和原生会话的租约由各自生命周期所有者持有。通用 JSON 写入、权限保留的原子发布及支持 Windows 打开读者的运行数据替换具有不同契约，不能机械替换。协议编解码、共享准备策略和对象存储客户端归基础库；唯一执行中的 turn、取消状态、凭据装配与跨域事务协调留在应用库。

停止拆分的依据是依赖方向、真实跨域消费者和单一状态所有权。应用根本身也是可链接库，不要求每个 handler 单独成为 crate。库不能通过全量上下文或巨型回调接口反向访问应用；仅该用例使用的算法可保留为内部模块。大文件按职责组织模块，原测试断言及忽略条件随其实现迁移。
