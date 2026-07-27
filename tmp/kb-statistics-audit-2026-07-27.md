# 知识库统计全链路审计

> 审计日期：2026-07-27  
> 范围：知识库详情页、后台知识库管理统计页、统计任务、指标口径、查询与采集性能  
> 方法：静态代码走查；未连接生产数据库，数据量、执行计划和线上延迟仍需用本文末尾的观测方案复核。

## 1. 结论摘要

当前实现的方向是合理的：业务库只读采集、独立统计库、Celery 异步任务、采集器级事务隔离、前端批量指标接口、详情页强制覆盖 `kb_ids`、管理员与知识库管理者鉴权，这些基础设计值得保留。

但当前版本还不适合把全部数字当作严格可信的经营指标。建议先解决以下问题，再做图表和查询性能的细化：

| 优先级 | 结论 | 影响 |
| --- | --- | --- |
| P0 | 采集器包导入了不存在的 `chunks_count_distribution`，异常又被静默吞掉 | `sys_ops`、`user_behavior` 等位于失败导入之后的采集器可能根本未注册、未执行，但页面仍可展示对应指标 |
| P0 | 日期上界语义混用：`effective_end_date = end + 1 day`，SQL 普遍继续使用 `<=`；按日循环也使用 `<=` | 可能把次日 00:00 计入，按日快照可能额外生成一天；默认窗口也存在 30/31/32 天混乱 |
| P0 | 页面查询选择“全局最新 completed/partial run”，不验证该 run 是否包含目标指标/域/KB | 局部域重跑或单 KB 任务可成为全局最新 run，导致其他卡片突然为空；不同图又可能跨 run 拼接 |
| P1 | 详情页“检索活跃天数”直接显示 `daily_rows.length` | 有零查询的补齐日期也会被算作活跃日，名称与数据不符 |
| P1 | 多日期手工任务只是逐个 `delay()`，并未等待前一个完成 | UI 所称“串行”仅是串行入队；会形成长队列，成功提示也只代表入队成功 |
| P1 | 统计页首次加载仍会同时发起多组批量请求，展开高级视图后再发多组请求；无共享缓存和请求取消 | 管理页和详情页约为“指标列表 + dashboard + 若干批次 + 独立健康指标/告警”，数据库仍执行几十条 SQL |
| P1 | `partial` run 与 `completed` 等价参与最新值和趋势聚合 | 失败域产生的数据缺口会被当作有效最新值，用户看不到质量标识 |
| P2 | 指标数量过多、核心集合注释与实际集合不一致，详情页信息密度高 | “30 个核心指标”实际集合只有 27 项，用户难以从诊断指标中快速得到行动结论 |

建议先用 1～2 个迭代完成“可信度修复”，再优化性能。否则缓存只会更快地返回不一致数据。

## 2. 当前链路

```text
知识库详情 / 管理后台
  -> Backend API（登录态、管理员或 KB owner/manager 鉴权）
  -> RemoteKbStatGateway
  -> Knowledge Runtime /internal/kb-stat
  -> KbStatQueryService
  -> 独立统计库 kb_stat_*

Celery Beat / 管理员手工触发
  -> kb_stat.collect_all 队列
  -> Redis target_date 分布式锁
  -> Runner 顺序执行所有 Collector
  -> 业务库只读查询
  -> 每个 Collector 独立提交到统计库
  -> kb_stat_runs / kb_stat_collector_runs 记录状态
```

主要代码入口：

- 前端 API 与类型：`frontend/src/features/knowledge-stat/api.ts`
- 详情页：`frontend/src/features/knowledge/document/components/KbStatView.tsx`
- 管理页：`frontend/src/features/knowledge-stat/components/admin/KnowledgeStatsAdminPanel.tsx`
- 指标分组与批量加载：`StatsPage.tsx`、`DomainSection.tsx`、`useMetricsBatch.ts`
- Backend 鉴权与转发：`backend/app/api/endpoints/knowledge_stats.py`、`admin/knowledge_stats.py`
- Runtime API 与任务：`knowledge_runtime/.../api/endpoints/kb_stat.py`、`tasks/stat_tasks.py`
- 指标查询与采集：`knowledge_engine/.../stat/query.py`、`runner.py`、`collectors/*`

## 3. 知识库详情页分析

### 3.1 做得合理的地方

1. Backend 不信任客户端的 `kb_ids`，使用路径中的 `kb_id` 强制覆盖过滤条件，避免越权横向查询。
2. 只有管理员、知识库 owner、已批准的 manager 能查看统计，权限边界清楚。
3. 顶部先给文档、查询、存储、健康度等概览，再将完整指标折叠到高级视图，方向比平铺全部指标好。
4. 指标按技术、运营、业务三类重新分组，比底层 collector domain 更符合产品语言。
5. 一组指标使用 batch API，避免每张卡片一个 HTTP 请求。

### 3.2 展示问题

#### P1：“检索活跃天数”口径错误

当前值为：

```ts
value={dashboard.daily_rows?.length ?? 0}
```

`daily_rows` 是报表日期行，不等同于有检索行为的日期。若采集器补齐零值日期，7 天范围永远可能显示 7 个“活跃天”。应改为：

```text
count(day where total_queries > 0)
```

并明确名称是“有查询天数”还是“有 RAG 检索天数”。若希望表达使用连续性，建议同时显示“活跃天数 / 所选天数”。

#### P1：健康度可能展示历史窗口中最近一个“有分数”的日期，而非报表截止日

代码过滤掉 `health_score = null` 后取最新有效行。若最新一天知识库已经清空，页面仍可能显示更早一天的健康分，看起来像当前健康度。建议卡片同时展示 `stat_date`，并区分：

- 截止日分数；
- 最近一次有数据分数；
- 无文档/无样本。

#### P1：加载状态不完整

详情页 dashboard 有 loading，但健康度请求没有独立 skeleton/error；`StatsPage` 又独立加载指标列表和批次。用户会看到顶部、健康度、详细指标分阶段跳动。建议以页面级 query model 合并关键首屏数据，至少提供统一的“数据截至时间”和局部 skeleton。

#### P2：日期输入缺乏校验

前端允许开始日期晚于结束日期、选择今天/未来日期、选择超过保留期的日期。后端模型也没有范围校验。建议：

- `start_date <= end_date`；
- 默认截止昨天，并将未来日期禁用；
- 设置最大跨度（例如 90 天）；
- 超过保留期时明确提示，而不是空图；
- 显示时区（建议统计日统一为业务时区，而不是浏览器本地/UTC 混用）。

#### P2：指标过多且行动性不足

详情页默认“核心指标”配置注释称 30 项，集合实际为 27 项。即使折叠高级项，默认项仍偏多。建议详情页只保留 8～12 个直接可行动指标：

- 健康分及四个组成项；
- 文档/有效文档/索引失败；
- 查询量、命中率、零分块率、采纳率；
- 存储与最近更新时间；
- 明确的异常建议。

排名类、平台类、运维类指标放管理员页；详情页高级视图按需加载。

## 4. 管理页分析

### 4.1 做得合理的地方

1. 管理页与任务页分 tab，统计结果和运行诊断没有混在一个长页面。
2. 平台比率使用事件加权 `SUM(numerator)/SUM(denominator)`，比“各 KB 百分比平均”合理。
3. 除平台均值外提供健康度分布，能够发现均值掩盖的长尾。
4. `generated_at`、报表周期、任务明细和 collector 失败信息具备可追溯基础。

### 4.2 指标与展示问题

#### P0：全局最新 run 可能不是完整平台 run

`_latest_run()` 只按最大 run id 选择 `completed` 或 `partial`。它不区分：

- 全量任务或 `kb_filter` 单 KB 任务；
- 全域任务或选定 domain 任务；
- 哪些 collector 成功；
- 该指标表在 run 中是否有行。

