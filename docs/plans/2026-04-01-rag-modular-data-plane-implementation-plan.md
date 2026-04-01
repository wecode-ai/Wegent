---
sidebar_position: 1
---

# RAG Modular Data Plane Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the first stable foundation for Wegent's modular RAG data plane by separating Backend control-plane logic from local data-plane execution through runtime specs, a gateway layer, and local execution adapters without changing user-visible behavior.

**Architecture:** Keep `backend` as the single control plane and preserve all existing APIs and task flows. Add `IndexRuntimeSpec` and `QueryRuntimeSpec` as the control-plane-to-data-plane contract, route internal retrieval and indexing through a new `RagGateway`, and move current local execution behind `LocalRagGateway` plus focused local data-plane modules. This plan intentionally stops before `summary_vector_index`, `tableRAG`, restricted mediator migration, and remote `rag_service`.

**Tech Stack:** FastAPI, SQLAlchemy, Pydantic, Celery, pytest, existing RAG storage backends (`Milvus`, `Elasticsearch`, `Qdrant`), `llama_index`

---

## Scope Split

The approved spec covers multiple independent subsystems. This plan implements only the first sub-project:

- Foundation refactor: `RuntimeSpec` + `RagGateway` + local data-plane modularization

Follow-up plans should be written separately for:

- `summary_vector_index` and summary-based retrieval
- `tableRAG` and table storage/query contracts
- `ProtectedKnowledgeMediator` migration of restricted secondary-model compression
- remote `rag_service` extraction

## File Structure

### New files

- `backend/app/services/rag/runtime_specs.py`
  Responsibility: Define stable `IndexRuntimeSpec`, `QueryRuntimeSpec`, result objects, and source payloads used below the control plane.
- `backend/app/services/rag/runtime_resolver.py`
  Responsibility: Convert KB / retriever / embedding / namespace / owner information in the control plane into pure runtime specs.
- `backend/app/services/rag/gateway.py`
  Responsibility: Define `RagGateway` protocol and shared gateway-facing request / response helpers.
- `backend/app/services/rag/local_gateway.py`
  Responsibility: Implement `LocalRagGateway` by delegating to focused local data-plane modules.
- `backend/app/services/rag/local_data_plane/indexing.py`
  Responsibility: Local document indexing entrypoint behind the gateway.
- `backend/app/services/rag/local_data_plane/retrieval.py`
  Responsibility: Local query / direct-injection orchestration behind the gateway.
- `backend/tests/services/rag/test_runtime_specs.py`
  Responsibility: Validate runtime contract normalization and invariants.
- `backend/tests/services/rag/test_runtime_resolver.py`
  Responsibility: Verify control-plane-to-runtime-spec resolution.
- `backend/tests/services/rag/test_local_gateway.py`
  Responsibility: Verify local gateway delegates correctly and preserves existing behavior.

### Modified files

- `backend/app/api/endpoints/internal/rag.py`
  Responsibility: Stop constructing retrieval behavior directly; call `RagGateway` with `QueryRuntimeSpec`.
- `backend/app/services/rag/retrieval_service.py`
  Responsibility: Preserve existing low-level retrieval helpers, but stop acting as the control-plane orchestrator.
- `backend/app/services/rag/document_service.py`
  Responsibility: Preserve current binary-loading and indexer bridging while moving orchestration behind local data-plane entrypoints.
- `backend/app/services/knowledge/indexing.py`
  Responsibility: Resolve runtime specs and route indexing through gateway instead of direct service coupling.
- `backend/app/tasks/knowledge_tasks.py`
  Responsibility: Keep Celery/task-state behavior unchanged while calling the new gateway path.
- `backend/tests/services/rag/test_retrieval_service.py`
  Responsibility: Narrow unit coverage to low-level retrieval behavior and final route-fit logic that remains local.
- `backend/tests/tasks/test_knowledge_tasks.py`
  Responsibility: Confirm tasks run through gateway and keep state-machine behavior unchanged.

### Existing files to reference while implementing

