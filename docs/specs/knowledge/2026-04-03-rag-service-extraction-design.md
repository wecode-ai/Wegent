---
sidebar_position: 1
---

# Knowledge Runtime 独立化设计

## 背景

`docs/plans/2026-03-24-rag-service-split-plan.md` 给出了“Backend 保留控制面，RAG 数据面逐步拆出”的总体方向。

`docs/specs/knowledge/2026-03-31-rag-modular-data-plane-design.md` 已完成进程内模块边界收敛，当前稳定基础包括：

- `RuntimeSpec`
- `RagGateway`
- `LocalRagGateway`
- `local_data_plane`

在该基础上，最初本轮曾尝试采用“先稳定服务边界，再让 `knowledge_runtime` 独立补齐执行能力”的路线。但随着 remote query 进入真实实现阶段，这条路径暴露出一个更直接的问题：

- 如果 `knowledge_runtime` 不复用现有底层执行能力，就需要在新服务中重新实现一遍解析、chunking、embedding、storage backend、query / delete 逻辑
- 一旦进入真实索引与真实检索，这种“独立重写”会快速偏离原本希望保留的 `knowledge_engine` 目标
- 为了让 `knowledge_runtime` 真正独立执行，又不能访问 Backend DB，remote contract 也必须承载更完整的运行时配置

因此本文修订后的核心方向是：

- 将跨服务协议放入 `shared`
- 保持 Backend 继续担任唯一 control plane
- 从 Backend 中抽离 RAG data-plane execution kernel，作为 `knowledge_engine`
- Backend local 与 `knowledge_runtime` remote 都依赖同一套 `knowledge_engine`
- 稳定 remote 后，再删除 Backend 原有 local 入口层

为避免与此前讨论断层，本文中的历史术语 `rag_service`，在目标形态中统一对应 `knowledge_runtime`。

## 状态快照（2026-04-06）

当前代码中已经具备以下基础：

- Backend internal retrieval 已收敛到 `backend/app/api/endpoints/internal/rag.py`
- `chat_shell` 中 `knowledge_base_search` 通过 Backend internal RAG API 完成检索
- `backend/app/services/rag/runtime_specs.py` 已提供 `IndexRuntimeSpec`、`QueryRuntimeSpec`、`DeleteRuntimeSpec` 与 `ConnectionTestRuntimeSpec`
- `backend/app/services/rag/gateway.py` 已定义 `RagGateway`
- `backend/app/services/rag/local_gateway.py` 与 `backend/app/services/rag/remote_gateway.py` 已完成 local / remote gateway 封装
- `knowledge_engine` 已经作为顶层执行库落地，承接 storage backend、embedding、query executor、document index / delete 等执行逻辑
- `knowledge_runtime` 对应的 remote contract 与 Backend 侧 adapter 已收敛；服务本体计划在后续分支接入，并复用 `knowledge_engine`
- Backend `RAG_RUNTIME_MODE` 已统一 local / remote 路由开关，并支持按 operation 切换

当前知识库 MCP 尚未提供 `search` 能力，但本轮不将其纳入拆分主线，只在后续工作中说明。

### 当前落地结论

- 本轮已经完成 `knowledge_engine` 抽离，Backend local mode 继续作为主 rollout 目标。
- `knowledge_runtime` 服务本体仍属于后续 rollout / parity 收敛工作，不是本轮主切换目标。
- `shared` 继续只承载 transport protocol；`direct injection` 与 `restricted mediation` 仍明确保留在 Backend。

## 问题

### 1. Backend 仍承载重数据面执行

虽然控制面与数据面边界已有所收敛，但当前实际执行仍在 Backend 进程内完成：

- 文档解析
- chunking
- embedding
- 向量索引写入
- 检索执行

这意味着 Backend 镜像、依赖、启动成本和故障域仍然被重 RAG 能力绑定。

### 2. 如果 `knowledge_runtime` 走“独立重写”，真实能力阶段会越来越偏离目标

当 remote 还只是占位 handler 时，“独立重写”看上去更稳；但一旦进入真实 index / query / delete：

- 需要重新接入现有向量库与 embedding 模型
- 需要复刻 `DocumentService`、storage backend、retriever 解析相关逻辑
- 需要再次处理 local / remote 语义对齐

这会让实现逐步变成“Backend 有一套真实底层，`knowledge_runtime` 再有一套相似底层”，不仅重复度高，也与“尽快形成可复用的 `knowledge_engine` 执行层”这一目标相冲突。

### 3. 文件内容传输方式会影响服务职责