因此管理员触发一次单域修复或单 KB 采集后，它可能成为 dashboard/global totals 和所有普通指标的“最新 run”。未参与此次任务的指标会返回空数组。这个问题也影响详情页。

建议建立“指标级数据版本”：

1. 查询每个 metric 时，选择“包含该 collector 且 collector status=success”的最新适用 run；
2. 管理 dashboard 只使用 `kb_filter IS NULL` 且 dashboard collectors 全成功的 run；
3. KB 页面可使用全量 run 中该 KB 的数据，或该 KB 专项 run；
4. 响应返回 `data_status`、`source_run_id`、`stat_date`、`is_partial`；
5. 页面提示“部分指标截至日期不同”，不要静默混合。

更稳妥的长期方案是维护 `kb_stat_metric_watermarks(metric_name, scope, kb_id, run_id, stat_date, status)`。

#### P1：`partial` 被视作正常最新数据

查询、趋势去重、平台聚合都允许 `status IN ('completed', 'partial')`。如果相关 collector 正好失败，新的 partial run 会覆盖旧的完整数据或产生断点。至少应关联 `kb_stat_collector_runs`，只接纳对应 collector 成功的结果。

#### P1：“活跃知识库比例”定义不清

管理 dashboard 使用所选周期内每日 `active_kb_count` 的最大值，再除以“最新快照知识库总数”。它不是：

- 周期内去重活跃 KB / 周期末 KB；
- 日均活跃率；
- 截止日活跃率。

名称却只叫“活跃知识库比例”。建议优先采用“周期内至少被查询一次的去重 KB / 周期末有效 KB”，另设 DAU-like 的“日均活跃 KB 率”。分子分母必须来自相同范围和相同快照。

#### P1：平台“去重率”可能语义反向

代码用 `unique_queries / total_queries` 作为 `dedup_rate`。该值越高代表重复越少，更像“唯一查询率”；通常“去重率”更容易被理解为：

```text
(total_queries - unique_queries) / total_queries
```

需要确认产品意图，名称应改为“唯一查询占比”，或反转公式后继续称“重复/去重率”。

#### P2：大量图表缺少样本量与空值解释

比率卡片虽有 `total_queries` 字段，但首屏主要展示百分比；小样本时会产生剧烈变化。建议所有比率同时显示 `n`，并采用阈值：

- `n = 0`：无数据；
- `0 < n < 最小样本量`：低样本，仅供参考；
- 达标后再使用红黄绿阈值。

#### P2：指标目录与前端分组存在双重配置

后端维护 domain、label、chart hint、date column、row limit，前端又维护 core 集合和 domain-to-type。新增指标容易出现“采集了但不展示”“展示分类错误”。建议把 `visibility`、`audience`、`metric_type`、`priority`、`good_direction`、`unit`、`sample_field` 都纳入后端 MetricSpec，由前端纯渲染。

## 5. 统计任务分析

### 5.1 P0：采集器注册链路已损坏

`knowledge_engine/stat/collectors/__init__.py` 从 `retrieval.py` 导入 `chunks_count_distribution`，但当前文件中不存在该函数。实际执行导入会抛出：

```text
ImportError: cannot import name 'chunks_count_distribution'
```

同时 `registry._ensure_imports()` 和 `query._ensure_imports()` 捕获 `ImportError` 后直接 `pass`。这会造成两个危险后果：

1. 服务可能不启动失败，而是带着不完整 registry 继续工作；
2. 位于失败导入语句之后的 `sys_ops`、`user_behavior` 模块不会被导入注册，健康检查的 `metrics_registered` 也可能只是一个不完整数字。

应立即：

- 修复函数名（很可能已改为 `doc_chunk_count_distribution` 或该指标已删除）；
- 禁止吞掉 collector import error，启动时 fail fast；
- 增加测试：所有 MetricSpec 有且只有一个可用 collector，所有 collector 都有 MetricSpec；
- 健康检查返回 expected/registered/missing 三个集合，而不是只返回数量。

### 5.2 P0：日期边界不一致

`MetricFilter` 当前语义：

```python
effective_end_date = (end_date or target_date) + timedelta(days=1)
effective_period_start = target_date - timedelta(days=lookback_days)
```

这里除闭区间错误外，还有一个独立问题：`effective_period_start` 以
`target_date` 为基准，而 `effective_end_date` 可以由请求中的
`end_date` 决定。当 `end_date != target_date` 时，起点和终点来自两个
不同基准，实际窗口长度不再等于 `lookback_days`，甚至可能出现空窗口
或超长窗口。查询 API 中 `_to_metric_filter()` 通常将 `target_date`
设置为 `payload.end_date or today`，可部分掩盖这个问题；但 Runner、
手工构造 `MetricFilter` 和后续复用代码并不天然保证两者相同。因此
日期模型本身仍然不自洽，不能依赖调用方碰巧传入一致值。

但采集 SQL 大量使用：

```sql
created_at >= :start_date AND created_at <= :end_date
```

正确的半开区间应是 `< end_exclusive`。当前 `<= end+1day` 会把次日 00:00:00 纳入。更严重的是 `kb_health_score`、部分 lifecycle collector：

```python
end = effective_end_date
while d <= end:
```

这会把“加一天后的日期”本身也生成一整行。默认 `target - 30` 到 `target + 1` 闭区间可产生 32 个日期，而 UI 默认明确选择 7 个自然日。

统一规则建议：

```text
start_date：包含
end_date：用户可见的包含日期
end_exclusive：end_date + 1 day，仅用于 DATETIME，SQL 使用 <
按 DATE 循环：start_date <= d <= end_date
lookback_days=N：start_date = end_date - (N - 1) days
```

实现上建议只保留一个规范化入口，先得到包含式 `period_end_date`，再由
它计算 `period_start_date` 和 `end_exclusive`；如果请求显式传入
`start_date`，则以显式范围为准并重新计算展示天数，不再同时套用
`lookback_days`。

并用边界测试覆盖 `23:59:59.999999`、次日 `00:00:00`、闰日和时区转换。

### 5.3 P1：手工日期范围并不是真正串行

前端 `for ... await triggerRun()` 仅等待 API 完成入队；API 立即返回 Celery task id，不等待采集完成。因此会快速将多日任务全部压入 `kb_stat` 队列。“全部成功”仅表示全部入队成功，不能表示统计成功。

建议提供一个后端 backfill job：

```text
POST /runs/backfill {start_date, end_date, domains}
-> 返回 job_id
-> worker 内部按日期执行并记录 completed/failed/skipped
-> GET /backfill-jobs/{id} 返回真实进度
```

前端展示“已入队”和“已完成”两个状态，不应在入队后显示统计成功。

### 5.4 P1：锁只按 target_date，且 Redis 不可用时静默降级

同一天不同 domain 的任务本可安全串行合并或按资源冲突判断，但当前统一互斥；不同日期任务却可并行扫描同一批大表，可能压垮只读副本。Redis 不可用又会退化为无锁，并且 DB fast-path 有竞态。

建议：

- 默认方案：Redis 锁不可用时 fail closed，任务不进入采集，并产生明确告警；不要静默退化为无锁；
- 当前 DB fast-path 只是先查询统计库中的 `running` 记录，两个请求可能同时查不到再一起入队，因此它是减噪优化，不是严格的第二重互斥；
- 可选增强：如果未来确实需要 Redis 之外的第二互斥机制，只能在独立统计库实现原子占位/租约或统计库 advisory lock，并经过并发与故障恢复验证；禁止在业务库加约束、建锁表或获取 advisory lock；
- worker 队列设置明确并发数（通常统计只读副本 1～2）；
- 限制同一时间的重型 collector 数量；
- 如果实际部署已经证明单实例、单 worker 足够且可接受 Redis 作为唯一锁，可暂不增加统计库第二锁，避免过度设计。