- `backend/app/services/knowledge/orchestrator.py`
- `backend/app/services/knowledge/summary_service.py`
- `backend/app/services/rag/index/indexer.py`
- `backend/app/services/rag/storage/factory.py`
- `backend/app/services/rag/embedding/factory.py`

## Implementation Notes

- Do not change public REST contracts or `chat_shell` payload shape in this plan.
- Do not move restricted secondary-model compression yet; only reserve the future seam in contracts.
- Keep `RetrievalService.get_all_chunks_from_knowledge_base(...)` and low-level retrieval helpers working during the transition.
- Keep all new comments in English.
- Prefer additive refactoring with behavior-preserving commits over big-bang moves.

### Task 1: Add Stable Runtime Contracts

**Files:**
- Create: `backend/app/services/rag/runtime_specs.py`
- Create: `backend/tests/services/rag/test_runtime_specs.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/services/rag/test_runtime_specs.py
from app.services.rag.runtime_specs import (
    DirectInjectionBudget,
    IndexRuntimeSpec,
    IndexSource,
    QueryRuntimeSpec,
)


def test_index_runtime_spec_keeps_control_plane_free_fields():
    spec = IndexRuntimeSpec(
        knowledge_base_id=7,
        document_id=8,
        index_owner_user_id=9,
        retriever_name="retriever-a",
        retriever_namespace="default",
        embedding_model_name="embed-a",
        embedding_model_namespace="default",
        source=IndexSource(attachment_id=123, source_type="attachment"),
        index_families=["chunk_vector"],
        splitter_config={"type": "smart"},
        user_name="alice",
    )
    assert spec.knowledge_base_id == 7
    assert spec.source.attachment_id == 123
    assert spec.index_families == ["chunk_vector"]


def test_query_runtime_spec_normalizes_direct_injection_budget():
    spec = QueryRuntimeSpec(
        knowledge_base_ids=[1, 2],
        query="how to ship",
        max_results=5,
        route_mode="auto",
        direct_injection_budget=DirectInjectionBudget(
            context_window=200000,
            used_context_tokens=5000,
            reserved_output_tokens=4096,
            context_buffer_ratio=0.1,
            max_direct_chunks=500,
        ),
        document_ids=[11],
        restricted_mode=False,
        user_id=3,
        user_name="alice",
    )
    assert spec.knowledge_base_ids == [1, 2]
    assert spec.document_ids == [11]
    assert spec.direct_injection_budget.max_direct_chunks == 500
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/services/rag/test_runtime_specs.py -v`
Expected: FAIL with `ModuleNotFoundError` for `app.services.rag.runtime_specs`.

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/services/rag/runtime_specs.py
from typing import Literal, Optional

from pydantic import BaseModel, Field


class IndexSource(BaseModel):
    source_type: Literal["attachment", "file_path"]
    attachment_id: Optional[int] = None
    file_path: Optional[str] = None


class DirectInjectionBudget(BaseModel):
    context_window: Optional[int] = None
    used_context_tokens: int = 0
    reserved_output_tokens: int = 4096
    context_buffer_ratio: float = 0.1
    max_direct_chunks: int = 500


class IndexRuntimeSpec(BaseModel):
    knowledge_base_id: int
    document_id: Optional[int] = None
    index_owner_user_id: int
    retriever_name: str
    retriever_namespace: str
    embedding_model_name: str
    embedding_model_namespace: str
    source: IndexSource
    index_families: list[str] = Field(default_factory=lambda: ["chunk_vector"])
    splitter_config: Optional[dict] = None
    user_name: Optional[str] = None


class QueryRuntimeSpec(BaseModel):
    knowledge_base_ids: list[int]
    query: str
    max_results: int = 5
    route_mode: Literal["auto", "direct_injection", "rag_retrieval"] = "auto"
    direct_injection_budget: Optional[DirectInjectionBudget] = None
    document_ids: Optional[list[int]] = None
    restricted_mode: bool = False
    user_id: Optional[int] = None
    user_name: Optional[str] = None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/services/rag/test_runtime_specs.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/rag/runtime_specs.py backend/tests/services/rag/test_runtime_specs.py
