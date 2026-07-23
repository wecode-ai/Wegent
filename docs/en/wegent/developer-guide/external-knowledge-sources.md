---
sidebar_position: 12
---

# External Knowledge Sources

English | [简体中文](../../zh/developer-guide/external-knowledge-sources.md)

External knowledge sources let Wegent retrieve from built-in knowledge bases and trusted external content systems during one task run. This is runtime retrieval infrastructure. It does not implement a concrete provider, and it does not put provider-specific UI, copy, or routes in core.

This is different from the external knowledge MCP. The external knowledge MCP lets external systems access Wegent knowledge bases. External knowledge sources let Wegent read user-selected knowledge records from external systems while executing a task.

## Design Goals

- Let Backend and Chat Shell retrieve external knowledge through one protocol.
- Let the frontend select external sources, render provenance, and open provider-owned sources.
- Keep core provider-neutral while downstream systems register provider implementations, openers, and source views.
- Degrade per source when an external provider fails, without breaking built-in knowledge base retrieval.

## Provider Protocol and Registry

`RetrievalSourceProvider` is the Backend protocol for external retrieval sources. A provider is responsible for:

- Declaring its provider id and capabilities.
- Validating and resolving external knowledge references from a task.
- Returning external records that `internal_retrieve` can merge.
- Optionally listing documents so the frontend or agents can browse selectable content.

The registry is the boundary between core and providers. Core only uses the registry to find providers and must not import downstream implementations. Downstream deployments register providers at startup. If a provider is missing or unavailable, core should mark that source as failed or ignored instead of failing the whole retrieval request.

### DingTalk MCP Service Boundary

DingTalk external knowledge uses two separate MCP services: WikiSpace MCP owns knowledge-base listing, metadata, and management; Docs MCP owns `list_nodes`, `search_documents`, and `get_document_content`. A WikiSpace ref still uses its `source_id` and local synced directory for access-scope validation, but content retrieval must always use Docs MCP.

Docs retrieval first searches document metadata with `keyword`, `pageSize`, and optional `workspaceIds`, then reads content with `nodeId`. An explicit document ref reads content directly; knowledge-base and folder refs use bounded candidate counts with bounded pagination, concurrency, and timeouts. MCP errors, missing tools, invalid parameters, and unrecognized responses are `failed`; only a successful empty search is `no_hit`.

## Task-Level Runtime Binding

`Ghost.spec.defaultExternalKnowledgeRefs` stores each Bot's default external knowledge. When a Task is created, member Ghost defaults are unioned, gated as the Team owner (`team.user_id`), and materialized into `Task.spec.externalKnowledgeRefs`.

Key constraints:

- Agent defaults are saved and run as the Team owner. Sharing an agent does not change that owner.
- A message-level explicit selection is gated as the sender and applies only to that execution. It must not update Ghost defaults or Task refs.
- Copying an agent to a new owner revalidates copied defaults as the new `team.user_id`.
- The effective external actor is request-scoped execution data. Do not persist it in the ref or infer it from `boundBy`.
- Do not store provider-private credentials in Task spec.
- Do not persist raw external URLs in source payloads. Use a stable, verifiable, provider-interpretable `source_uri` when a source needs to be located.
- Task detail, WebSocket payloads, and Chat Shell metadata should only pass provider-neutral fields.

### Reference Fields

`externalKnowledgeRefs[]` uses provider-neutral fields and must not store provider-private objects:

| Field                                   | Description                                                                                                                                                                                                                      |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`                              | Provider id.                                                                                                                                                                                                                     |
| `mode`                                  | Binding mode, usually `explicit`; `all_accessible` means a provider-interpretable all-accessible scope.                                                                                                                          |
| `id`                                    | Stable provider-owned source ID. Required when `mode=explicit`.                                                                                                                                                                  |
| `name`                                  | User-readable source name, such as the knowledge base name.                                                                                                                                                                      |
| `scope`                                 | Provider-interpretable scope, such as `personal`, `group`, or `organization`.                                                                                                                                                    |
| `target_type`                           | Optional target type: `knowledge_base`, `folder`, or `document`. Missing values are treated as whole-source bindings.                                                                                                            |
| `node_id` / `document_id` / `parent_id` | Provider-neutral folder or document locator fields.                                                                                                                                                                              |
| `target_name`                           | Display name for a selected folder or document. Document-scoped refs should keep `name` as the source name and store the document title in `target_name`, so source lists do not mistake the document title for the source name. |

### Management Entry and API

Task-level external bindings are the default snapshot for future messages. Composer selections override that snapshot only for the current message; the next message without an explicit selection restores the Task snapshot. Removing a Task binding affects future default execution requests and must not rewrite historical message context.

The frontend should reuse the existing task/group management entry and its Knowledge tab. Built-in knowledge bases and external knowledge sources should appear in one list instead of maintaining a separate "bound external knowledge" manager inside the composer context selector. External rows should use a short provider badge, such as `AP`.

Backend exposes these Task-level external binding APIs:

| Method | Path                                                  | Description                                                 |
| ------ | ----------------------------------------------------- | ----------------------------------------------------------- |
| `GET`  | `/api/tasks/{task_id}/external-knowledge-refs`        | Return external knowledge refs bound to the current Task.   |
| `POST` | `/api/tasks/{task_id}/external-knowledge-refs`        | Persist refs gated as the Task's Team owner.                |
| `POST` | `/api/tasks/{task_id}/external-knowledge-refs/remove` | Remove one external knowledge ref by normalized target key. |

The remove request body is:

```json
{
  "ref": {
    "provider": "ap",
    "mode": "explicit",
    "id": "kb-1",
    "target_type": "document",
    "node_id": "document:node-1",
    "document_id": "node-1"
  }
}
```

Management UI must treat external binding load failures as non-blocking: built-in knowledge base listing and unbinding remain available, while the external failure is shown as a local warning.

## Retrieval Merge Flow

`internal_retrieve` merges built-in knowledge base records and external provider records for Chat Shell. The recommended flow is:

1. If the current message has explicit external knowledge contexts, use only those refs for this execution and skip Task/default external refs.
2. Otherwise, read `externalKnowledgeRefs` from Task spec and resolve the actor from the persisted Team owner.
3. Run built-in knowledge base retrieval first, preserving existing permissions and index behavior.
4. Group external references by provider before calling the registered `RetrievalSourceProvider`.
5. Convert external records into unified context chunks and provenance fields.
6. Merge results and return a retrieval summary.

The two paths never fall back to each other, `boundBy`, or service/tenant credentials. A missing owner, revoked authorization, unconfigured provider, or invalid ref removes that source from the execution and produces a sanitized warning.

External provider errors must be isolated per source. If one source times out, fails authorization, or returns no records, only that source status should be affected; built-in knowledge base hits and other provider results should still be returned.

## Source Provenance Fields

When external records enter messages, tool events, or reference lists, use provider-neutral provenance fields:

| Field         | Description                                                                         |
| ------------- | ----------------------------------------------------------------------------------- |
| `source_type` | Source type or provider namespace for distinguishing built-in and external sources. |
| `source_id`   | Stable provider-owned ID.                                                           |
| `source_uri`  | Stable provider-interpretable URI. This should not be a raw external download URL.  |
| `source_name` | User-readable source name.                                                          |

Reference rendering must degrade to plain text source metadata when an opener is missing or a provider is unavailable. It must not drop the message body.

## Opener and Source View Seams

Frontend core provides two registries:

- External source opener registry: delegates a reference to a provider opener.
- Knowledge source view registry: mounts provider-neutral source views in the unified knowledge entrance.

Core does not contain downstream provider opener code, routes, icon copy, or business APIs. Downstream frontend packages can register openers and source views from their own initialization code. When none is registered, core uses fallback rendering for the source name and basic metadata.

## Optional Document Listing Capability

`knowledge_list_documents` is an optional provider capability for listing selectable documents or records under an external source. It is not specific to any provider.

Implementation requirements:

- Providers own permission filtering and pagination.
- Core only consumes provider-neutral listing results.
- The Backend external listing endpoint reports `pagination_scope: "per_provider"`; after Chat Shell aggregates built-in knowledge bases and external sources, it reports `pagination_scope: "per_source"`. Callers should not interpret these fields as one globally merged pagination window.
- When the capability is absent, the frontend should hide or disable the browsing entry instead of failing task execution.

## Security and Purity Rules

- Core must stay provider-neutral.
- Core must not contain provider-specific copy, routes, imports, or registration code.
- Raw external URLs should not be persisted in source payloads.
- Provider failures must degrade per source and must not break built-in knowledge base retrieval.
- Model context should receive permission-checked and formatted chunks, not raw provider responses.
- Logs and retrieval summaries may record provider id, source id, status, and counts, but must not record sensitive credentials.

## Testing Guidance

- Use fake providers to cover registry lookup, successful retrieval, empty results, and failure degradation.
- Core tests must not use provider-specific fixtures.
- Cover merge order when built-in knowledge bases and external sources both return hits.
- Cover propagation and rendering for `source_type`, `source_id`, `source_uri`, and `source_name`.
- Cover opener fallback when no opener is registered.
- Cover UI and tool degradation when `knowledge_list_documents` is not available.
