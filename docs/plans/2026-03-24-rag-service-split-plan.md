---
sidebar_position: 1
---

# RAG 数据面拆分落地方案

## 概述

本文给出 Wegent 当前知识库 RAG 能力拆分为独立服务的落地方案。

本次方案聚焦“拆 RAG 数据面”，不拆整个知识库域。

### 状态更新（2026-04-06）

- 本文中的 `Phase 0` 已经作为历史阶段完成：`chat_shell` 不再负责 `/all-chunks` 与 `/retrieve` 的主路由决策，Backend internal RAG API 已接管该选择。
- 当前已完成的核心收敛不是“先把路由下沉到 Backend”，而是“先稳定模块边界”，即 `RuntimeSpec + RagGateway + knowledge_engine`。
- `knowledge_engine` 已经作为顶层执行库落地，承接解析、切分、embedding、storage backend、index / query / delete 等 backend-agnostic 执行逻辑。
- `knowledge_runtime` 对应的 remote contract 与 Backend 侧 adapter 已收敛；服务本体仍计划在后续分支落地，默认 rollout 目标仍以 Backend local mode 为主。
- Backend 继续保留唯一 control plane：权限、多租户、KB / Document 元数据、CRD 解析、任务编排、`direct injection` 路由决策、`restricted mediation`。
- 当前生效的主设计文档以以下内容为准：
  - `docs/specs/knowledge/2026-03-31-rag-modular-data-plane-design.md`
  - `docs/specs/knowledge/2026-04-03-rag-service-extraction-design.md`
  - `backend/app/services/rag/README.md`

### 定位说明

- 本文保留为“为什么最终没有立刻拆独立 `rag_service`”的历史背景
- 当前如果要继续推进后续阶段，应优先更新 `2026-03-31` / `2026-04-03` 两份 spec，而不是回到本文继续追加任务清单
- 文中后续出现的历史术语：
  - `rag_service`：当前对应 `knowledge_runtime`
  - `rag data plane module`：当前已经具体化为 `knowledge_engine`
  - `/all-chunks`：当前仅保留为 legacy internal surface，主入口已经收敛到 `/api/internal/rag/retrieve`

目标：
- 将解析、切分、向量化、索引、检索等重依赖能力从 Backend 主进程中解耦。
- 保留 Backend 作为控制面，继续负责权限、资源配置、元数据和任务编排。
- 为后续接入新的解析/索引模块预留边界，例如 `docling`、层级摘要索引、rerank。
- 保持 Frontend 和 `chat_shell` 的改动最小，优先复用现有内部 API 外观。

## 现状

以下“现状”描述保留 2026-03-24 制定方案时的历史背景，但已按当前实现补充修正。

当前实现具备以下特征：

- Backend 已提供面向 `chat_shell` 的统一 internal RAG 主入口：
  - `/api/internal/rag/retrieve`
  - `/api/internal/rag/kb-size`
  - `/api/internal/rag/list-docs`
  - `/api/internal/rag/read-doc`
  - `/api/internal/rag/all-chunks` 仅保留为 legacy internal endpoint
- `chat_shell` 不再自行决定 `/all-chunks` 与 `/retrieve` 的主路由，只消费 Backend internal RAG 结果，并保留自身的 direct-injection / restricted 格式化处理。
- Backend 已将 RAG 视为重模块，通过 `RAG_RUNTIME_MODE` 统一控制 local / remote 路由。
- `knowledge_engine` 已承接底层索引与检索执行；Backend local data-plane 已围绕该执行库收敛，`knowledge_runtime` remote 将在后续分支复用同一执行层。
- Backend 仍负责回写 `KnowledgeDocument.is_active/status/chunks`、摘要触发和所有 control-plane 状态机。

## 现状问题

### 1. 重依赖仍绑定在 Backend

Backend 当前依赖：
- `llama-index-core`
- `llama-index-vector-stores-*`
- `llama-index-readers-file`
- `pymilvus`

这会导致：
- Backend 镜像变重
- 启动和依赖维护更复杂
- RAG 相关问题影响主业务进程

### 2. 运行时路由决策放在 chat_shell

当前 direct injection 与 RAG retrieval 的选择逻辑主要在 `chat_shell` 的 `KnowledgeBaseTool` 中完成：
- 先调用 `/api/internal/rag/kb-size`
- 再本地做 direct injection 候选判断
- 决定调用 `/api/internal/rag/all-chunks` 或 `/api/internal/rag/retrieve`

这会导致：
- 检索策略耦合到 agent/tool 层
- 后续引入更多检索路径时，`chat_shell` 需要持续长大
- `rag_service` 无法成为真正的检索编排中心

### 3. 控制面和数据面的边界未明确

当前检索代码中同时存在：
- KB 配置解析
- Retriever / Embedding CRD 查询
- 权限/命名规则计算
- 向量检索执行

