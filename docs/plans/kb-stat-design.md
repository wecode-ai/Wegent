---
sidebar_position: 50
title: 知识库统计功能设计文档
---

# 知识库统计功能

## 1. 功能概述

知识库统计功能为平台管理员和知识库运营人员提供知识库使用的全方位数据洞察，包括检索效果、内容质量、用户行为、系统性能等 **79 个统计指标**（78 个采集器，因 `period_and_daily` 是合并采集器产出两个指标），覆盖 10 个领域。

### 两个统计入口

| 入口 | 路径 | 数据范围 | 指标数 |
| --- | --- | --- | --- |
| **管理统计页** | Admin → 知识库统计 Tab | 全平台所有 KB | 79 |
| **KB 详情统计页** | 知识库详情 → statistics 子 Tab | 单个 KB 内部 | 41 |

### 技术架构

统计功能分为两个独立的子系统：**数据采集**（定时任务，离线）和 **数据展示**（在线查询），共享统计库但互不依赖。

#### 数据采集流程（Celery 定时任务，每日 03:07 北京时间）

```
┌──────────────────────────────────────────────────────────────┐
│                    数据采集子系统                             │
│                                                              │
│  ┌──────────────┐     ┌──────────────────┐                  │
│  │ Backend       │     │ knowledge_runtime │                  │
│  │ celery beat   │────▶│  Celery worker    │                  │
│  │              │     │  (kb_stat 队列)   │                  │
│  │ crontab:      │     │                  │                  │
│  │  每日 03:07   │     │  ┌─────────────┐ │                  │
│  │  collect_all  │     │  │ Redis 分布锁 │ │                  │
│  │  每周一 04:13 │     │  │ SET NX EX   │ │                  │
│  │  prune_old    │     │  └──────┬──────┘ │                  │
│  └──────────────┘     │         │        │                  │
│                       │         ▼        │                  │
│                       │  ┌─────────────┐ │                  │
│  ┌──────────────┐     │  │knowledge_   │ │     ┌──────────┐ │
│  │ 业务库(只读)  │◀────│  │engine stat  │─┼────▶│ 统计库   │ │
│  │ kinds        │ 读取 │  │ collectors  │ │写入 │ kb_stat_*│ │
│  │ documents    │     │  │ (79个)      │ │     │ (84张表) │ │
│  │ subtask_ctx  │     │  └─────────────┘ │     └──────────┘ │
│  │ members      │     └──────────────────┘                  │
│  │ share_links  │                                           │
│  └──────────────┘                                           │
│                                                              │
│  特性: 双库分离(不侵入主业务) / 故障隔离(每collector独立事务)  │
│        分布式锁(防并发) / 超时恢复(soft_time_limit)          │
└──────────────────────────────────────────────────────────────┘
```

#### 数据展示流程（在线查询，用户访问时实时）

```
┌──────────────────────────────────────────────────────────────┐
│                    数据展示子系统                             │
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐   │
│  │  Frontend    │    │   Backend    │    │knowledge_     │   │
│  │  Next.js     │    │   FastAPI    │    │runtime        │   │
│  │              │    │   :8000      │    │FastAPI :8200  │   │
│  │  管理统计页   │───▶│              │───▶│               │   │
│  │  Admin Tab   │    │  HTTP 代理   │    │ /internal/    │   │
│  │              │    │  (鉴权+过滤) │    │  kb-stat/*    │   │
│  │  KB详情统计   │    │              │    │               │   │
│  │  statistics  │    │  /admin/     │    │  KbStatQuery  │   │
│  │  子 Tab      │    │  knowledge-  │    │  Service      │   │
│  │              │    │  stats/*     │    │               │   │
|  │              │    │              │    │  Path A: 跨run│   │
│  │  recharts    │    │              │    │  聚合查询     │   │
│  │  图表渲染     │◀───│              │◀───│  Path B: 单run│   │
│  │  MA7/Sparkline│   │              │    │  快照查询     │   │
│  └──────────────┘    └──────────────┘    └───────┬───────┘   │
│                                                   │          │
│                                          ┌────────▼────────┐ │
│                                          │   统计库(只读)   │ │
│                                          │   kb_stat_*     │ │
│                                          │   (84张表)      │ │
│                                          └─────────────────┘ │
│                                                              │
│  特性: 批量查询(1个domain=1次HTTP) / 144个索引覆盖           │
│        表缺失容错(返回空不报500) / 503降级(统计库不可用时)    │
└──────────────────────────────────────────────────────────────┘
```