索引链路中的解析、切分、embedding 都依赖原始文档内容。

如果 Backend 在每次索引时直接把文件 bytes 推给 `knowledge_runtime`：

- Backend 会重新成为大文件中转站
- 异步重试与 reindex 模型会变差
- 同一份内容会重复经过“上传存储”和“服务推送”两条链路

因此，首版必须优先稳定“内容引用 contract”，而不是只追求“是否能传得动文件”。

### 4. “拆整个 knowledge 模块”范围过大，但“抽 execution kernel”是合理边界

当前真正需要迁移的不是整个 Backend `knowledge` 模块，而是其中的 RAG data-plane execution 部分。

如果直接拆整个 `knowledge` 模块：

- 会把权限、元数据、状态机、摘要触发等 control-plane 逻辑一起卷入
- 会放大数据库、ORM、业务规则迁移范围
- 会让本轮目标从“拆服务”膨胀成“重构知识模块”

更合理的边界是只抽出 execution kernel，使其：

- 不依赖 Backend DB model
- 只消费归一化后的 runtime config
- 同时服务于 Backend local 和 `knowledge_runtime` remote

## 目标

- 将 RAG 数据面执行迁移为可独立启动的 `knowledge_runtime`
- 保持 Backend 作为唯一 control plane
- 保持 `chat_shell` 和其他消费者继续只面向 Backend 调用
- 通过 `RagGateway` 支持 local / remote 双实现切换
- 将跨服务 transport schema 放入 `shared`
- 将 Backend 当前 RAG data-plane execution 抽离为可复用的 `knowledge_engine`
- 让 Backend local 与 `knowledge_runtime` remote 共用同一套底层执行能力
- 以 `index_family` 与 `retrieval_policy` 预留 `summary_vector_index` 扩展能力

## 非目标

- 本轮不实现知识库 MCP `search`
- 本轮不让 `knowledge_runtime` 直接访问 Backend 数据库
- 本轮不把附件存储实现复制到 `knowledge_runtime`
- 本轮不将 `direct injection` 下沉到 `knowledge_runtime`
- 本轮不将 `restricted mediation` 下沉到 `knowledge_runtime`
- 本轮不拆整个 Backend `knowledge` 模块
- 本轮不实现 `summary_vector_index`
- 本轮不决定 `tableRAG` 的具体底层存储和协议

## 方案对比

### 方案 1：`shared` 轻协议 + Backend local 基本不动 + `knowledge_runtime` 独立重写

做法：

- 将 remote contract 抽到 `shared`
- Backend local 数据面只做必要的协议对齐和 remote 接入改动
- `knowledge_runtime` 参考现有 Backend 数据面语义独立实现
- Backend 通过配置决定索引/检索/删除走 local 或 remote

优点：

- 服务拆分风险最低
- local 模式回归面最小
- 灰度和回滚边界清晰
- 更容易区分“服务化问题”和“执行逻辑问题”

缺点：

- 进入真实执行阶段后会持续复制底层实现
- local / remote 语义漂移风险更高
- 与 `knowledge_engine` 目标背离

### 方案 2：先抽 execution kernel，再让 local / remote 共用

做法：

- 先从 Backend 中抽出 `knowledge_engine`
- `knowledge_engine` 只承载解析、chunking、embedding、storage backend、index / query / delete 执行
- Backend local 和 `knowledge_runtime` 都依赖这套共享实现
- Backend 继续负责 control-plane 编排与 remote contract 归一化

优点：

- 更符合“尽快形成底层可复用执行层”的目标
- `knowledge_runtime` 更容易尽快接上真实向量库
- 可以避免 runtime 为了真实 query 再重写一套底层

缺点：

- 需要当轮处理 Python 包边界
- 需要为 remote contract 补充足够的运行时配置
- 抽离边界如果过宽，容易误伤 control plane

### 方案 3：一次性切到远程 `knowledge_runtime`

做法：

- Backend 直接移除本地执行主路径
- 索引、检索、删除全部切到独立 `knowledge_runtime`

优点：

- 目标形态最直接
- Backend 最快变轻

缺点：

- 首版风险最高
- 回退困难
- 远程 contract、内容获取、鉴权、回写、观测会在同一轮同时收敛

## 选型

采用方案 2，但只抽 execution kernel，不拆整个 `knowledge` 模块。

原因：

- 继续走“独立重写”会让真实 query / delete 越做越偏
- 用户当前更重视尽快复刻底层 `knowledge_engine` 能力，而不是继续维持两套相似实现
- 真正需要复用的是 RAG execution kernel，而不是整个 `knowledge` 模块
- 只要抽取边界足够窄，仍然可以把 control-plane 稳定留在 Backend

