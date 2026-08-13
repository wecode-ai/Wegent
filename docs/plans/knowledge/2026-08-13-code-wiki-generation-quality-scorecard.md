---
sidebar_position: 5
---

# Code Wiki 生成质量回归评分表

本评分表用于比较同一仓库快照在旧、新生成策略下的结果。它不是自动发布门禁，也不能证明正文
不含敏感信息。首批固定样本为 `abtest` 与 `user-graph-ci`。

## 执行方式

1. 在更新线上 `code-wiki-ghost` 前，记录两个 Wiki 当前已发布 generation，作为 baseline。不要
   重新生成 baseline。
2. 对每个样本记录仓库 commit、执行模型完整引用、语言和 prompt 标识。任何一项不同，本轮对照
   无效。
3. 手动更新 Ghost 与 skills 静态资源对应的实际数据。
4. 在 Wiki Reader 点击“重新生成”。前端会发送 `force_full=true`，所以即使 commit 未变化也会
   从空 generation 完整生成。
5. 等待候选 generation 完成。记录失败、publish refusal、Mermaid correction 和重试；不得只
   评价最终成功页面。
6. 先采集客观指标，再由至少一名熟悉该仓库的工程师评分。评分者应逐项写证据页，不只填总分。
7. 两个样本分别下结论。若一个改善、一个退化，结论是“需要继续调整”，不能以平均分掩盖。

因此，新旧对照的实际生成确实由你们后续手动触发；代码只保证手动操作是真正的 full rebuild，
并提供固定记录方法。

## 运行身份

| 字段 | abtest baseline | abtest candidate | user-graph-ci baseline | user-graph-ci candidate |
| --- | --- | --- | --- | --- |
| Knowledge Base ID |  |  |  |  |
| Generation ID |  |  |  |  |
| Repository commit |  |  |  |  |
| Execution model namespace/name |  |  |  |  |
| Language |  |  |  |  |
| Prompt identifier | legacy | `2026-08-13-generation-quality-v1` | legacy | `2026-08-13-generation-quality-v1` |
| Started / completed at |  |  |  |  |
| Status / retry count |  |  |  |  |
| Publish or correction notes |  |  |  |  |

模型必须记录 `namespace/name`，避免同名模型或 fallback 让对照实际使用不同 provider。

## 客观指标

| 指标 | baseline | candidate | 判断 |
| --- | ---: | ---: | --- |
| 页面数 |  |  | 不是越多越好；与仓库复杂度相称 |
| 根页面数 / 最大层级 |  |  | 导航清楚，不能把复杂系统压成平铺摘要 |
| 正文字符数 |  |  | 只用于发现异常缩水或膨胀 |
| Mermaid block 数 |  |  | 有适用架构/流程却为 0 是缺陷；无固定配额 |
| Mermaid 结构 warning 数 |  |  | 已检测 warning 目标为 0；另做 Reader 渲染复核 |
| 运行耗时（任务/trace 同一时钟） |  |  | 无可靠指标时记 N/A，不单独决定质量 |
| Token / cost（可用时） |  |  | 与质量变化一起看 |

可用下面的只读 MySQL 查询采集结构与内容规模。每次只替换一个确定的 generation ID；查询不输出
正文内容。

```sql
SET @generation_id = 0;

WITH page_paths AS (
  SELECT JSON_UNQUOTE(JSON_EXTRACT(ext, '$.path')) AS page_path
  FROM wiki_contents
  WHERE generation_id = @generation_id
)
SELECT
  COUNT(*) AS page_count,
  SUM(page_path IS NOT NULL AND page_path NOT LIKE '%/%') AS root_page_count,
  MAX(
    CASE
      WHEN page_path IS NULL THEN NULL
      ELSE 1 + CHAR_LENGTH(page_path)
        - CHAR_LENGTH(REPLACE(page_path, '/', ''))
    END
  ) AS max_depth,
  SUM(page_path IS NULL) AS pathless_page_count
FROM page_paths;

SELECT
  COALESCE(SUM(CHAR_LENGTH(content)), 0) AS content_chars,
  COALESCE(SUM(
    (CHAR_LENGTH(content) - CHAR_LENGTH(REPLACE(content, '```mermaid', '')))
    / CHAR_LENGTH('```mermaid')
  ), 0) AS mermaid_blocks
