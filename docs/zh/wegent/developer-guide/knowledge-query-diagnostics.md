---
sidebar_position: 13
---

# 知识检索耗时排查

Knowledge Runtime 的检索日志使用 `[KnowledgeTiming]` 标记。每次查询生成请求
ID；已有请求上下文时沿用该 ID。`request_id` 串联同次查询，`kb_id` 区分知识库，
上下文会传入检索工作线程，并在请求结束后恢复。

任务内发起的检索由 Backend 通过内部请求头 `X-Task-ID` 传递任务编号，所有
`[KnowledgeTiming]` 日志都会记录 `task_id`。该字段仅用于诊断，不参与权限判断；
无任务的检索记录为 `task_id=-`。

新增诊断日志只记录阶段、耗时、数量和异常类型，不记录查询正文、文档内容、
认证信息、服务 URL 或异常响应正文。原有查询计划日志继续保留。

## 阶段含义

| stage | 含义 |
| --- | --- |
| `query_total` | Runtime 整次查询耗时，包含配置解析、所有知识库检索及结果汇总 |
| `config_resolution` | 读取、校验检索所需配置 |
| `storage_backend_init` / `embedding_model_init` | 初始化检索后端及 Embedding 模型对象 |
| `retrieval_total` | 单个知识库的排队、检索及层级结果合并耗时 |
| `worker_queue` | 从提交工作线程到开始执行的等待时间 |
| `storage_retrieve` | 工作线程内执行检索的耗时 |
| `vector_store_init` | ES VectorStore 初始化耗时 |
| `query_embedding` | ES 查询向量生成耗时，包含内部重试 |
| `embedding_call` | OpenAI 兼容适配器生成查询向量的总耗时 |
| `embedding_request` | 自定义适配器单次 HTTP 调用及响应解析耗时 |
| `embedding_attempt` / `embedding_retry` | Embedding 适配器尝试序号、重试等待及异常类型 |
| `search` | ES 搜索调用耗时 |
| `result_processing` / `retrieval_result` | ES 结果处理耗时、过滤前后数量和分数阈值 |
| `hierarchical_merge` | 层级检索结果合并耗时 |
| `query_result` | Runtime 最终返回结果数 |

正常查询在 INFO 记录总耗时、配置解析、检索后端初始化、线程排队、向量请求、
ES 搜索和结果数量。阶段开始日志统一为 DEBUG；重复的 `retrieval_total`、
`storage_retrieve`、`query_embedding`，以及 `embedding_model_init`、
`result_processing`、`hierarchical_merge` 的正常完成日志也为 DEBUG。

成功或失败分别记录 `event=end`、`event=error`，并附带毫秒单位的 `duration_ms`。
所有阶段的失败都以 ERROR 记录，包括正常完成日志属于 DEBUG 的阶段。
`worker_queue` 只在工作线程开始时记录等待耗时。
各阶段可能互相包含，不能将所有耗时直接相加；仍未进入的工作线程不会产生
`worker_queue` 完成记录。

适配器重试保留原有重试条件、次数和退避策略。OpenAI SDK 自身的底层重试包含在
总耗时内，不单独计入适配器尝试序号。自定义适配器的重试日志对应每次 HTTP 尝试。
正常首次尝试为 DEBUG，后续尝试为 INFO，重试原因和等待时间为 WARNING。

## 查询方法

已知任务编号时，直接查该任务的全部检索阶段：

```bash
zgrep -nE '\[KnowledgeTiming\].*task_id=17042430385152( |$)' info.log.20261111-16.gz
```

在 Knowledge Runtime 的日志目录中，先按知识库和时段找到请求 ID：

```bash
zgrep -nE '\[KnowledgeTiming\].*(kb_id=157464|kb_ids=\[157464\])' info.log.20261109-15.gz
```

再用实际 ID 查询完整链路：

```bash
zgrep -nF 'request_id=实际请求ID ' info.log.20261109-15.gz
```

如果 `worker_queue` 较大，检查线程执行资源及并发任务；如果 `embedding_request`
或 `embedding_call` 较大，检查 Embedding 服务、网络及重试；如果 `search`
较大，再检查 ES。需要检查未完成阶段或重复层级时，将 Runtime 的
`KNOWLEDGE_RUNTIME_LOG_LEVEL` 设为 `DEBUG` 后复现；历史 INFO 日志无法补回
DEBUG 明细。
若候选很多、返回很少，应结合排序和分数阈值排查召回质量。

这些日志不会自动关闭已有的未关闭客户端，也不改变检索、过滤或重试策略。
`Unclosed client session` 的资源管理问题需要单独定位。
