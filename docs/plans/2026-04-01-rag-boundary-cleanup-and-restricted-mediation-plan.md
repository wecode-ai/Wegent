---
sidebar_position: 1
---

# RAG Boundary Cleanup and Restricted Mediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Phase 2.5 by separating Backend control-plane helpers from the RAG data plane, then implement Phase 5 by moving restricted safe-summary mediation from `chat_shell` into Backend internal RAG retrieval.

**Architecture:** Treat `backend/app/services/rag/` as the execution-side module boundary: runtime contracts, gateway, local data-plane execution, and engine adapters stay there; `SubtaskContext` persistence, `kb_head` usage recording, restricted mediation, and API orchestration move or stay in Backend control-plane modules. After the boundary cleanup, extend `/api/internal/rag/retrieve` so restricted requests run raw retrieval first, then flow through a new `ProtectedKnowledgeMediator`, and finally return a safe `restricted_safe_summary` payload that `chat_shell` only forwards.

**Tech Stack:** FastAPI, SQLAlchemy, Pydantic, pytest, existing RAG storage backends (`Milvus`, `Elasticsearch`, `Qdrant`), LangChain model factory in `chat_shell`, Backend CRD model resolution.

---

## Scope Split

This approved spec spans two dependent but still separable implementation slices:

- Slice A: Phase 2.5 boundary cleanup
- Slice B: Phase 5 restricted mediation migration

They should stay in one plan because Slice B depends directly on Slice A’s file moves and responsibility cleanup. `summary_vector_index`, `tableRAG`, and remote `rag_service` extraction remain out of scope.

## File Structure

### New files

- `backend/app/services/knowledge/retrieval_persistence.py`
  Responsibility: Persist knowledge retrieval results into `SubtaskContext` records from the Backend control plane.
- `backend/app/services/knowledge/document_read_service.py`
  Responsibility: Serve `kb_head` / internal read flows and persist `kb_head` usage from the Backend control plane.
- `backend/app/services/rag/splitter/runtime_config.py`
  Responsibility: Parse and normalize runtime splitter config without forcing `local_data_plane` to import `knowledge/indexing.py`.
- `backend/app/services/knowledge/protected_mediation.py`
  Responsibility: Define `ProtectedKnowledgeMediator`, `MediationContext`, request/response models, and the concrete restricted safe-summary orchestration.
- `backend/app/services/knowledge/protected_model_resolver.py`
  Responsibility: Resolve the restricted mediation model from current model identity, task/team defaults, KB `summaryModelRef`, or system fallback.
- `backend/tests/services/knowledge/test_retrieval_persistence.py`
  Responsibility: Cover the moved retrieval persistence service in its new control-plane location.
- `backend/tests/services/knowledge/test_document_read_service.py`
  Responsibility: Cover the moved document read service in its new control-plane location.
- `backend/tests/services/knowledge/test_protected_mediation.py`
  Responsibility: Validate restricted mediation, refusal behavior, and model resolution fallback.
- `backend/tests/api/endpoints/internal/test_rag_retrieve_endpoint.py`
  Responsibility: Validate normal and restricted `/api/internal/rag/retrieve` response shapes.
- `chat_shell/tests/test_knowledge_base_restricted_backend_mode.py`
  Responsibility: Verify `KnowledgeBaseTool` forwards Backend-provided restricted responses without local summarization.

### Modified files

- `backend/app/services/rag/retrieval_service.py`
  Responsibility: Drop `SubtaskContext` persistence and remain a local retrieval execution service only.
- `backend/app/services/rag/local_data_plane/indexing.py`
  Responsibility: Use neutral splitter runtime helpers instead of importing `knowledge/indexing.py`.
- `backend/app/services/rag/local_data_plane/retrieval.py`
  Responsibility: Stop carrying persistence behavior and return only raw retrieval execution results.
- `backend/app/services/rag/local_gateway.py`
  Responsibility: Add delete-index execution seam and keep retrieval/index execution local-only.
- `backend/app/services/rag/gateway.py`
  Responsibility: Add delete-index gateway method to match data-plane boundary cleanup.
- `backend/app/services/knowledge/indexing.py`
  Responsibility: Slim into an indexing control-plane adapter and import splitter helpers from the new neutral module.
- `backend/app/services/knowledge/knowledge_service.py`
  Responsibility: Route delete-index through the gateway/local data-plane boundary instead of constructing storage backends directly.
