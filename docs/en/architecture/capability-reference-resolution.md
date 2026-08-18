---
sidebar_position: 5
---

# Shared capability reference resolution

## Scope

This flow governs how visible personal or group references to capabilities such
as Model, Retriever, and Shell resolve to their source Kind.

## Connection graph

```mermaid
flowchart LR
    C["Caller"] --> R["Capability reference resolver"]
    R --> K["kinds: configuration source of truth"]
    R --> N["namespace: target scope"]
    R --> M["resource_members: sharing grant source of truth"]
    R --> S["Source Kind"]
```

## Sequence diagram

```mermaid
sequenceDiagram
    participant C as Caller
    participant R as Capability reference resolver
    participant DB as Database
    C->>R: kind, name, visible namespace, user_id
    R->>DB: Find a direct Kind in the visible namespace
    alt Direct Kind exists
        DB-->>R: Source Kind
    else Direct Kind does not exist
        R->>DB: Find an active namespace and approved reference
        DB-->>R: Active referenced source Kind
    end
    R-->>C: Source Kind or unavailable
```

## Code ownership

| Responsibility | Owner |
| --- | --- |
| Resolve one direct or referenced capability | `shared/db/capability_reference.py` |
| Create, remove, and list sharing grants | `backend/app/services/capability_reference_service.py` |
| Build Backend RAG configuration | `backend/app/services/rag/runtime_resolver.py` |
| Build Knowledge Runtime configuration | `knowledge_runtime/knowledge_runtime/services/config_resolver.py` |

## Essential invariants

- `Kind` is the only source of truth for capability configuration; sharing must not copy configuration or secrets.
- `ResourceMember` is the source of truth for sharing grants; a reference resolves only when its target namespace is active and its grant is approved.
- The namespace in a reference is the caller-visible scope and does not have to match the source Kind namespace.
- A direct Kind wins over a referenced Kind with the same name.
- Backend and every Runtime must use the same resolver; removing a grant or disabling its source makes it unavailable immediately.