### 5.5 P1：Runner 是约 80 个 collector 的串行全表扫描

每个 collector 单独读取业务表，不共享中间结果；大量 retrieval 指标重复扫描 `subtask_contexts` 和 JSON 路径，health collector 又按“日期 × KB × 文档”重复聚合。随着数据增长，执行时间近似：

```text
collector 数 × 窗口天数 × 业务表扫描成本
```

#### 5.5.1 当前性能问题的具体形态

当前 Runner 的 `for collector in collectors` 确实是严格串行的，但“串行”本身不是最主要的问题。主要浪费来自同一批源数据被重复解析、过滤和聚合：

| 源数据 | 当前重复工作 | 典型指标 |
| --- | --- | --- |
| `subtask_contexts` | 多个 collector 分别按相同时间范围扫描，并重复执行 `JSON_EXTRACT(type_data, ...)` | 查询量、RAG/Head 比例、模式分布、活跃用户、零分块率、命中率、采纳率、去重率、慢查询率 |
| `knowledge_documents` | 分别扫描文档状态、大小、摘要、chunks、更新时间、索引状态 | 上传趋势、索引状态、失败率、大小分布、分块策略、摘要状态、内容新鲜度、存储 |
| `kinds` | 重复读取 KB 名称、namespace、配置 JSON 和当前状态 | KB 总数、创建趋势、检索配置、健康度、配置合理性 |
| `resource_members` | 多次重复统计成员、角色、邀请和跨组织关系 | 共享、成员规模、权限分布、参与度 |
| 历史日期窗口 | 每次全量任务重新计算过去 30 天；部分 collector 又逐日查询 | 健康度、生命周期和趋势指标 |

其中最重的是 `subtask_contexts.type_data`：

- `knowledge_id`、`rag_result.injection_mode`、`chunks_count`、`retrieval_count`、`adoption_result` 等字段在许多 SQL 中重复解析；
- 对 JSON 表达式做过滤和分组通常很难利用普通索引；
- 同一天的同一行会为了十几个指标被反复读取；
- 全量回填多天时，每个目标日期又会重复读取重叠的 30 天窗口。

现有 Runner 还长期保持一个 `source_session`。如果连接默认事务隔离级别为 Repeatable Read，长任务可能持有较老快照，增加只读副本 MVCC 压力；如果在主库执行则风险更高。

#### 5.5.2 优化目标和约束

优化不能简单改成“80 个 collector 全并行”。那会把串行的慢查询变成同时压向只读副本的慢查询，可能缩短单次任务墙钟时间，却显著增加数据库 CPU、IO、锁和副本延迟。

建议目标：

| 指标 | 第一阶段目标 | 稳定阶段目标 |
| --- | --- | --- |
| 每日全量采集耗时 | 降低 30%～50% | 降低 70% 以上 |
| `subtask_contexts` 大范围扫描次数 | 下降到每个统计日 1～2 次 | 增量读取，不再回扫完整窗口 |
| `knowledge_documents` 全表扫描次数 | 每 run 不超过 2～3 次 | 变更驱动增量 |
| 业务只读副本 CPU | 峰值不高于现状 | 峰值可预算、可限流 |
| 数据新鲜度 | T+1 可稳定完成 | 支持小时级或更短增量 |
| 单 collector 故障 | 可独立重试 | 不重复抽取源数据 |
| 结果一致性 | 同一 run 使用同一 source cutoff | 事实层具备 watermark |

必须保留：

- 业务库完全只读：不执行 DDL、不新增索引/生成列、不回写结构化字段、不要求业务代码配合改表；
- 所有新增 staging、事实表、watermark 和索引只能创建在统计库；
- `knowledge_id`、retrieval mode、chunk count、score 等 JSON 结构化和索引优化仅发生在统计库 staging/事实表，绝不落到 `subtask_contexts` 等在线业务表；
- 失败隔离和精确重试；
- KB/domain 定向补数；
- 同一统计日结果可复现；
- 不因性能优化改变指标口径。

#### 5.5.3 第一阶段：先测量，再做低风险止血

不要先加线程池。先补齐 collector 级观测，取得真实 Top SQL。

在 `kb_stat_collector_runs` 增加或单独记录：

```text
duration_ms
source_query_count
source_query_ms
stat_write_ms
rows_read_estimate
rows_written
source_watermark
source_replica_lag_ms
error_code
```

SQLAlchemy 可在统计 worker 的 engine 上使用 `before_cursor_execute` / `after_cursor_execute` 事件，将查询次数和耗时累计到当前 collector context。慢 SQL 日志只保存归一化指纹和参数规模，不记录敏感内容。

采集一周后按以下顺序排序：

1. collector 总耗时；
2. 源 SQL 总耗时；
3. 同一 SQL 指纹的累计调用次数；
4. 检查行数/返回行数比；
5. 只读副本 CPU、IO、buffer pool miss、replica lag。

对 Top 10 SQL 运行生产相近数据量的 `EXPLAIN ANALYZE`，重点确认：

- 是否因为 JSON 表达式导致全表扫描；
- 时间字段是否走范围索引；
- 在现有索引不变的前提下，`context_type + created_at` 查询实际采用什么计划；
- 在现有索引不变的前提下，文档表组合过滤实际采用什么计划；
- `GROUP BY DATE(created_at)` 是否产生临时表和 filesort；
- `COUNT(DISTINCT JSON_EXTRACT(...))` 的成本；
- 大 `IN (kb_ids)` 是否改变计划。

低风险立即改进：

1. 将 `fetch_kb_metadata()` 的结果在一次 run 内缓存，所有 collector 共享；
2. 用户、KB 名称等维度映射一次批量读取，禁止每行回查；
3. 修复 `kb_avg_doc_length` 等潜在 N+1 查询；
4. collector 只查询自身需要的列，避免 `SELECT *` 和读取 LONGTEXT；
5. 对大结果使用 server-side cursor/分批读取，避免 worker 内存峰值；
6. 每个 collector 使用短生命周期只读 session，完成后释放事务快照；
7. 给 collector 增加 soft timeout 和重试策略；
8. 将轻量快照、重型扫描、外部依赖 collector 标注为不同 cost class。

建议扩展 `CollectorMeta`：

```python
@dataclass
class CollectorMeta:
    name: str
    domain: str
    cost_class: Literal['light', 'medium', 'heavy']
    source_sets: frozenset[str]
    dependencies: tuple[str, ...]
    timeout_seconds: int
    incremental: bool
```

这既服务调度，也能阻止将所有 collector 盲目并行。

#### 5.5.4 第二阶段：建立 Run 级共享抽取层

这是投入较小、收益较快的中间方案，不需要立刻建设完整数仓。

每个 run 先执行少量 extractor，将源表在目标窗口内转换成窄表或临时 staging 表；随后 collector 只读 staging：

```text
Extractor A: subtask_contexts
  -> stage_kb_query_event

Extractor B: knowledge_documents
  -> stage_kb_document

Extractor C: kinds/resource_members
  -> stage_kb_dimension
  -> stage_kb_member

Collectors
  -> 只对 stage 表聚合
  -> 写现有 kb_stat_* 指标表
```

建议的查询事件 staging schema：

