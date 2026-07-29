---
sidebar_position: 50
title: 知识库统计功能设计文档
---

# 知识库统计功能

## 1. 功能概述

知识库统计功能为平台管理员和知识库运营人员提供知识库使用的全方位数据洞察，包括检索效果、内容质量、用户行为、系统性能等 **71 个统计指标**（71 个采集器），覆盖 10 个领域。

### 两个统计入口

| 入口 | 路径 | 数据范围 | 指标数 |
| --- | --- | --- | --- |
| **管理统计页** | Admin → 知识库统计 Tab | 全平台所有 KB | 73 |
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
│  │ documents    │     │  │ (73个)      │ │     │ (76张表) │ │
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
│                                          │   (76张表)      │ │
│                                          └─────────────────┘ │
│                                                              │
│  特性: 批量查询(1个domain=1次HTTP) / 121个索引覆盖           │
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
| retrieval | 检索使用（调用频率/模式/质量） | 16 | 🟣 技术 |
| user_behavior | 用户行为（排行/偏好/参与度） | 10 | 🔵 业务 |
| collaboration | 协作权限（成员/邀请/分享/审批） | 7 | 🟠 运营 |
| deep_analysis | 深度分析（健康分/价值排行/生命周期） | 8 | 🟠 运营 |
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
| **快照指标** (date_col = null) | 56 | ❌ 不影响（显示当前截面） | Table/Cards/Pie |

### 2.4 核心指标（30 个精选，管理页展示）

管理统计页按"点-线-榜"布局展示：

**KPI 顶栏（3 个加权聚合卡）**：
- 平台命中率 — `SUM(hit_queries)/SUM(total_queries)×100%`
- 平台采纳率 — `SUM(cited_count>0)/SUM(total_queries)×100%`
- 平台零分块率 — `SUM(zero_chunk_queries)/SUM(total_queries)×100%`

**趋势图区**：
- 知识库健康度分布（堆叠面积图，百分比/绝对可切换）
- 每日查询量趋势（折线图）
- 文档上传趋势（折线图）
- KB 统计（新增/活跃，柱状图）
- 每日活跃用户（折线图）

**Domain 指标区**：
- 按 10 个 domain 分组，每组带类型图标
- 每个卡片含行动指引（阈值超限自动提示）
- 指标列表由 `/metrics/list` 动态返回并直接平铺展示（无折叠/高级视图）；
  `KB_STAT_ADVANCED_ENABLED=false` 时只返回 15 个基本 metric，`true` 时返回全部 71 个

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
| `kb_stat.collect_all` | `crontab(hour=19, minute=7)` | **每天 03:07** | 采集所有 71 个采集器（产出 71 个指标）。beat 传 `lookback_days=1`（纯增量，只统计当天），手动触发时默认 `lookback_days=30`（回看 30 天窗口） |
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
2. mark_kb_stat_orphaned_runs() — 清理同日期已失去锁的 running 状态
3. mark_kb_stat_stale_runs() — 清理其他超时 running 状态
4. _create_run() — 在 kb_stat_runs 表插入 running 记录
5. 遍历 71 个 collector：
   ├─ _create_collector_run() — 插入 kb_stat_collector_runs running 记录
   ├─ collector.fn() — 执行采集（读业务库 → 写统计库）
   ├─ 成功 → commit + 标记 success
   └─ 失败 → rollback + 标记 failed（不影响其他 collector）
6. _finalize_run() — 汇总状态（completed/partial/failed）
7. 释放 Redis 锁
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

#### 3.4.1 用户指标的时间边界口径

两个用户域 collector 不使用每日 beat 的 `lookback_days=1` 增量窗口，而是各自有固定口径：

- **`user_pattern_evolution`**：固定 6 个月趋势快照，范围为
  `[effective_end_date - 6 months, effective_end_date)`（含开始、不含结束）。每个 run
  生成完整 6 个月快照，`date_col=None`。排他结束边界确保历史回采不读取目标日之后的数据。
- **`user_participation_summary`**：当前仍有效资源的「截至统计日累计参与快照」，四类身份
  （`is_creator`/`is_uploader`/`is_retriever`/`is_member`）**只设置排他结束边界
  `created_at < effective_end_date`**，不设开始边界（累计快照，否则历史参与者会错误丢失身份）。
  成员只统计 `entity_type='user' AND status='approved'` 的直接用户成员（排除 group/department
  实体成员）；四个来源均排除 `user_id IS NULL`。

