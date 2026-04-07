---
sidebar_position: 1
---

# Knowledge Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a reusable `knowledge_engine` execution kernel from Backend, make Backend and `knowledge_runtime` share it, and move real RAG index/query/delete execution behind stable remote contracts without changing Backend's control-plane ownership.

**Architecture:** `shared` continues to hold lightweight service-to-service protocol models only. Backend remains the only control plane and is responsible for permissions, metadata, CRD resolution, orchestration, `direct injection`, and `restricted mediation`. `knowledge_engine` becomes a new top-level Python package for backend-agnostic RAG execution, while `knowledge_runtime` becomes a thin internal service that fetches content, validates internal auth, invokes `knowledge_engine`, and returns protocol responses.

**Tech Stack:** FastAPI, Pydantic v2, SQLAlchemy, httpx, uv, pytest, current RAG storage backends, LlamaIndex-based indexing helpers, Docker Compose.

---

## Current Baseline

The following items already exist and must be preserved while executing this plan:

- `shared` already contains the first version of `knowledge_runtime` protocol models
- Backend already exposes `content_ref` and internal content streaming
- Backend already supports unified `RAG_RUNTIME_MODE`
- Backend retrieve endpoint already keeps `direct injection` decisions in Backend
- Backend remote query already has local fallback on structured remote failure
- `knowledge_runtime` service scaffold is a follow-up delivery item for the next branch; this stage focuses on `knowledge_engine`, `shared`, and Backend-side integration
- Backend parity/integration tests already cover local vs remote route switching at the gateway level

This plan supersedes only the old "independent `knowledge_runtime` reimplementation" direction. It does not discard the already-landed transport and rollout safety work.

## Implementation Status (2026-04-06)

This plan has been substantially executed for the extraction phase. The current authoritative status is:

- Completed:
  - `shared` protocol models for `knowledge_runtime`
  - top-level `knowledge_engine` package extraction
  - Backend local indexing / retrieval / delete execution routed through `knowledge_engine`
  - `knowledge_runtime` thin adapter over `knowledge_engine`
  - Backend remote gateway payload wiring for index / query / delete / test-connection
  - storage and gateway-focused test migration into `knowledge_engine` / Backend
- Still follow-up work:
  - broader remote rollout / parity verification beyond focused regression coverage
  - release and operational hardening for `knowledge_runtime`
  - future `summary_vector_index`, `tableRAG`, and MCP `search`

The checkbox states below are preserved as the original execution breakdown and should be read as historical plan detail, not as the authoritative current rollout status.

## Fixed Decisions

- Service name remains `knowledge_runtime`
- Execution package name is `knowledge_engine`
- `knowledge_engine` is a top-level package, not nested under Backend or `knowledge_runtime`
- Backend remains the only control plane
- `shared` remains protocol-only and must not contain execution logic
- `knowledge_runtime` must not read Backend DB directly
- `direct injection` stays in Backend
- `restricted mediation` stays in Backend
- Content transport remains `content_ref`, not raw bytes push
- Remote execution remains switchable per operation:
  - index
  - query
  - delete
- Default first index family remains `chunk_vector`
- `summary_vector_index` remains out of scope, but protocol and engine seams must remain ready for it
- Do not split the whole Backend `knowledge` module
- Only extract the RAG execution kernel

## Target File Areas

### Shared protocol

- `shared/models/knowledge_runtime_protocol.py`
- `shared/models/__init__.py`
- `shared/tests/test_knowledge_runtime_protocol.py`

### New execution package

- `knowledge_engine/pyproject.toml`
- `knowledge_engine/knowledge_engine/`
- `knowledge_engine/tests/`

### Backend

- `backend/pyproject.toml`
- `backend/app/services/rag/runtime_specs.py`
- `backend/app/services/rag/runtime_resolver.py`
- `backend/app/services/rag/gateway.py`
- `backend/app/services/rag/local_gateway.py`
- `backend/app/services/rag/remote_gateway.py`
- `backend/app/services/rag/local_data_plane/`
- `backend/app/services/rag/retrieval_service.py`
- `backend/app/services/knowledge/indexing.py`
- `backend/app/services/knowledge/knowledge_service.py`
- `backend/app/api/endpoints/internal/rag.py`
- `backend/tests/services/rag/`
- `backend/tests/integration/test_rag_remote_mode.py`

