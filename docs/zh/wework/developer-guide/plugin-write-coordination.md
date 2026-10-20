---
sidebar_position: 42
---

# 插件认证与安装的写入协调

认证、退出登录、安装、更新、卸载及设备安装状态写入使用 Redis 互斥，
不再通过 `SELECT ... FOR UPDATE` 锁住 `users.id`。发布和设备注册的锁策略不在本次改造范围内。

## 共享协议

Python 与已迁移的 Rust 自动更新接口必须使用同一协议：

- 锁键为 `wegent:plugin-write:{user_id}`，值为随机的 32 位十六进制 token。
- 锁冲突等待上限为 3 秒，租约 30 秒。Python 每 10 秒续租；Rust 将整个操作限制在 20 秒内。
- 锁覆盖用户的插件业务域，因为自动认证策略、连接迁移与安装状态存在跨插件约束。
  同一事务需要多个用户时按用户 ID 升序获取锁。
- 续租和释放必须比较 token。Redis 不可用时拒绝写入，不回退到无锁执行。
- 锁保持到最外层事务提交、回滚或关闭；保存点结束不会释放锁。

仅检查 Redis 所有权无法防止检查后暂停的旧进程提交。因此获取租约后，
使用独立短事务把 token 写入 `plugin_write_fences(user_id, token)`。
业务事务最后通过条件 `UPDATE ... WHERE user_id = ? AND token = ?`
把 token 改为 `{token}:committed`，受影响行必须为 1。继任者领取新 token 后，
旧事务的条件更新失败并回滚。这里保留数据库正常 DML 的事务锁，不使用显式查询锁。

Python 的请求 Session 必须在第一条 SQL 前调用 `configure_plugin_session`，
HTTP 使用共享 `get_plugin_db` 依赖，以 READ COMMITTED 读取取得租约后的最新状态。
Rust 在取得租约后才创建固定连接的业务事务。外部 OAuth 和设备网络请求放在提交后的事务之外。

## 故障与部署

客户端错误为 HTTP 503 的 `plugin_write_busy`、`plugin_write_unavailable` 或
`plugin_write_lease_lost`；认证 broker 通过相同错误码返回拒绝结果。
Python 的 Redis 使用独立短超时且不重试的客户端。领取持久 token 使用独立连接池，
每个进程最多额外占用 4 个 MySQL 连接，获取连接最多等待 1 秒，避免业务连接池饱和后互相等待。
Rust 复用 Breeze 连接池，分别将获取租约、领取 token 限制在 3 秒内，释放限制在 500 毫秒内；
目录和权限读取在固定业务连接之前完成。

部署前执行 Alembic `upgrade head`，创建 `plugin_write_fences`。
旧进程不参与 Redis 协议，因此切换时应排空旧版插件写请求，再同步启用新版 Python、Rust 写入口；
不能依赖新旧写进程混跑时的互斥。回滚代码和删除该表前同样需要排空新版写请求。

真实 MySQL、Redis 并发回归由 `test-plugin-auth-mysql` CI 任务运行，
覆盖用户行锁不阻塞退出、同时注册凭证、卸载与认证交错、过期请求提交及 OAuth 刷新。
