# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Synchronous search preparation must leave the event loop responsive."""

import asyncio
from threading import Event, get_ident
from types import SimpleNamespace
from typing import Any, Callable
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.api.endpoints.knowledge_open import search_documents_open
from app.core.security import AuthContext
from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools import knowledge
from app.schemas.knowledge_search import KnowledgeSearchRequest
from app.services.knowledge import search_execution
from app.services.knowledge.orchestrator import knowledge_orchestrator
from app.services.rag.local_gateway import LocalRagGateway
from app.services.rag.remote_gateway import RemoteRagGatewayError
from app.services.rag.retrieval_service import RetrievalService
from app.services.rag.runtime_resolver import RagRuntimeResolver


@pytest.mark.parametrize(
    "stage", ["reader", "scope", "permission", "runtime", "route", "config"]
)
async def test_search_keeps_event_loop_responsive(
    monkeypatch: pytest.MonkeyPatch, stage: str
) -> None:
    # Arrange: model blocking synchronous extensions at each preparation boundary.
    loop = asyncio.get_running_loop()
    observations = []
    preparation_threads: list[int] = []

    def blocking_io(*args: Any, **kwargs: Any) -> None:
        progressed = Event()
        loop.call_soon_threadsafe(progressed.set)
        observations.append(progressed.wait(timeout=1))
        return None

    db = MagicMock()
    session = MagicMock()
    session.__enter__.return_value = db
    user = SimpleNamespace(id=3, user_name="alice")
    kb = SimpleNamespace(
        json={
            "spec": {
                "retrievalConfig": {
                    "retriever_name": "test",
                    "embedding_config": {"model": "test"},
                }
            }
        }
    )
    runtime = MagicMock()
    runtime.model_copy.return_value = runtime

    def at_stage(name: str, result: Any) -> Callable[..., Any]:
        def call(*args: Any, **kwargs: Any) -> Any:
            if name in {"permission", "runtime", "route", "config"}:
                preparation_threads.append(get_ident())
            if stage == name:
                blocking_io()
            return result

        return call

    monkeypatch.setattr(search_execution, "SessionLocal", lambda: session)
    monkeypatch.setattr(
        search_execution.KnowledgeService,
        "resolve_read_user_for_knowledge_base",
        at_stage("reader", user),
    )
    monkeypatch.setattr(
        search_execution.KnowledgeFolderService,
        "resolve_document_ids_for_scope",
        at_stage("scope", [11]),
    )
    monkeypatch.setattr(
        search_execution.KnowledgeService,
        "get_knowledge_base",
        at_stage("permission", (kb, True)),
    )
    monkeypatch.setattr(
        search_execution.RagRuntimeResolver,
        "build_query_runtime_spec",
        at_stage("runtime", runtime),
    )
    monkeypatch.setattr(
        search_execution.RagRuntimeResolver,
        "build_query_knowledge_base_configs",
        at_stage("config", []),
    )
    monkeypatch.setattr(
        search_execution.RetrievalService,
        "decide_route_mode_for_chat_shell",
        at_stage("route", "rag_retrieval"),
    )
    gateway = SimpleNamespace(query=AsyncMock(return_value={"records": [], "total": 0}))
    monkeypatch.setattr(search_execution, "get_query_gateway", lambda: gateway)

    # Act: run the actual async MCP search and orchestrator entry points.
    result = await knowledge.search_knowledge_base(
        token_info=TaskTokenInfo(task_id=1, subtask_id=2, user_id=3, user_name="alice"),
        knowledge_base_id=7,
        query="policy",
        folder_ids=[5],
    )

    # Assert: another callback runs during blocking I/O, not only after it completes.
    assert "error" not in result, result
    assert observations and all(observations)
    assert len(set(preparation_threads)) == 1
    gateway.query.assert_awaited_once()
    session.__exit__.assert_called()


async def test_openapi_search_resolves_scope_in_worker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """OpenAPI scope resolution must use the same worker-owned preparation path."""
    loop = asyncio.get_running_loop()
    progressed = Event()
    db = MagicMock()
    session = MagicMock()
    session.__enter__.return_value = db
    user = SimpleNamespace(id=3, user_name="alice")
    kb = SimpleNamespace(
        json={
            "spec": {
                "retrievalConfig": {
                    "retriever_name": "test",
                    "embedding_config": {"model": "test"},
                }
            }
        }
    )
    runtime = MagicMock()
    runtime.model_copy.return_value = runtime

    def resolve_scope(*args: Any, **kwargs: Any) -> list[int]:
        loop.call_soon_threadsafe(progressed.set)
        assert progressed.wait(timeout=1)
        return [11]

    monkeypatch.setattr(search_execution, "SessionLocal", lambda: session)
    monkeypatch.setattr(
        search_execution.KnowledgeService,
        "resolve_read_user_for_knowledge_base",
        lambda *args, **kwargs: user,
    )
    monkeypatch.setattr(
        search_execution.KnowledgeFolderService,
        "resolve_document_ids_for_scope",
        resolve_scope,
    )
    monkeypatch.setattr(
        search_execution.KnowledgeService,
        "get_knowledge_base",
        lambda *args, **kwargs: (kb, True),
    )
    monkeypatch.setattr(
        search_execution.RagRuntimeResolver,
        "build_query_runtime_spec",
        lambda *args, **kwargs: runtime,
    )
    monkeypatch.setattr(
        search_execution.RetrievalService,
        "decide_route_mode_for_chat_shell",
        lambda *args, **kwargs: "rag_retrieval",
    )
    monkeypatch.setattr(
        search_execution.RagRuntimeResolver,
        "build_query_knowledge_base_configs",
        lambda *args, **kwargs: [],
    )
    gateway = SimpleNamespace(query=AsyncMock(return_value={"records": []}))
    monkeypatch.setattr(search_execution, "get_query_gateway", lambda: gateway)

    result = await search_documents_open(
        data=KnowledgeSearchRequest(
            knowledge_base_id=7,
            query="policy",
            folder_ids=[5],
        ),
        auth_context=AuthContext(user=user),
    )

    assert result == {"records": []}
    assert progressed.is_set()
    gateway.query.assert_awaited_once()
    session.__exit__.assert_called_once()