### Runtime service

- `knowledge_runtime/pyproject.toml`
- `knowledge_runtime/knowledge_runtime/services/`
- `knowledge_runtime/knowledge_runtime/api/internal/`
- `knowledge_runtime/tests/`

### Deployment

- `docker/knowledge_runtime/Dockerfile`
- `docker-compose.yml`

---

### Task 1: Realign docs and package boundaries around `knowledge_engine`

**Files:**
- Modify: `docs/specs/knowledge/2026-04-03-rag-service-extraction-design.md`
- Modify: `docs/plans/2026-04-04-rag-service-extraction-implementation-plan.md`

- [ ] Update the design and plan to treat `knowledge_engine` as the current execution-kernel extraction target
- [ ] State explicitly that Backend keeps control-plane logic and does not split the full `knowledge` module
- [ ] State explicitly that `knowledge_runtime` becomes a thin remote adapter over `knowledge_engine`
- [ ] Keep the already-accepted boundaries unchanged:
  - protocol in `shared`
  - `content_ref` transfer
  - `direct injection` in Backend
  - `restricted mediation` in Backend

**Verification**

Run: `rg -n "independent|独立重写|future optional extraction|不拆整个 Backend \`knowledge\` 模块" docs/specs/knowledge/2026-04-03-rag-service-extraction-design.md docs/plans/2026-04-04-rag-service-extraction-implementation-plan.md`
Expected: old independent-rewrite wording is gone or only appears as historical comparison

### Task 2: Scaffold top-level `knowledge_engine` package

**Files:**
- Create: `knowledge_engine/pyproject.toml`
- Create: `knowledge_engine/knowledge_engine/__init__.py`
- Create: `knowledge_engine/knowledge_engine/storage/`
- Create: `knowledge_engine/knowledge_engine/embedding/`
- Create: `knowledge_engine/knowledge_engine/splitter/`
- Create: `knowledge_engine/knowledge_engine/index/`
- Create: `knowledge_engine/knowledge_engine/query/`
- Create: `knowledge_engine/knowledge_engine/services/`
- Create: `knowledge_engine/tests/test_imports.py`
- Modify: `backend/pyproject.toml`
- Modify: `knowledge_runtime/pyproject.toml`

- [ ] Create `knowledge_engine` as a standalone Python package following the same `pyproject + package dir` pattern already used by other Python modules
- [ ] Add local path dependencies so Backend and `knowledge_runtime` can both import `knowledge_engine`
- [ ] Keep `knowledge_engine` dependency surface minimal:
  - storage backend implementations
  - embedding helpers
  - splitter helpers
  - index/query/delete execution services
- [ ] Do not add Backend-only API, ORM, or CRD modules into `knowledge_engine`

**Verification**

Run: `uv run --project knowledge_engine --group dev pytest knowledge_engine/tests/test_imports.py -v`
Expected: PASS

### Task 3: Extract backend-agnostic indexing and delete execution into `knowledge_engine`

**Files:**
- Move or copy into `knowledge_engine` and then switch imports:
  - `backend/app/services/rag/document_service.py`
  - `backend/app/services/rag/index/`
  - `backend/app/services/rag/storage/`
  - `backend/app/services/rag/embedding/`
  - `backend/app/services/rag/splitter/`
- Modify: `backend/app/services/rag/local_data_plane/indexing.py`
- Modify: `backend/tests/services/rag/test_local_data_plane_indexing.py`
- Modify: `backend/tests/services/rag/test_local_gateway.py`

- [ ] Move pure execution logic first, starting with index and delete paths that already have clearer backend-agnostic seams
- [ ] Preserve current storage backend behavior and naming rules
- [ ] Keep Backend local indexing/delete behavior unchanged from the caller's perspective
- [ ] Replace Backend imports so local execution flows now call `knowledge_engine`
- [ ] Do not move retriever lookup or KB metadata lookup into `knowledge_engine`

**Verification**

Run: `uv run --project backend --group dev pytest backend/tests/services/rag/test_local_data_plane_indexing.py backend/tests/services/rag/test_local_gateway.py -v`
Expected: PASS

