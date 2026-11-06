---
sidebar_position: 45
---

# Rust 库与构建边界

Backend 和 Executor 分别编译、测试和发布，保留各自的 Cargo 锁文件。共享源码通过本地路径依赖复用，不依赖另一个应用的二进制，也不建立全仓 Cargo workspace。

## 库职责

| 位置 | crate | 职责 |
| --- | --- | --- |
| `shared/rust/protocol` | `wegent-protocol` | Backend dispatch 组装、Executor 请求解码、任务状态与协议值 |
| `shared/rust/crypto` | `wegent-crypto` | 显式 key/IV 的 AES-CBC 原语与严格 PKCS#7 |
| `backend-rs/crates/python-compat` | `wegent-python-compat` | Python JSON 序列化、值转换与整数集合顺序兼容 |
| `backend-rs/crates/http-compat` | `wegent-http-compat` | Breeze HTTP 服务的 FastAPI 错误响应兼容 |
| `backend-rs/crates/storage` | `wegent-storage` | S3 header/query 签名与对象路径编码 |

共享库不读取应用环境变量，不访问数据库，不决定权限。应用负责解析配置、选择密钥、发送请求，以及将算法错误映射为原有业务响应。S3 库的当前时间辅助函数只读取时钟。

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

Backend workspace 默认成员包含应用和专属库。共享 workspace 独立维护用于库测试的锁文件；依赖它的应用仍按各自锁文件解析依赖。应用的 `cargo test` 不会自动执行外部依赖的单测，因此现有 Backend CI 测试任务另外运行共享库的格式、测试和 Clippy 检查。

共享源码变化必须触发 Backend、Executor 及其既有集成验证。Docker 构建的依赖层和应用层都需要共享源码；依赖镜像指纹、运行时镜像指纹以及 macOS/Windows 构建指纹均包含共享库和应用专属库。新增本地 crate 时同步维护这些输入，避免复用旧二进制。
