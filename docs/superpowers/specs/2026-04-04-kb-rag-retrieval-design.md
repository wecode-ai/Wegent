---
sidebar_position: 1
---

# KB RAG Retrieval Design

## Overview

This design improves knowledge-base retrieval behavior for AI agents without adding new tools, new persistent configuration, or new backend I/O requests.

The current system already provides three complementary KB capabilities:

- `kb_ls` for document-level overview
- `knowledge_base_search` for fast retrieval
- `kb_head` for direct content reading

The main gap is not missing infrastructure. The gap is that agents do not have enough guidance or enough scoped-search controls to use these capabilities proactively on large or complex knowledge bases.

This design keeps the current intent-routing model, but changes the routing outcome for KB content questions from a mostly fixed "search first" path to a more flexible "decide the next best retrieval action" path.

## Goals

- Preserve intent routing as the first decision step for KB interactions.
- Let the agent choose between direct search, document overview, scoped search, and manual reading based on the current question and KB metadata.
- Allow `knowledge_base_search` to narrow search scope by specific documents.
- Reuse existing retrieval infrastructure and call-limit behavior.
- Avoid extra network requests or new long-lived configuration.

## Non-Goals

- No new "smart KB" tool that wraps `kb_ls`, `knowledge_base_search`, and `kb_head`.
- No backend-enforced size thresholds such as small/medium/large KB routing.
- No new generic metadata filter object exposed to the model in the first version.
- No changes to existing call-limit policies.

## Current Problems

1. Prompt guidance over-biases KB question answering toward `knowledge_base_search`, which weakens retrieval quality on larger or more heterogeneous KBs.
2. `knowledge_base_search` already supports document filtering internally through `document_ids`, but that capability is not exposed to the model as part of the tool schema.
3. Dynamic KB metadata injected into the conversation does not currently include retrieval-relevant facts such as document count or whether RAG is available.
4. `kb_ls` is described mainly as a fallback path instead of a proactive range-discovery tool.

## Proposed Behavior

### Intent Routing

Intent routing remains the first step.

For KB-related requests, the model should still first classify whether the user is asking about:

- KB metadata or selection
- KB document overview
- KB content question
- KB management operations
- Manual content reading in no-RAG situations

The change is in the next-step guidance for KB content questions:

- If the question is precise and direct retrieval is likely enough, the model may call `knowledge_base_search` immediately.
- If the question is broad, ambiguous, or likely to depend on document structure or document choice, the model should prefer `kb_ls` first.
- After `kb_ls`, the model may call `knowledge_base_search` again with scoped document arguments.
- If RAG is unavailable, the model should use `kb_ls` and `kb_head`.

### Dynamic KB Metadata

The request-scoped KB metadata block should remain lightweight and objective.

Each KB entry should include:

- `kb_name`
- `kb_id`
- `document_count`
- `rag_enabled`
- existing optional summary/topic hints when available

No derived size buckets should be added. Exact values are simpler to maintain and give the model enough signal to decide whether it should first inspect document scope.

Example shape:

```text
Knowledge Bases In Scope:
- KB Name: Product Docs, KB ID: 12, Documents: 128, RAG: enabled
  - Summary: Internal product documentation and runbooks
  - Topics: release process, deployment, alerts
```

### Scoped Search

`knowledge_base_search` should support narrowing retrieval to specific documents with:

- `document_ids: number[]`
- `document_names: string[]`

Expected usage:

- If the model already knows exact document names from the user prompt, previous `kb_ls` output, or conversation history, it may use `document_names` directly.
- If the model does not know the target documents, it should use `kb_ls` first.
- If the model has document IDs, it should prefer `document_ids`.

## Interface Design

### Shared Prompt Layer

Update the KB prompt templates in `shared/prompts/knowledge_base.py`.

Key prompt adjustments:

- Keep `Intent Routing (DO THIS FIRST)`.
- Keep the current strict / relaxed / no-RAG / restricted mode structure.
- Change KB content-question guidance from effectively "search first" to "decide whether to inspect scope first".
- Reframe `kb_ls` as a proactive document-overview tool, not only a fallback tool.
- Document that scoped `knowledge_base_search` can use `document_ids` or `document_names` when the target documents are known.