git commit -m "refactor(rag): add runtime specs"
```

### Task 2: Add Runtime Resolver for Index and Query Specs

**Files:**
- Create: `backend/app/services/rag/runtime_resolver.py`
- Create: `backend/tests/services/rag/test_runtime_resolver.py`
- Modify: `backend/app/services/knowledge/indexing.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/services/rag/test_runtime_resolver.py
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from app.services.rag.runtime_resolver import RagRuntimeResolver


def test_build_index_runtime_spec_uses_kb_owner_for_group_kb():
    resolver = RagRuntimeResolver()
    db = MagicMock()

    with patch(
        "app.services.rag.runtime_resolver.get_kb_index_info",
        return_value=SimpleNamespace(index_owner_user_id=42, summary_enabled=True),
    ):
        spec = resolver.build_index_runtime_spec(
            db=db,
            knowledge_base_id="7",
            attachment_id=11,
            retriever_name="retriever-a",
            retriever_namespace="default",
            embedding_model_name="embed-a",
            embedding_model_namespace="default",
            user_id=9,
            user_name="alice",
            document_id=99,
            splitter_config_dict={"type": "smart"},
        )

    assert spec.knowledge_base_id == 7
    assert spec.index_owner_user_id == 42
    assert spec.source.attachment_id == 11


def test_build_query_runtime_spec_maps_runtime_budget():
    resolver = RagRuntimeResolver()
    spec = resolver.build_query_runtime_spec(
        knowledge_base_ids=[1],
        query="release checklist",
        max_results=3,
        route_mode="auto",
        document_ids=[10],
        user_id=5,
        user_name="alice",
        context_window=200000,
        used_context_tokens=1200,
        reserved_output_tokens=4096,
        context_buffer_ratio=0.1,
        max_direct_chunks=250,
        restricted_mode=True,
    )

    assert spec.knowledge_base_ids == [1]
    assert spec.restricted_mode is True
    assert spec.direct_injection_budget.max_direct_chunks == 250
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/services/rag/test_runtime_resolver.py -v`
Expected: FAIL with import/function-not-found errors.

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/services/rag/runtime_resolver.py
from app.services.knowledge.indexing import get_kb_index_info
from app.services.rag.runtime_specs import (
    DirectInjectionBudget,
    IndexRuntimeSpec,
    IndexSource,
    QueryRuntimeSpec,
)


class RagRuntimeResolver:
    def build_index_runtime_spec(
        self,
        *,
        db,
        knowledge_base_id: str,
        attachment_id: int,
        retriever_name: str,
        retriever_namespace: str,
        embedding_model_name: str,
        embedding_model_namespace: str,
        user_id: int,
        user_name: str,
        document_id: int | None,
        splitter_config_dict: dict | None,
    ) -> IndexRuntimeSpec:
        kb_info = get_kb_index_info(db=db, knowledge_base_id=knowledge_base_id, current_user_id=user_id)
        return IndexRuntimeSpec(
            knowledge_base_id=int(knowledge_base_id),
            document_id=document_id,
            index_owner_user_id=kb_info.index_owner_user_id,
            retriever_name=retriever_name,
            retriever_namespace=retriever_namespace,
            embedding_model_name=embedding_model_name,
            embedding_model_namespace=embedding_model_namespace,
            source=IndexSource(source_type="attachment", attachment_id=attachment_id),
            splitter_config=splitter_config_dict,
            user_name=user_name,
        )

    def build_query_runtime_spec(self, **kwargs) -> QueryRuntimeSpec:
        return QueryRuntimeSpec(
            knowledge_base_ids=kwargs["knowledge_base_ids"],
            query=kwargs["query"],
            max_results=kwargs["max_results"],
            route_mode=kwargs["route_mode"],
            document_ids=kwargs.get("document_ids"),
            restricted_mode=kwargs.get("restricted_mode", False),
            user_id=kwargs.get("user_id"),
            user_name=kwargs.get("user_name"),
            direct_injection_budget=DirectInjectionBudget(
                context_window=kwargs.get("context_window"),
                used_context_tokens=kwargs.get("used_context_tokens", 0),
                reserved_output_tokens=kwargs.get("reserved_output_tokens", 4096),
                context_buffer_ratio=kwargs.get("context_buffer_ratio", 0.1),
                max_direct_chunks=kwargs.get("max_direct_chunks", 500),
            ),
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/services/rag/test_runtime_resolver.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/rag/runtime_resolver.py backend/tests/services/rag/test_runtime_resolver.py backend/app/services/knowledge/indexing.py
git commit -m "refactor(rag): add runtime resolver"
```

