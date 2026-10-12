# RAG Runtime Architecture

## Overview

This directory now holds the Backend-side runtime boundary for knowledge retrieval and indexing. It is no longer the home of the full execution implementation.

Current architecture:

- Backend remains the only control plane.
- `shared` holds transport-only protocol models for Backend <-> `knowledge_runtime`.
- `knowledge_engine` holds the backend-agnostic execution kernel.
- `knowledge_runtime` is a thin remote adapter over `knowledge_engine`.
- `backend/app/services/rag/` owns runtime specs, gateway routing, and Backend-facing adapters.

RAG execution has exactly one path: every index, query and delete operation runs
in `knowledge_runtime`. The Backend no longer contains a local execution plane or
the mode switch that used to select one, so `knowledge_runtime` is a required
dependency of the Backend rather than an alternative runtime.

Index, delete, purge, drop and list-chunks requests carry references only: the
knowledge base id, the document or chunk reference, and the index owner.
`knowledge_runtime` resolves the retriever, embedding model and splitter
configuration once per operation through its own `ConfigResolver`, so the
Backend never resolves a retriever or embedding configuration that it would
discard at the boundary.

## Responsibility Split

### Backend control plane

Backend continues to own:

- permissions and multi-tenant namespace rules
- `KnowledgeBase` / `KnowledgeDocument` metadata
- knowledge base owner resolution and reference-only runtime specs
- task orchestration, retries, and state write-back
- `direct injection` route decisions
- `restricted mediation`
- public and internal API surfaces

Control-plane logic lives primarily under `backend/app/services/knowledge/`.

### Backend runtime boundary

`backend/app/services/rag/` owns the seam between control plane and execution:

- `runtime_specs.py`: normalized runtime contracts
- `runtime_resolver.py`: resolves CRD + KB metadata into reference-only specs
- `gateway.py`: common gateway protocol
- `remote_gateway.py`: the only execution path, through `knowledge_runtime`
- `gateway_factory.py`: returns the `knowledge_runtime` gateway
- `direct_injection.py`: direct-injection routing and original-document reading, with no execution-kernel dependency

### Execution kernel

`knowledge_engine` owns backend-agnostic execution details:

- document parsing and splitting
- embedding model construction
- storage backend creation and operations
- index / query / delete execution
- retrieval filter helpers

The Backend still imports the light helpers of `knowledge_engine` (attachment
Excel reading, embedding capability checks and storage capability listing),
but never its retrieval execution or storage SDKs.

### Remote runtime service

`knowledge_runtime` is intentionally narrow:

- validates internal auth
- fetches document content through `content_ref`
- translates transport requests into `knowledge_engine` inputs
- returns protocol responses

It reads records and credentials from the shared product database to resolve
execution configuration by reference. Backend retains authorization and scope
selection; the runtime does not own product permission policy.

## Current Request Flow

### Retrieval

```text
chat_shell / internal callers
  -> /api/internal/rag/retrieve
  -> RagRuntimeResolver
  -> Backend route decision
     -> direct_injection stays in Backend
     -> rag_retrieval is executed by knowledge_runtime
  -> RemoteRagGateway
  -> knowledge_runtime
```

Notes:

- `/api/internal/rag/retrieve` is the primary internal retrieval surface.
- restricted flows are mediated in Backend after raw retrieval returns.

### Index / Delete

```text
Backend task or API
  -> RagRuntimeResolver
  -> RagGateway
  -> RemoteRagGateway
  -> knowledge_runtime
```

`/api/retrievers/test-connection` forwards the storage configuration through
`get_rag_gateway().test_connection(...)` to `knowledge_runtime`, which performs
the connection test using its storage factory.

## 授权与索引恢复

- 检索资源授权必须明确 `operation=index` 或 `operation=query`。Runtime 拒绝用途不匹配；索引只使用知识库保存的资源，不接受临时查询资源覆盖。修改协议时，Backend、Runtime 和共享协议需配套交付。
- 手动上传、编辑、重建和转移保留 `caller_user_id`，普通 PDF／Word 转换回调也保留该字段。后台执行索引前重新检查调用人的当前权限；自动系统派发可以不提供手动调用人。
- 调用人、文档／附件创建者和索引所属人是不同身份。索引数据仍属于知识库的 `index_owner_user_id`；远程索引请求的 `user_id` 使用手动调用人，未提供时使用索引所属人。
- 附件导入先检查调用人对源的访问权限和源的 ready 状态，再创建独立副本。创建失败只清理未被文档引用的副本，不删除原附件或已提交文档的正文。
- 超时扫描包含尚未激活的首次索引任务，并在持有文档锁后重新判断是否过期，避免旧扫描快照覆盖刚开始执行的任务。
- 远程索引的读取超时为600秒，其他操作保持原超时。Milvus 清理已存在集合前同步等待加载，超时20秒；失败向上传播，不继续写新索引。
- Runtime 保留 embedding 的 `additional_input_modalities`，记录实际 Top K、阈值和检索模式。配置优先使用 `KNOWLEDGE_RUNTIME_` 前缀，同时接受已有的通用别名；文档获取地址由 `content_ref` 提供，不再使用独立 Backend URL 配置。

## Authorization and index recovery

Retrieval grants require an explicit `index` or `query` operation. Runtime
rejects mismatched grants and query resource overrides on indexing. Deliver
Backend, Runtime and shared protocol updates together.

Manual dispatches retain `caller_user_id`, including ordinary PDF/Word
conversion callbacks, and recheck current caller permissions before indexing.
The caller, document author and index owner remain separate identities; system
dispatches may omit the manual caller. Attachment imports create independent
bodies after source authorization, and failure cleanup removes only unlinked
copies.

Stale scans include first attempts that are not retrieval-active and recheck
expiry under the document lock. Remote indexing has a 600-second read timeout;
other operations retain their existing timeout. Milvus cleanup waits up to 20
seconds for an existing collection to load and propagates failures.

Runtime preserves embedding input modalities and logs effective retrieval
parameters. Prefer `KNOWLEDGE_RUNTIME_` configuration names; existing generic
aliases remain accepted. Content fetching uses `content_ref`, not a separate
Backend URL setting.

## Content Transport

Remote indexing uses `content_ref`, not raw file bytes push.

Current supported content references:

- Backend attachment streaming
- presigned URL

This keeps Backend as the control plane without forcing `knowledge_runtime` to understand attachment storage internals.

## Deferred Work

The following areas are intentionally not part of this boundary yet:

- `summary_vector_index`
- `tableRAG`
- MCP `search`

## Practical Rule

If a change needs DB lookups, permissions, KB metadata, or chat-specific policy, it belongs in Backend control-plane code.

If a change needs parsing, embedding, vector storage, or pure retrieval execution, it belongs in `knowledge_engine`.