> **历史回采限制**：`user_participation_summary` 基于业务表当前状态（`is_active=1`、当前仍存在的
> KB/文档/成员），只能排除目标日之后创建的记录，**不承诺还原目标日当时已删除或已移除的数据**。
> 在不修改业务表、无业务变更历史表的前提下，这是可实现的最高精度。

### 3.5 业务库零侵入原则

统计功能对业务库保持零侵入：只允许只读查询，不修改业务表，不增加字段、
生成列、索引、触发器或锁表，也不要求业务写入链路维护统计字段。所有统计
表与索引仅位于独立统计库。采集器统一经 `readonly_session` 连接专用只读
副本（`DATABASE_READONLY_URL`），即使采集查询较慢也只影响统计任务自身，
不波及主库在线业务。

> 历史上曾规划过 "shadow/fact pipeline"（把业务库 JSON 预提取到统计库
> staging 表再由 collector 切读），用于在共享业务库场景下保护主库。在
> 当前 "从库专供统计" 的部署前提下，该机制要解决的问题已不存在，且其
> shadow 阶段为半成品（collector 并未真正切读 staging），相关代码、表与
> 配置已整体移除以避免维护负担。如未来部署变为共享业务库，应重新评估
> 采集器对业务库的查询效率，而非恢复此半成品管道。

## 4. 查询服务

### 4.1 查询路径

`_fetch_one` 根据指标的 `date_col` 走两条路径：`date_col` 非 `None`（`target_date` 或
`stat_date`）走跨 run 聚合，`date_col is None`（快照）走单最新 run。

**Path A（target_date / stat_date 类，跨 run 聚合）**：
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

> `stat_date` 指标走与 Path A 完全同构的跨 run 聚合（按 `stat_date`/`kb_id` 取每个日期的
> 最新成功 `run_id`），区别仅是分组列名为 `stat_date`。beat 每日 `lookback_days=1` 只写当天
> 1 行，查询时跨 N 个成功 run 拼出 N 天趋势。只有 `date_col is None` 的快照指标走 Path B。