### Task 3: Introduce RagGateway and LocalRagGateway

**Files:**
- Create: `backend/app/services/rag/gateway.py`
- Create: `backend/app/services/rag/local_gateway.py`
- Create: `backend/tests/services/rag/test_local_gateway.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/services/rag/test_local_gateway.py
from unittest.mock import AsyncMock

import pytest

from app.services.rag.local_gateway import LocalRagGateway
from app.services.rag.runtime_specs import IndexRuntimeSpec, IndexSource, QueryRuntimeSpec


@pytest.mark.asyncio
async def test_local_gateway_query_delegates_to_local_retrieval_executor():
    gateway = LocalRagGateway()
    gateway._retrieval_executor = AsyncMock(return_value={"mode": "rag_retrieval", "records": [], "total": 0})

    spec = QueryRuntimeSpec(knowledge_base_ids=[1], query="q")
    result = await gateway.query(spec)

    assert result["mode"] == "rag_retrieval"
    gateway._retrieval_executor.assert_awaited_once_with(spec)


@pytest.mark.asyncio
async def test_local_gateway_index_document_delegates_to_local_indexing_executor():
    gateway = LocalRagGateway()
    gateway._index_executor = AsyncMock(return_value={"status": "success", "knowledge_id": "1"})

    spec = IndexRuntimeSpec(
        knowledge_base_id=1,
        document_id=2,
        index_owner_user_id=3,
        retriever_name="r",
        retriever_namespace="default",
        embedding_model_name="e",
        embedding_model_namespace="default",
        source=IndexSource(source_type="attachment", attachment_id=9),
    )
    result = await gateway.index_document(spec)

    assert result["status"] == "success"
    gateway._index_executor.assert_awaited_once_with(spec)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/services/rag/test_local_gateway.py -v`
Expected: FAIL with import/function-not-found errors.

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/services/rag/gateway.py
from typing import Protocol

from app.services.rag.runtime_specs import IndexRuntimeSpec, QueryRuntimeSpec


class RagGateway(Protocol):
    async def index_document(self, spec: IndexRuntimeSpec) -> dict: ...
    async def query(self, spec: QueryRuntimeSpec) -> dict: ...
```

```python
# backend/app/services/rag/local_gateway.py
from app.services.rag.local_data_plane.indexing import index_document_local
from app.services.rag.local_data_plane.retrieval import query_local


class LocalRagGateway:
    def __init__(self):
        self._index_executor = index_document_local
        self._retrieval_executor = query_local

    async def index_document(self, spec):
        return await self._index_executor(spec)

    async def query(self, spec):
        return await self._retrieval_executor(spec)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/services/rag/test_local_gateway.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/rag/gateway.py backend/app/services/rag/local_gateway.py backend/tests/services/rag/test_local_gateway.py
git commit -m "refactor(rag): add local gateway"
```

### Task 4: Add Local Data-Plane Retrieval Module and Rewire Internal Retrieve

**Files:**
- Create: `backend/app/services/rag/local_data_plane/retrieval.py`
- Modify: `backend/app/api/endpoints/internal/rag.py`
- Modify: `backend/app/services/rag/retrieval_service.py`
- Modify: `backend/tests/services/rag/test_retrieval_service.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/services/rag/test_retrieval_service.py
from unittest.mock import AsyncMock, patch

import pytest