Restricted mode remains search-only. It does not expose `kb_ls` or `kb_head`.

### Dynamic KB Meta Prompt

Update the backend KB meta formatter so each entry includes `document_count` and `rag_enabled`.

This change should stay formatting-only from the prompt module's perspective. The preprocessing layer remains responsible for assembling the meta list from already available backend state.

### Chat Shell Tool Schema

Extend the `KnowledgeBaseInput` schema used by `knowledge_base_search`:

- add optional `document_ids`
- add optional `document_names`

The tool continues to call the same backend internal retrieve endpoint. Existing calls with only `query` and `max_results` remain valid and unchanged.

### Backend Internal Retrieve Surface

Extend the internal retrieval request model to accept:

- `document_ids`
- `document_names`

Resolution rules:

- If `document_ids` is provided, retrieval uses those IDs directly.
- If `document_names` is provided, backend resolves them to document IDs within the currently scoped KB set.
- If both are provided, `document_ids` takes precedence and `document_names` is ignored.
- Name resolution uses exact matching only.
- If no names resolve, return a structured error instructing the caller to use `kb_ls` first.

The backend should resolve `document_names` into `document_ids` before entering the existing retrieval/filtering flow so that the downstream retrieval path remains unchanged.

## Matching Rules

### `document_names`

- Matching is exact.
- Matching is scoped to the KBs already attached to the current tool invocation.
- If multiple KBs contain the same exact document name, all matching documents are included.
- No fuzzy matching or contains matching is added in the first version.

### Ambiguity

If multiple exact matches exist across KBs, that is acceptable and should not be treated as an error. The current system already supports multi-KB retrieval, so the scoped result set can include all exact matches.

## Error Handling

- If `document_names` resolves to no documents, return a structured error and guidance to call `kb_ls`.
- If `document_ids` or `document_names` is an empty list, treat it as absent input.
- If RAG is not configured, preserve the current no-RAG response and guide the model toward `kb_ls` and `kb_head`.
- Restricted mode continues to allow only `knowledge_base_search`, even when scoped arguments are used.
- Do not silently fall back from failed scoped search to global search. Silent widening would reduce precision and make tool behavior unpredictable.

## Compatibility

- Existing callers that use only `query` and `max_results` keep the current behavior.
- Existing retrieval logic based on `document_ids -> metadata_condition -> backend storage retrieval` remains the main implementation path.
- No new tool is introduced.
- No new persistent KB configuration is introduced.
- No new call-limit behavior is introduced.

## Implementation Boundaries

### Shared

Responsible for updating the KB prompt instructions only.

### Chat Shell

Responsible for exposing scoped-search inputs to the model and forwarding them to backend retrieval.

### Backend

Responsible for:

- enriching KB metadata with `document_count` and `rag_enabled`
- resolving `document_names` to `document_ids`
- keeping retrieval execution on the existing filtered retrieval path

## Testing

### Shared

- Update prompt tests to reflect the new KB guidance wording.
- Add or update tests for KB meta prompt formatting with `document_count` and `rag_enabled`.

### Chat Shell

- Verify `knowledge_base_search` schema includes `document_ids`.
- Verify `knowledge_base_search` schema includes `document_names`.
- Verify scoped arguments are forwarded in HTTP mode.
- Verify legacy unscoped usage remains unchanged.

### Backend

- Verify internal retrieve accepts `document_names`.
- Verify exact-match name resolution within KB scope.
- Verify unresolved names return the expected structured error.
- Verify multiple exact matches across KBs are included.
- Verify direct `document_ids` filtering still works.
- Verify the downstream retrieval path still uses document-based metadata filtering.

## Rollout Notes

This design is intentionally incremental.

The first version should stop at:

1. prompt guidance updates
2. dynamic metadata enrichment
3. scoped search support through `document_ids` and `document_names`
4. backend exact-match document-name resolution

Do not expand the first version into generic filter support, fuzzy matching, or backend hard-coded KB-size routing.