两个子系统的唯一耦合点是**统计库**（采集子系统写入，展示子系统读取），无直接代码依赖。

## 2. 统计指标体系

### 2.1 十大领域

| 领域 | 说明 | 指标数 | 类型 |
| --- | --- | --- | --- |
| dashboard | 全局总览（KB数/文档数/查询量/活跃度） | 3 | 🔵 业务 |
| kb_lifecycle | KB 生命周期（创建/规模/废弃/配置） | 6 | 🔵 业务 + 🟠 运营 |
| doc_management | 文档管理（上传/索引/分块/摘要） | 11 | 🟠 运营 |
| retrieval | 检索使用（调用频率/模式/质量） | 20 | 🟣 技术 |
| user_behavior | 用户行为（排行/偏好/参与度） | 10 | 🔵 业务 |
| collaboration | 协作权限（成员/邀请/分享/审批） | 7 | 🟠 运营 |
| deep_analysis | 深度分析（健康分/价值排行/孤儿文档） | 10 | 🟠 运营 |
| sys_ops | 系统运维（存储/附件） | 3 | 🟣 技术 |
| prometheus | 转换监控（成功率/耗时/回调） | 4 | 🟣 技术 |
| content_quality | 内容质量（瘦文档/新鲜度/重复） | 5 | 🟠 运营 |

### 2.2 指标类型标识

每个指标卡片标题旁标注类型图标：
- 🔵 **业务**：回答"系统有_value 吗？趋势如何？"
- 🟠 **运营**：回答"内容质量如何？缺什么？该补什么？"
- 🟣 **技术**：回答"快不快？准不准？系统健康吗？"

### 2.3 时序 vs 快照

| 类型 | 数量 | 响应时间选择器 | 图表 |
| --- | --- | --- | --- |
| **时序指标** (date_col ≠ null) | 22 | ✅ 动态重绘趋势折线 | Line + MA7 |
| **快照指标** (date_col = null) | 57 | ❌ 不影响（显示当前截面） | Table/Cards/Pie |

### 2.4 核心指标（30 个精选，管理页展示）

管理统计页按"点-线-榜"布局展示：

**KPI 顶栏（4 个加权聚合卡）**：
- 平台命中率 — `SUM(hit_queries)/SUM(total_queries)×100%`
- 平台采纳率 — `SUM(cited_count>0)/SUM(total_queries)×100%`
- 平台零分块率 — `SUM(zero_chunk_queries)/SUM(total_queries)×100%`
- 平台去重率 — `SUM(unique_queries)/SUM(total_queries)×100%`

**趋势图区**：
- 知识库健康度分布（堆叠面积图，百分比/绝对可切换）
- 每日查询量趋势（折线图）
- 文档上传趋势（折线图）
- KB 统计（新增/活跃，柱状图）
- 每日活跃用户（折线图）

**行动榜单区**：
- 配置异常 KB 告警列表
- 质检告警面板（5 类自动检测）

**Domain 指标区**：
- 按 10 个 domain 分组，每组带类型图标
- 每个卡片含行动指引（阈值超限自动提示）
- 51 个降级指标收入"高级视图"折叠区

### 2.5 KB 详情页核心指标（20 个精选）

- 8 张概览卡（文档数/新增/查询量/RAG/Head/直注/存储/活跃天数）+ Sparkline
- 健康分两栏（进度条横杠图 + 30 天趋势线）
- 按 RAG 技术/知识运营/业务效果三类型分组展示
- 每个卡片含行动指引 + 时间作用 badge

## 3. 数据采集

### 3.1 采集调度

