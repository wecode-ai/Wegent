# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Synchronous search preparation must leave the event loop responsive."""

import asyncio
from threading import Event, get_ident
from types import SimpleNamespace
from typing import Any, Callable
from unittest.mock import AsyncMock, MagicMock

import httpx
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
from app.services.rag.runtime_resolver import RagRuntimeResolver
from app.services.rag.runtime_specs import QueryRuntimeSpec
from shared.models import (
    RemoteKnowledgeBaseQueryConfig,
    RuntimeEmbeddingModelConfig,
    RuntimeRetrievalConfig,
    RuntimeRetrieverConfig,
)


def _build_remote_response(
    *,
    status_code: int = 200,
    json_body: dict | None = None,
) -> httpx.Response:
    request = httpx.Request("POST", "http://knowledge-runtime/internal/rag/query")
    return httpx.Response(status_code, json=json_body or {}, request=request)


def _remote_query_config(knowledge_base_id: int) -> RemoteKnowledgeBaseQueryConfig:
    return RemoteKnowledgeBaseQueryConfig(
        knowledge_base_id=knowledge_base_id,
        index_owner_user_id=3,
        retriever_config=RuntimeRetrieverConfig(
            name="retriever-a",
            namespace="default",
            storage_config={"type": "qdrant"},
        ),
        embedding_model_config=RuntimeEmbeddingModelConfig(
            model_name="embed-a",
            model_namespace="default",
            resolved_config={"protocol": "openai"},
        ),
        retrieval_config=RuntimeRetrievalConfig(top_k=20),
    )


async def _retrieve(runtime_spec: QueryRuntimeSpec) -> dict:
    return await search_execution.knowledge_search_runner.retrieve(
        user_id=3,
        task_id=None,
        knowledge_base_id=runtime_spec.knowledge_base_ids[0],
        query="policy",
        max_results=10,
        document_ids=None,
        folder_ids=None,
        include_subfolders=True,
        route_mode=runtime_spec.route_mode,
        context_window=128000,
        used_context_tokens=0,
        reserved_output_tokens=4096,
        context_buffer_ratio=0.1,
        max_direct_chunks=500,
        search_hints=None,
    )


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
    runtime = QueryRuntimeSpec(
        knowledge_base_ids=[7],
        query="policy",
        user_id=3,
        user_name="alice",
    )

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
        at_stage("config", [_remote_query_config(7)]),
    )
    monkeypatch.setattr(
        search_execution.direct_injection,
        "decide_route_mode_for_chat_shell",
        at_stage("route", "rag_retrieval"),
    )
    remote_post = AsyncMock(
        return_value=_build_remote_response(
            json_body={"records": [], "total": 0, "total_estimated_tokens": 0}
        )
    )
    monkeypatch.setattr("httpx.AsyncClient.post", remote_post)

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
    remote_post.assert_awaited_once()
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
    runtime = QueryRuntimeSpec(
        knowledge_base_ids=[7],
        query="policy",
        user_id=3,
        user_name="alice",
    )

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
        search_execution.direct_injection,
        "decide_route_mode_for_chat_shell",
        lambda *args, **kwargs: "rag_retrieval",
    )
    monkeypatch.setattr(
        search_execution.RagRuntimeResolver,
        "build_query_knowledge_base_configs",
        lambda *args, **kwargs: [_remote_query_config(7)],
    )
    remote_post = AsyncMock(
        return_value=_build_remote_response(
            json_body={"records": [], "total": 0, "total_estimated_tokens": 0}
        )
    )
    monkeypatch.setattr("httpx.AsyncClient.post", remote_post)

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
    remote_post.assert_awaited_once()
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


