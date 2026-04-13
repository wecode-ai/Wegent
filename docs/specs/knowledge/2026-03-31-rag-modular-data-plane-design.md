---
sidebar_position: 1
---

# Wegent RAG 模块化数据面设计

## 背景

`docs/plans/2026-03-24-rag-service-split-plan.md` 已经明确了一个方向：将 RAG 从 Backend 主进程中逐步解耦，Backend 保留控制面，重依赖能力最终迁移到独立数据面。

自该方案提出后，当前代码已经出现一个重要变化：

- `chat_shell` 到 Backend 的内部检索路由已经收敛到 `backend/app/api/endpoints/internal/rag.py`
- `chat_shell/chat_shell/tools/builtin/knowledge_base.py` 不再自行决定 `/all-chunks` 与 `/retrieve` 的主路由，只保留 tool 侧消费和本地格式化逻辑

这意味着“先把检索路由从 `chat_shell` 下沉到 Backend”这一步已经基本完成。新的问题不再是“是否继续做 Phase 0”，而是：

- 接下来是否还需要继续拆
- 应该先拆模块边界还是先拆部署边界
- 未来的 `summary index`、`tableRAG`、受限知识压缩、第三方 RAG engine 应该分别放在哪一层

## 状态快照（2026-04-06）

当前这一轮拆分已经完成推荐路线中的前四步：

- `runtime contract` 已落地
- 模块化 `rag data plane` 已落地
- `Phase 2.5` 已完成，control/data 边界已收敛
- restricted safe-summary 已迁入 Backend internal retrieval
- `knowledge_engine` 已落地为顶层 execution kernel，并承接 backend-agnostic 的 index / query / delete / storage execution
- Backend local data-plane 已通过 `knowledge_engine` 执行核心索引与检索逻辑
- `knowledge_runtime` 对应的 remote contract 与 adapter 方案已经收敛，服务本体将在后续分支接入，并复用 `knowledge_engine`

当前稳定边界如下：

- `shared` 只负责 lightweight transport protocol
- `backend/app/services/rag/` 负责 runtime contract、gateway、runtime resolver、local/remote adapter
- `backend/app/services/knowledge/` 负责 control-plane persistence、`kb_head`、protected mediation
- `knowledge_engine` 负责真正的执行内核
- `chat_shell` 只消费 Backend internal RAG 结果，不再承担 restricted 二级模型压缩编排

当前仍属于后续路线的问题只剩：

- remote rollout / parity 继续收敛
- `summary_vector_index`
- `tableRAG`
- MCP `search`

### 术语映射

由于本文写于模块化优先阶段，文中的部分术语需要按当前实现理解：

- `rag data plane module`：当前已经具体化为 `knowledge_engine`
- “独立 `rag_service`”：当前命名下对应 `knowledge_runtime`
- `/api/internal/rag/all-chunks`：当前仅是 legacy internal surface，主入口已统一收敛到 `/api/internal/rag/retrieve`

## 问题

当前实现虽然已经完成了一部分路由下沉，但仍存在以下结构性问题：

### 1. Backend 中仍混合了控制面与数据面职责

以下逻辑仍交织在 `backend/app/services/rag/`、`backend/app/services/knowledge/` 中：

- KB / Document 元数据与权限判断
- Retriever / Embedding / Summary Model 的 CRD 解析
- 附件二进制读取
- 文档解析、切片、embedding、向量索引
- direct injection / retrieval 编排
- 删除链路与状态回写

这使得 Backend 既是业务控制面，又承载数据面执行细节，边界仍不稳定。

### 2. 未来演进方向并不只有“向量检索”

已确认或高概率会出现的新能力包括：

- 文本切片后生成短总结，再基于短总结做 embedding 索引
- `tableRAG`，底层可能依赖 SQL / ClickHouse / Parquet
- 接入其它开源 RAG 实现
- 将当前 `chat_shell` 中 restricted 模式下的二级模型安全压缩逻辑迁回 Backend 或 RAG 侧

这些能力的共同点是：

- 检索产物种类会变多
- 检索路线会变多
- 执行引擎会变多

因此，仅围绕“向量库查询”组织代码已经不够。

### 3. 现在立即服务化会过早冻结错误边界

如果当前直接强行拆出独立 `rag_service`，服务接口需要立刻决定：

- 文档型与表格型数据是否共用同一协议
- summary index 是否作为独立查询路径暴露
- restricted 压缩是否属于 RAG 服务职责
- 第三方 RAG engine 的接入点在哪里