FROM wiki_contents
WHERE generation_id = @generation_id;

SELECT
  id,
  generation_type,
  status,
  JSON_UNQUOTE(JSON_EXTRACT(source_snapshot, '$.commit')) AS source_commit,
  created_at,
  completed_at,
  JSON_EXTRACT(ext, '$.publishGate.warnings') AS publish_warnings,
  JSON_EXTRACT(ext, '$.publishGate.correctionPending') AS correction_pending
FROM wiki_generations
WHERE id = @generation_id;
```

`publish_warnings` 同时包含结构与 Mermaid warning；按 warning 文本分类后记录到评分表。该
字段的权威来源是 `wiki_generations.ext.publishGate`；当前运行历史 API 不暴露这些细节。如果
实际数据库不存在该字段，记为 N/A，不要猜测或修改业务数据。

Code Wiki 的层级来自 `wiki_contents.ext.path`，不是 `parent_id`；后者在增量 seed 时会被重置为
0。`pathless_page_count` 对正常 Code Wiki 应为 0，非 0 表示存在旧版无稳定路径页面，应单独
标注，不能把它们误算为根页面。

当前 `wiki_generations.created_at` 可能来自 MySQL 会话本地时区，而 completion 路径写入 naive
UTC；不得直接用这两个字段相减计算耗时。优先记录任务执行或 trace 中由同一时钟产生的 duration；
没有可靠来源时填 N/A。原始时间只用于定位 generation，这个历史时区语义应另行统一。

## 人工评分

每项按 0–4 分评价：0 缺失或严重错误，1 明显不足，2 可用但有重要缺口，3 良好，4 可作为维护
入口。每个分数必须附一条页面路径和具体事实。

| 维度 | 权重 | baseline | candidate | 证据与差异 |
| --- | ---: | ---: | ---: | --- |
| 重大组件覆盖 | 20% |  |  |  |
| 关键数据流与控制流覆盖 | 20% |  |  |  |
| 工程导航：入口、关键符号、约束、测试 | 20% |  |  |  |
| Mermaid 选择与事实准确性 | 15% |  |  |  |
| 业务/领域语义理解 | 10% |  |  |  |
| 内容密度与非重复性 | 10% |  |  |  |
| 安全与最小披露 | 5% |  |  |  |

安全项重点审阅配置、部署、集成和故障排查页面：是否出现真实 credential、个人信息、私网 IP、
内部域名或完整内部 URL；是否能改写成配置键、逻辑服务或角色。正则命中只能用于定位人工复核，
不能因“零命中”宣称确定性安全。

## 工程问题抽查

每个仓库至少准备五个只有深入理解代码才能回答的问题，baseline 与 candidate 使用同一问题集。

| 问题 | 期望源码事实 | baseline 可回答性 | candidate 可回答性 | 证据页 |
| --- | --- | ---: | ---: | --- |
| 系统入口如何到达核心业务流程？ |  |  |  |  |
| 核心数据在哪些组件间流动？ |  |  |  |  |
| 一个关键状态如何创建、迁移和结束？ |  |  |  |  |
| 修改核心行为应从哪些符号和测试开始？ |  |  |  |  |
| 最容易破坏的约束或失败路径是什么？ |  |  |  |  |

可回答性同样按 0–4 分，并同时检查答案是否能从页面引用的源码得到支持。图更好看但关系错误，应
计为退化。

## 结论模板

- `abtest`：接受 / 继续调整 / 退回；主要改善；主要退化。
- `user-graph-ci`：接受 / 继续调整 / 退回；主要改善；主要退化。
- 安全复核：未发现 / 发现待处理内容；注意这不是扫描证明。
- 总结：只有两个样本均未出现重要退化，且工程问题可回答性或图示覆盖有实质改善，才接受新
  prompt 作为默认版本。

## English Version

### Procedure

1. Before updating the deployed resources, record the currently published `abtest` and
   `user-graph-ci` generations as baselines. Do not regenerate them.
2. Record the KB ID, generation ID, repository commit, complete model namespace/name, language,
   prompt ID, timestamps, status, retries, and publish/correction notes for each baseline.
3. Manually synchronize the updated Ghost and skills to the target environment.
4. Click **Regenerate** in each Reader. The request sends `force_full=true`, so the unchanged commit
   is regenerated from an empty version.
5. Record the candidate identity and every failure, refusal, correction, and retry.
6. Collect objective metrics first, then have an engineer familiar with the repository score both
   generations against identical questions. Every score needs a page-path citation.
7. Evaluate the repositories separately. If one improves and the other regresses, continue tuning;
   do not hide the conflict in an average.

Real baseline/candidate generation is therefore a manual environment follow-up. The code guarantees
that the manual action is a full rebuild and this scorecard makes the comparison reproducible.

### Run Identity

For baseline and candidate in each repository, record:

- Knowledge Base ID and Generation ID;
- repository commit;
- execution model namespace/name;
- language and prompt identifier (`legacy` or `2026-08-13-generation-quality-v1`);
- start/completion timestamps, status, retry count, and publish/correction notes.

Always include model namespace and name so a same-name model or fallback cannot silently change the
provider between runs.

### Objective Metrics

Record page count, root-page count, maximum path depth, pathless legacy page count, body characters,
Mermaid block count, detected Mermaid structural warnings, status, reliable task/trace duration, and
token/cost data when available. More pages or text is not automatically better. Zero diagrams is a
defect only when the repository contains applicable architecture or workflow relationships.

Use the read-only SQL in the Chinese section with one explicit generation ID at a time. Code Wiki
hierarchy comes from `wiki_contents.ext.path`, not `parent_id`; incremental seeding resets
`parent_id` to zero. Normal Code Wiki generations should have zero pathless pages.

`wiki_generations.ext.publishGate` is the authoritative source for stored warnings and correction
state. The run-history API does not currently expose those details; record N/A when the field is not
present rather than guessing or mutating data.

Do not subtract `created_at` and `completed_at`: legacy writes may mix MySQL session-local time with
naive UTC. Use a duration produced by one task/trace clock, or record N/A. Treat the timestamps only
as generation-location aids until storage semantics are unified.

### Human Scoring

Score every dimension from 0 to 4: 0 missing or seriously wrong, 1 substantially inadequate,
2 usable with important gaps, 3 good, and 4 a strong maintenance entry point. Apply these weights:

| Dimension | Weight |
| --- | ---: |
| Major component coverage | 20% |
| Key data/control-flow coverage | 20% |
| Engineering navigation: entrypoints, symbols, constraints, tests | 20% |
| Mermaid selection and factual accuracy | 15% |
| Domain semantics | 10% |
| Density and non-redundancy | 10% |
| Security and minimum disclosure | 5% |

For security, inspect configuration, deployment, integration, and troubleshooting pages for real
credentials, PII, private IPs, internal domains, or complete internal URLs. Confirm that safe content
uses keys, logical services, or roles instead. Pattern searches may locate candidates for human
review but a zero-match result is not deterministic proof.

### Engineering Question Sample

Prepare at least five questions per repository and use the same set for baseline and candidate:

1. How does the system entrypoint reach the core business flow?
2. How does core data move between components?
3. How is a key state created, transitioned, and completed?
4. Which symbols and tests should an engineer start with to change core behavior?
5. Which invariant or failure path is easiest to break?

Score answerability from 0 to 4 and verify every answer against cited source evidence. A visually
better diagram with incorrect relationships is a regression.

### Decision

For each repository choose **accept**, **continue tuning**, or **revert**, and list the main
improvements and regressions. Record whether human security review found content requiring cleanup,
without calling that review a scan guarantee. Adopt the prompt as default only if neither sample has
an important regression and engineering answerability or diagram coverage improves materially.