async def test_remote_failure_is_reported_without_local_execution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A failing knowledge runtime surfaces its error instead of executing locally."""
    runtime_spec = QueryRuntimeSpec(
        knowledge_base_ids=[7],
        query="policy",
        route_mode="rag_retrieval",
        user_id=3,
        knowledge_base_configs=[_remote_query_config(7)],
    )
    remote_error = RemoteRagGatewayError("runtime unavailable", retryable=True)
    local_query = AsyncMock()

    monkeypatch.setattr(
        search_execution.KnowledgeSearchRunner,
        "_prepare",
        staticmethod(lambda **kwargs: runtime_spec),
    )
    monkeypatch.setattr(
        "httpx.AsyncClient.post",
        AsyncMock(
            return_value=_build_remote_response(
                status_code=503,
                json_body={
                    "code": "runtime_unavailable",
                    "message": remote_error.args[0],
                    "retryable": True,
                },
            )
        ),
    )
    monkeypatch.setattr(LocalRagGateway, "query", local_query)

    with pytest.raises(RemoteRagGatewayError):
        await _retrieve(runtime_spec)

    local_query.assert_not_called()


async def test_direct_injection_hit_never_queries_knowledge_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A direct injection hit is served from MySQL without a knowledge runtime call."""
    runtime_spec = QueryRuntimeSpec(
        knowledge_base_ids=[7],
        query="policy",
        route_mode="direct_injection",
        user_id=3,
    )
    session = MagicMock()
    session.__enter__.return_value = MagicMock()
    remote_post = AsyncMock()

    monkeypatch.setattr(search_execution, "SessionLocal", lambda: session)
    monkeypatch.setattr(
        search_execution.KnowledgeSearchRunner,
        "_prepare",
        staticmethod(lambda **kwargs: runtime_spec),
    )
    monkeypatch.setattr(
        search_execution.direct_injection,
        "get_original_documents_from_knowledge_base",
        AsyncMock(
            return_value=[
                {
                    "content": "full document",
                    "score": 1.0,
                    "title": "Original doc",
                    "metadata": {"document_id": 10, "total_length": 13},
                    "knowledge_base_id": 7,
                }
            ]
        ),
    )
    monkeypatch.setattr("httpx.AsyncClient.post", remote_post)

    result = await _retrieve(runtime_spec)

    assert result["mode"] == "direct_injection"
    assert [record["content"] for record in result["records"]] == ["full document"]
    assert session.__exit__.called
    remote_post.assert_not_called()


async def test_rejected_direct_injection_queries_knowledge_runtime_with_config(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A rejected injection is executed remotely with the KB runtime config."""
    runtime_spec = QueryRuntimeSpec(
        knowledge_base_ids=[7],
        query="policy",
        route_mode="direct_injection",
        user_id=3,
        user_name="alice",
    )
    session = MagicMock()
    session.__enter__.return_value = MagicMock()
    remote_post = AsyncMock(
        return_value=_build_remote_response(
            json_body={
                "records": [
                    {
                        "content": "retrieved chunk",
                        "title": "Chunk doc",
                        "score": 0.5,
                        "knowledge_base_id": 7,
                    }
                ],
                "total": 1,
                "total_estimated_tokens": 4,
            }
        )
    )

    monkeypatch.setattr(search_execution, "SessionLocal", lambda: session)
    monkeypatch.setattr(
        search_execution.KnowledgeSearchRunner,
        "_prepare",
        staticmethod(lambda **kwargs: runtime_spec),
    )
    monkeypatch.setattr(
        search_execution.direct_injection,
        "get_original_documents_from_knowledge_base",
        AsyncMock(return_value=None),
    )
    monkeypatch.setattr(
        RagRuntimeResolver,
        "build_query_knowledge_base_configs",
        lambda *args, **kwargs: [_remote_query_config(7)],
    )
    monkeypatch.setattr("httpx.AsyncClient.post", remote_post)

    result = await _retrieve(runtime_spec)

    assert result["mode"] == "rag_retrieval"
    assert [record["content"] for record in result["records"]] == ["retrieved chunk"]
    remote_post.assert_awaited_once()
    assert remote_post.await_args.args[0].endswith("/internal/rag/query")
    posted_body = remote_post.await_args.kwargs["json"]
    assert posted_body["knowledge_base_ids"] == [7]
    assert [
        config["knowledge_base_id"] for config in posted_body["knowledge_base_configs"]
    ] == [7]
    assert posted_body["knowledge_base_configs"][0]["retriever_config"]["name"] == (
        "retriever-a"
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