```sql
CREATE TABLE kb_stat_stage_query_event (
    run_id              BIGINT NOT NULL,
    event_id            BIGINT NOT NULL,
    event_time          DATETIME(6) NOT NULL,
    stat_date           DATE NOT NULL,
    kb_id               BIGINT NULL,
    user_id             BIGINT NULL,
    injection_mode      VARCHAR(32) NULL,
    is_rag              BOOLEAN NOT NULL,
    is_kb_head          BOOLEAN NOT NULL,
    chunks_count        INT NULL,
    retrieval_count     INT NULL,
    restricted_mode     BOOLEAN NULL,
    hit                 BOOLEAN NULL,
    adopted             BOOLEAN NULL,
    cited_count         INT NULL,
    query_hash          BINARY(32) NULL,
    duration_ms         INT NULL,
    PRIMARY KEY (run_id, event_id),
    INDEX ix_stage_query_kb_date (run_id, kb_id, stat_date),
    INDEX ix_stage_query_date_mode (run_id, stat_date, injection_mode),
    INDEX ix_stage_query_user_date (run_id, user_id, stat_date)
);
```

文档 staging schema：

```sql
CREATE TABLE kb_stat_stage_document (
    run_id              BIGINT NOT NULL,
    doc_id              BIGINT NOT NULL,
    kb_id               BIGINT NOT NULL,
    created_date        DATE NOT NULL,
    updated_date        DATE NOT NULL,
    is_active           BOOLEAN NOT NULL,
    index_status        VARCHAR(32) NULL,
    file_size           BIGINT NOT NULL,
    chunk_count         INT NULL,
    splitter_type       VARCHAR(64) NULL,
    summary_status      VARCHAR(32) NULL,
    has_summary         BOOLEAN NOT NULL,
    PRIMARY KEY (run_id, doc_id),
    INDEX ix_stage_doc_kb (run_id, kb_id),
    INDEX ix_stage_doc_created (run_id, created_date),
    INDEX ix_stage_doc_status (run_id, index_status)
);
```

注意：

- staging 表应在统计库，不在业务库；
- extractor 用只读连接流式读取，批量写入统计库；
- JSON 只解析一次；
- `query_text` 不建议明文进入事实表；去重只保存规范化 hash；
- staging 结果带 `run_id`，便于失败重试复用；
- 完整 run 成功后可立即删除 staging，或短期保留 3～7 天供重试和审计。

Collector 接口应从直接依赖业务 session 改为依赖显式数据源：

```python
class CollectorContext:
    run_id: int
    metric_filter: MetricFilter
    facts: FactRepository
    stat_session: Session
```

短期可以双轨：

- 已迁移 collector 读取 `FactRepository`；
- 未迁移 collector 继续使用 `source_session`；
- 按 domain 逐步迁移，避免一次重写 80 个指标。

优先迁移顺序：

1. retrieval 和 dashboard：共享 `subtask_contexts`，收益最大；
2. user_behavior 中依赖查询事件的指标；
3. doc_management、content_quality、prometheus、sys_ops：共享文档 staging；
4. collaboration/lifecycle；
5. deep_analysis。

#### 5.5.5 第三阶段：建设持久化日事实层

Run 级 staging 仍会在每天重新抽取窗口。长期方案是将事件和文档状态增量沉淀为持久化事实表。

建议最少建立四类事实：

```text
fact_kb_query_event       一次查询/检索事件一行
fact_kb_query_daily       kb_id + stat_date 日聚合
fact_kb_document_change   文档创建、更新、启停、索引、摘要变化事件
fact_kb_document_daily    kb_id + stat_date 文档状态快照/增量
```

`fact_kb_query_daily` 示例：

```sql
CREATE TABLE kb_stat_fact_query_daily (
    stat_date            DATE NOT NULL,
    kb_id                BIGINT NOT NULL,
    total_queries        BIGINT NOT NULL,
    rag_queries          BIGINT NOT NULL,
    kb_head_queries      BIGINT NOT NULL,
    direct_injections    BIGINT NOT NULL,
    zero_chunk_queries   BIGINT NOT NULL,
    hit_queries          BIGINT NOT NULL,
    adopted_queries      BIGINT NOT NULL,
    unique_query_count   BIGINT NOT NULL,
    active_user_count    BIGINT NOT NULL,
    restricted_queries   BIGINT NOT NULL,
    source_max_id        BIGINT NOT NULL,
    refreshed_at         DATETIME(6) NOT NULL,
    PRIMARY KEY (stat_date, kb_id)
);
```

绝大多数查询类指标随后只需要读取这张日聚合表；只有分布类和用户明细类指标需要事件事实。

增量 watermark：

```text
source_name
partition_key
last_source_id
last_event_time
last_successful_run_id
updated_at
```

抽取算法：

1. 记录本次 source cutoff，例如 `MAX(id)` 和数据库时间；
2. 只读取 `(last_source_id, cutoff_id]`；
3. 批量 upsert 事件事实；
4. 重新聚合受影响的 `stat_date + kb_id` 分区；
5. 事务提交事实分区和 watermark；
6. collector 从事实层读取同一 watermark 版本；
7. 延迟事件进入历史日期时，只重算受影响分区。

如果业务记录存在 update/delete：

- 单纯按自增 id 不够；
- 可使用 `updated_at + id` 复合游标；
- 更可靠的是 CDC/binlog；
- 删除事件必须通过软删除字段、审计日志或 CDC 捕获。

在没有 CDC 前，建议每天增量、每周对最近 7～30 天做校正重算，平衡性能和最终一致性。

#### 5.5.6 健康度专项优化

当前健康度按日期循环，每个日期都将 `kinds LEFT JOIN knowledge_documents` 重新聚合。复杂度接近：

```text
窗口天数 × 文档表扫描/连接
```

应改为基于文档变化事件维护日快照：

```text
前一日文档状态
+ 当日新增
+ 当日启停变化
+ 当日索引状态变化
+ 当日摘要状态变化
= 当日文档状态
```

建议事实表：

```sql
CREATE TABLE kb_stat_fact_document_daily (
    stat_date             DATE NOT NULL,
    kb_id                 BIGINT NOT NULL,
    total_docs            BIGINT NOT NULL,
    active_docs_30d       BIGINT NOT NULL,
    indexed_success_docs  BIGINT NOT NULL,
    enabled_docs          BIGINT NOT NULL,
    summary_docs          BIGINT NOT NULL,
    PRIMARY KEY (stat_date, kb_id)
);
```

健康分 collector 变成一次简单计算：

```sql
SELECT stat_date, kb_id,
       active_docs_30d / NULLIF(total_docs, 0),
       indexed_success_docs / NULLIF(total_docs, 0),
       enabled_docs / NULLIF(total_docs, 0),
       summary_docs / NULLIF(total_docs, 0)
FROM kb_stat_fact_document_daily
WHERE stat_date BETWEEN :start AND :end;
```

`active_docs_30d` 是滑动窗口指标，可以通过：

- 每日对 `last_updated_date >= stat_date - 29 days` 做一次索引友好的按 KB 聚合；
- 或维护文档最后更新时间分布，再做窗口和；
- 不要为每个目标日重复连接全部历史文档。

#### 5.5.7 并发与调度方案

事实/staging 抽取完成后，collector 大多只读取统计库，才适合有限并行。

推荐 DAG：

```text
create_run
  -> extract_dimensions
  -> extract_query_facts
  -> extract_document_facts
  -> [query metric group]
  -> [document metric group]
  -> [collaboration metric group]
  -> [deep-analysis metric group]
  -> validate_run
  -> publish_watermarks
  -> finalize_run
```

并发原则：

- 业务库 extractor：并发 1～2，保护只读副本；
- 统计库轻量聚合：并发 2～4，根据连接池和 CPU 调整；
- 同一输出表/分区不可并发写；
- heavy collector 使用独立队列和 rate limit；
- backfill 使用低优先级队列，不能挤占每日 T+1；
- 先抽取事实再 fan-out，禁止每个并发 collector 回扫业务库。