这些问题尚未在进程内模块边界上稳定下来。此时服务化会让错误边界通过 HTTP contract 固化，后续返工成本高。

## 目标

本次设计目标如下：

- 继续推进 RAG 拆分，但优先拆模块边界，不急于拆部署边界
- 明确 Backend 控制面、RAG 数据面、受限知识消费策略三者的职责边界
- 为 `summary index`、`tableRAG`、第三方 RAG engine 预留稳定落点
- 为未来独立 `rag_service` 提前定义稳定的 runtime contract
- 保持 `chat_shell` 继续只面向 Backend internal API 编程

## 非目标

本次不做以下内容：

- 不要求立即将主路径切换到 remote `knowledge_runtime`
- 不直接重写现有索引与检索实现
- 不在本次设计中决定具体使用哪一种 `tableRAG` 存储方案
- 不要求 restricted 模式在首期就从 `chat_shell` 迁出
- 不承诺与现有内部实现保持完全一比一目录映射

## 方案对比

### 方案 1：继续在 Backend 内零散重构

做法：

- 保持现有 `backend/app/services/rag/` 与 `backend/app/services/knowledge/` 结构
- 按需抽方法、拆文件、整理依赖

优点：

- 短期改动最小
- 没有额外接口设计成本

缺点：

- 无法形成未来 `rag_service` 的稳定边界
- `summary index`、`tableRAG`、第三方 engine 很快会再次把结构拉乱
- restricted 安全压缩也更容易继续散落在多处

### 方案 2：先做模块化数据面，再择机服务化

做法：

- Backend 保留控制面
- 在仓库内先形成逻辑独立的 RAG 数据面模块
- 在控制面与数据面之间引入稳定的 runtime spec 与 gateway
- restricted 压缩单独抽成消费策略层

优点：

- 可以同时解决边界清晰、能力扩展、未来服务化三个问题
- 允许先在单进程内验证契约和职责，再决定是否服务化
- 对现有 `chat_shell` 改动最小

缺点：

- 首期需要认真设计 contract，不能只做目录重组

### 方案 3：立即拆出独立 `rag_service`

做法：

- 现在就把解析、切片、embedding、索引、检索整体移到独立服务

优点：

- Backend 最快变轻
- 重依赖隔离最彻底

缺点：

- 容易过早冻结错误服务边界
- summary index、tableRAG、restricted 压缩、第三方 engine 的职责划分会持续反复
- 灰度与回退成本更高

## 选型

采用方案 2。

理由：

- 你未来最确定的变化不是“进程数量”，而是“索引族、检索路线、执行引擎”会持续扩张
- 因此先稳定模块边界，再稳定部署边界，风险最低
- 一旦 runtime contract 稳定，后续将数据面抽成独立 `rag_service` 会是自然演进，而不是第二次架构重做

## 总体设计

目标形态分为四层：

1. `knowledge control plane`，保留在 Backend
2. `rag gateway + runtime resolver`，保留在 Backend
3. `protected knowledge mediation`，保留在 Backend
4. `rag data plane module`，首期仍在同一仓库中，逻辑上独立

调用关系如下：

```text
chat_shell
  -> Backend internal RAG / knowledge APIs
     -> Knowledge control plane
        -> RagGateway + RuntimeResolver
           -> Rag data plane module
        -> ProtectedKnowledgeMediator
```

### 1. Knowledge Control Plane

该层负责：

- `KnowledgeBase` / `KnowledgeDocument` 元数据
- 权限、多租户、namespace、group / personal 访问规则
- Retriever / Embedding / Summary Model 的 CRD 解析
- 附件与原文生命周期
- 索引任务调度、状态机、失败重试、摘要触发
- 对 `chat_shell` 提供统一内部 API

该层不负责：

- 文档解析实现细节
- chunking / embedding / 索引写入
- 检索执行细节
- restricted 安全压缩的模型调用实现

### 2. RagGateway + RuntimeResolver

该层是本次拆分最关键的边界。

职责：

- 将控制面中的 CRD / 权限 / namespace / owner / model 配置解析为纯运行时对象
- 向下游暴露统一入口，不让执行层直接依赖数据库和 SQLAlchemy model
- 屏蔽 local module 与 future remote service 的差异

建议定义两类稳定 contract：

- `IndexRuntimeSpec`
- `QueryRuntimeSpec`

建议包含但不限于以下信息：

#### `IndexRuntimeSpec`

- 知识库标识与文档标识
- index owner user id
- storage backend config
- embedding model config
- splitter config
- index families 启用配置
- source type 与数据读取方式

#### `QueryRuntimeSpec`