**Path B（快照类，`date_col is None`，单最新 run）**：
```sql
SELECT * FROM {table}
WHERE run_id = :run_id
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

指标卡行动提示的阈值统一定义在 `thresholds.ts`。

## 6. 环境变量配置

> **服务列说明**：统计功能跨三个服务协作——
> - **backend**（FastAPI :8000 + Celery beat）：对外 API 鉴权代理层 + 定时调度
> - **knowledge_runtime**（FastAPI :8200 + Celery worker）：采集执行 + 指标查询
> - **frontend**（Next.js :3000）：统计仪表盘 UI
>
> 同名变量在不同服务可能含义不同（如 `KB_STAT_ENABLED` 在 backend 控制 API/beat，在
> runtime 控制采集执行），下表按服务分别标注。变量写在对应服务的 `.env`（参考各服务
> `.env.example`）。

### 6.1 功能开关

| 变量 | 服务 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `KB_STAT_ENABLED` | backend | `false` | 总开关。false 时统计 API 返回 503、beat 移除采集/清理任务。新部署默认关闭，需显式置 true |
| `KB_STAT_ENABLED` | knowledge_runtime | `false` | HTTP 层 + 采集执行开关。false 时 /internal/kb-stat/* 返回 503、已入队的 collect 任务跳过。需与 backend 保持一致 |
| `KB_STAT_PRUNE_ENABLED` | backend | `false` | 清理任务开关。false 时移除每周清理 beat，永久保留历史数据。需与 runtime 保持一致 |
| `KB_STAT_PRUNE_ENABLED` | knowledge_runtime | `false` | /health 上报实际生效值（与 backend 同步） |
| `KB_STAT_ADVANCED_ENABLED` | backend | `false` | 指标分级开关。false 时 beat 投递 collect 任务传 `advanced_enabled=false`，只采集 14 个基本 collector。需与 runtime 同名变量一致 |
| `KB_STAT_ADVANCED_ENABLED` | knowledge_runtime | `false` | 采集 + 查询分级。false 时 collect_all 只跑基本 collector（采集耗时 ~20min→~3min）、`/metrics/list` 只返回 15 个基本 metric、dashboard 不返回平台命中率/采纳率/零分块率/健康度分布等高级聚合字段；true 开启全部 71 指标。需与 backend 一致 |
| `KB_STAT_WORKER_ENABLED` | knowledge_runtime | `false` | Celery worker 子进程开关（main.py 拉起内嵌 worker）。需显式置 true 才会消费 kb_stat 队列 |
| `NEXT_PUBLIC_KB_STAT_ENABLED` | frontend | （未设置=关闭） | 前端功能开关。**构建时**内联替换，仅显式置 `true`/`1` 启用；未设置时 Tab 隐藏，与 backend/runtime 默认关闭一致 |
| `NEXT_PUBLIC_KB_STAT_ADVANCED_ENABLED` | frontend | （未设置=基本） | 前端分级开关（**构建时**）。false 时只渲染基本指标分组；`/metrics/list` 已服务端过滤，此开关主要控制高级分组容器是否渲染。与后端不一致也不报错（最多多/少几个空分组标题） |

### 6.2 数据库与连接

| 变量 | 服务 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `DATABASE_URL` | backend / knowledge_runtime | 必填 | 业务主库连接（backend 读写、runtime 采集的回退数据源） |
| `KNOWLEDGE_STAT_DATABASE_URL` | knowledge_runtime | （回退到 DATABASE_URL） | 专用统计库连接。生产强烈建议独立，避免分析查询干扰业务 |
| `DATABASE_READONLY_URL` | knowledge_runtime | （回退到 DATABASE_URL） | 业务库只读副本连接，采集器经此读取。生产强烈建议指向专用从库 |
| `KNOWLEDGE_RUNTIME_URL` | backend | `http://localhost:8200` | knowledge_runtime 地址，backend 代理统计请求至此 |
| `INTERNAL_SERVICE_TOKEN` | backend / knowledge_runtime | 必填（两端须一致） | 服务间鉴权 token。runtime 启动时 fail-fast 校验非空 |
| `CELERY_BROKER_URL` | backend / knowledge_runtime | （回退到 REDIS_URL） | Redis broker。backend 的 beat 投递任务、runtime 的 worker 消费 + 分布式锁均依赖此 |

### 6.3 采集行为

| 变量 | 服务 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `KNOWLEDGE_STAT_LOOKBACK_DAYS` | knowledge_runtime | `30` | 手动触发采集的回看窗口（天）。每日 beat 传 `lookback_days=1` 纯增量，不受此影响 |
| `KNOWLEDGE_STAT_RETENTION_DAYS` | knowledge_runtime | `400` | 数据保留期（天）。<=0 永久保留（建议同时 `KB_STAT_PRUNE_ENABLED=false`） |
| `KB_STAT_DOMAINS` | knowledge_runtime | （空=全部） | 逗号分隔的采集域过滤器，限制只跑部分域 |
| `KB_STAT_STALE_MINUTES` | knowledge_runtime | `120` | 卡死 "running" run 的自动标记失败阈值（分钟） |
| `KB_STAT_LOCK_TTL_SECONDS` | knowledge_runtime | `2100` | 采集分布式锁 TTL（秒，=time_limit 1800 + 300 缓冲） |

### 6.4 指标分级清单

`KB_STAT_ADVANCED_ENABLED=false` 时只采集/暴露**基本**指标，`true` 时全部开启。
权威清单见 `knowledge_engine/stat/tiers.py`（`BASIC_COLLECTORS` / `BASIC_METRICS`）；本节为同步快照，改分级请同步 `tiers.py` 与本表。

**基本 collector（14 个，按域）**：

| 域 | 基本 collector |
| --- | --- |
| dashboard | `global_totals`、`period_and_daily`、`kb_daily_stats` |
| deep_analysis | `kb_growth_curve` |
| doc_management | `kb_avg_doc_length`、`doc_index_failure_rate` |
| kb_lifecycle | `kb_size_distribution`、`kb_creation_trend`、`kb_abandon_rate` |
| content_quality | `kb_thin_doc_rate`、`duplicate_doc_suspect` |
| retrieval | `rag_vs_head_ratio`、`kb_active_users` |
| sys_ops | `storage_usage` |