Celery 可使用 chord/group 表达 DAG，但需要明确处理 chord callback 丢失和重复执行。另一种更简单的方式是在一个 orchestrator task 中提交 group，并将每个阶段状态落库。所有阶段必须幂等：

```text
唯一键 = metric_name + target_date + kb_scope + source_watermark/version
```

重试使用 upsert 或“写临时分区 -> 原子发布”，避免重复行。

不建议一开始做的方案：

- 直接把 Runner 改成 80 线程；
- 每个 collector 独立 Celery task 后仍各自扫描业务库；
- 只增大 worker 数、连接池和超时时间；
- 要求业务库为统计功能新增字段、生成列或索引；
- 将所有 collector 合并成一个不可测试的大 SQL。

#### 5.5.8 业务库零侵入条件下的读取优化

本统计功能不应要求业务库改变设计。本方案明确排除：

- 修改任何业务表；
- 增加业务表字段、生成列、索引、触发器或物化视图；
- 要求业务写入链路同步维护统计字段；
- 在业务库创建统计临时表；
- 为统计任务使用表锁或高隔离级别长事务。

在该约束下，可采用的优化全部发生在读取方式和统计库：

1. **一次流式抽取，多指标复用**  
   每个源表在一个 run 中尽量只读取一次。JSON 解析发生在 extractor 进程中，解析结果批量写入统计库 staging；后续 collector 不再查询业务 JSON。

2. **使用源表已有的可用游标**  
   如果已有自增 `id`，使用 `(last_id, cutoff_id]`；如果已有 `updated_at`，使用 `(updated_at, id)` 复合游标。这里只读取现有字段，不新增字段。若某表没有可靠变更游标，则对它采用分区窗口重读和对账，不假设可以修改源表。

3. **只读取必要列**  
   查询事件 extractor 只读取 `id/created_at/user_id/type_data` 等必要字段；文档 extractor 避免读取正文、提取文本等大字段。`chunks`、`summary` 仅在对应统计需要时读取。

4. **用原始时间列做范围过滤**  
   where 条件保持 `created_at >= :start AND created_at < :end_exclusive`，避免在过滤条件左侧使用 `DATE(created_at)`。按日分桶移到统计侧或 select/group 阶段处理。

5. **keyset pagination**  
   使用 `WHERE id > :last_id ORDER BY id LIMIT :batch_size`，避免大 OFFSET。批次大小通过压测确定，例如 2,000～10,000 行；每批及时释放结果和事务。

6. **冻结读取 cutoff**  
   run 开始读取源表 `MAX(id)` 或当前可见最大游标，此后仅处理 cutoff 以内的数据，确保长任务结果可复现，也避免不断追逐新写入。

7. **短事务与连接限流**  
   extractor 每批使用短只读事务；业务库并发固定为 1～2，连接池单独限额。统计库 collector 可以更高并发，但不得把并发传导到业务库。

8. **统计库自行建立索引**  
   staging/事实表可自由增加 `(run_id, kb_id, stat_date)`、`(stat_date, kb_id)`、watermark 等组合索引。页面查询需要的 target-date/run 索引也只调整统计库。

9. **抽取缓存复用于重试**  
   collector 失败时复用相同 `run_id + source_cutoff` 的 staging，不重新访问业务库。staging 至少保留到 run 全部成功或超过重试期限。

10. **读取压力保护**  
    监测只读副本 lag、CPU 和查询耗时；超过阈值暂停下一批或动态降低 batch size。每日任务优先，历史 backfill 进入低优先级队列并设置时间窗。

如果业务库现有索引无法支持高效范围读取，这属于必须接受的源端约束。统计系统应通过降低读取频率、增量游标、低峰调度、批次节流和统计侧持久化减少影响，而不是推动业务表为统计功能承担额外写放大。

`EXPLAIN`/慢查询分析在这里仅用于理解现有执行计划、选择更合适的已有访问路径，不意味着修改业务索引。

#### 5.5.9 数据一致性和发布

共享事实层后，必须解决“什么时候一批数据对页面可见”：

1. run 开始时冻结 `source_cutoff`；
2. 所有 extractor 使用同一 cutoff；
3. collector 输出先标记 `building`；
4. validator 检查必需指标、行数、分子分母、日期完整性；
5. 通过后一次性更新 metric watermark；
6. 页面只读取 published watermark；
7. partial run 只发布成功且通过校验的 metric，不更新失败 metric。

建议校验：

- `rag_queries <= total_queries`；
- `hit_queries <= rag_queries`；
- `zero_chunk_queries <= rag_queries`；
- 比率在 0～100；
- 文档分布各桶和等于总数；
- 日期行数等于请求范围；
- KB 数量异常波动告警；
- 事实层与源表抽样对账。

#### 5.5.10 迁移路线

推荐 4 个迭代：

**迭代 A：观测与止血**

- collector 级 SQL 耗时和调用数；
- Top 10 `EXPLAIN ANALYZE`；
- run 内维度缓存；
- N+1 修复；
- 明确只读副本并发预算。

**迭代 B：查询事实 staging**

- `stage_query_event`；
- 迁移 dashboard、retrieval 和相关 user_behavior；
- 对比新旧结果双写；
- 目标：`subtask_contexts` 每 run 只扫描一次。

**迭代 C：文档事实 staging/日快照**

- `stage_document`、`fact_document_daily`；
- 迁移 doc_management、content_quality、sys_ops、prometheus、health；
- 目标：健康度不再逐日回扫文档表。

**迭代 D：增量与 DAG**

- watermark 和迟到数据修正；
- 有限 fan-out；
- 原子发布；
- backfill 低优先级分区重算；
- 删除短期 staging 或保留作重试缓存。

每个迭代都应采用 shadow run：

```text
旧 collector 输出
新事实层输出
-> 同一日期/KB/指标逐项 diff
-> 连续 7～14 天无不可解释差异
-> 切读新结果
-> 最后删除旧扫描路径
```

#### 5.5.11 验收基准

使用至少三档数据量：

| 档位 | KB | 文档 | 查询事件/30 天 |
| --- | ---: | ---: | ---: |
| 小 | 100 | 10,000 | 100,000 |
| 中 | 2,000 | 500,000 | 10,000,000 |
| 大 | 10,000+ | 5,000,000+ | 100,000,000+ |

记录：

- 全量 run 墙钟时间；
- 每类 extractor 和 metric group p50/p95；
- 业务只读副本 CPU/IO/lag；
- 扫描行数与物理读取；
- 统计库写入量和索引大小；
- worker 峰值内存；
- backfill 30 天耗时；
- 单 collector 重试耗时；
- 新旧结果 diff。

只有当“总耗时下降且副本峰值负载不升高、结果完全对账”时，才算优化成功。单纯通过加并发缩短墙钟时间不应作为验收。

#### 5.5.12 按文件实施步骤与配套文档、SQL、测试数据修改

本次优化不只是修改 Runner。设计文档、统计库 DDL、ORM、测试数据、验证脚本和运维说明必须在同一变更中保持一致。

##### 实施前置：确定统计库 Schema 的唯一事实来源

当前仓库存在一处需要先解决的不一致：

- `docs/plans/kb-stat-design.md` 写明统计库使用独立 Alembic、版本为 018，并给出 `cd knowledge_runtime && uv run alembic -c alembic.ini ...`；
- 当前代码树中未找到 `knowledge_runtime/alembic.ini`、独立统计库 Alembic env 或对应 versions；
- 当前可见的 Schema 来源是 `knowledge_engine/knowledge_engine/stat/models/` 和完整 SQL `docs/plans/kb-stat-schema.sql`；
- `knowledge_engine/stat/models/base.py` 又明确将 StatBase 与业务库迁移隔离。

实施前必须二选一并写入设计文档：

