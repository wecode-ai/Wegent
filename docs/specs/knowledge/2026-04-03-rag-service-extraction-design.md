---
sidebar_position: 1
---

# RAG Service 独立化设计

## 背景

`docs/plans/2026-03-24-rag-service-split-plan.md` 给出了“Backend 保留控制面，RAG 数据面逐步拆出”的总体方向。

`docs/specs/knowledge/2026-03-31-rag-modular-data-plane-design.md` 已完成进程内模块边界收敛，当前稳定基础包括：

- `RuntimeSpec`
- `RagGateway`
- `LocalRagGateway`
- `local_data_plane`

在该基础上，下一步不再是继续做进程内重构，而是将 RAG 数据面执行能力进一步抽为可独立启动的 `rag_service`，同时保留灰度与回退能力。

本设计聚焦：

- 将解析、切分、embedding、索引、检索、删索引迁移到独立 `rag_service`
- Backend 保持唯一控制面
- 不将 `direct injection` 与 `restricted mediation` 下沉到 `rag_service`
- 为 `summary_vector_index` 和后续多索引族检索路线预留稳定扩展点

## 状态快照

当前代码中已经具备以下基础：

- Backend internal retrieval 已收敛到 `backend/app/api/endpoints/internal/rag.py`
- `chat_shell` 中 `knowledge_base_search` 通过 Backend internal RAG API 完成检索
- `backend/app/services/rag/runtime_specs.py` 已提供 `IndexRuntimeSpec` 与 `QueryRuntimeSpec`
- `backend/app/services/rag/gateway.py` 已定义 `RagGateway`
- `backend/app/services/rag/local_gateway.py` 已将本地执行路径封装到 `LocalRagGateway`

当前知识库 MCP 尚未提供 `search` 能力，但本轮不将其纳入拆分主线，只在后续工作中说明。

## 问题

### 1. Backend 仍承载重数据面执行

虽然控制面与数据面边界已有所收敛，但当前实际执行仍在 Backend 进程内完成：

- 文档解析
- chunking
- embedding
- 向量索引写入
- 检索执行

这意味着 Backend 镜像、依赖、启动成本和故障域仍然被重 RAG 能力绑定。

### 2. 首版服务化如果边界错误，返工成本会更高

如果直接将现有执行逻辑整体通过 HTTP 暴露，而不先明确稳定 contract，会把以下不稳定点固化进服务协议：

- 文件内容如何获取
- 执行面是否关心权限与 CRD
- `direct injection` 是否属于检索服务职责
- `restricted mediation` 是否属于 RAG 服务职责
- 未来 `summary_vector_index`、`tableRAG` 如何接入

### 3. 文件内容传输方式会影响服务职责

索引链路中的解析、切分、embedding 都依赖原始文档内容。

如果 Backend 在每次索引时直接把文件 bytes 推给 `rag_service`：

- Backend 会重新成为大文件中转站
- 异步重试与 reindex 模型会变差
- 同一份内容会重复经过“上传存储”和“服务推送”两条链路

因此，首版必须优先稳定“内容引用 contract”，而不是只追求“是否能传得动文件”。

## 目标

- 将 RAG 数据面执行迁移为可独立启动的 `rag_service`
- 保持 Backend 作为唯一 control plane
- 保持 `chat_shell` 和其他消费者继续只面向 Backend 调用
- 通过 `RagGateway` 支持 local / remote 双实现切换
- 建立统一 remote contract，使 `LocalRagGateway` 与 `RemoteRagGateway` 语义一致
- 以 `index_family` 预留 `summary_vector_index` 扩展能力

## 非目标

- 本轮不实现知识库 MCP `search`
- 本轮不让 `rag_service` 直接访问 Backend 数据库
- 本轮不把附件存储实现复制到 `rag_service`
- 本轮不将 `direct injection` 下沉到 `rag_service`
- 本轮不将 `restricted mediation` 下沉到 `rag_service`
- 本轮不决定 `tableRAG` 的具体底层存储和协议

## 方案对比

### 方案 1：一次性切换到远程 `rag_service`

做法：

- Backend 直接移除本地执行主路径
- 索引、检索、删除全部切到独立 `rag_service`