**基本 metric（15 个）**：上述 collector 产出的 metric——dashboard 域 3 个 collector 产出 4 个（`global_totals`、`period_totals`、`daily_dashboard`、`kb_daily_stats`），其余 11 个 collector 各产出 1 个，共 15。

> 注：`kb_daily_stats` 是 KB 详情页 dashboard 的内部表，由 dashboard 端点直接查询，**不经 `/metrics/list` 暴露**。故 `/metrics/list` 基本模式返回 14 个 metric（15 减去 `kb_daily_stats`）。

**高级 = 其余**：71 个 collector 中的其余 57 个、71 个 queryable metric 中的其余 57 个，仅在 `KB_STAT_ADVANCED_ENABLED=true` 时采集与暴露。已从基本挪到高级的典型：`kb_health_score`（管理页健康评分/健康度分布趋势 + 详情页健康评分）、`doc_upload_trend`（管理页文档上传趋势）、`kb_config_sanity`（详情页配置合理性）。

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

提供三个脚本用于灌入测试数据。所有 seed 操作均**幂等**——重复运行前会先删除该范围的 `__test__` 前缀旧数据，不会因 `share_token` / `resource_members` 唯一约束冲突而报错。

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

# 灌完后立即触发该 KB 的采集，详情页即可直接看到数据（推荐）
.venv/bin/python ../scripts/kb_stat_seed_kb.py seed --kb-id 148 --days 30 --queries 15 --trigger-collect

# 清理该 KB 的所有 __test__ 测试数据（源表 + 统计表）
.venv/bin/python ../scripts/kb_stat_seed_kb.py clean --kb-id 148
```

参数说明：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--kb-id` | （必填） | 目标知识库 ID |
| `--days` | 30 | 时间跨度（天），同时作为 `--trigger-collect` 的采集回看窗口 |
| `--queries` | 15 | 每天灌入的检索记录数 |
| `--trigger-collect` | 关 | 灌入后立即触发一次该 KB 限定的 `collect_all`（`kb_ids=[kb_id]`、`lookback_days=--days`、`triggered_by=__test__seed_kb`），使最新 run 包含该 KB，详情页无需再等下次 beat |

`seed` 灌入内容：
- **subtask_contexts**：每天 N 条检索记录（30 天 ≈ 450 条），含完整的 type_data JSON：
  - `rag_result`（query/chunks_count/latency_ms/restricted_mode）
  - `adoption_result`（cited_count — 覆盖采纳率）
  - `kb_head_result`（document_ids — 覆盖 RAG 验证率）
  - `extracted_text`（chunks[].score — 覆盖检索相关性分数分布）
  - `rag_result.selected_documents`（覆盖部分指定文档使用路径）
- **selected_documents 上下文**：`context_type='selected_documents'`、`type_data={knowledge_base_id, document_ids}`，分散到周期内多天（覆盖 `selected_documents_usage` 采集器，与生产 notebook 模式直接注入的上下文结构一致）
- **resource_members**：4 种角色（Owner/Maintainer/Developer/Reporter）+ 1 个 RestrictedAnalyst
- **share_links**：2 个分享链接
- **knowledge_documents**：新建 8 篇 `__test__doc_kb{id}_*` 测试文档，`created_at` 分散到周期内多天，含 `file_extension`/`source_type='file'`/`user_id`/`file_size`/`chunks`（含 items[].score）/`summary`（覆盖 doc_upload_trend / kb_growth_curve / kb_size_distribution）
- **tasks**：2 个绑定该 KB 的任务

`clean` 清理范围：
- `subtask_contexts`：`__test__sc_kb{id}_*` 的检索记录（含 selected_documents 上下文）
- `knowledge_documents`：`__test__doc_kb{id}_*` 的测试文档
- `share_links`：`__test__kb{id}_link_*` 的分享链接
- `tasks`：`__test__task_kb{id}_*` 的任务
- `resource_members`：该 KB 下测试用户的成员关系
- `users`：`__test__*` 的测试用户
- 统计库：所有 `__test__` 前缀触发的 run（含 `--trigger-collect` 产生的 `__test__seed_kb` run）及其关联数据