- 查询目标知识库与文档过滤条件
- retrieval policy
- direct injection runtime budget
- 可用 index families
- rerank / fallback / expansion 开关
- restricted 模式标记

关键约束：

- 从该层往下，不再传 `db session`
- 不再传 `Kind`、`KnowledgeDocument` 等 ORM 对象
- 不在数据面重复实现 namespace / user_id / 权限规则

### 3. Protected Knowledge Mediation

该层用于承接“受权限约束的知识转换 / 压缩”，不属于标准 RAG 数据面。

职责：

- 在权限校验完成后处理 restricted 模式
- 将可检索出的原始 chunk 转换为安全摘要、redacted summary 或未来的压缩 artifact
- 统一承载当前 `chat_shell` 中 restricted 模式下的二级模型压缩逻辑

该层存在的原因：

- 它处理的是“内容允许以什么形式继续向上游流动”
- 而不是“如何建索引”或“如何查询向量库”

因此它应该放在 Backend 控制面附近，而不是混入 RAG 数据面。

### 4. Rag Data Plane Module

该层先以模块形式存在，后续整体可抽成独立 `rag_service`。

建议继续拆成四类子模块：

#### `ingestion`

职责：

- 输入原始文档或结构化数据
- 输出标准化 artifact

典型 artifact：

- normalized text
- chunks
- summary snippets
- table schema / row-set snapshot

#### `index families`

职责：

- 维护不同索引族的构建与删除能力

首期建议明确支持“多索引族并存”的抽象，而不是只围绕单一 chunk vector index 设计。

建议索引族示例：

- `chunk_vector_index`
- `summary_vector_index`
- `table_index`
- `keyword_index`（预留）

#### `retrieval orchestration`

职责：

- 根据 `QueryRuntimeSpec` 决定查询路径
- 统一执行 normal retrieval、direct injection、summary retrieval、table retrieval、hybrid retrieval
- 负责 merge、fallback、rerank、expand 等编排

#### `engine adapters`

职责：

- 适配底层执行引擎

适配目标示例：

- 现有内部实现
- `llama_index`
- 第三方开源 RAG 框架
- 未来自研执行器

要求：

- 适配层只做协议映射
- 不承载多租户、权限、namespace 等控制面规则

## 未来能力归属

### 文本切片 + AI 短总结 + summary embedding index

该能力属于数据面能力，应放入 `rag data plane module`。

建议形态：

- 在 `ingestion` 阶段生成短总结 artifact
- 将其交给 `summary_vector_index` 建索引
- 在 `retrieval orchestration` 中增加 `summary retrieval -> expand` 路径

控制面仍负责：

- 是否开启该索引族
- 使用哪个 summary model
- 何时重建索引

### restricted 模式二级模型压缩

该能力不放入数据面，放入 `protected knowledge mediation`。

理由：

- 它的本质是安全消费策略，不是检索执行策略
- 它高度依赖访问模式和输出约束
- 如果放入数据面，会把数据面污染成“检索 + 权限策略 + agent 输出 contract”的混合层

建议进一步明确以下落点：

- restricted 逻辑在 Backend internal search 编排层中执行，而不是留在 `chat_shell`
- `chat_shell` 只发起一次 `/api/internal/rag/retrieve` 请求，不再自行调用二级模型
- 数据面仍只返回原始 retrieval result；是否允许这些内容继续上浮，由 `ProtectedKnowledgeMediator` 决定

建议调用链：

```text
/api/internal/rag/retrieve
  -> RagRuntimeResolver
  -> RagGateway.query(...)
  -> local data plane retrieval
  -> raw retrieval result
  -> ProtectedKnowledgeMediator.transform(...)
  -> restricted_safe_summary response
```

restricted 模式下建议新增明确响应形态，而不是继续伪装成普通检索：

- `mode = "restricted_safe_summary"`
- `retrieval_mode = "direct_injection" | "rag_retrieval"`
- `restricted_safe_summary = {...}`
- `answer_contract`
- `message`
- `total`
- `total_estimated_tokens`

关键约束：

- 返回给 `chat_shell` 的主消费结果不再包含原始 `records`
- 原始 chunks / records 只允许在 Backend 内部用于：
  - safe summary
  - refusal 判断
  - 持久化安全产物或受限来源元信息
- restricted 持久化不存原文 chunk 内容，只存安全产物和来源索引信息

二级模型解析策略建议如下：

- `chat_shell` 可在请求中附带 `mediation_context`
- `mediation_context` 只包含当前模型身份，例如：
  - `current_model_name`
  - `current_model_namespace`
