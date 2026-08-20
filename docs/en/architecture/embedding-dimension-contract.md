---
sidebar_position: 6
---

# Embedding dimension contract

## Scope

This flow governs how embedding configuration declared on a Model travels through
Backend and Knowledge Runtime resolution into `CustomEmbedding` provider requests,
response validation, and document-indexing failure projection. Native SDK adapter
response contracts and physical-index isolation are out of scope.

## Connection graph

```mermaid
flowchart LR
    K["Model Kind: embedding config"] --> R["Runtime config resolver"]
    R --> F["Embedding factory"]
    F --> A["CustomEmbedding adapter"]
    A --> P["External embedding provider"]
    P --> V["Response dimension validation"]
    V -->|matches| I["Vector index"]
    V -->|mismatch| E["Structured Runtime error"]
    E --> B["Backend document-processing error"]
```

## Sequence diagram

```mermaid
sequenceDiagram
    participant B as Backend
    participant R as Knowledge Runtime
    participant P as Embedding Provider
    participant S as Vector Store
    B->>R: Index request with Model reference
    R->>R: Resolve dimensions and encoding_format
    R->>P: model, input, optional dimensions/encoding_format
    P-->>R: embedding
    R->>R: Validate actual dimensions
    alt Dimensions match or are not declared
        R->>S: Store embedding
        S-->>R: Indexing succeeds
        R-->>B: Success
    else Dimensions differ
        R-->>B: embedding_dimension_mismatch (not retryable)
    end
```

## Code ownership

| Responsibility | Owner |
| --- | --- |
| Model embedding configuration schema | `backend/app/schemas/kind.py` |
| Backend RAG config construction | `backend/app/services/rag/runtime_resolver.py` |
| Backend local CRD config construction | `backend/app/services/rag/embedding/factory.py` |
| Knowledge Runtime config construction | `knowledge_runtime/knowledge_runtime/services/config_resolver.py` |
| Provider request and response-dimension guarantee | `knowledge_engine/knowledge_engine/embedding/custom.py` |
| Embedding adapter selection | `knowledge_engine/knowledge_engine/embedding/factory.py` |
| Structured Runtime error response | `knowledge_runtime/knowledge_runtime/main.py` |
| Backend indexing-failure projection | `backend/app/services/knowledge/processing_errors.py` |

## Essential invariants

- `embeddingConfig` is the source of truth for expected output format; config resolution must preserve `dimensions` and `encoding_format`.
- When routed through `CustomEmbedding`, optional configured request parameters must be sent to the provider; absent parameters must not acquire invented defaults.
- When routed through `CustomEmbedding` with declared `dimensions`, every provider response vector must have exactly that length.
- A dimension mismatch must fail immediately inside the provider adapter and must never reach the vector index.
- A dimension mismatch is a non-retryable configuration error; Runtime and Backend must preserve its stable error code.
- Error logs may include the model and expected/actual dimensions, but never credentials, input text, or vector contents.