1. **推荐：建立独立统计库迁移链路**  
   在统计子系统下维护独立 Alembic 配置、versions 和 `kb_stat_alembic_version`；ORM 是结构定义，migration 是升级路径，完整 SQL 是全新部署快照。

2. **如果项目决定不引入 Alembic**  
   明确 `kb-stat-schema.sql` 是唯一部署入口，并为每次升级提供独立、可回滚的增量 SQL。不能继续保留不存在的 Alembic 命令说明。

不要把统计表迁移放进 `backend/alembic`。统计库与业务库必须继续隔离。

##### 步骤 1：修改设计文档 `docs/plans/kb-stat-design.md`

新增“共享抽取与事实层”章节，至少包含：

- 业务库零侵入约束：只读、零 DDL、零索引调整、零业务代码配合；
- 当前逐 collector 扫描链路和优化后 DAG；
- extractor、staging、daily fact、collector、publisher 的职责边界；
- `source_cutoff` 和 watermark 定义；
- 全量、增量、补数、迟到数据、重试的行为；
- staging 保留和清理周期；
- 业务只读连接并发预算；
- 统计库内并发预算；
- partial run 的指标级发布规则；
- 数据一致性校验和抽样对账；
- 新增表清单、索引清单和容量估算；
- 新旧链路 shadow run、切换和回滚方法。

更新原有架构图：

```text
旧：
业务库 -> 78 collectors -> 80+ metric tables

新：
业务库（只读）
  -> extractor（并发 1～2）
  -> 统计库 staging/facts
  -> metric groups（统计库受控并发）
  -> validator
  -> metric watermark publish
  -> 现有查询服务
```

同步修正文档中的动态数字，不再手写容易过期的“79 个指标、78 个采集器、84 张表、151 个索引”。建议由校验脚本生成或在 CI 中核对；至少将数字标注为“以 registry/ORM 当前输出为准”。

设计文档还要修正以下已有说明：

- “每 collector 直接读业务库”改为只有 extractor 读取业务库；
- “每 collector 独立事务”改为 extractor 阶段、metric 阶段和发布阶段的事务边界；
- 测试数据章节增加 `legacy/fact/shadow` 三种执行模式；
- 数据库迁移章节与实际选定的迁移方式一致；
- 脚本清单增加事实抽取、性能基准和 shadow diff 工具；
- 明确 `docs/plans/kb-stat-schema.sql` 是全新安装快照，不替代生产增量升级脚本。

##### 步骤 2：新增统计库 ORM 模型

建议在 `knowledge_engine/knowledge_engine/stat/models/` 新增：

```text
facts/query_event.py
facts/query_daily.py
facts/document.py
facts/document_daily.py
pipeline/watermark.py
pipeline/extractor_run.py
pipeline/metric_publish.py
```

可先从最小集合开始：

| 表 | 第一阶段用途 | 是否持久 |
| --- | --- | --- |
| `kb_stat_stage_query_event` | 一次解析查询 JSON，供 retrieval/dashboard 复用 | 短期 |
| `kb_stat_stage_document` | 一次读取文档窄字段，供文档类指标复用 | 短期 |
| `kb_stat_source_watermarks` | 保存源表游标和 cutoff | 持久 |
| `kb_stat_extractor_runs` | 保存抽取状态、耗时、读取/写入行数 | 持久 |
| `kb_stat_metric_watermarks` | 指标级已发布版本 | 持久 |

完成 staging 验证后再引入：

```text
kb_stat_fact_query_daily
kb_stat_fact_document_daily
kb_stat_fact_document_change（只有现有源字段能可靠推导变更时）
```

所有统计 ORM 模型必须：

- 继承 `StatBase`，不能混入业务 ORM metadata；
- 使用确定的唯一键保证重试幂等；
- 包含 `source_cutoff` 或可关联 extractor run；
- 按查询条件声明统计库组合索引；
- 避免存储查询正文、文档正文等敏感内容；
- 对 `query_hash` 使用稳定规范化算法并记录 hash version；
- 明确清理策略，避免 staging 被现有 prune 遗漏。

同步更新：

- `knowledge_engine/knowledge_engine/stat/models/__init__.py`；
- 必要的 `facts/__init__.py`、`pipeline/__init__.py`；
- `runner.prune_old_runs()` 的表发现与删除规则。

需要特别注意：当前 prune 假设统计指标表都有 `run_id`。持久 daily fact 和 source watermark 不一定按 run 清理，必须单独定义保留策略，不能被通用 `DELETE ... WHERE run_id IN (...)` 错删，也不能永久无界增长。

##### 步骤 3：修改 SQL 创建脚本 `docs/plans/kb-stat-schema.sql`

该文件是完整建库快照，必须同步加入：

- staging 表；
- daily fact 表；
- extractor run 表；
- source/metric watermark 表；
- 统计库组合索引；
- 表和字段注释；
- 当前准确的表数、列数、索引数、生成日期和 schema version；
- 建表依赖顺序；
- staging/fact 的清理说明。

建议将新增 DDL 分成清晰区块：

```sql
-- Pipeline control tables
-- Staging tables
-- Persistent fact tables
-- Metric publish/watermark tables
-- Existing metric result tables
-- Performance indexes
```

SQL 验证要求：

1. 空统计库执行完整 SQL 成功；
2. 所有表使用 InnoDB/utf8mb4；
3. 主键、唯一键和组合索引与 ORM 一致；
4. 重复执行策略明确：完整脚本可以要求空库，不要用 `CREATE TABLE IF NOT EXISTS` 掩盖版本漂移；
5. `SHOW CREATE TABLE` 与 ORM/预期 DDL 对比；
6. staging/fact 不引用业务库外键；
7. downgrade 或独立回滚 SQL 在测试库验证；
8. SQL 不包含任何业务表 `ALTER`。

如果完整 SQL 由 ORM metadata 自动生成，应把生成命令和脚本加入仓库，禁止手工同时维护两份易漂移结构。

##### 步骤 4：增加统计库增量升级脚本

全新建库 SQL 不能替代已有环境升级。根据前置决策：

- 若建立独立 Alembic：新增一个 revision，`upgrade()` 只创建统计库表/索引，`downgrade()` 按依赖逆序删除；验证 `upgrade head -> downgrade -1 -> upgrade head`；
- 若使用纯 SQL：新增带版本号的增量脚本，例如 `docs/plans/sql/kb-stat-019-fact-pipeline-up.sql` 和对应 down SQL，并增加 schema version 记录。

升级必须分阶段：

1. 先加新表，不改旧表读写；
2. 部署 extractor/shadow write；
3. 对账通过后切换 collector；
4. 切换 query watermark；
5. 最后在后续版本删除废弃路径。

首个版本不要删除任何旧指标表，也不要让新版本上线后立即要求完成历史 backfill。

##### 步骤 5：实现 extractor 和 FactRepository

建议新增：

```text
knowledge_engine/knowledge_engine/stat/extractors/base.py
knowledge_engine/knowledge_engine/stat/extractors/query_event.py
knowledge_engine/knowledge_engine/stat/extractors/document.py
knowledge_engine/knowledge_engine/stat/facts/repository.py
knowledge_engine/knowledge_engine/stat/pipeline.py
```

实现顺序：

1. `SourceCursor`：描述现有源字段游标，不修改源表；
2. `ExtractorContext`：run、日期范围、KB filter、cutoff、batch size；
3. Query extractor：keyset 分页、JSON 单次解析、批量写 staging；
4. Document extractor：仅读必要列、批量写 staging；
5. `FactRepository`：向 collector 提供稳定查询接口；
6. extractor run 状态和耗时落库；
7. staging cleanup；
8. watermark 原子提交。

抽取器失败时：

- run 不进入指标阶段；
- 已写 staging 保留供诊断或按 extractor-run id 重试；
- watermark 不前移；
- 不允许 collector 回退为直接全表扫描业务库，否则会重新引入双路径和不可预测负载。