统计任务由 Backend 的 Celery beat 驱动，投递到 `kb_stat` 队列，由 knowledge_runtime 的 Celery worker 消费执行。Celery 时区配置为 UTC，crontab 按北京时间换算。

| 任务 | Celery crontab (UTC) | 北京时间 | 说明 |
| --- | --- | --- | --- |
| `kb_stat.collect_all` | `crontab(hour=19, minute=7)` | **每天 03:07** | 采集所有 78 个采集器（产出 80 个指标）。beat 传 `lookback_days=1`（纯增量，只统计当天），手动触发时默认 `lookback_days=30`（回看 30 天窗口） |
| `kb_stat.prune_old_runs` | `crontab(day_of_week=6, hour=20, minute=13)` | **每周一 04:13** | 清理 400 天前的旧数据。分块删除（每批 100 个 run_id），避免长事务锁表 |

**时区说明**：Celery `timezone="UTC"`，所以 crontab 的 hour 是 UTC。北京时间 = UTC+8，反向换算：北京 03:07 → UTC 前一天 19:07，北京周一 04:13 → UTC 周日 20:13。

**任务超时与锁**：

| 参数 | 值 | 说明 |
| --- | --- | --- |
| `soft_time_limit` | 1500s (25 分钟) | 软超时，触发后 collector 循环立即中止 |
| `time_limit` | 1800s (30 分钟) | 硬超时，强制 kill worker 进程 |
| `kb_stat_lock_ttl_seconds` | 2100s (35 分钟) | Redis 分布式锁 TTL，必须 > time_limit |
| `kb_stat_stale_minutes` | 120 分钟 | running 状态超过此时间的 run 自动标记为 failed |

**防并发机制**：同一 `target_date` 的并发采集通过 Redis 分布式锁（`SET NX EX`）+ DB 级 `running` 状态检查双重防护。手动触发同一日期时返回 HTTP 409 `run_in_progress`。

### 3.2 采集执行流程

```
1. 获取 Redis 分布式锁 kb_stat:lock:{target_date}
   ↓ 锁竞争失败 → 抛 KbStatRunInProgressError → API 返回 409
2. mark_kb_stat_stale_runs() — 清理上次崩溃留下的 running 状态
3. _create_run() — 在 kb_stat_runs 表插入 running 记录
4. 遍历 78 个 collector：
   ├─ _create_collector_run() — 插入 kb_stat_collector_runs running 记录
   ├─ collector.fn() — 执行采集（读业务库 → 写统计库）
   ├─ 成功 → commit + 标记 success
   └─ 失败 → rollback + 标记 failed（不影响其他 collector）
5. _finalize_run() — 汇总状态（completed/partial/failed）
6. 释放 Redis 锁
```

### 3.3 采集架构

- **双库分离**：采集器走只读副本（`DATABASE_READONLY_URL`），不影响在线业务
- **独立统计库**：写入 `KNOWLEDGE_STAT_DATABASE_URL`（可独立部署）
- **故障隔离**：每个 collector 独立事务，单点失败不阻断全局
- **状态汇总**：completed（全成功）/ partial（部分成功）/ failed（全失败）
- **容错恢复**：`SoftTimeLimitExceeded` 正确中止；`mark_kb_stat_stale_runs` 自动标记卡死任务
- **分布式锁**：Redis `SET NX EX` + Lua release，按 `target_date` 防并发

### 3.4 关键采集器

| 采集器 | 数据源 | 输出指标 |
| --- | --- | --- |
| `collect_global_totals` | kinds + knowledge_documents + dingtalk | 全局总量 |
| `collect_period_and_daily` | subtask_contexts | 每日大盘 |
| `collect_kb_daily_stats` | subtask_contexts + knowledge_documents | KB 详情页每日时序 |
| `kb_health_score` | knowledge_documents（文档活跃度/索引/启用/摘要） | 4 维加权健康分 |
| `kb_zero_chunk_rate` | subtask_contexts.rag_result.chunks_count | 零分块率 |
| `kb_retrieval_hit_rate` | subtask_contexts.rag_result.chunks_count | 命中率 |
| `kb_config_sanity` | kinds.json 检索配置 | 配置异常检测 |

