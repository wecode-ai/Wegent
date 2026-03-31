---
sidebar_position: 12
---

# 知识库索引保护

## 背景

知识库文档的 RAG 索引原先主要依赖 Celery 的消息投递与重试机制，没有业务侧的幂等保护。

在生产环境里，如果出现下面几类情况：

- worker / Pod 重启，触发 broker redelivery
- 同一文档被重复 enqueue
- 旧任务在新一轮索引已经开始后才恢复执行

就可能出现同一份大文件被重复 embedding、多台 worker 轮流消费同一逻辑任务的问题。

## 本次改造的目标

- 同一文档同一时刻只允许一个有效索引世代在运行
- 旧的 redelivery / retry 任务不能覆盖新的索引结果
- Celery 本身即使再次投递，业务层也能快速判定并跳过
- 明确记录索引状态，便于后续排查和前端展示

## 设计概览

本次保护分为三层。

### 1. 文档索引状态机

在 `knowledge_documents` 表新增字段：

- `index_status`: `not_indexed | queued | indexing | success | failed`
- `index_generation`: 当前索引世代

其中 `index_generation` 是这次改造的核心。每次“有效的新一轮索引”都会生成新的 generation，旧任务只要 generation 对不上，就必须退出。

其中 `not_indexed` 是显式初始态，表示文档尚未建立过索引，不再把“未开始”和“执行失败”混成同一个 `failed` 状态。

### 2. enqueue 前的业务去重

在真正调用 Celery 之前，orchestrator 会先更新数据库状态：

- 如果文档已经处于 `queued / indexing`，默认不再重复入队
- 如果 `queued / indexing` 已经卡住太久，会允许新请求接管并生成新的 generation
- 如果文档已经 `success`，普通重试请求直接跳过
- 只有明确需要覆盖当前世代的场景，才会生成新的 generation

当前策略：

- 新建文档：正常生成新 generation
- 失败文档重试：生成新 generation
- 文档内容被更新 / Web 文档刷新：允许覆盖当前世代，旧任务会自动变 stale
- 长时间停留在 `queued / indexing`：按 `updated_at` 判定为 stale 后允许接管

当前默认阈值：

- `queued` 超过 10 分钟，允许新的 generation 接管
- `indexing` 超过 45 分钟，允许新的 generation 接管

### 3. worker 执行前的最终判定

Celery worker 在真正调用 embedding 之前，会先做两件事：

1. 获取基于 `document_id` 的 Redis 分布式锁
2. 校验数据库中的 `index_generation` 和 `index_status`

只有满足下面条件才继续执行：

- 当前任务的 generation 等于数据库里的当前 generation
- 当前状态仍然是 `queued` 或 `indexing`

否则直接返回 `skipped`，不会再次调用 embedding 模型。

## 为什么 generation 能解决 redelivery 问题

单纯靠“有没有锁”并不够。

因为 worker 崩溃后，锁最终会过期，而 broker 里的旧消息可能会再次被投递。如果没有 generation，旧消息重新拿到锁后仍然会继续跑。

引入 generation 之后：

- 新一轮任务入队时会把 generation 加一
- 旧消息即使后来被 redelivery，拿到锁后也会发现 generation 已经过期
- 旧任务完成时，即使跑到了最终写库阶段，也不能再覆盖新世代状态

## 长任务锁续期

知识库 embedding 可能持续十几分钟甚至更久，因此文档级 Redis 锁不是一次性固定 TTL，而是采用 watchdog 续期：

- 初始锁 TTL 较短
- 任务存活期间后台线程定期 extend
- 进程异常退出后 watchdog 也会停止，锁会自然过期

这样可以同时避免两类问题：

- TTL 太短导致长任务中途失锁
- TTL 太长导致 worker 崩溃后长时间无法恢复

## 与 Celery retry 的关系

这次改造的重点仍然是“业务自身保护”，因此 `index_document` 不再对所有异常走通用重试。

当前行为更接近：

- `lock_held`：只做有限次、短间隔的延迟重试，用来覆盖 worker 重启后的旧锁残留窗口
- 业务可判定的重复 / 过期任务：直接 `skipped`
- 真正执行失败：记录为 `failed`
- 执行过程中如果底层返回业务 `skipped`：也会落为 `failed`，避免误记成 `success`
- 后续是否重试，由业务重新发起新的 generation

这样可以避免“同一个失败任务在 broker 和 worker 之间反复回放”。

当前默认锁参数：

- 文档锁 TTL：120 秒
- watchdog 续期间隔：30 秒
- `lock_held` 延迟重试间隔：15 秒
- `lock_held` 最大重试次数：10 次

## 兼容已有数据

迁移时会对历史文档做一次初始化：

- `is_active = true` 的文档回填为 `index_status = success`
- 其它历史文档默认回填为 `index_status = not_indexed`

这是为了让已有数据能立即进入新状态机，而不是处于未定义状态。

## 后续建议

这次改造解决的是“业务幂等与重复执行”问题，但不是 Celery 部署治理的终点。生产环境仍建议继续推进：

- Web / Worker / Beat 拆分部署
- 停用 embedded Celery
- 知识库任务独立队列
- 增加超时、失败回收与监控指标

业务保护负责兜底，Celery 架构治理负责把异常面继续缩小。