## 总体设计

目标调用链如下：

```text
chat_shell / public API / future MCP consumers
  -> Backend knowledge control plane
     -> RagRuntimeResolver
     -> RagGateway
        -> LocalRagGateway | RemoteRagGateway
           -> knowledge_engine | knowledge_runtime -> knowledge_engine
```

### `shared` 职责

`shared` 只承载轻协议，建议放置：

- remote request / response schema
- `content_ref` schema
- internal auth header / token schema
- error code / error payload schema

`shared` 不承载：

- 文档解析逻辑
- embedding / 索引执行逻辑
- Backend 编排逻辑
- `direct injection` / `restricted mediation` 语义

换句话说，`shared` 在本轮是 transport contract 层，不是执行层。

### Backend 职责

Backend 始终保留：

- 权限、多租户、namespace、group / personal 规则
- `KnowledgeBase` / `KnowledgeDocument` 元数据
- Retriever / Embedding / Summary 等 CRD 解析
- 任务调度、状态机、失败回写、摘要触发
- `direct injection` 路由决策
- `restricted mediation`
- 对 `chat_shell` 和其他消费者暴露统一 API

迁移期内，Backend 还负责：

- 将 CRD / 元数据解析为归一化 runtime config
- 为 remote 请求补齐执行所需配置，而不是让 `knowledge_runtime` 反查 Backend DB
- 保留 local fallback 与回滚能力

Backend 不再直接承载长期演进的底层 RAG execution 细节；这些能力应沉到 `knowledge_engine`。

### `knowledge_engine` 职责

`knowledge_engine` 是本轮应落地的 execution kernel，职责包括：

- 文档解析
- splitter
- embedding
- storage backend 选择与调用
- index 执行
- query 执行
- delete document index 执行

`knowledge_engine` 必须满足：

- 不依赖 Backend ORM model
- 不读取 Backend DB
- 只消费归一化后的 runtime config 与外部传入资源
- 可被 Backend local 与 `knowledge_runtime` remote 共用

### `knowledge_runtime` 职责

`knowledge_runtime` 是新的内部执行服务，只负责 remote 数据面执行：

- 文档内容拉取
- 将 remote request 转换为 `knowledge_engine` 可执行输入
- 调用 `knowledge_engine` 执行真实 index / query / delete
- 返回协议化结果

`knowledge_runtime` 不负责：

- 权限判断
- CRD 查询与解析
- ORM / DB session 处理
- Backend 元数据回写
- `direct injection` 消费编排
- `restricted mediation`

### 关于 `knowledge_engine`

`knowledge_engine` 在修订后的方案中不再是“未来可选抽取”，而是当前应落地的窄边界 execution kernel。

它不是：

- 整个 knowledge 模块
- control plane
- 轻协议层

它只是：

- Backend local 与 `knowledge_runtime` remote 共同依赖的底层执行库

如果未来 Backend 不再保留 local mode，那么 `knowledge_engine` 可以继续只作为 `knowledge_runtime` 的内部组成部分存在；如果未来需要单独发布，再评估是否独立成 package / repo。

### 稳定边界原则

真正稳定的边界不是“服务是否独立重写”，而是：

- Backend 传递 runtime contract 和 `content_ref`
- `shared` 提供稳定 transport schema
- `knowledge_engine` 只消费归一化 runtime config，不理解数据库语义
- `knowledge_runtime` 不理解 Backend DB 与 control-plane 规则
- Backend local 与 remote 在相同 execution kernel 或相同 contract 下保持语义一致

## 内容获取设计

### 为什么不采用 Backend 直接推送文件 bytes

即使多数文件只有几 MB，直接 push 仍存在结构性问题：

- Backend 重新成为数据面中转站
- 异步重试与 reindex 难以围绕统一引用建模
- 同一份内容需要经过两次主链路搬运
- 长请求、流控、超时、补偿更复杂

因此，首版不以“直推 bytes”作为主路径。

### 采用 `content_ref` 拉取模式

索引请求只传内容引用，不直接传大文件内容。

建议定义：

```text
content_ref
  -> backend_attachment_stream
  -> presigned_url
```

### `backend_attachment_stream`

适用于当前 MySQL 或仅 Backend 可读的附件存储。

行为：

- Backend 生成内部可鉴权下载 URL
- `knowledge_runtime` 按引用回源拉取内容

意义：

- 保证兼容当前所有附件存储后端
- 不需要把附件存储实现复制到 `knowledge_runtime`