@pytest.mark.asyncio
async def test_internal_retrieve_endpoint_uses_gateway_runtime_spec(test_client):
    payload = {
        "query": "test",
        "knowledge_base_ids": [123],
        "max_results": 5,
        "route_mode": "auto",
        "runtime_context": {
            "context_window": 10000,
            "used_context_tokens": 100,
            "reserved_output_tokens": 4096,
            "context_buffer_ratio": 0.1,
            "max_direct_chunks": 500,
        },
    }

    with patch(
        "app.api.endpoints.internal.rag.RagRuntimeResolver.build_query_runtime_spec",
        return_value=object(),
    ) as mock_resolve, patch(
        "app.api.endpoints.internal.rag.LocalRagGateway.query",
        new_callable=AsyncMock,
        return_value={"mode": "rag_retrieval", "records": [], "total": 0, "total_estimated_tokens": 0},
    ) as mock_query:
        response = test_client.post("/api/internal/rag/retrieve", json=payload)

    assert response.status_code == 200
    mock_resolve.assert_called_once()
    mock_query.assert_awaited_once()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/services/rag/test_retrieval_service.py -v`
Expected: FAIL because endpoint still constructs `RetrievalService` directly.

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/services/rag/local_data_plane/retrieval.py
from app.services.rag.retrieval_service import RetrievalService


async def query_local(spec):
    service = RetrievalService()
    budget = spec.direct_injection_budget
    return await service.retrieve_for_chat_shell(
        query=spec.query,
        knowledge_base_ids=spec.knowledge_base_ids,
        db=spec.db,
        max_results=spec.max_results,
        document_ids=spec.document_ids,
        user_name=spec.user_name,
        route_mode=spec.route_mode,
        user_id=spec.user_id,
        context_window=budget.context_window if budget else None,
        used_context_tokens=budget.used_context_tokens if budget else 0,
        reserved_output_tokens=budget.reserved_output_tokens if budget else 4096,
        context_buffer_ratio=budget.context_buffer_ratio if budget else 0.1,
        max_direct_chunks=budget.max_direct_chunks if budget else 500,
        restricted_mode=spec.restricted_mode,
    )
```

```python
# backend/app/api/endpoints/internal/rag.py
from app.services.rag.local_gateway import LocalRagGateway
from app.services.rag.runtime_resolver import RagRuntimeResolver

resolver = RagRuntimeResolver()
gateway = LocalRagGateway()

# inside internal_retrieve(...)
runtime_spec = resolver.build_query_runtime_spec(
    knowledge_base_ids=knowledge_base_ids,
    query=request.query,
    max_results=request.max_results,
    route_mode=request.route_mode,
    document_ids=request.document_ids,
    user_id=persistence_context.user_id if persistence_context else None,
    user_name=request.user_name,
    context_window=runtime_context.context_window if runtime_context else None,
    used_context_tokens=runtime_context.used_context_tokens if runtime_context else 0,
    reserved_output_tokens=runtime_context.reserved_output_tokens if runtime_context else 4096,
    context_buffer_ratio=runtime_context.context_buffer_ratio if runtime_context else 0.1,
    max_direct_chunks=runtime_context.max_direct_chunks if runtime_context else 500,
    restricted_mode=persistence_context.restricted_mode if persistence_context else False,
)
runtime_spec.db = db
result = await gateway.query(runtime_spec)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/services/rag/test_retrieval_service.py -v`
Expected: PASS with existing routing tests still green.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/rag/local_data_plane/retrieval.py backend/app/api/endpoints/internal/rag.py backend/app/services/rag/retrieval_service.py backend/tests/services/rag/test_retrieval_service.py
git commit -m "refactor(rag): route internal retrieve through gateway"
```

### Task 5: Add Local Data-Plane Indexing Module and Rewire Knowledge Index Task

**Files:**
- Create: `backend/app/services/rag/local_data_plane/indexing.py`
- Modify: `backend/app/services/knowledge/indexing.py`
- Modify: `backend/app/tasks/knowledge_tasks.py`
- Modify: `backend/app/services/rag/document_service.py`
- Modify: `backend/tests/tasks/test_knowledge_tasks.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/tasks/test_knowledge_tasks.py
from unittest.mock import AsyncMock, MagicMock, patch


