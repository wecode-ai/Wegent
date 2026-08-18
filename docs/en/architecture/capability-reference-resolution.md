---
sidebar_position: 5
---

# Shared Model reference resolution

## Scope

This flow governs how RAG resolves a visible personal or group Model reference
to its source Kind.

## Connection graph

```mermaid
flowchart LR
    C["Caller"] --> D["Direct Model lookup"]
    D -->|Not found| R["Shared Model reference resolver"]
    R --> K["kinds: configuration source of truth"]
    R --> N["namespace: target scope"]
    R --> M["resource_members: sharing grant source of truth"]
    R --> S["Source Kind"]
```

## Sequence diagram

```mermaid
sequenceDiagram
    participant C as Caller
    participant R as Shared Model reference resolver
    participant DB as Database
    C->>DB: Find a direct Model with existing rules
    alt Direct Model does not exist
        C->>R: name, visible namespace, user_id
        R->>DB: Find an active namespace and approved reference
        DB-->>R: Active source Kind with the smallest id
        R-->>C: Source Kind or unavailable
    else Direct Model exists
        DB-->>C: Direct Model
    end
```

## Code ownership

| Responsibility | Owner |
| --- | --- |
| Resolve one shared Model reference | `shared/db/capability_reference.py` |
| Create, remove, list, and delegate Backend sharing access | `backend/app/services/capability_reference_service.py` |
| Build Backend RAG configuration | `backend/app/services/rag/runtime_resolver.py` |
| Build Knowledge Runtime configuration | `knowledge_runtime/knowledge_runtime/services/config_resolver.py` |

## Essential invariants

- `Kind` is the only source of truth for capability configuration; sharing must not copy configuration or secrets.
- `ResourceMember` is the source of truth for sharing grants; a reference resolves only when its target namespace is active and its grant is approved.
- The namespace in a reference is the caller-visible scope and does not have to match the source Kind namespace.
- When a visible scope has multiple referenced Models with the same name, the `Kind` with the smallest id is treated as the earliest and selected.
- Callers retain their existing direct Model lookup and resolve a shared reference only when it is not found.
- Backend RAG and Knowledge Runtime must use the same shared Model reference resolver; removing a grant or disabling its source makes it unavailable immediately.