如果直接将现有实现整体搬到新服务，会把数据库依赖和控制面逻辑一并复制过去，形成双控制面。

## 方案目标

### 控制面保留在 Backend

Backend 继续负责：
- `KnowledgeBase` / `KnowledgeDocument` 元数据
- 权限与多租户控制
- Retriever / Embedding / Namespace / Group 配置解析
- 附件上传与原始存储
- 索引成功后的状态回写
- 摘要触发
- 对 `chat_shell` 暴露统一内部 API

### 数据面迁移到 `knowledge_runtime` + `knowledge_engine`

`knowledge_engine` 负责：
- 文档解析
- splitter
- embedding 调用
- vector store 读写
- document index/delete
- chunk retrieval
- 后续层级检索能力

`knowledge_runtime` 负责：
- `content_ref` 拉取
- internal auth
- 远程 request / response 协议适配
- 调用 `knowledge_engine` 执行真实 index / query / delete

### chat_shell 不直接感知底层 RAG 演进

`chat_shell` 继续面向 Backend 的知识库 API 编程，不直接连 `knowledge_runtime`。

理想调用链：

```text
chat_shell
   -> Backend internal RAG API
      -> RagGateway
         -> LocalRagGateway | RemoteRagGateway
            -> knowledge_engine | knowledge_runtime -> knowledge_engine
```

## 核心设计

### 1. 引入 RagGateway

Backend 中新增统一抽象：

- `RagGateway`
- `LocalRagGateway`
- `RemoteRagGateway`

职责：
- 屏蔽本地/远程实现差异
- 统一索引、检索、全量 chunks、删除等调用面
- 为未来检索编排下沉提供稳定入口

建议方法：
- `index_document(...)`
- `retrieve(...)`
- `delete_document_index(...)`
- `get_all_chunks(...)`
- `get_kb_runtime_info(...)`

### 2. 运行时配置由 Backend 解析后传给 `knowledge_runtime`

`knowledge_runtime` 不直接访问 Backend 数据库。

Backend 负责将以下内容解析为 runtime payload：
- storage backend 配置
- embedding model 配置
- retrieval 参数
- index owner user id
- splitter 配置

这样可以避免：
- `rag_service` 重复实现 Kind/Namespace/User 权限逻辑
- 双控制面
- 配置漂移

### 3. direct injection / retrieval 路由决策下沉

当前决策在 `chat_shell`。建议逐步下沉到 Backend 的 RAG 内部层。

推荐目标形态：

- `chat_shell` 仅发起一次“知识库检索请求”
- Backend / `RagGateway` 决定使用：
  - normal retrieval
  - all chunks
  - future hierarchical retrieval
- 返回统一结果结构给 `chat_shell`

这一步不要求首个版本就直接下沉到 `rag_service` 内部，也可以先下沉到 Backend 的 internal RAG API 层。

### 4. 保留 public API 与 internal API 分层

建议区分两类接口：

#### Public API

面向外部或通用调用，保留纯检索语义：
- `/api/knowledge/v1/retrieve`

它更适合作为：
- 显式 RAG 查询入口
- 通用外部知识检索接口

不建议首版直接将 direct injection 的策略分支暴露到这里，否则 public API 语义会混入 agent/tool 专用行为。

#### Internal API

面向 `chat_shell` / Backend 内部调用：
- `/api/internal/rag/retrieve`
- 后续可吸收 `/all-chunks` 能力

这里更适合承载：
- 路由决策
- direct injection 所需结果
- future hierarchical retrieval
- agent 专用的返回结构

## 推荐实施顺序

### Phase 0：先做检索路由下沉（已完成，保留为历史记录）

目标：
- 不立刻拆服务
- 先把 `/all-chunks` 与 `/retrieve` 的选择权从 `chat_shell` 下沉到 Backend internal RAG 层

建议改法：
- 保留 `chat_shell` 发起单一知识库查询入口
- Backend internal RAG API 新增统一请求 schema
- 在 Backend 内部完成：
  - KB size 查询
  - strategy decision
  - 走 normal retrieve 或 all-chunks
  - 返回统一 records/results 结构

这一步的收益：
- 减少 `chat_shell` 对检索策略的感知
- 为后续 rag_service 拆分创造稳定接口
- 避免未来 `hierarchical retrieval` 再次把策略堆回 `chat_shell`

当前补充说明：

- 该阶段已经完成，不再是当前实施重点。
- 当前基础重构以 `RuntimeSpec`、`RagGateway`、`LocalRagGateway` 和 `local_data_plane` 为核心。
- `summary_vector_index`、`tableRAG`、restricted mediator 迁移、remote `rag_service` 抽离，均转入后续独立 track。

### Phase 1：抽象 RagGateway