##### 步骤 6：修改 Runner 和 Collector

`knowledge_engine/knowledge_engine/stat/runner.py` 分阶段改造：

```text
create run
-> resolve/freeze source cutoff
-> run extractors
-> run metric groups
-> validate
-> publish metric watermarks
-> finalize
```

Runner 需要新增：

- pipeline phase 状态；
- extractor 失败处理；
- collector 依赖检查；
- cost class 和受控并发；
- 单 collector timeout；
- shadow mode；
- legacy/fact 模式开关；
- 精确 collector retry；
- publish 前校验。

Collector 迁移按域进行：

1. `dashboard`、`retrieval`；
2. 查询相关的 `user_behavior`；
3. `doc_management`、`content_quality`、`sys_ops`、`prometheus`；
4. `lifecycle`、`collaboration`；
5. `deep_analysis` 和健康度。

每个已迁移 collector 只依赖 `FactRepository`。不要长期保留“FactRepository 无数据就直接扫描业务库”的 fallback；shadow 期可以同时运行旧、新两套并比较，但切换完成后删除旧路径。

##### 步骤 7：修改 `scripts/kb_stat_test_data.py`

该脚本继续只向测试业务数据表灌数据，**不直接伪造 staging/fact 数据**。这样才能验证 extractor 的正确性。

建议新增参数：

```text
--pipeline-mode legacy|fact|shadow
--profile correctness|small|medium|large
--events-total N
--batch-size N
--late-events N
--update-ratio FLOAT
--delete-ratio FLOAT（仅现有软删除字段允许时）
--keep-staging
```

新增固定数据场景：

1. 跨日期边界：截止日 23:59:59 和次日 00:00:00；
2. 同一 KB 多模式查询；
3. JSON 新旧路径共存；
4. `knowledge_id` 缺失、非法或 null；
5. 零分块、命中、未命中、采纳、未采纳；
6. 重复 query hash；
7. 迟到事件写入历史日期；
8. 文档启停、索引状态、摘要状态和更新时间变化；
9. 空 KB、小样本 KB、大 KB；
10. extractor 中断后重试。

`clean()` 修改：

- 清理测试 run 对应 staging；
- 清理测试 extractor run、metric watermark；
- 对持久 facts 只删除测试 KB/date 分区；
- 不依赖“所有统计表都有 run_id”的假设；
- 清理前解析并显示精确目标，避免误删非测试数据。

`status()` 增加：

- source 测试数据量；
- staging 行数；
- fact 分区和 watermark；
- extractor 状态；
- legacy/fact/shadow 最近 run；
- 新旧结果 diff 摘要。

`--trigger-collect` 输出不能再写固定“80 collectors、2～5 分钟”，改为从 registry 读取实际数量，并显示 extractor/metric 各阶段耗时。

##### 步骤 8：修改 `scripts/kb_stat_seed_kb.py`

该脚本面向已有 KB，风险高于批量测试脚本。建议：

- 增加 `--pipeline-mode`，默认 `shadow` 或由配置决定；
- 明确只写现有测试记录，不修改 KB 原有文档内容；当前脚本会更新已有 `knowledge_documents.chunks/summary`，需要改成创建带测试前缀的测试文档，或保存原值并可可靠恢复；
- seed 输出 source event id 范围，便于验证 keyset/cutoff；
- clean 同时清理该 KB 的 staging/fact 测试分区和 watermark；
- 增加截止边界、迟到事件、重复查询和状态变化场景；
- 禁止直接向 fact/staging 插入“期望结果”。

如果无法保证恢复已有文档的原始 `chunks/summary`，不应继续在真实 KB 上执行该更新路径。

##### 步骤 9：修改 `scripts/kb_stat_verify.py`

端到端校验扩展为三路：

```text
源业务测试数据
  -> legacy collector result
  -> fact pipeline result
  -> Python expected result
```

必须新增检查：

- extractor rows read/written 与预期一致；
- 同一源行只进入 staging 一次；
- 重试不产生重复 staging/fact；
- watermark 只在成功后前移；
- extractor 失败时指标不发布；
- partial metric 不覆盖旧 watermark；
- legacy 与 fact 的每个 metric schema/row diff；
- 7 天窗口恰好 7 天；
- 迟到事件只重算受影响分区；
- staging 清理后持久 fact 和已发布指标仍可查询；
- backfill 不污染每日增量 watermark；
- 业务库测试前后 schema 完全不变。

为避免只验证非空，diff 应比较：

- 行键集合；
- int 精确值；
- float 容差；
- null/zero 语义；
- 日期和时区；
- source run/watermark。

##### 步骤 10：新增性能基准脚本

不要把百万级性能数据全部塞进日常正确性脚本。建议新增：

```text
scripts/kb_stat_benchmark.py
```

功能：

- 生成 small/medium/large 统计负载；
- 分别运行 legacy、fact、shadow；
- 输出 extractor、metric group、总耗时；
- 输出源查询数、源 SQL 时间、统计库写入行数；
- 输出 worker 峰值内存；
- 输出每个指标 diff；
- 生成 JSON/Markdown 报告；
- 可设业务只读最大并发和 batch size；
- 默认仅测试环境可运行，要求显式 `--confirm-test-environment`。

基准脚本不得对业务表执行 DDL，也不能自动建议或创建业务索引。

##### 步骤 11：修改 backfill 与运维脚本

`scripts/kb_stat_backfill.py` 增加：

- `--pipeline-mode`；
- `--priority`；
- `--batch-size`；
- `--resume-from-watermark`；
- `--rebuild-facts`；
- `--dry-run`；
- 日期/KB 分区进度；
- 失败后从 extractor/metric phase 恢复。

Backfill 应复用持久事实分区：

- 分区已存在且 watermark 一致时不重新访问业务库；
- 只有显式 `--rebuild-facts` 才重抽；
- 低优先级执行；
- 不推进实时增量 watermark，除非显式发布并通过校验。

`scripts/kb_stat_verify.py`、`kb_stat_test_data.py`、`kb_stat_seed_kb.py` 和 backfill 共用测试标识、清理和 pipeline-mode 工具，避免四套不同的删除逻辑。

##### 步骤 12：测试与发布顺序

推荐提交/发布拆分：

1. **文档与观测**  
   修正 `kb-stat-design.md`；增加 collector/extractor timing，不改变结果。

2. **统计库 Schema**  
   ORM、增量升级脚本、完整 `kb-stat-schema.sql`、upgrade/downgrade 测试。

3. **Query staging shadow**  
   extractor + query staging + dashboard/retrieval shadow collector。

4. **测试工具**  
   test data、seed KB、verify、benchmark、cleanup/status。

5. **Query fact 切换**  
   连续 7～14 天 diff 通过后切换 retrieval/dashboard。

6. **Document fact 与健康度**  
   文档 staging/daily fact、健康度专项迁移。

7. **受控 DAG 与发布 watermark**  
   有限并发、指标级发布、精确重试。

8. **删除旧扫描路径**  
   所有 domain 对账后删除直接扫描 fallback 和废弃代码。

每个阶段的完成定义：

- 设计文档、ORM、完整 SQL、增量升级脚本一致；
- 正确性测试通过；
- shadow diff 通过；
- 业务库 schema hash 前后不变；
- 源查询次数和副本负载不高于基线；
- downgrade/回滚步骤已实测；
- cleanup 不残留测试 staging/fact/watermark；
- 统计页仍能读取旧的已发布指标。

### 5.6 P1：任务重试粒度不准确

Backend retry 先找失败 collector，再只取其 domain，重跑整个失败 domain。它不是 collector 级重试，且为了寻找 run 用 `list_runs(limit=200)` 扫描最近 200 条；更老任务会丢失原日期/KB filter，进而可能重跑“今天的全量任务”。