### `presigned_url`

适用于 S3 / MinIO / 其他对象存储。

行为：

- Backend 生成预签名 URL
- `knowledge_runtime` 直接读取对象存储

意义：

- 减少 Backend 在对象存储场景下的数据流参与
- 为后续更彻底解耦铺路

### 首版解耦目标

首版不追求“`knowledge_runtime` 完全不依赖 Backend 提供内容入口”。

首版追求的是：

- `knowledge_runtime` 不理解附件存储实现
- Backend 不承担长期 bytes push 中转职责
- 索引重试可围绕统一 `content_ref` 复用

## Contract 设计

### Backend 内部 contract 尽量保持不变

Backend 内部继续使用现有：

- `IndexRuntimeSpec`
- `QueryRuntimeSpec`

本轮只做必要扩展，不把 local 路径大改成另一套抽象。

### 远程 contract 放入 `shared`

`RemoteRagGateway` 与 `knowledge_runtime` 之间共享的 transport schema 放在 `shared`。

建议包括：

- `RemoteIndexRequest`
- `RemoteQueryRequest`
- `RemoteDeleteDocumentIndexRequest`
- `RemoteQueryResult`
- `ContentRef`
- internal auth schema
- remote error schema

这样做的目的不是“共享执行逻辑”，而是：

- 统一跨服务协议
- 降低 Backend 接入 remote 的改动面
- 让 local / remote 行为对齐有共同的 contract 基线

### `RemoteIndexRequest`

建议包含：

- `knowledge_base_id`
- `document_id`
- `index_owner_user_id`
- `retriever_config`
- `embedding_model_config`
- `splitter_config`
- `index_families`
- `content_ref`
- `trace_context`

说明：

- Backend 在发请求前完成 retriever / embedding 配置展开
- `knowledge_runtime` 不再按 name / namespace 回查 CRD

### `RemoteQueryRequest`

建议尽量贴近 `QueryRuntimeSpec`，包含：

- `knowledge_base_ids`
- `query`
- `max_results`
- `document_ids`
- `user_name`
- `enabled_index_families`
- `retrieval_policy`

其中：

- `retrieval_policy` 是稳定的远程执行语义，不应直接暴露 chat-specific 的消费策略
- 当前 `QueryRuntimeSpec` 中已有的 `route_mode` / `direct_injection_budget` 可以在 Backend 内部继续保留，作为 control-plane 路由输入
- 首版 `RemoteQueryRequest` 不把 `direct injection` 决策语义固化进服务 contract

### `RemoteDeleteDocumentIndexRequest`

建议包含：

- `knowledge_base_id`
- `document_ref`
- `index_owner_user_id`
- `retriever_config`
- `enabled_index_families`

## `knowledge_runtime` API 形态

首期 `knowledge_runtime` 仅提供三类内部执行接口：

- `POST /internal/rag/index`
- `POST /internal/rag/query`
- `POST /internal/rag/delete-document-index`

设计约束：

- 不接收 DB session、ORM、CRD ref 查找请求
- 不直接回写 Backend 数据库
- 返回结构与 `shared` 中的 response schema 对齐

## 多索引族扩展设计

### 将 `index_family` 作为一等概念

不能将未来扩展继续围绕单一 `chunk_vector` 路径硬编码。

从本轮开始，remote contract 与 `knowledge_runtime` 内部执行都要按 `index_family` 预留。

### 首期默认 family

首期默认：

- `chunk_vector`

未来扩展：

- `summary_vector`
- 其他 family，例如 `table_rag`

### `QueryRuntimeSpec` / RemoteQuery 扩展位

建议新增或保留扩展位：

- `enabled_index_families`
- `retrieval_policy`

推荐 `retrieval_policy` 面向未来支持：

- `chunk_only`
- `summary_first`
- `summary_then_chunk_expand`
- `hybrid`

### 结果来源标记

`knowledge_runtime` 返回结果时应明确记录来源族，例如：

- `index_family = chunk_vector`
- `index_family = summary_vector`

这样 Backend 才能在未来做：

- 多路线编排
- 调试与观测
- 不同消费方的结果解释

## `direct injection` 与 `restricted mediation` 边界

### `direct injection` 保留在 Backend

`direct injection` 不是纯检索执行，而是消费编排决策。

它依赖：

- 当前会话上下文预算
- 模型窗口与输出保留
- 消费方的 prompt 注入方式

因此首版不将其作为 `knowledge_runtime` 的主职责。

允许的边界是：

- `knowledge_runtime` 提供常规 query 执行
- Backend 决定是否走 direct injection
- Backend 决定如何包装结果供 `chat_shell` 消费