## 4. 查询服务

### 4.1 查询路径

`_fetch_one` 根据指标的 `date_col` 类型走两条路径：

**Path A（target_date 类，跨 run 聚合）**：
```sql
SELECT t.* FROM {table} t
INNER JOIN (
    SELECT target_date, kb_id, MAX(run_id) AS max_run
    FROM {table}
    WHERE run_id IN (SELECT id FROM kb_stat_runs WHERE status IN ('completed','partial'))
      AND target_date >= :start_date AND target_date <= :end_date
      AND kb_id IN (:kb_ids)
    GROUP BY target_date, kb_id
) latest ON t.target_date = latest.target_date
    AND t.run_id = latest.max_run
    AND t.kb_id = latest.kb_id
ORDER BY t.target_date LIMIT 60
```

**Path B（stat_date / 快照类，单最新 run）**：
```sql
SELECT * FROM {table}
WHERE run_id = :run_id
  [AND stat_date >= :start_date AND stat_date <= :end_date]
  [AND kb_id IN (:kb_ids)]
ORDER BY {order_by} LIMIT {limit}
```

### 4.2 Dashboard 查询

`fetch_dashboard` 根据是否有 `kb_ids` 走不同路径：
- **全局模式**：跨所有 completed run，按 `stat_date` 取每日最新 run 聚合
- **KB 模式**：从 `kb_stat_kb_daily_stats` 表查该 KB 的每日时序
- **单 run 模式**：指定 `run_id` 时查该 run 的完整快照

平台级聚合（防辛普森悖论）：
- `_fetch_platform_health_distribution`：跨 run 按 target_date 去重，按健康分级 SUM
- `_fetch_platform_retrieval_quality`：`SUM(zero_chunk_queries)/SUM(total_queries)` 事件加权

### 4.3 批量查询优化

`fetch_metrics_batch` 复用单次 run 解析 + 单 session，一个 domain 的所有指标只需一次 HTTP 请求。前端 `useMetricsBatch` 按 domain 聚合请求。

## 5. 前端展示

### 5.1 图表类型

| 图表 | 用途 | 组件 |
| --- | --- | --- |
| **LineChart + MA7** | 时序趋势（比率类叠加 7 日移动平均） | recharts LineChart |
| **BarChart** | 分类对比（双 Y 轴） | recharts BarChart |
| **PieChart** | 截面分布（环形+中心总量） | recharts PieChart |
| **HealthDistributionChart** | 堆叠面积图（百分比/绝对可切换） | recharts AreaChart |
| **Sparkline** | KPI 卡迷你趋势线 | recharts AreaChart |
| **DataTable** | 明细列表 | HTML table |

### 5.2 数据平滑与置信度

- **7 日移动平均（MA7）**：比率类指标自动叠加 MA7 虚线，平滑长尾 KB 毛刺
- **low_confidence 置信度**：当日查询量 <5 的 KB 标记为低置信度，LineChart 渲染灰色空心点
- **时间作用 badge**：时序指标标"近 N 天滑动"，快照指标标"当前截面"

### 5.3 行动指引引擎

每个 MetricCard 根据阈值自动生成行动建议：
- 零分块率 >30% → "查看知识覆盖缺口"
- 健康分 <50 → "检查文档活跃度和索引成功率"
- 瘦文档率 >50% → "清理空文件或修复解析失败"
- 配置异常 → "修正检索配置（threshold=0/top_k=1）"

阈值定义集中在 `thresholds.ts`，action-hints 和 QualityAlertPanel 共享同一来源。