def test_index_document_task_calls_gateway_with_runtime_spec():
    with patch(
        "app.tasks.knowledge_tasks.RagRuntimeResolver.build_index_runtime_spec",
        return_value=object(),
    ) as mock_resolve, patch(
        "app.tasks.knowledge_tasks.LocalRagGateway.index_document",
        return_value={"status": "success", "document_id": 4, "knowledge_base_id": "1", "chunks_data": {"total_count": 8}},
    ) as mock_index:
        result = index_document_task.run(**_task_kwargs())

    assert result["status"] == "success"
    mock_resolve.assert_called_once()
    mock_index.assert_called_once()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/tasks/test_knowledge_tasks.py -v`
Expected: FAIL because task still calls `run_document_indexing(...)` directly.

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/services/rag/local_data_plane/indexing.py
from app.services.rag.document_service import DocumentService
from app.services.rag.storage.factory import create_storage_backend
from app.services.adapters.retriever_kinds import retriever_kinds_service


async def index_document_local(spec, db):
    retriever = retriever_kinds_service.get_retriever(
        db,
        user_id=spec.index_owner_user_id,
        name=spec.retriever_name,
        namespace=spec.retriever_namespace,
    )
    storage_backend = create_storage_backend(retriever)
    service = DocumentService(storage_backend=storage_backend)
    return await service.index_document(
        knowledge_id=str(spec.knowledge_base_id),
        embedding_model_name=spec.embedding_model_name,
        embedding_model_namespace=spec.embedding_model_namespace,
        user_id=spec.index_owner_user_id,
        db=db,
        attachment_id=spec.source.attachment_id,
        splitter_config=spec.splitter_config,
        document_id=spec.document_id,
        user_name=spec.user_name,
    )
```

```python
# backend/app/services/knowledge/indexing.py
resolver = RagRuntimeResolver()
gateway = LocalRagGateway()

runtime_spec = resolver.build_index_runtime_spec(...)
result = asyncio.run(gateway.index_document(runtime_spec, db=db))
```

```python
# backend/app/tasks/knowledge_tasks.py
# keep state-machine + summary logic unchanged; only replace the direct indexing call path
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/tasks/test_knowledge_tasks.py -v`
Expected: PASS with lock, finalize, and summary enqueue coverage still green.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/rag/local_data_plane/indexing.py backend/app/services/knowledge/indexing.py backend/app/tasks/knowledge_tasks.py backend/app/services/rag/document_service.py backend/tests/tasks/test_knowledge_tasks.py
git commit -m "refactor(rag): route indexing through local gateway"
```

### Task 6: Tighten RuntimeSpec Boundaries and Remove DB Leakage from Query Spec

**Files:**
- Modify: `backend/app/services/rag/runtime_specs.py`
- Modify: `backend/app/services/rag/local_data_plane/retrieval.py`
- Modify: `backend/app/services/rag/local_data_plane/indexing.py`
- Modify: `backend/app/api/endpoints/internal/rag.py`
- Modify: `backend/app/services/knowledge/indexing.py`
- Test: `backend/tests/services/rag/test_runtime_specs.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/services/rag/test_runtime_specs.py
import pytest

from app.services.rag.runtime_specs import QueryRuntimeSpec


def test_query_runtime_spec_rejects_unknown_db_field():
    with pytest.raises(Exception):
        QueryRuntimeSpec(knowledge_base_ids=[1], query="q", db=object())
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/services/rag/test_runtime_specs.py -v`
Expected: FAIL because the temporary gateway wiring leaked `db` into the spec object.

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/services/rag/runtime_specs.py
class QueryRuntimeSpec(BaseModel):
    model_config = {"extra": "forbid"}
    ...
```

```python
# backend/app/services/rag/gateway.py
class RagGateway(Protocol):
    async def query(self, spec: QueryRuntimeSpec, *, db) -> dict: ...
    async def index_document(self, spec: IndexRuntimeSpec, *, db) -> dict: ...
```

```python
# backend/app/services/rag/local_gateway.py
async def query(self, spec, *, db):
    return await self._retrieval_executor(spec, db=db)

async def index_document(self, spec, *, db):
    return await self._index_executor(spec, db=db)
```

