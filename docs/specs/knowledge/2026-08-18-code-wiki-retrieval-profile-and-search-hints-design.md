---
sidebar_position: 6
---

# 知识库检索默认 Profile 与查询 Hints 设计

## 问题

新建知识库原先完全依赖用户和 namespace 的自动资源解析。管理员无法稳定地设定全局
检索基线，例如指定公共 retriever、embedding 模型、检索模式、混合权重、Top K 和 Score
阈值。Code Wiki 与普通知识库共用创建流程，因此这项默认值必须作用于所有新建知识库，
而不是只作用于 Wiki。

系统已有 hybrid 检索和 `SearchHints`，但工具说明需要按知识库实际检索模式引导 Agent。
尤其 vector-only 模式以原始问题作为 dense query，要求 Agent 再写 `semantic_query` 没有
实际收益；hybrid 模式则可以受益于可选的语义改写以及关键词、短语。

## 方案

增加一个系统级“知识库检索默认 Profile”。它只保存公共资源引用和检索参数，不保存或
返回 endpoint、collection、账号、密码等连接配置。所有认证用户可以读取安全的 Profile
摘要；只有管理员可以修改它。

共享创建对话框加载该 Profile 以显示默认选择。若创建者未修改检索配置，前端省略
`retrieval_config`，后端在创建时读取当前 Profile 并完成解析。这避免了前端打开后管理员
修改或删除资源时，将过期配置重新写回。若创建者修改了检索器、embedding、模式、Top K、
Score 阈值或混合权重，前端才提交该显式覆盖项。

Profile 无效、缺失或资源已删除时，后端记录原因并回退到既有自动解析。Profile 只影响
新建知识库；不会重写、删除或重建既有知识库的检索投影。

## 约束与优先级

1. `rag_config_mode=disabled` 不配置检索。
2. 未触碰的共享表单默认值省略，由当前有效 Profile 决定；无有效 Profile 时使用既有自动默认值。
3. 创建者显式提交的字段覆盖 Profile，对未提供的字段仍可从 Profile 或自动解析补全。
4. Profile 不回填或迁移已存在知识库。
5. 历史公开 URL 暂保持稳定；实现内部、存储 key 和 UI 名称使用 knowledge-base 语义。
   变更公开 URL 需要单独的弃用期和调用方迁移。

存储 key 从 `code_wiki_retrieval_profile` 迁移为
`knowledge_base_retrieval_profile`。迁移可逆；如果目标 key 已存在，保留目标值以避免覆盖
运营期间已经保存的新值。

## 检索能力与 Hints

`retrieval_capabilities` 是从知识库已保存配置派生的安全摘要，包含模式和 hint 开关，绝不
包含基础设施连接信息。所有工具和动态上下文从同一纯函数获取该摘要。

| 模式 | semantic_query | keywords / phrases | 原因 |
| --- | --- | --- | --- |
| vector | 否 | 否 | 原始 query 已作为 dense query；额外改写不值得要求 Agent 填写。 |
| hybrid | 是 | 是 | dense 改写和 sparse 提示都可能改善排序。 |
| keyword | 否 | 是 | 只使用 sparse 提示。 |
| 缺失或未知 | 否 | 否 | 安全降级。 |

`search_hints` 保持可选，使用既有 `semantic_query`、`keywords`、`phrases` 结构。服务端不
自动生成 hint，也不强制改写查询。direct injection 不执行排序检索，因此忽略 hints，且不能
因为 hints 而放弃 direct injection。

## 安全与 API

- Profile 读取要求已认证用户；管理读取和写入要求管理员。
- 响应 schema 只允许 retriever/model 引用与检索参数，防止历史错误配置泄露连接信息。
- Profile 健康状态只返回 `missing`、`valid`、`invalid` 和受限的回退原因。
- 新建知识库仍由后端校验并补全实际资源；前端展示的 Profile 不是授权凭据。

## 验证

- 覆盖 profile 完整性、单查询健康检查和 vector/hybrid/keyword capability 派生。
- 覆盖认证读取、非管理员拒绝写入以及响应不泄露密码或连接字段。
- 覆盖创建对话框：未修改 Profile 时省略 `retrieval_config`；修改后提交显式配置。
- 覆盖后端创建在 Profile 无效时走自动默认解析，避免过期引用持久化。
- 覆盖 `search_hints` 在 Notebook/MCP/运行时的透传与 direct injection 非使用路径。

## 非目标

- 不迁移、重建或重新索引已有知识库。
- 不给普通用户写全局 Profile 的权限。
- 不强制使用 hybrid 或自动生成查询 hints。
- 不在本次改变 direct injection 的路由策略。
- 不在没有弃用计划的情况下更换既有公开 API URL。

## English Version

# Knowledge Base Retrieval Default Profile and Search Hints

## Problem

New knowledge bases previously relied entirely on user and namespace automatic resolution.
Administrators need one stable baseline for public retrievers, embedding models, retrieval mode,
hybrid weights, Top K, and score threshold. Because Code Wiki uses the shared creation flow, the
profile applies to every new knowledge base, not only wikis.

## Design

The system stores an administrator-managed knowledge-base retrieval default profile containing only
public resource references and retrieval parameters. Authenticated users may read its safe summary;
only administrators may update it. An untouched shared form omits `retrieval_config`, so creation
resolves the current valid profile atomically on the backend. Explicit user changes are sent as
overrides. Missing or invalid profiles fall back to the existing automatic resolver and never rewrite
existing knowledge bases.

The persisted key is renamed from `code_wiki_retrieval_profile` to
`knowledge_base_retrieval_profile` through a reversible migration. Existing public URLs remain
stable until a separately planned caller migration.

## Search Hints

Capability metadata is a safe derived summary. Vector mode advertises no hints because the original
query is already its dense query. Hybrid advertises semantic, keyword, and phrase hints; keyword
advertises keyword and phrase hints. Hints are optional, never change direct-injection routing, and
never expose infrastructure details.

## Verification and Non-goals

Tests cover profile health, capability derivation, authorization and redaction, form omission versus
explicit override, and stale-profile fallback. This work does not reindex existing knowledge bases,
force hybrid retrieval, generate hints automatically, change direct injection, or replace public API
paths without a deprecation plan.