优点：

- 目标形态直接
- Backend 能最快变轻

缺点：

- 首版风险最大
- 出问题时回退困难
- 远程 contract、内容获取、鉴权、回写、观测会在同一轮同时收敛

### 方案 2：双实现网关，先落远程能力，再灰度切换

做法：

- 保留 `LocalRagGateway`
- 新增 `RemoteRagGateway`
- Backend 继续解析 `RuntimeSpec`
- 通过配置决定索引/检索/删除走 local 或 remote

优点：

- 与现有代码边界最一致
- 支持渐进灰度
- 允许快速回退到 local

缺点：

- 过渡期会同时维护 local / remote 两套执行入口

### 方案 3：仅先拆索引，检索继续留在本地

做法：

- 解析、切分、embedding、索引迁到 `rag_service`
- 检索仍由本地 data-plane 执行

优点：

- 优先拆出最重的文件处理链路

缺点：

- 会形成“写远程、读本地”的阶段性混合边界
- 后续还要再做一次检索远程化收敛

## 选型

采用方案 2。

原因：

- 当前 `RuntimeSpec + RagGateway` 已经形成天然过渡层
- 可以先稳定远程 contract，再决定何时切换默认路径
- 能在不打断现有 `chat_shell` 调用面的前提下完成服务化
- 风险和收益平衡最好

## 总体设计

目标调用链如下：

```text
chat_shell / public API / future MCP consumers
  -> Backend knowledge control plane
     -> RagRuntimeResolver
     -> RagGateway
        -> LocalRagGateway | RemoteRagGateway
           -> local_data_plane | rag_service
```

### Backend 职责

Backend 保留：

- 权限、多租户、namespace、group / personal 规则
- `KnowledgeBase` / `KnowledgeDocument` 元数据
- Retriever / Embedding / Summary 等 CRD 解析
- 任务调度、状态机、失败回写、摘要触发
- `direct injection` 路由决策
- `restricted mediation`
- 对 `chat_shell` 和其他消费者暴露统一 API

Backend 不负责：

- 文档解析实现
- chunking / embedding / 索引写入执行
- 远程数据面中的向量检索执行

### rag_service 职责

`rag_service` 只负责执行面：

- 文档内容拉取
- 文档解析
- splitter
- embedding
- index family 写入
- query 执行
- document index 删除

`rag_service` 不负责：

- 权限判断
- CRD 查询与解析
- ORM / DB session 处理
- Backend 元数据回写
- `direct injection` 消费编排
- `restricted mediation`

### 稳定边界原则

真正稳定的边界不是“文件存在哪里”，而是：

- Backend 传递 runtime contract 和 content reference
- `rag_service` 只消费这些 contract，不理解数据库语义

## 内容获取设计

### 为什么不采用 Backend 直接推送文件 bytes

即使多数文件只有几 MB，直接 push 仍存在结构性问题：

- Backend 重新成为数据面中转站
- 异步重试与 reindex 难以围绕统一引用建模
- 同一份内容需要经过两次主链路搬运
- 长请求、流控、超时、补偿更复杂

因此，首版不以“直推 bytes”作为主路径。

### 采用 content_ref 拉取模式

索引请求只传内容引用，不直接传大文件内容。

建议定义：

```text
content_ref
  -> backend_attachment_stream
  -> presigned_url
```

#### `backend_attachment_stream`

适用于当前 MySQL 或仅 Backend 可读的附件存储。

行为：

- Backend 生成内部可鉴权下载 URL
- `rag_service` 按引用回源拉取内容

意义：

- 保证兼容当前所有附件存储后端
- 不需要把附件存储实现复制到 `rag_service`

#### `presigned_url`

适用于 S3 / MinIO / 其他对象存储。

行为：

- Backend 生成预签名 URL
- `rag_service` 直接读取对象存储

意义：

- 减少 Backend 在对象存储场景下的数据流参与
- 为后续更彻底解耦铺路

### 首版解耦目标

首版不追求“`rag_service` 完全不依赖 Backend 提供内容入口”。

首版追求的是：

- `rag_service` 不理解附件存储实现
- Backend 不承担长期 bytes push 中转职责
- 索引重试可围绕统一 `content_ref` 复用

