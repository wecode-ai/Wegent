---
sidebar_position: 1
title: 后端真实数据库验收
---

# 插件账号认证 MySQL 验收

`test_plugin_account_auth_mysql.py` 使用 MySQL 8.0 / InnoDB 的
`REPEATABLE READ` 和独立 SQLAlchemy Session 验证真实事务竞态。它不使用
SQLite 或数据库 mock，也不会在缺少数据库时跳过。

创建专用、可丢弃的 `plugin_auth_test` 数据库后，在 `backend/` 执行：

```bash
PLUGIN_AUTH_MYSQL_TEST_URL='mysql+pymysql://test-user:test-password@127.0.0.1:3306/plugin_auth_test' \
  uv run pytest integration_checks/test_plugin_account_auth_mysql.py -n 0
```

URL 必须指向本机的 `plugin_auth_test`。测试只创建必要的 `users`、`kinds`
表，使用合成凭据，每项测试清理自己创建的用户和资源，不删除整库或读取个人认证。
不要将变量指向开发共享库或生产库。

该套件由 `.github/workflows/test.yml` 的 `test-plugin-auth-mysql` 执行，使用
独立 MySQL service；普通 Backend 单测仍由 `tests/` 下的 SQLite 夹具负责。

## English

Run the command above against a disposable local `plugin_auth_test` database.
The suite exercises real MySQL 8.0 / InnoDB transactions at `REPEATABLE READ`,
including concurrent enrollment/reservations, stale snapshots, terminal transfer
states, idempotent receipts and cached owner status. A missing database is a failure.
Each test removes only its own synthetic user and resources. GitHub CI runs this
suite in `test-plugin-auth-mysql`, separately from ordinary SQLite unit tests.
