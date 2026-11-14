---
sidebar_position: 42
---

# 插件认证与安装的写入协调

插件使用 Redis 插件级租约和现有业务记录上的 CAS，不新增表、列或索引，不使用 `FOR UPDATE` 或 MySQL 命名锁。不同插件的安装、更新、卸载和认证可以并行；同一插件的写入相互协调。

## 锁的身份与期限

普通操作的 key 为 `wegent:plugin-write:{user_id}:{InstalledPlugin.name}`，不包含设备号，因为多台设备修改的是同一账号安装记录。首次安装使用现有的稳定名称派生规则；重装或历史名称的安装先查找已有记录，取得其真实名称的租约，再重新核验身份。

Python 复用公共 `DistributedLock.owned_lock`，Rust 使用相同 key、随机 owner token 和 Redis NX 协议：

```python
distributed_lock.owned_lock(
    f"wegent:plugin-write:{user_id}:{installation_name}",
    expire_seconds=180,
    blocking_timeout=3,
    redis_client=plugin_redis_client,
)
```

- TTL 为 180 秒；正常事务完成后按 token 立即释放，不等待 TTL。
- 获取单个插件的租约最多等待 3 秒，业务处理预算仍为 20 秒。Python 保留每 10 秒的有界续租，Rust 不启动续租任务。
- 保存点结束不释放根事务的租约。批量操作按身份排序，失败时回滚整笔事务并释放已取得的租约，不保留部分撤权或卸载。
- 所有权校验、续租和释放均比较 token。旧请求不能释放后来请求的锁；Redis 不可用时明确失败，不无锁执行。
- 不持有覆盖整个账号插件操作的 Redis 用户锁。账号策略编辑使用 `@account-policy` 专用租约；缺失的账号同步状态首次创建使用 `@sync-init` 专用租约。它们不包住日常安装、更新和卸载流程。

业务或网络超时不等于数据库事务已结束。TTL 180 秒为短事务提供较大的异常余量；进程退出且未释放锁时，同一插件可能等待接近剩余租期，其他插件使用独立 key。

## 复用现有持久化记录

账号期望状态仍在 `kinds` 的 `InstalledPlugin/default` 记录中；设备实际安装状态仍在 `plugin_device_installations` 中。

同步状态保存在原有 `kinds` 记录：`user_id=当前账号`、`kind=PluginSyncState`、`namespace=plugin-sync`、`name=account`。JSON 继续保存 generation、设备水位、每实例每插件的请求顺序和最新受理标记，以及 `creationRevisions[安装名称]`。不新建 `plugin_states`，不运行全量或按需数据搬迁。

`InstalledPlugin.spec.writeRevision` 保护认证、安装和设备记录的共同提交；安装意图的 `spec.revision` 在安装、更新和卸载等期望状态改变时推进。现有记录缺少版本时按 0 处理，正常写入时递增，不批量回填。

首次安装尚无安装行时，在该插件 Redis 租约下读取对应的创建计数，提交时只比较该插件的槽位。不同插件的元数据使用 JSON 路径合并；它们可能短暂争用同一同步记录的数据库写锁，但不跨下载、适配器或 IPC 等待持有该行。

快照先读取同步版本，再读取期望状态并 CAS 发布 generation。设备回执核对 generation、水位、安装意图和当前期望状态，迟到回执不能直接恢复已经卸载的安装。正常认证只校验真实账号策略，不递增共享偏好版本；只有编辑自动授权开关才修改该版本。

## 首次初始化的约定边界

`PluginSyncState` 和 `ConnectorAuthPolicy` 第一次创建由 180 秒 Redis 元数据租约协调；已有记录使用 CAS。

本方案明确接受以下残余风险：如果数据库 COMMIT 未决或进程停顿跨越租约到期，后继初始化仍可能查空并再次插入。无数据库唯一约束时，TTL 和续租都不能证明首次创建严格唯一。发现重复记录时拒绝自动选择，需要人工核对处理。该边界需要人工审查确认，不能把普通并发测试通过表述为极端提交故障已被消除。

## Native 与后台同步

沿用 V2 同步协议及 HTTP 本机操作入口。新版桌面执行器按插件准备包，并只在短暂的 manifest 发布阶段共享元数据锁；相同目标的 HTTP／Socket 重复投递复用准备结果，分别核验各自 generation。目标变化、更新和卸载继续终止旧目标的等价范围。

普通插件操作不取得本机完整对账队列。完整对账串行合并扫描证据，等待期间不持有短 journal 租约；前台操作到来时，旧计划在提交前重新核验。刷新遇到 `plugin_local_sync_busy` 时沿用有界暂缓机制，前台安装、更新和卸载可以继续。

自动认证保留启动、重连、插件清单变更和本机登录／退出事件触发，以及 300 秒、每进程 ±30 秒抖动的补充巡检。准备和只读状态查询不占整批插件写租约，凭据提交时才取得目标安装的租约。

## 部署与已有开发库

旧用户锁与插件锁不是同一协议。切换 Python／Rust 写入进程前，先停止受理并排空旧插件事务，再统一切换，避免新旧锁协议混跑。

从 main 部署本方案无需新增协调表或执行数据迁移；正常启动仍执行 main 已有的数据库迁移。

若开发库曾运行本 PR 的有表版本，切换前保留备份，并使用旧版本 `e677c1a84` 的原生迁移工具执行 `wegent-backend-rs db downgrade b1c2d3e4f5a6`。它把新表水位和最新回执合并回旧 Kind 后删除新表，同时保留 main 的分享链接迁移。核对迁移版本后再启动无表版本。不要直接清空新表或手动 stamp 跳过回写；本次代码修改不自动操作开发或线上数据库。

## 验证

复用现有插件单元测试、真实 MySQL／Redis 集成测试和桌面检查点，不新增 CI 作业。检查不同插件同时持有 180 秒租约、同插件竞争与 CAS、首次普通并发、账号隔离、重复投递、迟到回执、后台认证及完整对账与前台操作的隔离。

真实 Redis 用例检查 PTTL，HTTP 身份用例继续接入 `test_plugin_write_races_mysql.py`；桌面沿用 `plugin-write-coordination` 和本机同步检查点。首次初始化跨租约的严格唯一性不属于本方案保证范围。