- 不传完整 `model_config`

Backend 自行解析实际模型配置，推荐优先级：

1. 当前请求携带的 `current_model_name/current_model_namespace`
2. 任务或团队默认模型
3. KB 的 `summaryModelRef`
4. 系统默认 restricted-summary model

该解析器属于 `ProtectedKnowledgeMediator` 侧能力，不属于 `RagRuntimeResolver`。

### tableRAG

该能力属于新的索引族与查询路径，不应硬塞进当前文档 chunk pipeline。

建议形态：

- 作为独立 `table_index`
- 作为独立 `table_retrieval_path`
- 底层可以接 SQL / ClickHouse / Parquet，但对上层保持统一 query contract

### 第三方开源 RAG 实现接入

该能力放在 `engine adapters`。

建议要求第三方实现适配统一接口，例如：

- `build_indexes(...)`
- `delete_document(...)`
- `query(...)`
- `fetch_for_injection(...)`

禁止让第三方实现直接侵入控制面逻辑。

## 接口建议

首期不要求完整定义所有字段，但建议围绕以下稳定接口收敛。

### Gateway 接口

```python
class RagGateway(Protocol):
    async def index_document(
        self,
        spec: IndexRuntimeSpec,
        source: IndexSource,
    ) -> IndexResult: ...

    async def delete_document_index(
        self,
        spec: IndexRuntimeSpec,
        document_ref: str,
    ) -> DeleteResult: ...

    async def query(
        self,
        spec: QueryRuntimeSpec,
        query_text: str,
    ) -> QueryResult: ...

    async def fetch_for_injection(
        self,
        spec: QueryRuntimeSpec,
    ) -> QueryResult: ...
```

### Mediator 接口

```python
class ProtectedKnowledgeMediator(Protocol):
    async def transform(
        self,
        request: MediationRequest,
    ) -> MediationResult: ...
```

### restricted internal response 约束

当 `restricted_mode = true` 时，`/api/internal/rag/retrieve` 建议返回：

- `mode = "restricted_safe_summary"`
- `retrieval_mode`
- `restricted_safe_summary`
- `answer_contract`
- `message`
- `total`
- `total_estimated_tokens`

其中：

- `restricted_safe_summary` 是最终给 `chat_shell` 透传消费的安全产物
- `retrieval_mode` 仅用于说明该安全产物来自 direct injection 还是 rag retrieval
- 不要求对外暴露原始 `records`

### mediation context 约束

为避免把完整调用配置泄露给 `chat_shell` 与 Backend 之间的 internal search 边界，建议：

- `runtime_context` 继续只承载 direct injection 路由预算
- 新增 `mediation_context`，只承载当前模型身份
- Backend 根据模型身份自行解析完整模型配置与可用性策略

### QueryResult 约束

无论底层来自 chunk retrieval、summary retrieval、table retrieval 还是 direct injection，建议统一返回：

- `mode`
- `records`
- `sources`
- `artifacts`
- `debug_info`

其中：

- `records` 面向通用检索结果
- `artifacts` 用于承载 direct injection、summary expansion、table intermediate result 等结构化产物

## 迁移策略

### Phase 1：抽出 runtime contract

目标：

- 从现有 `RetrievalService`、`DocumentService`、`knowledge/indexing.py` 中拆出运行时配置解析层

交付结果：

- 控制面负责解析 spec
- 下游执行层不再直接依赖数据库或 CRD

### Phase 2：将数据面重组为模块

目标：

- 不改变部署方式
- 先形成 `ingestion`、`index families`、`retrieval orchestration`、`engine adapters`

交付结果：

- 现有文本 RAG 路径可以跑通新边界
- `chat_shell` 无需直接感知变化

### Phase 2.5：清理 control/data 边界

目标：

- 在不引入新检索能力的前提下，将 control plane 与 data plane 的职责分离干净
- 收敛当前过渡期遗留的 legacy surface

交付结果：

- `services/rag/` 中只保留 runtime contract、gateway、local data plane execution、engine adapters
- `SubtaskContext` 持久化、`kb_head` 使用记录、restricted mediation 等 control-plane 逻辑移回 Backend control-plane 侧
- 删除链路通过统一边界进入 data plane，而不是由 `knowledge_service` 直接拼 storage backend
- `/api/internal/rag/all-chunks` 降级为 legacy internal endpoint，或并入统一 retrieve contract

当前状态补充：