灌入完成后需触发采集，详情页才能读到该 KB 的数据（详情页只读最新 run）。两种方式：
- **推荐**：灌入时直接带 `--trigger-collect`，一步完成 seed + 该 KB 限定采集。
- **手动**：灌入后再跑 `kb_stat_backfill.py`（可带 `--kb-id` 限定单 KB，更快）：
```bash
.venv/bin/python ../scripts/kb_stat_backfill.py --date 2026-07-23 --kb-id 148 --via direct
```

#### 8.3.3 数据覆盖情况

灌入后采集的数据覆盖情况（以 KB 148 为例）：

| 表状态 | 数量 | 说明 |
| --- | --- | --- |
| 有数据 | 75 张表 | 覆盖全部核心检索/内容/用户/协作指标 |
| 无数据（语义正确） | 3 张表 | kb_config_sanity（配置正常）/ cross_org_access（同 namespace）/ doc_folder_depth（无文件夹） |

覆盖的 JSON 路径：

| JSON 路径 | 覆盖的指标 |
| --- | --- |
| `$.knowledge_id` | 所有 per-KB 指标 |
| `$.rag_result.chunks_count` | 零分块率、命中率（per-day stat_date 时序） |
| `$.rag_result.injection_mode` | 检索模式分布、RAG/Head 比 |
| `$.adoption_result.cited_count` | 采纳率（per-day stat_date 时序） |
| `$.kb_head_result` | RAG 验证率 |

> **注意**：以下 7 个指标已从 `target_date`（截面快照）改为 `stat_date`（per-day 时序）：
> - 检索类：零分块率、命中率、采纳率（3 个）
> - 质量/生命周期类：瘦文档率、KB 规模分布、健康分、废弃率（4 个）
>
> 采集采用每日增量：beat 传 `lookback_days=1`，每个 run 只写当天 1 行；查询时走 Path A
> 同构的跨 run 聚合（按 `stat_date` 取每个日期的最新成功 run）拼出 N 天趋势，而非从单个
> run 读取 30 天。两个测试脚本已同步灌入完整的源数据（含 `chunks[].score`、分散的
> `created_at` 等）。

### 8.4 数据库迁移

统计库 schema 由 `docs/plans/kb-stat-schema.sql` 建表脚本维护（权威快照），**不使用
alembic 维护统计类表格**：

```bash
# 全新空统计库：一步建表（含全部 kb_stat_* 表与索引）
mysql -u <user> -p <stat_db> < docs/plans/kb-stat-schema.sql
```

- **建表脚本即事实源**：`docs/plans/kb-stat-schema.sql` 是统计库结构的权威定义，新库
  直接执行即可得到当前完整 schema（已反映指标增删，如已下线的 5 张表不再包含）。
- **表结构变更流程**：修改 `docs/plans/kb-stat-schema.sql`；已有统计库执行对应的增量
  DDL（或重建库后回填历史数据）。
- **不走 alembic**：统计库不纳入 alembic 迁移链，无 `upgrade`/`downgrade`。`backend/alembic`
  属于业务库迁移，禁止放入任何 KB-stat 统计表。

### 8.5 日志

采集任务日志写入 `knowledge_runtime/logs/kb_stat_worker.log`（同时仍走 root handler 进入 `info.log`，未禁用传播）。

**日志路由**：`knowledge_runtime/core/logging.py` 的 `setup_kb_stat_worker_logging` 在每次采集启动时（由 `stat_tasks._ensure_worker_logging` 调用）创建一个专用 `FileHandler`，挂到 `knowledge_engine.stat` 与 `knowledge_runtime.tasks.stat_tasks` 两个 logger 上并 `setLevel(INFO)`。`knowledge_engine.stat.runner` 等子 logger 的日志经传播写入该文件，便于单独跟踪采集进度而无需在合并日志里 grep。

**记录内容**（每次 `collect_all` 一条 run 汇总 + 每个 collector 一条结果）：

- 每个 collector 的成功/失败（`runner.py` 的 collector 循环）：
  - 成功：`[kb_stat] run_id=<id> collector=<name> success rows=<n> duration_ms=<ms>`（INFO）
  - 失败（异常）：`[kb_stat] run_id=<id> collector=<name> failed duration_ms=<ms> error=<msg>`（WARNING，`error` 与写库 `kb_stat_collector_runs.error_message` 一致，经 `_sanitize_error` 处理）
  - 失败（软超时）：`[kb_stat] run_id=<id> collector=<name> failed duration_ms=<ms> error=soft time limit exceeded`（WARNING，记日志后 re-raise 以触发 `stat_tasks` 的软超时处理）
