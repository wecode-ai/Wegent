# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Synchronous search preparation must leave the event loop responsive."""

import asyncio
from threading import Event
from types import SimpleNamespace
from typing import Any, Callable
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools import knowledge
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

    def blocking_io(*args: Any, **kwargs: Any) -> None:
        progressed = Event()
        loop.call_soon_threadsafe(progressed.set)
        observations.append(progressed.wait(timeout=1))
        return None

    db = MagicMock()
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
            if stage == name:
                blocking_io()
            return result

        return call

    monkeypatch.setattr(knowledge, "SessionLocal", lambda: db)
    monkeypatch.setattr(
        knowledge, "_get_read_user_for_knowledge_base", at_stage("reader", user)
    )
    monkeypatch.setattr(
        knowledge.KnowledgeFolderService,
        "resolve_document_ids_for_scope",
        at_stage("scope", [11]),
    )
    monkeypatch.setattr(
        knowledge.KnowledgeService,
        "get_knowledge_base",
        at_stage("permission", (kb, True)),
    )
    monkeypatch.setattr(
        RagRuntimeResolver, "build_query_runtime_spec", at_stage("runtime", runtime)
    )
    monkeypatch.setattr(
        RagRuntimeResolver, "build_query_knowledge_base_configs", at_stage("config", [])
    )
    monkeypatch.setattr(
        RetrievalService,
        "decide_route_mode_for_chat_shell",
        at_stage("route", "rag_retrieval"),
    )
    gateway = SimpleNamespace(query=AsyncMock(return_value={"records": [], "total": 0}))
    monkeypatch.setattr(
        "app.services.rag.gateway_factory.get_query_gateway", lambda: gateway
    )

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
    gateway.query.assert_awaited_once()
    db.close.assert_called_once()


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
    closed_after_worker = []
    db.close.side_effect = lambda: closed_after_worker.append(finished.is_set())

    def read_user(*args: Any) -> None:
        loop.call_soon_threadsafe(started.set)
        try:
            assert release.wait(timeout=5)
            if worker_fails:
                raise ValueError("Permission resolution failed after cancellation")
        finally:
            finished.set()

    monkeypatch.setattr(knowledge, "SessionLocal", lambda: db)
    monkeypatch.setattr(knowledge, "_get_read_user_for_knowledge_base", read_user)
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
