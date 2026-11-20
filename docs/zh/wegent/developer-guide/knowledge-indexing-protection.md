---
sidebar_position: 12
---

# 知识库索引保护

## 网页刷新与文档级发布

网页自动更新复用钉钉的 Rust 每日扫描、分页 cursor 和已有文档索引状态机。
Rust 仅派发 `app.tasks.web_auto_update_tasks.refresh_web_document` 到 Python
`wegent_online` 队列；手动刷新调用同一个 Python 服务，随后显式派发已有索引任务到该队列。
不要注册第二个 Python 网页 cron，也不要让 Rust 索引执行器消费网页候选任务。

发布顺序为：抓取候选 → 构建候选索引 → 验证可查询 → 数据库切换发布指针 → 延迟回收。
这些步骤不是跨数据库和向量存储的原子事务。

| 持久状态           | 位置与用途                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------- |
| 业务 generation    | 复用 `knowledge_documents.index_generation`，拒绝旧任务                                  |
| 候选               | `source_config._web_refresh`：源 URL、配置指纹、不可变附件、hash、请求人和用户启用状态   |
| 已发布版本         | `source_config.published_generation`，独立于正在运行的 generation                        |
| 已发布 hash / 配置 | `webAutoUpdate.content_hash` / `published_index_fingerprint`；内容与配置都相同才跳过构建 |
| 可回收版本         | 既有附件 `type_data.web_index_version`：准确版本、原存储资源引用与指纹、可回收时间       |

候选物理引用为 `document_id@generation`，没有发布指针的存量文档继续使用原引用。
Runtime 从数据库解析发布指针，将文档与版本配对过滤下推到 Elasticsearch、Milvus、Qdrant
的召回和分块列表条件，再执行 top-k。客户端传入的版本映射不决定可见性。
正文、chunks、转换附件引用与摘要一起随发布事务切换；旧摘要回调按源附件做条件更新。