- run 汇总：`[kb_stat] run_id=<id> target_date=<date> status=<completed|partial|failed> metrics_count=<rows>`（INFO，由 `runner.collect_all` 结束时输出）
- 任务包装：`[kb_stat] collect_all run_id=<id> date=<date> done`（`stat_tasks`）

**样例**（一次 71 个 collector 的采集约输出 73 条 collector 结果 + 1 条 run 汇总）：

```
2026-07-28 03:07:15 INFO  [kb_stat] worker logging initialised -> ./logs/kb_stat_worker.log
2026-07-28 03:07:18 INFO  [kb_stat] run_id=68 collector=global_totals success rows=1 duration_ms=210
2026-07-28 03:07:21 INFO  [kb_stat] run_id=68 collector=period_and_daily success rows=31 duration_ms=2850
2026-07-28 03:07:22 WARNING [kb_stat] run_id=68 collector=storage_usage failed duration_ms=12 error=(pymysql.err.IntegrityError) ...
2026-07-28 03:08:40 INFO  [kb_stat] run_id=68 target_date=2026-07-28 status=partial metrics_count=7358
2026-07-28 03:08:40 INFO  [kb_stat] collect_all run_id=68 date=2026-07-28 done
```

> 失败的 collector 单点不影响其他 collector（独立事务，rollback 后继续），run 整体状态为 `partial`；从日志可快速定位是哪个 collector 失败及原因，亦可在 `kb_stat_collector_runs` 表查每条 collector 的 `status`/`rows_written`/`duration_ms`/`error_message`。

### 8.6 开关操作矩阵

| 场景 | 配置 |
| --- | --- |
| 完全关闭 | `KB_STAT_ENABLED=false` + `KB_STAT_WORKER_ENABLED=false` |
| 基本模式（只采 14 个基本指标） | `KB_STAT_ENABLED=true` + `KB_STAT_ADVANCED_ENABLED=false`（两端一致）+ `NEXT_PUBLIC_KB_STAT_ADVANCED_ENABLED=false` |
| 全量模式（全部 71 指标） | `KB_STAT_ADVANCED_ENABLED=true`（两端一致）+ `NEXT_PUBLIC_KB_STAT_ADVANCED_ENABLED=true` |
| 暂停采集但保留查询 | `KB_STAT_WORKER_ENABLED=false` |
| 永久保留历史数据 | `KB_STAT_PRUNE_ENABLED=false` |
| 隐藏前端入口 | `NEXT_PUBLIC_KB_STAT_ENABLED=false` |
| 最小数据保留 | `KB_STAT_PRUNE_ENABLED=true` + `KNOWLEDGE_STAT_RETENTION_DAYS=90` |

## 9. 数据库设计

- 表、列和索引数量以 `StatBase.metadata` 与建库 SQL 校验结果为准，文档不
  再手写易漂移的总数
- 引擎：MySQL 8.0+ / InnoDB / utf8mb4
- 统计库 schema 由 `docs/plans/kb-stat-schema.sql` 建表脚本维护，不走 alembic

完整建表语句见同目录 `kb-stat-schema.sql`。

## 10. 脚本工具

| 脚本 | 用途 |
| --- | --- |
| `scripts/kb_stat_test_data.py` | 批量测试数据管理（seed/clean/status），创建测试 KB 并灌入全量源数据 |
| `scripts/kb_stat_seed_kb.py` | 指定知识库灌入完整检索数据（覆盖所有 JSON 路径，适合验证 KB 详情页） |
| `scripts/kb_stat_backfill.py` | 历史数据回填（按日期范围逐日触发采集） |
| `scripts/kb_stat_verify.py` | 端到端校验（灌数据→采集→对比期望值） |

> 指标元数据以 `knowledge_engine/stat/metric_spec.py` 的 `_METRIC_SPECS` 为唯一事实源
> （手写，无 codegen）。新增/修改指标直接编辑 `_METRIC_SPECS`，不再有 `gen_metric_specs.py`
> / `verify_metric_specs.py` 及 query.py 的并行 legacy 字典。