```python
# backend/app/api/endpoints/internal/rag.py
result = await gateway.query(runtime_spec, db=db)
```

```python
# backend/app/services/knowledge/indexing.py
result = asyncio.run(gateway.index_document(runtime_spec, db=db))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/services/rag/test_runtime_specs.py tests/services/rag/test_local_gateway.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/rag/runtime_specs.py backend/app/services/rag/gateway.py backend/app/services/rag/local_gateway.py backend/app/services/rag/local_data_plane/retrieval.py backend/app/services/rag/local_data_plane/indexing.py backend/app/api/endpoints/internal/rag.py backend/app/services/knowledge/indexing.py backend/tests/services/rag/test_runtime_specs.py
git commit -m "refactor(rag): keep runtime specs control-plane free"
```

### Task 7: Regression Verification and Documentation Cleanup

**Files:**
- Modify: `docs/plans/2026-03-24-rag-service-split-plan.md`
- Modify: `backend/app/services/rag/README.md`

- [ ] **Step 1: Write the failing documentation/test expectation**

```markdown
Add explicit notes that:
- Phase 0 is already complete
- foundation work now consists of RuntimeSpec + RagGateway + local data-plane modules
- `summary_vector_index`, `tableRAG`, restricted mediator migration, and remote service extraction are follow-up tracks
```

- [ ] **Step 2: Run targeted backend regression suite**

Run: `cd backend && uv run pytest tests/services/rag/test_runtime_specs.py tests/services/rag/test_runtime_resolver.py tests/services/rag/test_local_gateway.py tests/services/rag/test_retrieval_service.py tests/tasks/test_knowledge_tasks.py tests/services/knowledge/test_orchestrator.py tests/api/endpoints/test_knowledge_document_detail_endpoints.py -v`
Expected: PASS.

- [ ] **Step 3: Update docs to match the implemented architecture**

```markdown
In `docs/plans/2026-03-24-rag-service-split-plan.md`, mark the old `chat_shell` routing concern as historical context and add a short note pointing to the modular data-plane spec and this implementation plan.

In `backend/app/services/rag/README.md`, add a section:
- `RuntimeSpec` contracts
- `RagGateway`
- `local_data_plane`
- follow-up work not implemented yet
```

- [ ] **Step 4: Run regression suite again after doc updates**

Run: `cd backend && uv run pytest tests/services/rag/test_runtime_specs.py tests/services/rag/test_runtime_resolver.py tests/services/rag/test_local_gateway.py tests/services/rag/test_retrieval_service.py tests/tasks/test_knowledge_tasks.py tests/services/knowledge/test_orchestrator.py tests/api/endpoints/test_knowledge_document_detail_endpoints.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/plans/2026-03-24-rag-service-split-plan.md docs/plans/2026-04-01-rag-modular-data-plane-implementation-plan.md backend/app/services/rag/README.md
git commit -m "docs(rag): document modular data plane foundation"
```

## Self-Review

### Spec coverage

- `RuntimeSpec` contract: covered by Tasks 1, 2, and 6
- `RagGateway + RuntimeResolver`: covered by Tasks 2, 3, and 4
- local data-plane modularization: covered by Tasks 4 and 5
- preserving existing `chat_shell` / Backend external behavior: covered by Tasks 4, 5, and 7 regression checks
- follow-up subsystem split for summary index / tableRAG / restricted mediator / remote service: explicitly deferred in `Scope Split`

### Boundary note

- `user_subtask_id` and related persistence metadata remain Backend-only execution context and are intentionally excluded from `QueryRuntimeSpec`

### Placeholder scan

- No `TBD`, `TODO`, “implement later”, or “similar to Task N” placeholders remain.
- Every task includes explicit files, commands, and a concrete commit target.

### Type consistency

- Contract names are consistent: `IndexRuntimeSpec`, `QueryRuntimeSpec`, `DirectInjectionBudget`, `RagRuntimeResolver`, `RagGateway`, `LocalRagGateway`.
- Temporary `db` leakage is intentionally corrected in Task 6 so the final shape matches the approved spec boundary.