目标：
- 将 Backend 中直接依赖 `DocumentService` / `RetrievalService` 的位置改为依赖 gateway

改造范围：
- internal RAG API
- knowledge indexing task
- knowledge delete index 流程

交付结果：
- `RAG_RUNTIME_MODE=local`
- 所有行为保持不变

### Phase 2：抽 runtime config resolver

目标：
- 将 CRD/权限/资源解析与数据面执行解耦

新增内容：
- storage runtime config schema
- embedding runtime config schema
- retrieval runtime config schema
- index naming runtime payload

交付结果：
- 数据面执行不再需要直接查数据库

### Phase 3：创建 `knowledge_runtime`

目标：
- 搭建独立部署服务，只承载 remote 数据面逻辑

首版接口建议：
- `POST /internal/rag/index`
- `POST /internal/rag/query`
- `POST /internal/rag/delete-document-index`
- `POST /internal/rag/test-connection`
- `GET /healthz`

首版非目标：
- 不做用户鉴权
- 不做 CRD 解析
- 不做摘要任务

### Phase 4：Backend 接入 `RemoteRagGateway`

目标：
- Backend 通过 HTTP 调用 `knowledge_runtime`

新增环境变量建议：
- `RAG_RUNTIME_MODE=local|remote|{default,index,query,delete}`
- `KNOWLEDGE_RUNTIME_URL=http://knowledge_runtime:8200`

交付结果：
- local/remote 可切换
- 支持灰度

### Phase 5：移除重依赖

目标：
- 当 remote 模式稳定后，从 Backend 主包逐步移除 RAG 重依赖
- 评估从 `chat_shell` 中删除未实际使用的 RAG 依赖

## 第一阶段详细建议：合并 /all-chunks 到 internal retrieve

这是当前最值得先做的一步。

### 当前行为

`chat_shell` 当前会：
1. 调 `kb-size`
2. 本地判断是否 direct injection
3. direct injection 时调用 `/all-chunks`
4. 否则调用 `/retrieve`

### 建议目标

改为：
1. `chat_shell` 发起单一 internal retrieve 请求
2. Backend internal RAG 层完成 strategy decision
3. Backend 自行决定走：
   - normal retrieval
   - all chunks
4. 返回统一结果给 `chat_shell`

### 为什么应放在 Backend，而不是 chat_shell

- 检索路由是 RAG 编排逻辑，不是 agent/tool 决策逻辑
- 未来若新增：
  - hierarchical summary retrieval
  - parent-child expand
  - rerank fallback
  - keyword/vector/hybrid orchestration
  这些都不应继续堆在 `chat_shell`
- Backend 更接近后续 `rag_service` 和 gateway 边界

### 为什么不建议首版直接放到 public /api/knowledge/v1/retrieve

原因：
- public `/v1/retrieve` 当前语义是“显式检索”
- `/all-chunks` 语义更像 agent 内部的 direct injection 支持能力
- 将二者强行合并到 public API，容易让对外接口语义变混

因此推荐：
- 先合并到 internal retrieve
- 若后续确认 public API 也需要统一，再升级 public contract

## 风险

### 1. 索引命名兼容风险

当前 group/personal KB 的索引 owner 计算较特殊。

要求：
- 必须由 Backend 单点计算
- 不得在 `rag_service` 重复实现

### 2. 删除链路遗漏风险

删除文档时，必须同步删除：
- Backend 元数据
- 向量索引中的 document chunks

### 3. 返回结构兼容风险

`chat_shell` 当前依赖：
- retrieval records
- sources
- chunks
- direct injection persistence

internal retrieve 合并后必须保证返回结构兼容，避免 tool 层大改。

### 4. 大知识库全量注入风险

即使 `/all-chunks` 能力下沉，也必须保留：
- `max_chunks`
- token budget 检查
- context window 限制

## 验收标准

### 阶段一验收

- `chat_shell` 不再自己决定 `/all-chunks` 与 `/retrieve`
- `chat_shell` 使用单一 internal retrieve 入口
- 现有 direct injection 行为保持一致
- Notebook / KB 场景回归通过

### 服务拆分验收

- `RAG_RUNTIME_MODE=local|remote|{default,index,query,delete}` 可切换
- Frontend 无需改动
- `chat_shell` 无需直接对接 `knowledge_runtime`
- 文档上传、索引、检索、删除链路行为一致
- 摘要链路保持在 Backend 触发

## 执行建议

推荐按以下顺序推进：

1. 先下沉 `/all-chunks` 与 `/retrieve` 路由决策到 Backend internal RAG 层
2. 再抽 `RagGateway`
3. 再抽 runtime config resolver
4. 再建立 `knowledge_runtime`
5. 最后切 remote mode 并清理依赖

这是风险最低、收益最直接的路径。
