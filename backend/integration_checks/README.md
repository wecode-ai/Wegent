---
sidebar_position: 1
title: 后端真实数据库验收
---

# 插件账号认证 Redis / MySQL 验收

插件认证与写入协调套件使用真实 MySQL 8.0 / InnoDB、Redis 7 和独立
SQLAlchemy Session 验证事务竞态。连接池初始使用 `REPEATABLE READ`，生产协调器
将插件请求 Session 配置为 `READ COMMITTED`，验证等待租约后读取最新状态。
套件不使用 SQLite 或数据库 mock，缺少任一服务都会失败。

创建专用、可丢弃的 `plugin_auth_test` MySQL 数据库，并准备本机测试 Redis 的
DB 15 后，在 `backend/` 执行：

```bash
PLUGIN_AUTH_MYSQL_TEST_URL='mysql+pymysql://test-user:test-password@127.0.0.1:3306/plugin_auth_test' \
PLUGIN_AUTH_REDIS_TEST_URL='redis://127.0.0.1:6379/15' \
  uv run pytest integration_checks/test_plugin_account_auth_mysql.py \
    integration_checks/test_plugin_write_races_mysql.py \
    integration_checks/test_plugin_connection_requests_mysql.py \
    integration_checks/test_plugin_policy_bootstrap_mysql.py -n 0
```

MySQL URL 必须指向本机的 `plugin_auth_test`，Redis URL 必须指向本机 DB 15。
测试只创建必要的 `users`、`kinds`、`skill_binaries` 表，使用合成凭据，
每项测试清理自己创建的用户和资源，不删除整库或读取个人认证。不要将变量指向
开发共享库或生产库。

| 套件                                       | 验证范围                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `test_plugin_account_auth_mysql.py`        | 并发凭证登记、凭证迁移、刷新、旧快照、过期提交保护、连接池耗尽与用户行锁隔离 |
| `test_plugin_write_races_mysql.py`         | 同用户争用及恢复、跨用户隔离、真实租约过期、退出与凭证迁移或卸载交错         |
| `test_plugin_connection_requests_mysql.py` | 真实 JWT 与 HTTP 路由、并发退出的版本冲突、503 后重试、用户行锁下退出        |
| `test_plugin_policy_bootstrap_mysql.py`    | 首建策略、失败回滚、偏好保留、重复拒绝和旧版本 CAS                           |

这些是后端集成测试，不替代桌面 E2E；接口测试保留生产认证和数据库依赖，
仅将连接工厂配置到测试 MySQL，不替换业务服务。并发场景使用独立事务和同步事件
控制交错，断言返回结果及最终持久状态。

该套件由 `.github/workflows/test.yml` 的 `test-plugin-auth-mysql` 执行，使用
独立 MySQL、Redis service；普通 Backend 单测仍由 `tests/` 下的 SQLite 夹具负责。

`test_team_namespace_collation_mysql.py` 同样由该 CI job 执行，验证连接使用
`utf8mb4_0900_ai_ci` 或 `utf8mb4_unicode_ci` 时的 namespace 授权查询、分页和权限过滤。
本地运行时设置 `TEAM_NAMESPACE_MYSQL_TEST_URL` 后执行
`uv run pytest integration_checks/test_team_namespace_collation_mysql.py -n 0`。
URL 必须指向本机 MySQL，账号需要建库权限；测试创建随机命名的独立数据库并在结束后删除。

## English

Run the command above against a disposable local `plugin_auth_test` database
and local Redis DB 15. The suites exercise real MySQL 8.0 / InnoDB and Redis 7.
The pool defaults to `REPEATABLE READ`; the production coordinator configures
plugin request sessions as `READ COMMITTED` before their first query.
Missing services are failures. Tests remove only their own synthetic users and
resources; they never clear an entire database or read personal credentials.

The original account suite covers enrollment, transfers, refresh ownership,
stale snapshots, business revision CAS and connection-pool exhaustion. The
write-races suite adds real contention, recovery, user isolation, lease expiry
and interleaved logout/transfer/uninstall operations. The request suite exercises
real JWT authentication and HTTP routes, concurrent disconnect conflicts, retry
after HTTP 503, and logout while another transaction holds the user row lock.
The policy suite covers first creation, rollback, preference preservation,
duplicate rejection, and stale-revision CAS.
Only the database connection factory is configured for the test database;
authentication and business services remain real. These are backend integration
tests, not desktop E2E tests. GitHub CI runs all four suites with dedicated
MySQL/Redis services in `test-plugin-auth-mysql`, separately from SQLite unit tests.

The same CI job runs `test_team_namespace_collation_mysql.py` against both
connection collations. Set `TEAM_NAMESPACE_MYSQL_TEST_URL` to a local MySQL URL
with database creation privileges to run it locally. The suite creates and
removes its own randomly named database and checks pagination and grant filtering.