- `backend/app/api/endpoints/internal/rag.py`
  Responsibility: Add `mediation_context`, call the control-plane persistence service, run restricted mediation, and return the new restricted response shape.
- `backend/app/api/endpoints/knowledge.py`
  Responsibility: Continue calling `KnowledgeService.delete_document(...)` after the delete path is cleaned up.
- `backend/app/services/knowledge/orchestrator.py`
  Responsibility: Update imports for moved document read helpers if needed.
- `chat_shell/chat_shell/tools/builtin/knowledge_base.py`
  Responsibility: Remove local restricted summarization/model config execution and forward Backend restricted results.
- `chat_shell/chat_shell/tools/knowledge_factory.py`
  Responsibility: Stop wiring `summarizer_model_config` into `KnowledgeBaseTool`; instead pass current model identity fields if needed.
- `chat_shell/tests/test_knowledge_injection_strategy.py`
  Responsibility: Replace local restricted-safe-summary execution assertions with Backend-pass-through behavior assertions.
- `docs/specs/knowledge/2026-03-31-rag-modular-data-plane-design.md`
  Responsibility: Keep spec aligned if small naming adjustments are needed during implementation.

### Existing files to reference while implementing

- `backend/app/services/rag/document_service.py`
- `backend/app/services/rag/runtime_resolver.py`
- `backend/app/services/rag/runtime_specs.py`
- `backend/app/services/context/context_service.py`
- `backend/app/api/endpoints/internal/chat_storage.py`
- `chat_shell/chat_shell/tools/restricted_kb_summary.py`
- `chat_shell/chat_shell/services/context.py`

## Implementation Notes

- Keep all new comments in English.
- Do not push restricted mediation into `local_data_plane`; it belongs to Backend control-plane orchestration.
- Do not pass full `model_config` through `/api/internal/rag/retrieve`; only pass current model identity inside `mediation_context`.
- Preserve existing normal retrieval behavior and current `route_mode` semantics.
- Mark `/api/internal/rag/all-chunks` as legacy in code comments/docstrings during cleanup, but do not delete it in this plan.

### Task 1: Move Control-Plane Retrieval Persistence out of `services/rag`

**Files:**
- Create: `backend/app/services/knowledge/retrieval_persistence.py`
- Modify: `backend/app/services/rag/retrieval_service.py`
- Modify: `backend/tests/services/rag/test_retrieval_service.py`
- Create: `backend/tests/services/knowledge/test_retrieval_persistence.py`

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/services/knowledge/test_retrieval_persistence.py
from unittest.mock import MagicMock

from app.services.knowledge.retrieval_persistence import RetrievalPersistenceService


def test_persist_retrieval_result_skips_missing_user_subtask_id():
    service = RetrievalPersistenceService()
    db = MagicMock()

    service.persist_retrieval_result(
        db=db,
        user_subtask_id=None,
        user_id=7,
        query="q",
        mode="rag_retrieval",
        records=[{"knowledge_base_id": 1, "title": "doc", "content": "chunk"}],
    )

    db.assert_not_called()


def test_prepare_payload_redacts_titles_in_restricted_mode():
    service = RetrievalPersistenceService()

    payload = service._prepare_persistence_payload(
        records=[
            {
                "knowledge_base_id": 1,
                "title": "salary-plan.md",
                "content": "hidden",
                "score": 0.9,
            }
        ],
        restricted_mode=True,
    )

    assert payload[1]["sources"][0]["title"] == "Source 1"
```

```python
# backend/tests/services/rag/test_retrieval_service.py
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.mark.asyncio
async def test_retrieve_for_chat_shell_no_longer_persists_subtask_context():
    from app.services.rag.retrieval_service import RetrievalService

    service = RetrievalService()
    service.retrieve_from_knowledge_base_internal = AsyncMock(
        return_value={"records": []}
    )

    with patch(
        "app.services.rag.retrieval_service.retrieval_persistence_service"
    ) as mock_persistence:
        await service.retrieve_for_chat_shell(
            query="test",
            knowledge_base_ids=[1],
            db=MagicMock(),
            user_subtask_id=10,
            user_id=20,
        )

    mock_persistence.persist_retrieval_result.assert_not_called()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/services/knowledge/test_retrieval_persistence.py tests/services/rag/test_retrieval_service.py -v`
Expected: FAIL because `app.services.knowledge.retrieval_persistence` does not exist and `RetrievalService` still persists results directly.

- [ ] **Step 3: Implement the move and remove persistence from retrieval execution**

```python
# backend/app/services/knowledge/retrieval_persistence.py
from app.services.context.context_service import context_service


