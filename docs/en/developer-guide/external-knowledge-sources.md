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

## Task-Level Runtime Binding

`externalKnowledgeRefs` is a Task-level runtime binding. It describes which external knowledge sources are selected for the current task run. It is not a default Ghost, Bot, or Team configuration.

Key constraints:

- Do not write external knowledge sources as Ghost default knowledge configuration.
- Do not store provider-private credentials in Task spec.
- Do not persist raw external URLs in source payloads. Use a stable, verifiable, provider-interpretable `source_uri` when a source needs to be located.
- Task detail, WebSocket payloads, and Chat Shell metadata should only pass provider-neutral fields.

## Retrieval Merge Flow

`internal_retrieve` merges built-in knowledge base records and external provider records for Chat Shell. The recommended flow is:

1. Read `externalKnowledgeRefs` from Task spec.
2. Run built-in knowledge base retrieval first, preserving existing permissions and index behavior.
3. Group external references by provider and call the registered `RetrievalSourceProvider`.
4. Convert external records into unified context chunks and provenance fields.
5. Merge results and return a retrieval summary.

External provider errors must be isolated per source. If one source times out, fails authorization, or returns no records, only that source status should be affected; built-in knowledge base hits and other provider results should still be returned.

## Source Provenance Fields

When external records enter messages, tool events, or reference lists, use provider-neutral provenance fields:

| Field | Description |
| --- | --- |
| `source_type` | Source type or provider namespace for distinguishing built-in and external sources. |
| `source_id` | Stable provider-owned ID. |
| `source_uri` | Stable provider-interpretable URI. This should not be a raw external download URL. |
| `source_name` | User-readable source name. |

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