@pytest.mark.parametrize("worker_fails", [False, True])
async def test_cancelled_search_waits_for_session_worker(
    monkeypatch: pytest.MonkeyPatch,
    worker_fails: bool,
) -> None:
    loop = asyncio.get_running_loop()
    started = asyncio.Event()
    release = Event()
    finished = Event()
    db = MagicMock()
    session = MagicMock()
    session.__enter__.return_value = db
    closed_after_worker = []
    session.__exit__.side_effect = lambda *args: closed_after_worker.append(
        finished.is_set()
    )

    def read_user(*args: Any, **kwargs: Any) -> None:
        loop.call_soon_threadsafe(started.set)
        try:
            assert release.wait(timeout=5)
            if worker_fails:
                raise ValueError("Permission resolution failed after cancellation")
        finally:
            finished.set()

    monkeypatch.setattr(search_execution, "SessionLocal", lambda: session)
    monkeypatch.setattr(
        search_execution.KnowledgeService,
        "resolve_read_user_for_knowledge_base",
        read_user,
    )
    task = asyncio.create_task(
        knowledge.search_knowledge_base(
            token_info=TaskTokenInfo(
                task_id=1, subtask_id=2, user_id=3, user_name="alice"
            ),
            knowledge_base_id=7,
            query="policy",
        )
    )
    try:
        await asyncio.wait_for(started.wait(), timeout=5)
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.sleep(0)
    finally:
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert closed_after_worker == [True]


async def test_remote_failure_falls_back_to_local_with_worker_owned_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Retryable remote errors must execute local fallback with a closed Session."""
    session = MagicMock()
    session.__enter__.return_value = MagicMock()
    local_finished = Event()
    session.__exit__.side_effect = lambda *args: local_finished.is_set()
    runtime_spec = object()
    remote_error = RemoteRagGatewayError("runtime unavailable", retryable=True)
    remote_gateway = SimpleNamespace(query=AsyncMock(side_effect=remote_error))

    async def local_query(_self: LocalRagGateway, spec: Any, *, db: Any) -> dict:
        assert spec is runtime_spec
        assert db is session.__enter__.return_value
        local_finished.set()
        return {"records": [{"content": "local"}], "total": 1}

    monkeypatch.setattr(search_execution, "SessionLocal", lambda: session)
    monkeypatch.setattr(
        search_execution.KnowledgeSearchRunner,
        "_prepare",
        staticmethod(lambda **kwargs: runtime_spec),
    )
    monkeypatch.setattr(search_execution, "get_query_gateway", lambda: remote_gateway)
    monkeypatch.setattr(LocalRagGateway, "query", local_query)

    result = await search_execution.knowledge_search_runner.retrieve(
        user_id=3,
        task_id=None,
        knowledge_base_id=7,
        query="policy",
        max_results=10,
        document_ids=None,
        folder_ids=None,
        include_subfolders=True,
        route_mode="rag_retrieval",
        context_window=128000,
        used_context_tokens=0,
        reserved_output_tokens=4096,
        context_buffer_ratio=0.1,
        max_direct_chunks=500,
        search_hints=None,
    )

    assert result["records"] == [{"content": "local"}]
    remote_gateway.query.assert_awaited_once_with(runtime_spec)
    session.__exit__.assert_called_once()
    assert (
        session.__exit__.call_args.args and session.__exit__.call_args.args[0] is None
    )


async def test_retrieve_knowledge_restores_default_for_non_positive_max_results(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The public orchestrator keeps the historical fallback default of ten."""
    retrieve = AsyncMock(return_value={"records": []})
    monkeypatch.setattr(
        search_execution.knowledge_search_runner,
        "retrieve",
        retrieve,
    )

    await knowledge_orchestrator.retrieve_knowledge(
        user_id=3,
        knowledge_base_id=7,
        query="policy",
        max_results=0,
    )

    assert retrieve.await_args.kwargs["max_results"] == 10