建议 Runtime 提供 `GET /runs/{id}`，并让 retry 请求携带精确 `collector_names`；若原 run 不存在则返回 404，不得用默认日期/全量范围兜底。

### 5.7 P2：stale run 只在下一次采集开始时清理

若 worker 崩溃后长期没有新任务，任务会永久显示 running，前端一直 10 秒轮询。应增加独立 beat watchdog，或让任务列表查询识别超时状态。

## 6. 查询与页面性能

### 6.1 当前请求模型

批量接口已经从“每指标一个 HTTP 请求”改成“每 section 一个请求”，但不是整页一个请求：

- 管理页：metric list 1 次、dashboard 1 次、quality alert 独立请求、每个核心 domain 1 次；展开高级视图后每个高级 domain/type 再 1 次。
- 详情页：metric list 1 次、dashboard 1 次、health score 1 次、三个核心 type group 约 3 次；高级视图展开后约再 3 次。
- 每个 batch 在 Runtime 内仍逐个执行各 metric 的 SQL，只减少了 HTTP 往返，没有减少 DB query 数。

### 6.2 建议

#### 首屏接口

为两个页面分别定义 BFF 式响应：

```text
GET/POST KB detail summary:
  snapshot + health + 8~12 core metrics + data freshness

GET/POST admin summary:
  platform totals + 4 KPI + health distribution + alerts
```

高级指标继续懒加载。不要把 50～80 个指标塞进一个超大响应。

#### 前端缓存与取消

- metric list 是低频元数据，可缓存 5～30 分钟；
- 同 scope/filter/run 的请求使用 React Query/SWR 去重；
- 日期改变时使用 `AbortController` 真正取消旧请求，而不仅是忽略结果；
- 输入日期先本地编辑，点击“应用”后统一刷新，避免改开始日期和结束日期分别触发整页请求；
- 保留旧数据并显示 refreshing，减少页面闪空。

#### 统计库索引

当前很多表只有单列 `run_id`、单列 `kb_id`，而热点查询是组合条件：

```text
run_id + kb_id
target_date + kb_id + run_id
stat_date + run_id
status + id
```

文档计划中已有部分新增组合索引，但 ORM 定义与计划并不完全一致。应以实际生产 DDL 为准做 `EXPLAIN ANALYZE`，重点验证：

- `kb_stat_runs(status, id)`；
- target-date 指标表 `(target_date, kb_id, run_id)`；
-普通 KB 指标表 `(run_id, kb_id)`；
- daily dashboard `(stat_date, run_id)`；
- collector runs `(run_id, status)`。

避免盲目为约 80 张表全部加索引；写放大和 prune 成本也要衡量。

#### 趋势查询

当前 target-date 指标每次用子查询 `GROUP BY target_date, kb_id; MAX(run_id)` 去重。可在采集完成时更新 watermark/current 表，查询直接按日期读取，避免每次扫描历史 runs。

#### 缓存键与失效

统计是离线快照，非常适合缓存：

```text
cache key = scope + kb_id + metric_names + start + end + resolved watermark
```

新 run 完成后只失效受影响 metric/domain/KB。不要只按“最新全局 run id”失效，否则局部重跑会冲掉全部缓存。

## 7. 数据指标体系建议

建议将指标分成四层，避免“采集字段即产品指标”：

| 层级 | 用途 | 示例 |
| --- | --- | --- |
| 事实 | 可重复聚合的原始日事实 | query_count、hit_count、zero_chunk_count、document_state_count |
| 比率 | 同口径分子/分母 | hit_rate、adoption_rate、index_success_rate |
| 诊断 | 帮助定位原因 | chunk 分布、慢查询、索引失败原因 |
| 综合/行动 | 面向用户的结论 | health score、风险等级、建议动作 |

每个指标元数据至少应包含：

- 业务定义、公式、单位；
- 分子和分母；
- 时间语义（事件发生时间/创建时间/更新时间/快照日）；
- scope（平台/KB/用户）；
- 空值与零值含义；
- 数据延迟、最小样本量；
- 越高越好/越低越好；
- 可见角色；
- 数据 owner 和版本。

### 健康分建议

当前健康分为：

```text
30% 文档 30 天活跃率
+ 30% 当前索引成功率
+ 20% 启用率
+ 20% 摘要覆盖率
```

问题：

- “文档更新”不等于知识被使用；
- 摘要覆盖率可能是系统处理能力，不完全是 KB owner 可控质量；
- 空 KB 为 null 合理，但小 KB 波动极大；
- 没有检索命中、零分块、内容新鲜度等结果指标；
- 权重没有版本和解释。

建议把“内容健康”和“使用效果”拆开，不要合成唯一总分；如果保留总分，响应和 UI 都显示 `score_version`、样本量和四项原值。

## 8. 推荐实施顺序

### 第一阶段：可信度止血（P0，优先）

1. 修复 collector import，移除静默 `ImportError`。
2. 统一日期半开区间并补充边界测试。
3. 引入 metric/collector 级 run 选择，禁止局部 run 污染全局最新值。
4. partial run 仅使用已成功 collector 的数据。
5. 修正“检索活跃天数”和去重率命名/公式。

验收标准：

- registry expected = registered，无 missing；
- 任意单域/单 KB 重跑后，其他页面指标不变；
- 7 日筛选只产生 7 个自然日；
- 次日 00:00 不落入前一日；
- 所有卡片可追溯到 source run、stat date、collector status。

### 第二阶段：任务可运营

1. 后端 backfill job 和真实进度；
2. 精确 collector retry 与 run detail API；
3. 独立 stale watchdog；
4. 采集耗时、扫描量、失败率告警；
5. 明确只读副本并发预算。

### 第三阶段：性能

1. 基于生产慢 SQL/EXPLAIN 优化读取方式；组合索引只增加在统计库；
2. 建日事实层，合并重复源表扫描；
3. 增量 health/document state；
4. watermark/current 表；
5. 页面首屏接口、缓存、懒加载和请求取消。

### 第四阶段：产品体验

1. 将详情页默认指标降到 8～12 个；
2. 每个比率显示样本量与截至时间；
3. 健康分拆分“内容健康/使用效果”；
4. 异常卡片直接给可执行建议；
5. 后端元数据统一控制可见性、类型和优先级。

## 9. 建议补充的验证与监控

### 自动化测试

- collector registry 完整性测试；
- MetricSpec、表、collector 三方一致性测试；
- 日期边界和时区测试；
- full/domain/KB/retry run 的选取测试；
- partial run 某 collector 失败时的回退测试；
- 详情页与管理页契约测试；
- 100 KB、1 万 KB 场景的查询基准。

### 线上指标

- run queue wait / duration / success / partial / failed；
- collector p50/p95 duration、rows scanned/written；
- source DB query duration 和 replica lag；
- stat API p50/p95、SQL 数、返回大小、缓存命中率；
- 页面请求数、首屏可用时间、日期切换时间；
- 数据新鲜度（now - latest successful watermark）；
- missing metric / empty result / partial data 次数。

### 数据对账

每天抽样 5～10 个 KB，将统计库结果与业务库直接 SQL 对账：

- 文档数、有效文档数、存储；
- 查询量、命中数、零分块数；
- 新增文档；
- 健康分四个分项。

对账结果本身应成为任务页的一项质量状态。

## 10. 最终判断

架构基础可继续演进，不建议推倒重来。当前最大问题不是图表样式，而是“采集器是否真的运行、日期到底包含哪一天、某张卡片取的是哪次任务”的可证明性。先把 registry、日期和数据版本三个基础问题修好，再做事实层、缓存和首屏优化，投入产出最高。