- 该阶段在当前代码中已基本收敛完成
- restricted safe-summary mediation 已并入 Backend `/api/internal/rag/retrieve`
- `chat_shell` 不再本地执行 restricted 二级模型压缩，只消费 Backend 返回的 `restricted_safe_summary`

收敛原则：

- `backend/app/services/rag/retrieval_persistence_service.py` 不应继续留在 `services/rag/`
- `backend/app/services/rag/document_read_service.py` 不应继续留在 `services/rag/`
- `local_data_plane` 不应反向依赖 `knowledge/indexing.py`
- `knowledge/indexing.py`、`document_service.py`、`retrieval_service.py` 应分别收敛为清晰的 adapter / execution 职责

### Phase 3：引入 `summary_vector_index`

目标：

- 先验证“多索引族 + 多检索路径”的设计是否合理

原因：

- 相比 tableRAG，它与当前文本 RAG 更接近
- 能更低风险地验证架构扩展性

### Phase 4：引入 tableRAG

目标：

- 验证统一 query contract 能否容纳非文档型检索

要求：

- 不污染现有 chunk pipeline
- 不把 SQL / ClickHouse / Parquet 细节泄露到控制面

### Phase 5：迁移 restricted 安全压缩

目标：

- 将当前 `chat_shell` 中的 restricted 二级模型压缩逻辑收敛到 `ProtectedKnowledgeMediator`

交付结果：

- `chat_shell` 只消费受限知识结果，不再承担安全压缩模型编排职责
- restricted 响应由 Backend internal search 直接返回 `mode = "restricted_safe_summary"`
- 模型选择由 Backend 解析，不再由 `chat_shell` 透传完整 `model_config`

执行顺序说明：

- 为了避免在脏边界上继续迁移 restricted 逻辑，当前建议的实施顺序是：
  - 先完成 `Phase 2.5`
  - 再执行 `Phase 5`
  - 最后继续 `Phase 3` 和 `Phase 4`
- `Phase 3`、`Phase 4`、`Phase 5` 的编号保留为概念路线图编号，不强制要求按数字顺序实施

### Phase 6：评估独立 `knowledge_runtime`

前置条件：

- `IndexRuntimeSpec` 与 `QueryRuntimeSpec` 已稳定
- 多索引族与多检索路径已在进程内验证
- 数据面模块内部边界清晰

满足以上条件后，再将 `knowledge_engine` 所承载的数据面能力以 `knowledge_runtime` 形式继续外部化 rollout，风险最低。

## 兼容性要求

- `chat_shell` 继续只调用 Backend internal API
- Frontend 无需直接感知数据面变化
- 权限、多租户、namespace 规则仍由 Backend 单点负责
- 删除、重建、摘要触发等状态机仍由 Backend 控制

## 风险

### 1. 只做目录拆分，不做 contract 拆分

如果只是移动文件而没有引入 `RuntimeSpec`，最终仍会把数据库依赖带入执行层，无法形成稳定边界。

### 2. 把 restricted 压缩误放进数据面

这样会导致数据面混入权限消费策略，后续 tableRAG 和第三方引擎接入都会更复杂。

### 3. 把 tableRAG 塞进现有 chunk pipeline

这样会让原本清晰的文档型处理链被结构化查询逻辑污染，长期维护成本高。

### 4. 过早服务化

在 contract 未稳定前服务化，会让后续变更需要同时修改本地实现、远程协议、灰度逻辑和回退逻辑。

## 验收标准

- Backend 控制面、RuntimeResolver、ProtectedKnowledgeMediator、RAG 数据面模块的职责边界清晰
- runtime contract 可以承载 future `summary index`、`tableRAG`、第三方 engine
- `chat_shell` 不新增底层 RAG 策略分支
- 后续扩大 `knowledge_runtime` rollout 时，无需重新设计核心 contract

## 最终结论

Wegent 应继续推进 RAG 拆分，但本阶段应优先做“模块边界拆分”，而不是立即做“进程边界拆分”。

截至 2026-04-02，推荐路线 1~4 已完成；后续决策重点已经切换为 5~7。

推荐路线是：

1. 先抽 runtime contract
2. 再形成模块化数据面
3. 再完成 `Phase 2.5`，把 control/data 边界清理干净
4. 优先迁移 restricted 安全压缩到 Backend internal search
5. 再落地 `summary_vector_index`
6. 再落地 `tableRAG`
7. 最后视 contract 稳定度决定是否扩大 `knowledge_runtime` 的 remote 主路径

这样可以在不提前冻结错误服务边界的前提下，为 Backend 变轻、索引与检索能力扩展、存储多形态共存、第三方 RAG engine 接入同时铺平道路。