## 6. 环境变量配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `KB_STAT_ENABLED` | `true` | 总开关，false 时 API 返回 503 |
| `KB_STAT_PRUNE_ENABLED` | `true` | 清理任务开关，false 时永久保留历史数据 |
| `KB_STAT_WORKER_ENABLED` | `true` | Celery worker 子进程开关 |
| `KB_STAT_AUTO_MIGRATE` | `false` | 启动时自动执行 alembic upgrade head（生产环境建议手动执行迁移） |
| `KNOWLEDGE_STAT_DATABASE_URL` | （回退到 DATABASE_URL） | 专用统计库连接 |
| `DATABASE_READONLY_URL` | （回退到 DATABASE_URL） | 业务库只读副本连接 |
| `KNOWLEDGE_STAT_LOOKBACK_DAYS` | `30` | 手动触发时的回看窗口 |
| `KNOWLEDGE_STAT_RETENTION_DAYS` | `400` | 数据保留期（天），<=0 永久保留 |
| `KB_STAT_DOMAINS` | （空=全部） | 逗号分隔的采集域过滤器 |
| `KB_STAT_STALE_MINUTES` | `120` | 卡死 run 的超时阈值（分钟） |
| `KB_STAT_LOCK_TTL_SECONDS` | `2100` | 分布式锁 TTL（秒，>time_limit） |
| `NEXT_PUBLIC_KB_STAT_ENABLED` | `true` | 前端功能开关 |

## 7. API 端点

### 7.1 knowledge_runtime 端点（`/internal/kb-stat/*`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 统计库连通性 + 开关状态 |
| POST | `/dashboard` | Dashboard 聚合数据 |
| POST | `/metrics/{name}` | 单指标查询 |
| POST | `/metrics/batch` | 批量指标查询（一次 HTTP 取 N 个指标） |
| GET | `/metrics/list` | 指标元数据列表（含 date_col/chart_hint/description） |
| GET | `/runs` | 采集运行历史（分页+状态过滤） |
| GET | `/runs/{run_id}/collectors` | 单次运行的采集器明细 |
| POST | `/runs/trigger` | 手动触发采集（409 防重） |

### 7.2 Backend 端点（代理层）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/admin/knowledge-stats/dashboard` | 管理统计 Dashboard |
| POST | `/admin/knowledge-stats/metrics/{name}` | 管理统计单指标 |
| POST | `/admin/knowledge-stats/metrics/batch` | 管理统计批量 |
| GET | `/admin/knowledge-stats/metrics/list` | 指标列表 |
| GET | `/admin/knowledge-stats/runs` | 运行历史 |
| POST | `/admin/knowledge-stats/runs/trigger` | 触发采集 |
| POST | `/admin/knowledge-stats/runs/{run_id}/retry` | 重试失败采集器 |
| POST | `/knowledge-bases/{kb_id}/stats/dashboard` | KB 详情 Dashboard |
| POST | `/knowledge-bases/{kb_id}/stats/metrics/batch` | KB 详情批量 |
| POST | `/knowledge-bases/{kb_id}/stats/metrics/{name}` | KB 详情单指标 |

## 8. 运维

### 8.1 手动触发采集

```bash
# 方式 1：通过 API
curl -X POST http://localhost:8200/internal/kb-stat/runs/trigger \
  -H "Authorization: Bearer $INTERNAL_SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"target_date": "2026-07-22", "triggered_by": "manual_cli"}'

# 方式 2：通过脚本
cd knowledge_engine
set -a && . ../knowledge_runtime/.env && set +a
.venv/bin/python ../scripts/kb_stat_backfill.py --date 2026-07-22 --via direct
```

### 8.2 历史回填

```bash
cd knowledge_engine
set -a && . ../knowledge_runtime/.env && set +a
.venv/bin/python ../scripts/kb_stat_backfill.py --start-date 2026-06-01 --end-date 2026-06-30
```

### 8.3 测试数据管理

提供两个脚本用于灌入测试数据：

#### 8.3.1 批量测试数据（`kb_stat_test_data.py`）

创建测试知识库并灌入全量源数据，适合验证采集流程和前端联调。

```bash
cd knowledge_engine
set -a && . ../knowledge_runtime/.env && set +a

# 灌入测试数据（默认 5 个测试 KB × 30 天，含检索/文档/成员/分享/钉钉）
.venv/bin/python ../scripts/kb_stat_test_data.py seed --kbs 5 --days 30 --trigger-collect

# 查看测试数据概况
.venv/bin/python ../scripts/kb_stat_test_data.py status

# 清理所有 __test__ 前缀的测试数据（源表 + 统计表）
.venv/bin/python ../scripts/kb_stat_test_data.py clean

# 自定义规模
.venv/bin/python ../scripts/kb_stat_test_data.py seed --kbs 10 --docs 8 --queries 20 --days 60

# 只灌某个域的源数据
.venv/bin/python ../scripts/kb_stat_test_data.py seed --domain retrieval
```