### Task 4: Define real remote execution config in `shared`

**Files:**
- Modify: `shared/models/knowledge_runtime_protocol.py`
- Modify: `shared/models/__init__.py`
- Modify: `shared/tests/test_knowledge_runtime_protocol.py`
- Modify: `backend/app/services/rag/runtime_specs.py`
- Modify: `backend/tests/services/rag/test_runtime_specs.py`

- [ ] Extend remote protocol so query and delete no longer depend on Backend-side DB lookup after the request leaves Backend
- [ ] Keep the request model split explicit:
  - transport-only fields
  - execution config fields
  - future extension fields
- [ ] Add normalized execution config for at least:
  - retriever identity and storage config
  - embedding model config where required by index
  - retrieval mode / top_k / score threshold or equivalent normalized query config
  - enabled index families
  - retrieval policy
- [ ] Keep direct-injection-only fields out of remote protocol

**Verification**

Run: `uv run --project shared --group dev pytest shared/tests/test_knowledge_runtime_protocol.py -v`
Expected: PASS

### Task 5: Build Backend runtime-config resolvers for local and remote execution

**Files:**
- Modify: `backend/app/services/rag/runtime_resolver.py`
- Modify: `backend/app/services/rag/retrieval_service.py`
- Modify: `backend/app/services/knowledge/indexing.py`
- Modify: `backend/app/services/knowledge/knowledge_service.py`
- Modify: `backend/tests/services/rag/test_runtime_resolver.py`
- Modify: `backend/tests/services/rag/test_retrieval_service.py`

- [ ] Keep Backend responsible for turning CRD + KB metadata into normalized runtime execution config
- [ ] Add explicit builder paths for:
  - index execution config
  - remote rag query execution config
  - delete execution config
- [ ] Preserve current Backend-only route decision flow:
  - auto route resolution
  - direct injection budgeting
  - restricted mediation
- [ ] Ensure Backend local execution and remote execution are fed from the same normalized config wherever possible

**Verification**

Run: `uv run --project backend --group dev pytest backend/tests/services/rag/test_runtime_resolver.py backend/tests/services/rag/test_retrieval_service.py -v`
Expected: PASS

### Task 6: Implement `knowledge_engine` real query executor

**Files:**
- Create: `knowledge_engine/knowledge_engine/query/executor.py`
- Create or modify: `knowledge_engine/knowledge_engine/query/`
- Modify: `knowledge_engine/tests/`
- Modify: `backend/app/services/rag/retrieval_service.py`

- [ ] Add a backend-agnostic query executor in `knowledge_engine` for standard RAG retrieval
- [ ] Reuse existing storage backend abstractions instead of calling Backend retrieval orchestration directly
- [ ] Limit this executor to true RAG retrieval only
- [ ] Keep these concerns out of `knowledge_engine.query`:
  - direct injection
  - restricted mediation
  - persistence side effects
  - chat-specific route decisions
- [ ] Make Backend `RetrievalService` continue to own chat-specific orchestration while delegating pure retrieval execution where appropriate

**Verification**

Run: `uv run --project knowledge_engine --group dev pytest knowledge_engine/tests -k query -v`
Expected: PASS

### Task 7: Make `knowledge_runtime` a thin adapter over `knowledge_engine`

**Files:**
- Modify: `knowledge_runtime/knowledge_runtime/services/handlers.py`
- Modify: `knowledge_runtime/knowledge_runtime/services/content_fetcher.py`
- Modify: `knowledge_runtime/knowledge_runtime/api/internal/rag.py`
- Modify: `knowledge_runtime/tests/test_internal_rag.py`

- [ ] Replace placeholder handler behavior with real `knowledge_engine` execution calls
- [ ] Keep `knowledge_runtime` responsibilities narrow:
  - auth validation
  - `content_ref` fetch
  - request validation
  - translating protocol models into `knowledge_engine` inputs
  - translating results back into protocol responses
- [ ] Do not let `knowledge_runtime` perform retriever lookup from Backend DB
- [ ] Query must now return true retrieval results from the configured vector backend

**Verification**