Elasticsearch 发布前刷新相关索引并检查 shard 失败；Milvus 以 Strong 读取完整候选，不逐篇 flush collection；
Qdrant 检查所有副本可见的候选节点。屏障逐批核对全部子节点和父节点，部分写入不能发布。
Milvus 的版本相关搜索通过既有客户端包装层传递 Strong；无版本搜索沿用原默认。
父节点读取仅在候选校验和版本相关查询中提高一致性。
这依据 Milvus 的[一致性契约](https://milvus.io/docs/v2.5.x/tune_consistency.md)；
[频繁 flush 会产生小 segment 并影响性能](https://milvus.io/api-reference/pymilvus/v2.5.x/ORM/Partition/flush.md)。
这需要在目标存储部署上完成集成验收，单元测试或嵌入式 Qdrant 不证明集群一致性。

文档锁复用既有索引锁键，使用 owner token 续租与释放；跨抓取、排队和索引通过已有业务状态交接。
发布事务重新校验 generation、URL、配置资源指纹、请求人权限、KB 存续及自动更新开关，
并检查用户启用状态没有变化。刷新不自动启用禁用文档；自动扫描跳过禁用文档。
首次索引成功会转为内容就绪；已有 JSON 的 `web_user_status` 记录显式用户选择，
使系统默认的 disabled 可在首次成功时启用，而用户主动禁用继续生效。
候选保存该选择，发布前重查；原生首次索引任务也尊重它。禁用后仍可手动启用。

刷新对有效短正文（包括 PDF、Playwright 分帧及文本提取）启用局部质量策略，
保留认证／反爬壳、密度、重复、HTTP 状态和 SSRF 检查；不改变其他调用的长度默认值。
内容未变化时也须在数据库行锁下重查状态，按 generation 条件更新，并在提交前确认租约归属。

抓取阶段通过 Redis 对每个目标域名互斥，并以 Redis 时间保证两次抓取操作启动至少间隔 5 秒。
HTTP、PDF、浏览器导航、重定向和 iframe 的目标域名也需获得许可；页面内部同域资源属于同一次抓取。
域名锁在抓取结束释放，不占用到索引完成。Redis 不可用时拒绝本次刷新。

旧版本及未发布附件至少保留 24 小时，覆盖现有十分钟网关调用期限内的旧请求。
清理复用附件清理入口，按已有 batch 配置（默认 200）连续处理多批，精确到原存储和版本；
单次复用 `EXTERNAL_DOC_SYNC_RUN_MAX_DOCUMENTS`（默认 10000）和既有时间预算，
时间预算不超过清理间隔；耗尽预算保存 cursor，下次继续。删除失败保留记录重试，
不回滚已发布内容。当前版本、活跃候选不会被回收；失效候选和暂存草稿到期可回收。
抓取、派发或索引失败保留已有草稿供重试；草稿过期后清除附件引用，重建索引会明确提示重新抓取，不能悄悄使用旧正文。
如果原 Retriever 资源被删除或其定义发生变化，清理会保留记录并记录告警，不能猜测新存储位置。

### 启用与回退边界

- 默认全局和每个 KB 均关闭。在 Rust 调度进程与 Python worker 的部署配置中设置
  `WEB_AUTO_UPDATE_SCHEDULE_ENABLED=true` 后，维护者／创建者可在知识库编辑窗口开启网页定时刷新。
  未配置 `WEGENT_RS_JOB_ALLOWLIST` 时自动启用网页扫描和已有的超时恢复、附件清理任务。
  显式 allowlist 必须包含 `app.tasks.web_auto_update_tasks.scan_web_documents`、
  `app.tasks.knowledge_tasks.scan_stale_index_tasks` 和 `app.tasks.knowledge_tasks.cleanup_knowledge_attachment_orphans`；缺少依赖会在启动时报告配置错误。
  Rust 派发和 Python worker 使用同一个 `CELERY_BROKER_URL`（仅支持 Redis 传输，未设置时使用 `REDIS_URL`）；结果订阅连接保持独立。
- 每日扫描固定为 **04:00 UTC（北京时间 12:00）**，不依赖宿主机时区。
  扫描复用 `EXTERNAL_DOC_SYNC_RUN_MAX_DOCUMENTS`（默认 10000）和
  `EXTERNAL_DOC_SYNC_TIME_BUDGET_SECONDS`（默认 2700 秒）；cursor 跨次保留。
- KB 开关在执行前和发布前重查。全局环境开关是进程部署配置，修改环境文件不会即时通知已有 worker；
  紧急停用先关闭相关 KB，停用调度并排空／停止旧 worker。关闭自动更新不影响手动刷新。
- 自动摘要默认关闭，继续尊重手动入口的显式摘要选项。
- 文档重复任务按既有 `KNOWLEDGE_INDEX_LOCK_MAX_RETRIES` 和
  `KNOWLEDGE_INDEX_LOCK_RETRY_DELAY_SECONDS` 有界重试（默认 1 次、15 秒），超限跳过等待后续扫描；
  同域拥塞在原扫描消息的 24 小时有效期内指数退避并加少量随机间隔，最长约 5 分钟一次，
  不共用文档重复任务的一次重试预算，也不延长原消息期限。没有新增队列、调度器或配置项。
- 已有索引的 `trigger_indexing=false` 只准备草稿，后续重新索引消费草稿并发布；
  未建立索引的网页仍可先更新正文。草稿到期回收后需要重新抓取。
- Backend、Runtime、Engine 和 shared 协议须一起升级。发布过版本后，**不能只回滚到不识别发布指针的旧 Runtime**；
  停用任务后保留本版读取能力，或先完成经验证的索引／数据回迁。无新增数据库表或列迁移。

配置 API 为 Rust 所有的 `GET/PUT /api/knowledge-bases/{id}/web-auto-update`，
请求和响应均为 `{"enabled": boolean}`。无访问权限返回 403，不存在返回 404；
PUT 要求创建者或 Maintainer，非 JSON 布尔值返回 422。其余已有知识库 API 继续由原路由所有者执行。

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

- `index_status`: `not_indexed | queued | pending_conversion | converting | indexing | success | failed`
- `index_generation`: 当前索引世代

其中 `index_generation` 是这次改造的核心。每次“有效的新一轮索引”都会生成新的 generation，旧任务只要 generation 对不上，就必须退出。

其中 `not_indexed` 是显式初始态，表示文档尚未建立过索引，不再把“未开始”和“执行失败”混成同一个 `failed` 状态。

### 2. enqueue 前的业务去重

在真正调用 Celery 之前，orchestrator 会先更新数据库状态：

- 如果文档已经处于 `queued / pending_conversion / converting / indexing`，默认不再重复入队
- 如果 `queued / pending_conversion / converting / indexing` 已经卡住太久，会允许新请求接管并生成新的 generation
- 如果文档已经 `success`，普通重试请求直接跳过
- 只有明确需要覆盖当前世代的场景，才会生成新的 generation

当前策略：

- 新建文档：正常生成新 generation
- 失败文档重试：生成新 generation
- 文档内容被更新 / Web 文档刷新：允许覆盖当前世代，旧任务会自动变 stale
- 长时间停留在 `queued / pending_conversion / converting / indexing`：按 `updated_at` 判定为 stale 后允许接管

当前默认阈值：

- `queued` 超过 10 分钟，允许新的 generation 接管
- `pending_conversion` 超过 20 分钟，允许新的 generation 接管
- `indexing` 超过 45 分钟，允许新的 generation 接管

### 3. worker 执行前的最终判定

Celery worker 在真正调用 embedding 之前，会先做两件事：

1. 获取基于 `document_id` 的 Redis 分布式锁
2. 校验数据库中的 `index_generation` 和 `index_status`

只有满足下面条件才继续执行：

- 当前任务的 generation 等于数据库里的当前 generation
- 当前状态仍然是 `queued`、`pending_conversion` 或 `indexing`

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