## Runtime Contract 与 Remote Contract

### 本地 contract 保持不变

Backend 内部继续使用：

- `IndexRuntimeSpec`
- `QueryRuntimeSpec`

### 引入远程 payload 映射层

`RemoteRagGateway` 负责将本地 runtime contract 转换为远程请求：

- `RemoteIndexRequest`
- `RemoteQueryRequest`
- `RemoteDeleteDocumentIndexRequest`

这样 `local` 与 `remote` 的差异只体现在 transport，而不体现在业务语义。

### RemoteIndexRequest

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
- `rag_service` 不再按 name / namespace 回查 CRD

### RemoteQueryRequest

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
- `retrieval_policy` 用于未来扩展多索引族路线

### RemoteDeleteDocumentIndexRequest

建议包含：

- `knowledge_base_id`
- `document_ref`
- `index_owner_user_id`
- `retriever_config`
- `enabled_index_families`

## rag_service API 形态

首期仅提供三类内部执行接口：

- `POST /internal/rag/index`
- `POST /internal/rag/query`
- `POST /internal/rag/delete-document-index`

设计约束：

- 不接收 DB session、ORM、CRD ref 查找请求
- 不直接回写 Backend 数据库
- 返回结构尽量与本地 gateway 一致

## 多索引族扩展设计

### 将 index family 作为一等概念

不能将未来扩展继续围绕单一 `chunk_vector` 路径硬编码。

从本轮开始，需将索引执行与检索执行都按 `index_family` 预留。

### 首期默认 family

首期默认：

- `chunk_vector`

未来扩展：

- `summary_vector`
- 其他 family，例如 `table_rag`

### IndexRuntimeSpec 扩展方向

建议保持：

- `index_families: ["chunk_vector"]`

未来可扩：

- `["chunk_vector", "summary_vector"]`

### QueryRuntimeSpec 扩展方向

建议新增或保留扩展位：

- `enabled_index_families`
- `retrieval_policy`

推荐 `retrieval_policy` 面向未来支持：

- `chunk_only`
- `summary_first`
- `summary_then_chunk_expand`
- `hybrid`

### 结果来源标记

`rag_service` 返回结果时应明确记录来源族，例如：

- `index_family = chunk_vector`
- `index_family = summary_vector`

这样 Backend 才能在未来做：

- 多路线编排
- 调试与观测
- 不同消费方的结果解释

## direct injection 与 restricted mediation 边界

### direct injection 保留在 Backend

`direct injection` 不是纯检索执行，而是消费编排决策。

它依赖：

- 当前会话上下文预算
- 模型窗口与输出保留
- 消费方的 prompt 注入方式

因此首版不将其作为 `rag_service` 的主职责。

允许的边界是：

- `rag_service` 提供执行原语，例如常规 query 或 all-chunks 风格执行
- Backend 决定是否走 direct injection
- Backend 决定如何包装结果供 `chat_shell` 消费

### restricted mediation 保留在 Backend

`restricted mediation` 明确属于安全与权限策略，而不是检索能力。

因此：

- `rag_service` 返回原始检索候选
- Backend 负责决定是否：
  - 直接返回
  - 做 safe-summary / restricted artifact
  - 拒绝输出

不允许 `rag_service` 承担 policy decision。

## 三条主链路

### 索引链路

```text
Backend
  -> 权限校验 / 元数据创建 / 任务调度
  -> RagRuntimeResolver 构造 IndexRuntimeSpec
  -> RemoteRagGateway 映射 RemoteIndexRequest
  -> 生成 content_ref
  -> rag_service 拉取内容并执行解析、切分、embedding、索引
  -> 返回执行结果
  -> Backend 回写 document 状态与 chunks，并触发摘要
```

Backend 回写内容包括：

- `KnowledgeDocument.index_status`
- `KnowledgeDocument.is_active`
- `KnowledgeDocument.chunks`
- 摘要任务触发

### 检索链路

```text
chat_shell / other consumers
  -> Backend API
  -> 权限与目标解析
  -> QueryRuntimeSpec
  -> RagGateway(local|remote)
  -> rag_service 执行 query
  -> Backend 保持 direct injection / restricted / persistence 编排
```