### `restricted mediation` 保留在 Backend

`restricted mediation` 明确属于安全与权限策略，而不是检索能力。

因此：

- `knowledge_runtime` 返回原始检索候选
- Backend 负责决定是否：
  - 直接返回
  - 做 safe-summary / restricted artifact
  - 拒绝输出

不允许 `knowledge_runtime` 承担 policy decision。

## 迁移策略

### Phase 1：抽出轻协议与 execution kernel 边界

- 在 `shared` 中维持 `knowledge_runtime` remote contract
- 明确 `knowledge_engine` 的输入输出边界
- 不把 control-plane 规则带入 `knowledge_engine`

### Phase 2：从 Backend 提取 `knowledge_engine`

- 将 local data-plane 中可复用的底层执行能力抽入 `knowledge_engine`
- Backend local 改为通过 `knowledge_engine` 执行
- 保持 Backend 对外 API 与控制语义不变

### Phase 3：让 `knowledge_runtime` 复用 `knowledge_engine`

- 新服务不独立重写底层 index / query / delete
- `knowledge_runtime` 只负责协议接入、内容拉取、鉴权和结果序列化
- remote request 必须携带足够的运行时配置，使 `knowledge_runtime` 无需读取 Backend DB

### Phase 4：通过 `RemoteRagGateway` 灰度接入

- Backend 增加 remote gateway
- 索引、检索、删除按配置独立切换 local / remote
- 保留 local fallback 与快速回退能力

### Phase 5：稳定后删除 Backend local 入口层

- 当 remote 模式稳定后
- 删除 Backend 中只用于本地执行的入口层
- `knowledge_engine` 保留为 `knowledge_runtime` 的核心执行层

## 风险与约束

### 1. `knowledge_engine` 抽取边界过宽会误伤 control plane

如果把权限、元数据、状态机、摘要触发也一起抽走：

- 会扩大本轮迁移范围
- 会引入 DB / ORM / 业务规则耦合
- 会让服务拆分与业务重构绑定在一起

因此必须坚持：

- 只抽 execution kernel
- 不抽整个 `knowledge` 模块

### 2. remote contract 如果不携带足够 runtime config，`knowledge_runtime` 仍无法独立执行

如果 remote query / delete 仍只传 KB id 和 query：

- `knowledge_runtime` 仍需要回查 Backend 获取 retriever / storage / embedding 配置
- 服务边界会重新退化
- 真实 query 接入现有向量库时会卡住

因此本轮 remote contract 必须逐步承载足够的运行时配置，同时保留：

- `index_family`
- `retrieval_policy`
- 结果来源标记

作为一等扩展位写入设计。

### 3. chat-specific 语义下沉会污染数据面

如果把 `direct injection` 或 `restricted mediation` 迁入 `knowledge_runtime`：

- 数据面会耦合消费语义
- MCP / chat_shell / future API 会共享错误边界

因此本轮明确禁止该下沉。

## 后续工作

- 设计知识库 MCP `search`，将其作为 retrieval surface 的新增消费面
- 在 remote 稳定后，再评估是否继续删除 Backend 仅用于 local mode 的入口层
- 视独立发布需求评估是否进一步独立发布 `knowledge_engine`
- 将 `summary_vector_index` 接入 `index_family` 执行体系
- 为 `tableRAG` 设计独立 family / query policy
- 在对象存储场景中进一步减少 Backend 对内容拉取链路的参与

## 结论

本轮修订后采用“`shared` 放轻协议、Backend 保留 control plane、抽离 `knowledge_engine` execution kernel、`knowledge_runtime` 后续复用该 kernel、通过 `RagGateway` 灰度接入 remote”的路线；其中 `knowledge_engine` 抽离已经完成，后续重点转为 `knowledge_runtime` 服务接入、remote rollout、parity 验证与后续索引族扩展。

首版最重要的设计结论是：

- 不推文件 bytes，统一走 `content_ref`
- 不将 `direct injection` 与 `restricted mediation` 下沉到 `knowledge_runtime`
- 不拆整个 Backend `knowledge` 模块，只抽 RAG execution kernel
- 让 `knowledge_runtime` 尽快复用真实底层执行能力，而不是继续独立重写
- 从首版开始按 `index_family` / `retrieval_policy` 设计，为 `summary_vector_index` 预留稳定空间

这样既能保留 Backend control-plane 稳定性，又能尽快让 `knowledge_runtime` 接入真实底层执行能力，避免后续继续维护两套相似的数据面实现。