class RetrievalPersistenceService:
    """Persist Backend retrieval results into SubtaskContext records."""

    def persist_retrieval_result(
        self,
        db,
        *,
        user_subtask_id: int | None,
        user_id: int | None,
        query: str,
        mode: str,
        records: list[dict],
        restricted_mode: bool = False,
    ) -> None:
        if not user_subtask_id or not records or user_id is None or user_id <= 0:
            return
        payload_by_kb = self._prepare_persistence_payload(
            records=records,
            restricted_mode=restricted_mode,
        )
        existing_contexts = context_service.get_knowledge_base_context_map_by_subtask(
            db=db,
            subtask_id=user_subtask_id,
            knowledge_ids=list(payload_by_kb.keys()),
        )
        for kb_id, payload in payload_by_kb.items():
            self._upsert_context_for_kb(
                db=db,
                existing_contexts=existing_contexts,
                kb_id=kb_id,
                payload=payload,
                user_subtask_id=user_subtask_id,
                user_id=user_id,
                query=query,
                mode=mode,
                restricted_mode=restricted_mode,
            )


retrieval_persistence_service = RetrievalPersistenceService()
```

```python
# backend/app/services/rag/retrieval_service.py
class RetrievalService:
    async def retrieve_for_chat_shell(
        self,
        *,
        query: str,
        knowledge_base_ids: list[int],
        db,
        max_results: int = 5,
        route_mode: str = "auto",
        document_ids: list[int] | None = None,
        user_name: str | None = None,
        user_id: int | None = None,
        user_subtask_id: int | None = None,
        context_window: int | None = None,
        used_context_tokens: int = 0,
        reserved_output_tokens: int = 4096,
        context_buffer_ratio: float = 0.1,
        max_direct_chunks: int = 500,
        restricted_mode: bool = False,
    ) -> dict:
        return {
            "mode": mode,
            "records": records,
            "total": len(records),
            "total_estimated_tokens": total_estimated_tokens,
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/services/knowledge/test_retrieval_persistence.py tests/services/rag/test_retrieval_service.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/knowledge/retrieval_persistence.py backend/app/services/rag/retrieval_service.py backend/tests/services/knowledge/test_retrieval_persistence.py backend/tests/services/rag/test_retrieval_service.py
git commit -m "refactor(rag): move retrieval persistence to control plane"
```

### Task 2: Move `kb_head` Document Read Logic out of `services/rag`

**Files:**
- Create: `backend/app/services/knowledge/document_read_service.py`
- Modify: `backend/app/services/knowledge/orchestrator.py`
- Modify: `backend/app/api/endpoints/internal/rag.py`
- Create: `backend/tests/services/knowledge/test_document_read_service.py`

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/services/knowledge/test_document_read_service.py
from unittest.mock import MagicMock

from app.services.knowledge.document_read_service import DocumentReadService


def test_read_documents_returns_access_denied_when_doc_outside_allowed_kbs():
    service = DocumentReadService()
    db = MagicMock()

    db.query.return_value.filter.return_value.all.return_value = []

    results = service.read_documents(
        db,
        document_ids=[99],
        knowledge_base_ids=[1],
        user_subtask_id=None,
        user_id=None,
    )

    assert results[0]["id"] == 99
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/services/knowledge/test_document_read_service.py tests/services/knowledge/test_orchestrator.py tests/api/endpoints/test_knowledge_document_detail_endpoints.py -v`
Expected: FAIL because `app.services.knowledge.document_read_service` does not exist.

- [ ] **Step 3: Move the service and update imports**

```python
# backend/app/services/knowledge/document_read_service.py
class DocumentReadService:
    """Read knowledge documents and optionally persist kb_head usage."""

    def read_documents(
        self,
        db,
        *,
        document_ids: list[int],
        offset: int = 0,
        limit: int = 50_000,
        knowledge_base_ids: list[int] | None = None,
        user_subtask_id: int | None = None,
        user_id: int | None = None,
    ) -> list[dict]:
        documents_by_id = self._load_documents(db, document_ids)
        attachments_by_id = self._load_attachment_contexts(
            db,
            {
                document.attachment_id
                for document in documents_by_id.values()
                if document.attachment_id > 0
            },
        )
        results: list[dict] = []
        document_ids_by_kb: dict[int, list[int]] = {}
        for document_id in document_ids:
            document = documents_by_id.get(document_id)
            if document is None:
                results.append({"id": document_id, "error": "Document not found"})
                continue
            if knowledge_base_ids and document.kind_id not in set(knowledge_base_ids):
                results.append({"id": document_id, "error": "Access denied"})
                continue
            attachment = attachments_by_id.get(document.attachment_id)
            results.append(
                self._build_document_result(
                    document=document,
                    attachment=attachment,
                    offset=offset,
                    limit=limit,
                )
            )
            document_ids_by_kb.setdefault(document.kind_id, []).append(document.id)
        if user_subtask_id and user_id is not None and user_id > 0:
            self._persist_kb_head_usage(
                db,
                user_subtask_id=user_subtask_id,
                user_id=user_id,
                document_ids_by_kb=document_ids_by_kb,
                offset=offset,
                limit=limit,
            )
        return results


document_read_service = DocumentReadService()
```

```python
# backend/app/services/knowledge/orchestrator.py
from app.services.knowledge.document_read_service import document_read_service
```

```python
# backend/app/api/endpoints/internal/rag.py
from app.services.knowledge.document_read_service import document_read_service
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/services/knowledge/test_document_read_service.py tests/services/knowledge/test_orchestrator.py tests/api/endpoints/test_knowledge_document_detail_endpoints.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/knowledge/document_read_service.py backend/app/services/knowledge/orchestrator.py backend/app/api/endpoints/internal/rag.py backend/tests/services/knowledge/test_document_read_service.py
git commit -m "refactor(knowledge): move document read service to control plane"
```

### Task 3: Finish Data-Plane Cleanup for Splitter and Delete Paths

**Files:**
- Create: `backend/app/services/rag/splitter/runtime_config.py`
- Modify: `backend/app/services/rag/local_data_plane/indexing.py`
- Modify: `backend/app/services/knowledge/indexing.py`
- Modify: `backend/app/services/rag/gateway.py`
- Modify: `backend/app/services/rag/local_gateway.py`
- Modify: `backend/app/services/knowledge/knowledge_service.py`
- Modify: `backend/tests/services/knowledge/test_index_runtime.py`
- Modify: `backend/tests/services/rag/test_local_gateway.py`

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/services/rag/test_local_gateway.py
from unittest.mock import AsyncMock

import pytest

from app.services.rag.local_gateway import LocalRagGateway


@pytest.mark.asyncio
async def test_local_gateway_delete_document_index_delegates_to_delete_executor():
    gateway = LocalRagGateway()
    gateway._delete_executor = AsyncMock(return_value={"deleted": True})

    result = await gateway.delete_document_index(
        knowledge_base_id=1,
        document_ref="9",
        db=object(),
    )

    assert result == {"deleted": True}
    gateway._delete_executor.assert_awaited_once()
```

```python
# backend/tests/services/knowledge/test_index_runtime.py
def test_splitter_runtime_parser_supports_smart_type():
    from app.services.rag.splitter.runtime_config import parse_runtime_splitter_config

    splitter = parse_runtime_splitter_config({"type": "smart"})

    assert splitter.type == "smart"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/services/rag/test_local_gateway.py tests/services/knowledge/test_index_runtime.py -v`
Expected: FAIL because `delete_document_index(...)` and `parse_runtime_splitter_config(...)` do not exist.

- [ ] **Step 3: Implement the neutral splitter helper and delete-index gateway seam**

```python
# backend/app/services/rag/splitter/runtime_config.py
from app.schemas.rag import SemanticSplitterConfig, SentenceSplitterConfig, SmartSplitterConfig


def parse_runtime_splitter_config(config_dict: dict | None):
    if not config_dict:
        return None
    splitter_type = config_dict.get("type")
    if splitter_type == "semantic":
        return SemanticSplitterConfig(**config_dict)
    if splitter_type == "smart":
        return SmartSplitterConfig(**config_dict)
    return SentenceSplitterConfig(**config_dict)
```

```python
# backend/app/services/rag/local_gateway.py
class LocalRagGateway:
    def __init__(self) -> None:
        self._delete_executor = delete_document_index_local

    async def delete_document_index(self, knowledge_base_id: int, document_ref: str, *, db):
        return await self._delete_executor(
            knowledge_base_id=knowledge_base_id,
            document_ref=document_ref,
            db=db,
        )
```

```python
# backend/app/services/knowledge/knowledge_service.py
result = asyncio.run(
    rag_gateway.delete_document_index(
        knowledge_base_id=kind_id,
        document_ref=doc_ref,
        db=db,
    )
)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/services/rag/test_local_gateway.py tests/services/knowledge/test_index_runtime.py tests/services/knowledge/test_orchestrator.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/rag/splitter/runtime_config.py backend/app/services/rag/local_data_plane/indexing.py backend/app/services/knowledge/indexing.py backend/app/services/rag/gateway.py backend/app/services/rag/local_gateway.py backend/app/services/knowledge/knowledge_service.py backend/tests/services/rag/test_local_gateway.py backend/tests/services/knowledge/test_index_runtime.py
git commit -m "refactor(rag): finish boundary cleanup for execution seams"
```

### Task 4: Introduce Backend `ProtectedKnowledgeMediator`

**Files:**
- Create: `backend/app/services/knowledge/protected_model_resolver.py`
- Create: `backend/app/services/knowledge/protected_mediation.py`
- Create: `backend/tests/services/knowledge/test_protected_mediation.py`

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/services/knowledge/test_protected_mediation.py
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.knowledge.protected_mediation import (
    ProtectedKnowledgeMediationService,
    RestrictedSafeSummaryResult,
)


@pytest.mark.asyncio
async def test_mediator_uses_current_model_identity_first():
    service = ProtectedKnowledgeMediationService()

    with patch.object(
        service._model_resolver,
        "resolve_model_config",
        return_value={"model_id": "gpt-4o"},
    ) as mock_resolve, patch.object(
        service,
        "_summarize_records",
        AsyncMock(
            return_value=RestrictedSafeSummaryResult(
                decision="answer",
                reason="ok",
                summary="High-level diagnosis",
                observations=[],
                risks=[],
                recommended_actions=[],
                answer_guidance="Stay abstract",
                confidence="medium",
            )
        ),
    ):
        result = await service.transform(
            db=MagicMock(),
            query="What is broken?",
            retrieval_mode="rag_retrieval",
            records=[{"content": "secret", "title": "doc", "knowledge_base_id": 1}],
            mediation_context={
                "current_model_name": "my-model",
                "current_model_namespace": "default",
            },
            knowledge_base_ids=[1],
        )

    mock_resolve.assert_called_once()
    assert result.mode == "restricted_safe_summary"
    assert result.restricted_safe_summary.summary == "High-level diagnosis"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/services/knowledge/test_protected_mediation.py -v`
Expected: FAIL because `app.services.knowledge.protected_mediation` does not exist.

- [ ] **Step 3: Implement mediator request/response models and model resolution**

```python
# backend/app/services/knowledge/protected_mediation.py
class RestrictedSafeSummaryResult(BaseModel):
    decision: Literal["answer", "refuse"]
    reason: str
    summary: str
    observations: list[str] = Field(default_factory=list)
    risks: list[str] = Field(default_factory=list)
    recommended_actions: list[str] = Field(default_factory=list)
    answer_guidance: str
    confidence: Literal["high", "medium", "low"] = "low"


class ProtectedKnowledgeMediationResponse(BaseModel):
    mode: Literal["restricted_safe_summary"] = "restricted_safe_summary"
    retrieval_mode: Literal["direct_injection", "rag_retrieval"]
    restricted_safe_summary: RestrictedSafeSummaryResult
    answer_contract: str
    message: str
    total: int
    total_estimated_tokens: int = 0
```

```python
# backend/app/services/knowledge/protected_model_resolver.py
class ProtectedModelResolver:
    def resolve_model_config(
        self,
        *,
        db,
        mediation_context: dict | None,
        knowledge_base_ids: list[int],
        user_id: int | None,
    ) -> dict:
        if mediation_context and mediation_context.get("current_model_name"):
            return self._resolve_named_model(
                db=db,
                model_name=mediation_context["current_model_name"],
                model_namespace=mediation_context.get(
                    "current_model_namespace", "default"
                ),
                user_id=user_id,
            )
        fallback = self._resolve_task_or_team_default_model(
            db=db,
            user_id=user_id,
            knowledge_base_ids=knowledge_base_ids,
        )
        if fallback:
            return fallback
        return self._resolve_summary_or_system_fallback(
            db=db,
            knowledge_base_ids=knowledge_base_ids,
            user_id=user_id,
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/services/knowledge/test_protected_mediation.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/knowledge/protected_model_resolver.py backend/app/services/knowledge/protected_mediation.py backend/tests/services/knowledge/test_protected_mediation.py
git commit -m "feat(knowledge): add protected knowledge mediator"
```

### Task 5: Extend `/api/internal/rag/retrieve` for Restricted Mediation and Control-Plane Persistence

**Files:**
- Modify: `backend/app/api/endpoints/internal/rag.py`
- Modify: `backend/tests/services/rag/test_retrieval_service.py`
- Create: `backend/tests/api/endpoints/internal/test_rag_retrieve_endpoint.py`

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/api/endpoints/internal/test_rag_retrieve_endpoint.py
from unittest.mock import AsyncMock, patch


def test_internal_retrieve_returns_restricted_safe_summary(test_client):
    payload = {
        "query": "What risks do you see?",
        "knowledge_base_ids": [1],
        "runtime_context": {
            "context_window": 10000,
            "used_context_tokens": 100,
            "reserved_output_tokens": 2048,
            "context_buffer_ratio": 0.1,
            "max_direct_chunks": 500,
        },
        "persistence_context": {
            "user_subtask_id": 11,
            "user_id": 7,
            "restricted_mode": True,
        },
        "mediation_context": {
            "current_model_name": "main-model",
            "current_model_namespace": "default",
        },
    }

    with patch(
        "app.api.endpoints.internal.rag.LocalRagGateway.query",
        new_callable=AsyncMock,
        return_value={
            "mode": "rag_retrieval",
            "records": [{"content": "secret", "title": "doc", "knowledge_base_id": 1}],
            "total": 1,
            "total_estimated_tokens": 33,
        },
    ), patch(
        "app.api.endpoints.internal.rag.protected_knowledge_mediator.transform",
        new_callable=AsyncMock,
        return_value={
            "mode": "restricted_safe_summary",
            "retrieval_mode": "rag_retrieval",
            "restricted_safe_summary": {"decision": "answer", "reason": "ok", "summary": "High-level diagnosis", "observations": [], "risks": [], "recommended_actions": [], "answer_guidance": "Stay abstract", "confidence": "medium"},
            "answer_contract": "Do not quote.",
            "message": "Protected KB material was analyzed internally.",
            "total": 1,
            "total_estimated_tokens": 33,
        },
    ):
        response = test_client.post("/api/internal/rag/retrieve", json=payload)

    assert response.status_code == 200
    body = response.json()
    assert body["mode"] == "restricted_safe_summary"
    assert body["retrieval_mode"] == "rag_retrieval"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/api/endpoints/internal/test_rag_retrieve_endpoint.py tests/services/rag/test_retrieval_service.py -v`
Expected: FAIL because `mediation_context` and restricted-safe-summary responses are not supported yet.

- [ ] **Step 3: Implement new request/response models and endpoint orchestration**

```python
# backend/app/api/endpoints/internal/rag.py
class RetrieveMediationContext(BaseModel):
    current_model_name: str | None = None
    current_model_namespace: str | None = "default"


class RestrictedInternalRetrieveResponse(BaseModel):
    mode: Literal["restricted_safe_summary"]
    retrieval_mode: Literal["direct_injection", "rag_retrieval"]
    restricted_safe_summary: dict
    answer_contract: str
    message: str
    total: int
    total_estimated_tokens: int = 0
```

```python
# backend/app/api/endpoints/internal/rag.py
raw_result = await rag_gateway.query(runtime_spec, db=db)
if persistence_context:
    retrieval_persistence_service.persist_retrieval_result(
        db=db,
        user_subtask_id=persistence_context.user_subtask_id,
        user_id=persistence_context.user_id,
        query=request.query,
        mode=raw_result["mode"],
        records=raw_result.get("records", []),
        restricted_mode=persistence_context.restricted_mode,
    )
if persistence_context and persistence_context.restricted_mode:
    return await protected_knowledge_mediator.transform(
        db=db,
        query=request.query,
        retrieval_mode=raw_result["mode"],
        records=raw_result.get("records", []),
        mediation_context=request.mediation_context.model_dump()
        if request.mediation_context
        else None,
        knowledge_base_ids=knowledge_base_ids,
        total_estimated_tokens=raw_result.get("total_estimated_tokens", 0),
        user_id=persistence_context.user_id,
    )
return InternalRetrieveResponse(
    mode=raw_result["mode"],
    records=[RetrieveRecord(**record) for record in raw_result.get("records", [])],
    total=raw_result.get("total", len(raw_result.get("records", []))),
    total_estimated_tokens=raw_result.get("total_estimated_tokens", 0),
)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/api/endpoints/internal/test_rag_retrieve_endpoint.py tests/services/rag/test_retrieval_service.py tests/services/knowledge/test_protected_mediation.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/endpoints/internal/rag.py backend/tests/api/endpoints/internal/test_rag_retrieve_endpoint.py backend/tests/services/rag/test_retrieval_service.py
git commit -m "feat(rag): mediate restricted internal retrieval in backend"
```

### Task 6: Simplify `chat_shell` Restricted KB Handling into Backend Pass-Through

**Files:**
- Modify: `chat_shell/chat_shell/tools/builtin/knowledge_base.py`
- Modify: `chat_shell/chat_shell/tools/knowledge_factory.py`
- Modify: `chat_shell/tests/test_knowledge_injection_strategy.py`
- Create: `chat_shell/tests/test_knowledge_base_restricted_backend_mode.py`

- [ ] **Step 1: Write the failing tests**

```python
# chat_shell/tests/test_knowledge_base_restricted_backend_mode.py
import json
from unittest.mock import AsyncMock, patch

import pytest

from chat_shell.tools.builtin import KnowledgeBaseTool


@pytest.mark.asyncio
async def test_restricted_tool_forwards_backend_safe_summary():
    tool = KnowledgeBaseTool(
        knowledge_base_ids=[1],
        tool_access_mode="restricted_search_only",
        user_id=7,
        user_subtask_id=11,
    )

    with patch.object(
        tool,
        "_retrieve_with_strategy_from_all_kbs",
        AsyncMock(
            return_value=(
                "restricted_safe_summary",
                {
                    "mode": "restricted_safe_summary",
                    "retrieval_mode": "rag_retrieval",
                    "restricted_safe_summary": {
                        "decision": "answer",
                        "reason": "ok",
                        "summary": "High-level diagnosis",
                        "observations": [],
                        "risks": [],
                        "recommended_actions": [],
                        "answer_guidance": "Stay abstract",
                        "confidence": "medium",
                    },
                    "answer_contract": "Do not quote.",
                    "message": "Protected KB material was analyzed internally.",
                    "total": 1,
                    "total_estimated_tokens": 10,
                },
            )
        ),
    ):
        result = json.loads(await tool._arun("what risks?"))

    assert result["mode"] == "restricted_safe_summary"
    assert result["restricted_safe_summary"]["summary"] == "High-level diagnosis"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd chat_shell && uv run pytest tests/test_knowledge_base_restricted_backend_mode.py tests/test_knowledge_injection_strategy.py -v`
Expected: FAIL because `KnowledgeBaseTool` still performs local restricted summarization and `_retrieve_with_strategy_from_all_kbs(...)` does not forward raw Backend payloads.

- [ ] **Step 3: Remove local restricted summarization from the tool**

```python
# chat_shell/chat_shell/tools/builtin/knowledge_base.py
async def _retrieve_with_strategy_from_all_kbs(
    self,
    query: str,
    max_results: int,
    route_mode: str = "auto",
) -> tuple[str, dict]:
    result = await self._retrieve_with_strategy_via_http(
        query=query,
        max_results=max_results,
        route_mode=route_mode,
    )
    return result.get("mode", InjectionMode.RAG_ONLY), result
```

```python
# chat_shell/chat_shell/tools/builtin/knowledge_base.py
if route_mode == "restricted_safe_summary":
    return json.dumps(raw_backend_result, ensure_ascii=False)
```

```python
# chat_shell/chat_shell/tools/knowledge_factory.py
kb_tool = KnowledgeBaseTool(
    model_id=model_id or KnowledgeBaseTool.model_id,
    context_window=context_window,
    user_name=user_name,
    auth_token=auth_token,
    db_session=db,
    user_subtask_id=user_subtask_id,
)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd chat_shell && uv run pytest tests/test_knowledge_base_restricted_backend_mode.py tests/test_knowledge_injection_strategy.py tests/test_kb_prompt_deduplication.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add chat_shell/chat_shell/tools/builtin/knowledge_base.py chat_shell/chat_shell/tools/knowledge_factory.py chat_shell/tests/test_knowledge_base_restricted_backend_mode.py chat_shell/tests/test_knowledge_injection_strategy.py
git commit -m "refactor(chat-shell): consume restricted kb summaries from backend"
```

### Task 7: Regression Verification, Legacy Notes, and Documentation Alignment

**Files:**
- Modify: `docs/specs/knowledge/2026-03-31-rag-modular-data-plane-design.md`
- Modify: `backend/app/api/endpoints/internal/rag.py`
- Modify: `backend/app/services/rag/README.md`

- [ ] **Step 1: Add final legacy/documentation expectations**

```markdown
Add explicit notes that:
- Phase 2.5 boundary cleanup is complete
- `/api/internal/rag/all-chunks` is a legacy internal endpoint
- restricted mediation now runs in Backend internal retrieval
- `chat_shell` no longer owns restricted safe-summary model execution
```

- [ ] **Step 2: Run backend regression suites**

Run: `cd backend && uv run pytest tests/services/knowledge/test_retrieval_persistence.py tests/services/knowledge/test_document_read_service.py tests/services/knowledge/test_protected_mediation.py tests/services/rag/test_runtime_specs.py tests/services/rag/test_runtime_resolver.py tests/services/rag/test_local_gateway.py tests/services/rag/test_retrieval_service.py tests/services/knowledge/test_index_runtime.py tests/services/knowledge/test_orchestrator.py tests/api/endpoints/internal/test_rag_retrieve_endpoint.py tests/api/endpoints/test_knowledge_document_detail_endpoints.py tests/tasks/test_knowledge_tasks.py -v`
Expected: PASS.

- [ ] **Step 3: Run chat_shell regression suites**

Run: `cd chat_shell && uv run pytest tests/test_knowledge_base_restricted_backend_mode.py tests/test_knowledge_injection_strategy.py tests/test_knowledge_base_call_limits.py tests/test_kb_prompt_deduplication.py -v`
Expected: PASS.

- [ ] **Step 4: Update docs and legacy comments**

```markdown
In `backend/app/services/rag/README.md`, add a short section clarifying:
- `services/rag/` is the execution-side module boundary
- control-plane persistence and restricted mediation live under `services/knowledge/`
- `/api/internal/rag/all-chunks` is retained only as a legacy internal endpoint
```

- [ ] **Step 5: Run the focused regression suites again after doc/comment updates**

Run: `cd backend && uv run pytest tests/services/knowledge/test_protected_mediation.py tests/api/endpoints/internal/test_rag_retrieve_endpoint.py tests/services/rag/test_retrieval_service.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add docs/specs/knowledge/2026-03-31-rag-modular-data-plane-design.md backend/app/api/endpoints/internal/rag.py backend/app/services/rag/README.md
git commit -m "docs(rag): document cleaned boundaries and restricted mediation"
```

## Self-Review

### Spec coverage

- Phase 2.5 boundary cleanup: covered by Tasks 1, 2, and 3
- Moving persistence and `kb_head` helpers out of `services/rag/`: covered by Tasks 1 and 2
- Removing `local_data_plane -> knowledge/indexing.py` reverse dependency: covered by Task 3
- Delete path cleanup through the gateway boundary: covered by Task 3
- Backend restricted mediation and model resolution: covered by Tasks 4 and 5
- `chat_shell` pass-through migration: covered by Task 6
- Legacy endpoint/documentation cleanup: covered by Task 7

### Placeholder scan

- No unresolved placeholders or deferred implementation markers remain.

### Type consistency

- `restricted_safe_summary`, `retrieval_mode`, and `mediation_context` naming is used consistently across Tasks 4, 5, and 6.
- Control-plane persistence is always named `retrieval_persistence_service` after the move to `services/knowledge/`.
