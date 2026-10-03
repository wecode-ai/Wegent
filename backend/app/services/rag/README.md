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
