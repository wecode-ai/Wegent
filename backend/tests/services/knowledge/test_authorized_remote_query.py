# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Focused tests for the authorized remote query closure.

The Backend product entry must reach knowledge_runtime with the resources it
authorized, must not turn an empty document set into a whole-knowledge-base
query, and must surface remote failures instead of querying local storage.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from app.services.knowledge import search_execution
from app.services.rag.local_gateway import LocalRagGateway
from app.services.rag.remote_gateway import RemoteRagGateway, RemoteRagGatewayError
from app.services.rag.runtime_resolver import RagRuntimeResolver
from app.services.rag.runtime_specs import QueryRuntimeSpec
from shared.models import RetrievalScope

_RETRIEVAL_CONFIG = {
    "retriever_name": "retriever-a",
    "retriever_namespace": "default",
    "embedding_config": {"model_name": "embed-a", "model_namespace": "default"},
}


def _kb() -> Any:
    return SimpleNamespace(
        id=7,
        user_id=42,
        json={"spec": {"retrievalConfig": _RETRIEVAL_CONFIG}},
    )


def _prepare_environment(
    monkeypatch: pytest.MonkeyPatch,
    *,
    resolved_document_ids: list[int] | None,
    has_access: bool = True,
) -> list[dict[str, Any]]:
    """Patch the worker-owned preparation dependencies for one search."""
    session = MagicMock()
    session.__enter__.return_value = MagicMock()
    user = SimpleNamespace(id=3, user_name="alice")
    captured: list[dict[str, Any]] = []

    def build_spec(**kwargs: Any) -> QueryRuntimeSpec:
        captured.append(kwargs)
        return QueryRuntimeSpec(
            knowledge_base_ids=kwargs["knowledge_base_ids"],
            query=kwargs["query"],
            max_results=kwargs["max_results"],
            route_mode="rag_retrieval",
            scope=kwargs["scope"],
            user_id=kwargs["user_id"],
            user_name=kwargs["user_name"],
        )

    monkeypatch.setattr(search_execution, "SessionLocal", lambda: session)
    monkeypatch.setattr(
        search_execution.KnowledgeService,
        "resolve_read_user_for_knowledge_base",
        lambda *args, **kwargs: user,
    )
    monkeypatch.setattr(
        search_execution.KnowledgeFolderService,
        "resolve_document_ids_for_scope",
        lambda *args, **kwargs: resolved_document_ids,
    )
    monkeypatch.setattr(
        search_execution.KnowledgeService,
        "get_knowledge_base",
        lambda *args, **kwargs: (_kb(), has_access),
    )
    monkeypatch.setattr(
        search_execution.RagRuntimeResolver,
        "build_query_runtime_spec",
        staticmethod(build_spec),
    )
    monkeypatch.setattr(
        search_execution.RagRuntimeResolver,
        "build_query_authorized_resources",
        staticmethod(lambda **kwargs: ["authorized-resources"]),
    )
    monkeypatch.setattr(
        search_execution.RetrievalService,
        "decide_route_mode_for_chat_shell",
        lambda *args, **kwargs: "rag_retrieval",
    )
    return captured


def _prepare_kwargs(**overrides: Any) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "user_id": 3,
        "task_id": None,
        "knowledge_base_id": 7,
        "query": "policy",
        "max_results": 10,
        "document_ids": None,
        "folder_ids": None,
        "include_subfolders": True,
        "route_mode": "rag_retrieval",
        "context_window": 128000,
        "used_context_tokens": 0,
        "reserved_output_tokens": 4096,
        "context_buffer_ratio": 0.1,
        "max_direct_chunks": 500,
        "search_hints": None,
    }
    kwargs.update(overrides)
    return kwargs


def test_whole_knowledge_base_query_has_no_document_scope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _prepare_environment(monkeypatch, resolved_document_ids=None)

    prepared = search_execution.KnowledgeSearchRunner._prepare(**_prepare_kwargs())

    assert prepared is not None
    assert prepared.scope is None
    assert prepared.authorized_resources == ["authorized-resources"]
    assert captured[0]["scope"] is None
    assert captured[0]["knowledge_base_ids"] == [7]