Run: `uv run --project knowledge_runtime --group dev pytest knowledge_runtime/tests/test_internal_rag.py -v`
Expected: PASS

### Task 8: Update Backend remote gateway to send real execution config

**Files:**
- Modify: `backend/app/services/rag/remote_gateway.py`
- Modify: `backend/app/services/rag/gateway_factory.py`
- Modify: `backend/app/api/endpoints/internal/rag.py`
- Modify: `backend/tests/services/rag/test_remote_gateway.py`
- Modify: `backend/tests/api/endpoints/internal/test_rag_retrieve_endpoint.py`

- [ ] Update remote gateway payload mapping to include the new normalized execution config
- [ ] Preserve `RAG_RUNTIME_MODE` behavior by operation
- [ ] Preserve Backend ownership of `auto -> direct_injection` finalization
- [ ] Preserve local fallback when structured remote errors occur
- [ ] Ensure `rag_retrieval` remote path now hits real `knowledge_engine`-backed execution

**Verification**

Run: `uv run --project backend --group dev pytest backend/tests/services/rag/test_remote_gateway.py backend/tests/api/endpoints/internal/test_rag_retrieve_endpoint.py -v`
Expected: PASS

### Task 9: Expand parity and end-to-end verification

**Files:**
- Modify: `backend/tests/integration/test_rag_remote_mode.py`
- Modify: `knowledge_runtime/tests/`
- Modify or add focused tests under `backend/tests/services/rag/`

- [ ] Keep the current local/remote route-switch parity coverage
- [ ] Add a real index -> remote query -> delete round-trip test path against mocked or isolated storage dependencies at the engine boundary
- [ ] Verify that:
  - local query still works
  - remote query now returns real indexed results
  - remote failure still falls back to local where designed
  - index/query/delete remain independently switchable
- [ ] Add regression coverage that protects against reintroducing Backend DB dependency into `knowledge_runtime`

**Verification**

Run: `uv run --project backend --group dev pytest backend/tests/integration/test_rag_remote_mode.py -v`
Expected: PASS

### Task 10: Align containerization and local runtime wiring

**Files:**
- Modify: `docker/knowledge_runtime/Dockerfile`
- Modify: `docker-compose.yml`

- [ ] Ensure `knowledge_runtime` image installs both `wegent-shared` and `knowledge_engine`
- [ ] Keep base image and startup style aligned with Backend / Chat Shell conventions
- [ ] Copy top-level package directories needed for local editable installs
- [ ] Keep healthcheck and service wiring valid after the package split

**Verification**

Run: `docker compose -f docker-compose.yml config`
Expected: valid compose output including `knowledge_runtime` and the new package wiring

## Rollout Guidance

- Keep `RAG_RUNTIME_MODE=local` as the default during extraction
- First prove that Backend local now runs through `knowledge_engine`
- Then enable remote index
- Then enable remote query backed by real `knowledge_engine` execution
- Keep remote query fallback to local until parity confidence is high
- Enable remote delete last
- Remove Backend local entrypoints only after remote paths are proven stable

## Final Verification Checklist

- `uv run --project shared --group dev pytest shared/tests/test_knowledge_runtime_protocol.py -v`
- `uv run --project knowledge_engine --group dev pytest knowledge_engine/tests -v`
- `uv run --project backend --group dev pytest backend/tests/services/rag backend/tests/api/endpoints/internal backend/tests/integration/test_rag_remote_mode.py -v`
- `uv run --project knowledge_runtime --group dev pytest knowledge_runtime/tests -v`
- `docker compose -f docker-compose.yml config`

## Guardrails

- Do not move permissions, namespace rules, or metadata queries into `knowledge_engine`
- Do not move `direct injection` into `knowledge_runtime` or `knowledge_engine`
- Do not move `restricted mediation` into `knowledge_runtime` or `knowledge_engine`
- Do not make `knowledge_runtime` read Backend DB
- Do not push raw document bytes from Backend to `knowledge_runtime`
- Do not split the entire Backend `knowledge` module
- Do ensure remote query/delete requests carry enough runtime config for true independent execution
- Do ensure `knowledge_engine` remains consumable by both Backend and `knowledge_runtime`