参数说明：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--kbs` | 5 | 创建的测试 KB 数量 |
| `--docs` | 4 | 每个 KB 的文档数 |
| `--queries` | 6 | 每天 KB 的检索记录数 |
| `--days` | 30 | 时间跨度（天） |
| `--target-date` | 今天 | 目标采集日期 |
| `--domain` | all | 限制灌入的域（retrieval/content/collaboration/dashboard/sys_ops/lifecycle/deep_analysis/user_behavior/prometheus） |
| `--trigger-collect` | 关 | 灌入后自动触发采集（同步执行，约 2-5 分钟） |

灌入的数据特征：
- **零分块率趋势**：从 30% 逐渐降到 10%（模拟内容持续优化效果）
- **注入模式混合**：RAG 检索 60% / 直接注入 20% / KB Head 20%
- **延迟分布**：100ms~3000ms 随机（模拟 P50/P90 分布）
- **文件类型多样**：pdf/docx/md/xlsx/pptx 混合，80% 索引成功 / 15% 失败 / 5% 等待
- **配置多样化**：score_threshold 0/0.3/0.5/0.8，top_k 1/3/5/10（覆盖 kb_config_sanity 检测）

#### 8.3.2 指定知识库灌入（`kb_stat_seed_kb.py`）

为**已有的真实知识库**灌入完整的检索测试数据，适合验证 KB 详情页统计。支持 `seed`（灌入）和 `clean`（清理）两个子命令。

```bash
cd knowledge_engine
set -a && . ../knowledge_runtime/.env && set +a

# 为 KB id=148 (2026071301-note) 灌入 30 天检索数据
.venv/bin/python ../scripts/kb_stat_seed_kb.py seed --kb-id 148 --days 30 --queries 15

# 清理该 KB 的所有 __test__ 测试数据（源表 + 统计表）
.venv/bin/python ../scripts/kb_stat_seed_kb.py clean --kb-id 148
```

参数说明：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--kb-id` | （必填） | 目标知识库 ID |
| `--days` | 30 | 时间跨度（天） |
| `--queries` | 15 | 每天灌入的检索记录数 |

`seed` 灌入内容：
- **subtask_contexts**：每天 N 条检索记录（30 天 ≈ 450 条），含完整的 type_data JSON：
  - `rag_result`（query/chunks_count/latency_ms/restricted_mode）
  - `adoption_result`（cited_count — 覆盖采纳率）
  - `kb_head_result`（document_ids — 覆盖 RAG 验证率）
  - `extracted_text`（chunks[].score — 覆盖检索相关性分数分布）
  - `selected_documents`（覆盖指定文档使用率）
- **resource_members**：4 种角色（Owner/Maintainer/Developer/Reporter）+ 1 个 RestrictedAnalyst
- **share_links**：2 个分享链接
- **knowledge_documents**：更新 chunks JSON（含 items[].score）和 summary
- **tasks**：2 个绑定该 KB 的任务

`clean` 清理范围：
- `subtask_contexts`：`__test__sc_kb{id}_*` 的检索记录
- `share_links`：`__test__kb{id}_link_*` 的分享链接
- `tasks`：`__test__task_kb{id}_*` 的任务
- `resource_members`：该 KB 下测试用户的成员关系
- `users`：`__test__*` 的测试用户
- 统计库：所有 `__test__` 前缀触发的 run 及其关联数据

灌入完成后需手动触发采集：
```bash
.venv/bin/python ../scripts/kb_stat_backfill.py --date 2026-07-23 --via direct
```

#### 8.3.3 数据覆盖情况

灌入后采集的数据覆盖情况（以 KB 148 为例）：