def test_non_empty_document_set_keeps_its_scope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _prepare_environment(monkeypatch, resolved_document_ids=[11, 12])

    prepared = search_execution.KnowledgeSearchRunner._prepare(
        **_prepare_kwargs(document_ids=[11, 12])
    )

    assert prepared is not None
    assert prepared.scope == RetrievalScope(document_ids=[11, 12])
    assert prepared.authorized_resources == ["authorized-resources"]
    assert captured[0]["scope"] == RetrievalScope(document_ids=[11, 12])


def test_empty_document_set_returns_no_query(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _prepare_environment(monkeypatch, resolved_document_ids=[])

    prepared = search_execution.KnowledgeSearchRunner._prepare(
        **_prepare_kwargs(folder_ids=[5])
    )

    assert prepared is None
    assert captured == []


def test_caller_without_knowledge_access_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _prepare_environment(
        monkeypatch, resolved_document_ids=None, has_access=False
    )

    with pytest.raises(ValueError, match="Access denied"):
        search_execution.KnowledgeSearchRunner._prepare(**_prepare_kwargs())

    assert captured == []


async def test_remote_failure_is_exposed_without_local_query(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    spec = QueryRuntimeSpec(
        knowledge_base_ids=[7],
        query="policy",
        route_mode="rag_retrieval",
        user_id=3,
        user_name="alice",
    )
    remote_gateway = SimpleNamespace(
        query=AsyncMock(
            side_effect=RemoteRagGatewayError("runtime unavailable", retryable=True)
        )
    )
    local_query = AsyncMock(side_effect=AssertionError("local must not be called"))

    monkeypatch.setattr(
        search_execution.KnowledgeSearchRunner,
        "_prepare",
        staticmethod(lambda **kwargs: spec),
    )
    monkeypatch.setattr(search_execution, "get_query_gateway", lambda: remote_gateway)
    monkeypatch.setattr(LocalRagGateway, "query", local_query)

    with pytest.raises(RemoteRagGatewayError):
        await search_execution.knowledge_search_runner.retrieve(**_prepare_kwargs())

    remote_gateway.query.assert_awaited_once_with(spec)
    local_query.assert_not_called()


async def test_authorized_references_reach_the_runtime_request(
    monkeypatch: pytest.MonkeyPatch, mocker
) -> None:
    """The resolver-authorized references travel in the knowledge_runtime POST."""
    resolver = RagRuntimeResolver()
    monkeypatch.setattr(resolver, "_get_knowledge_base_record", lambda **kwargs: _kb())
    monkeypatch.setattr(
        "app.services.rag.runtime_resolver.retriever_kinds_service.get_retriever",
        lambda **kwargs: MagicMock(),
    )
    monkeypatch.setattr(resolver, "_get_model_kind", lambda **kwargs: MagicMock())
    authorized = resolver.build_query_authorized_resources(
        db=MagicMock(),
        knowledge_base_ids=[7],
    )
    spec = QueryRuntimeSpec(
        knowledge_base_ids=[7],
        query="policy",
        route_mode="rag_retrieval",
        user_id=3,
        user_name="alice",
        authorized_resources=authorized,
    )
    post = mocker.patch(
        "httpx.AsyncClient.post",
        return_value=httpx.Response(
            200,
            json={"records": [], "total": 0, "total_estimated_tokens": 0},
            request=httpx.Request(
                "POST", "http://knowledge-runtime/internal/rag/query"
            ),
        ),
    )

    await RemoteRagGateway(base_url="http://knowledge-runtime").query(spec)

    body = post.await_args.kwargs["json"]
    assert body["authorized_resources"] == [
        {
            "knowledge_base_id": 7,
            "index_owner_user_id": 42,
            "retriever": {
                "kind": "Retriever",
                "name": "retriever-a",
                "namespace": "default",
            },
            "embedding_model": {
                "kind": "Model",
                "name": "embed-a",
                "namespace": "default",
            },
        }
    ]