首版中，检索远程化不改变以下责任归属：

- direct injection routing：Backend
- restricted mediation：Backend
- retrieval persistence：Backend

### 删除索引链路

```text
Backend
  -> 基于文档与 KB 元数据决定删索引
  -> 组装 remote delete request
  -> rag_service 删除 index family 中的 document 数据
  -> Backend 回写状态与后续清理
```

## Gateway 与迁移策略

### 双实现网关

保留：

- `LocalRagGateway`

新增：

- `RemoteRagGateway`

建议引入选择层：

- `ConfigurableRagGateway`
- 或 factory based gateway selector

### 切换粒度

建议按操作独立切换：

- `index_mode = local | remote`
- `query_mode = local | remote`
- `delete_mode = local | remote`

原因：

- 索引与检索风险模型不同
- 灰度与回退更细粒度

### 推荐迁移顺序

1. 落 `rag_service` 可启动骨架与 remote contract
2. 实现 `RemoteRagGateway`，默认仍走 local
3. 先灰度索引链路到 remote
4. 索引稳定后灰度检索链路
5. 最后灰度删除链路
6. 稳定后评估是否降低 local data-plane 主路径权重

### 回退策略

- 任一操作异常时，可通过配置切回 local
- 对上层 API 不做改动
- 不引入双写、双查等高复杂度补偿逻辑

## 观测与诊断

切换期必须显式区分 local / remote：

- `gateway_mode`
- `operation = index | query | delete`
- 远程请求耗时
- 内容拉取耗时
- 解析耗时
- embedding 耗时
- 向量写入耗时
- 错误类型
- 回退次数

`rag_service` 返回错误时，建议区分：

- 内容获取失败
- 解析失败
- embedding 调用失败
- 向量存储失败
- 非法 contract

## 测试策略

### Backend

- `RagRuntimeResolver` contract 测试
- `RemoteRagGateway` payload 映射测试
- gateway 切换配置测试
- 索引 / 检索 / 删除的回写测试

### rag_service

- `content_ref` 解析测试
- `backend_attachment_stream` 拉取测试
- `presigned_url` 拉取测试
- index / query / delete 接口测试
- 多 index family executor 测试

### 集成测试

- local 模式回归
- remote 模式端到端
- remote 失败后切回 local

## 风险

### 1. MySQL 附件场景仍依赖 Backend 在线

这是首版有意识接受的现实约束。

但该依赖只体现在：

- Backend 作为内容流入口

不应扩散为：

- `rag_service` 直接依赖 Backend 数据库
- Backend 重新承担 bytes push 中转职责

### 2. contract 如果只围绕单一路径设计，未来会返工

如果远程 query contract 仍默认“只有 chunk_vector”，则 `summary_vector_index` 接入时会再次重做协议。

因此本轮必须将：

- `index_family`
- `retrieval_policy`
- 结果来源标记

作为一等扩展位写入设计。

### 3. chat-specific 语义下沉会污染数据面

如果把 `direct injection` 或 `restricted mediation` 迁入 `rag_service`：

- 数据面会耦合消费语义
- MCP / chat_shell / future API 会共享错误边界

因此本轮明确禁止该下沉。

## 后续工作

- 设计知识库 MCP `search`，将其作为 retrieval surface 的新增消费面
- 将 `summary_vector_index` 接入 `index_family` 执行器体系
- 为 `tableRAG` 设计独立 family / executor / query policy
- 在对象存储场景中进一步减少 Backend 对内容拉取链路的参与

## 结论

本轮采用“Backend 作为唯一控制面，`rag_service` 作为独立执行数据面”的路线，并通过 `RagGateway` 保持 local / remote 双实现切换。

首版最重要的设计结论是：

- 不推文件 bytes，统一走 `content_ref`
- 不将 `direct injection` 与 `restricted mediation` 下沉到 `rag_service`
- 从首版开始按 `index_family` 设计，为 `summary_vector_index` 预留稳定空间

这样可以在保持灰度和回退能力的同时，把未来 `summary_vector_index`、`tableRAG`、知识库 MCP search 等能力建立在更稳定的服务边界上。