| 表状态 | 数量 | 说明 |
| --- | --- | --- |
| 有数据 | 76 张表 | 覆盖全部核心检索/内容/用户/协作指标 |
| 无数据（语义正确） | 5 张表 | kb_config_sanity（配置正常）/ orphan_doc_alert（文档都被引用）/ cross_org_access（同 namespace）/ retrieval_latency（已删除）/ doc_folder_depth（无文件夹） |

覆盖的 JSON 路径：

| JSON 路径 | 覆盖的指标 |
| --- | --- |
| `$.knowledge_id` | 所有 per-KB 指标 |
| `$.rag_result.query` | 查询去重率（per-day stat_date 时序） |
| `$.rag_result.chunks_count` | 零分块率、命中率（per-day stat_date 时序） |
| `$.rag_result.latency_ms` | 慢查询率 |
| `$.rag_result.injection_mode` | 检索模式分布、RAG/Head 比 |
| `$.adoption_result.cited_count` | 采纳率（per-day stat_date 时序） |
| `$.kb_head_result` | RAG 验证率 |
| `extracted_text.chunks[].score` | 检索相关性分数分布、低分率（per-day stat_date 时序） |

> **注意**：以下 10 个指标已从 `target_date`（截面快照）改为 `stat_date`（per-day 时序），每次采集写 30 天 daily 行：
> - 检索类：零分块率、命中率、采纳率、去重率、低分率、相关性分数分布（6 个）
> - 质量/生命周期类：瘦文档率、KB 规模分布、健康分、废弃率（4 个）
>
> 前端可从单次最新 run 获取完整 30 天趋势（走 Path B 查询）。两个测试脚本都已同步灌入完整的源数据（含 `chunks[].score`、分散的 `created_at` 等）。

### 8.4 数据库迁移

```bash
cd knowledge_runtime
KNOWLEDGE_STAT_DATABASE_URL=mysql://... \
  uv run alembic -c alembic.ini upgrade head    # 升级
  uv run alembic -c alembic.ini current          # 查看当前版本
  uv run alembic -c alembic.ini downgrade -1     # 回滚一步
```

### 8.5 日志

采集任务日志写入 `knowledge_runtime/logs/kb_stat_worker.log`。

### 8.6 开关操作矩阵

| 场景 | 配置 |
| --- | --- |
| 完全关闭 | `KB_STAT_ENABLED=false` + `KB_STAT_WORKER_ENABLED=false` |
| 暂停采集但保留查询 | `KB_STAT_WORKER_ENABLED=false` |
| 永久保留历史数据 | `KB_STAT_PRUNE_ENABLED=false` |
| 隐藏前端入口 | `NEXT_PUBLIC_KB_STAT_ENABLED=false` |
| 最小数据保留 | `KB_STAT_PRUNE_ENABLED=true` + `KNOWLEDGE_STAT_RETENTION_DAYS=90` |

## 9. 数据库设计

- **82 张 ORM 表**（+ 1 张 alembic 版本表 = 84 张物理表）
- **719 列**
- **122 个 ORM 声明索引 + 29 个迁移创建的复合/优化索引 = 151 个索引**
- 引擎：MySQL 8.0+ / InnoDB / utf8mb4
- 版本表独立：`kb_stat_alembic_version`（与业务库的 `alembic_version` 分离）
- alembic 版本：018

完整建表语句见同目录 `kb-stat-schema.sql`。

## 10. 脚本工具

| 脚本 | 用途 |
| --- | --- |
| `scripts/kb_stat_test_data.py` | 批量测试数据管理（seed/clean/status），创建测试 KB 并灌入全量源数据 |
| `scripts/kb_stat_seed_kb.py` | 指定知识库灌入完整检索数据（覆盖所有 JSON 路径，适合验证 KB 详情页） |
| `scripts/kb_stat_backfill.py` | 历史数据回填（按日期范围逐日触发采集） |
| `scripts/kb_stat_verify.py` | 端到端校验（灌数据→采集→对比期望值） |
| `scripts/gen_metric_specs.py` | 从 query.py 生成 metric_spec.py（codegen） |
| `scripts/verify_metric_specs.py` | 校验 metric_spec 与 query.py 等价性 |
