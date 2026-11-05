---
sidebar_position: 25
---

# Rust MySQL 数据库迁移

Rust Backend 在启动后台消费者和 HTTP 服务前准备数据库，仅支持 MySQL。
开发环境沿用 `ENVIRONMENT=development`、`DB_AUTO_MIGRATE=true`；生产环境只检查版本并提示手动升级。

## 数据库版本

继续使用 `alembic_version.version_num` 及历史 revision 标识。版本表可以有多行，表示分支上的当前 head；迁移按父版本依赖执行，合并节点完成后收敛版本记录。未知 revision 会报错，不会自动 stamp。

空库按 `backend-rs/migrations/schema.json` 创建最新完整结构，成功后记录该结构对应的 head。已有数据库只执行尚未应用的迁移。数据库本身仍需提前创建，与 Python 的使用方式相同。

迁移资产按 revision 放在 `backend-rs/migrations/revisions/`，通过 `src/migrations/assets.rs` 嵌入二进制。SQL 步骤可以声明表结构检查条件；需要查询、JSON 转换等操作的历史迁移由 Rust 模块实现。运行时不调用 Python 或 Alembic。

原始 Alembic 历史脚本及旧 Wiki SQL 集中保存在 `backend-rs/migrations/reference/`，用于 Python 独立运行和兼容性对照；Rust 不加载这些 Python 脚本。

## 开发命令

从 `backend-rs` 目录运行，使用开发数据库配置文件：

```bash
cargo run -- db validate
cargo run -- --env-file ../backend/.env db status
cargo run -- --env-file ../backend/.env db upgrade
cargo run -- --env-file ../backend/.env db downgrade -1
cargo run -- --env-file ../backend/.env db downgrade REVISION
cargo run -- --env-file ../backend/.env db init
```

`db init` 沿用初始化数据的环境开关，不负责建表。

新增迁移时保留已应用的版本文件，添加新 revision 和父版本，在嵌入清单注册，同时更新最新完整结构及其 revision。修改历史迁移不能代替新增迁移。迁移中涉及业务数据时，要同时验证结构变更与数据转换。

MySQL DDL 可能隐式提交。迁移失败会终止启动，但已成功的 DDL 不保证回滚；版本记录不会推进到失败 revision。检查错误和已有结构后修复，不要通过手动修改版本表跳过迁移。

保留原有迁移的降级限制：按最新模型创建的空库不等同于重放全部历史迁移，在跨越早期外键迁移降级时可能遇到重复外键错误；Python 原实现也存在这一限制。不要把版本图可达视为任意数据库都能无损降级的保证。


迁移连接独立于请求连接池，最多使用一个连接，每个迁移回调的驱动超时为一小时；完成后关闭。

## 默认数据和启动责任

默认资源在 `backend-rs/init_data/`。初始化使用 `INIT_DATA_ENABLED`、`INIT_DATA_FORCE` 和 `INIT_DATA_DIR`，保留公共资源身份、已有资源跳过规则、内置 Skill 版本升级和默认管理员密码设置状态。扩展代码可注册额外的初始化目录。预编译二进制从运行目录读取本地 `init_data/`，不依赖构建机路径；混合启动脚本会切换到 `backend-rs/`，从其他目录运行时应设置 `INIT_DATA_DIR` 和 `BUILTIN_PLUGINS_DIR`。

混合启动由 Rust 先准备数据库，再启动 Python 上游。启动脚本给 Python 设置 `DB_INITIALIZATION_OWNER=rust`，避免重复初始化；Python 独立调试默认仍由自身负责初始化。容器内资源目录保持 `/app/init_data`。

沿用 Python 的 `wegent:startup_lock`，有效期 120 秒；拿不到锁时跳过初始化，不增加多实例排队机制。

## 验证

使用已有 Rust CI 的 MySQL 服务和隔离测试 schema：

```bash
WEGENT_TEST_MYSQL_ADDRESS=127.0.0.1:3306 cargo test --lib migrations::mysql_tests -- --ignored --nocapture
```

测试只创建和删除自身的临时 schema。迁移图和资源解析测试随普通 `cargo test` 执行。

### 历史数据回归与恢复边界

原生 MySQL 套件复用现有 CI 的 MySQL、Redis 服务，串行执行每个独立 schema 的用例，避免增加并发数据库连接与 DDL 负载。用例覆盖市场发布前的历史表和非空 Team/Skill 安装统计、运行环境与工作区迁移、协作授权及指派事件、插件待审核提交、整型 ID/成员唯一约束、内置插件 staging 到 ZIP 和市场发布，以及 Rust 启动锁与迁移失败释放锁。后期迁移用例将结构降至对应父 revision 后插入旧业务数据，再执行原生升级和降级；这不等于对全部 65 个历史起点逐一完成认证。

SQLAlchemy 未绑定参数会在执行计划预检时被拒绝。其他 SQL 或连接失败仍可能发生在 MySQL DDL 隐式提交之后；版本号不前进并不代表结构已回滚，不能盲目重试或手工 stamp 跳过。应先停止服务、检查失败 revision 的实际表和索引，按备份恢复或经审核清理该 revision 的残留结构后再升级。降级也可能丢失新结构中的数据，不能替代备份恢复。

本 PR 不记录或代替人工数据库迁移批准。对需要保留数据的本机开发库，实际执行前仍需确认停止服务的时间、备份及恢复验证、失败处置和适用的回滚边界；生产环境需要另行审核。
