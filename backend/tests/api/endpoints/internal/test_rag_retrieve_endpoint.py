# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import ANY, AsyncMock, patch

from app.core.config import settings
from app.services.rag.remote_gateway import RemoteRagGatewayError
from app.services.rag.runtime_specs import (
    DirectInjectionBudget,
    QueryRuntimeSpec,
)


def _make_runtime_spec(
    *,
    route_mode: str = "auto",
    knowledge_base_ids: list[int] | None = None,
    document_ids: list[int] | None = None,
    query: str = "test",
    with_budget: bool = False,
) -> QueryRuntimeSpec:
    return QueryRuntimeSpec(
        knowledge_base_ids=knowledge_base_ids or [1],
        document_ids=document_ids,
        query=query,
        route_mode=route_mode,
        direct_injection_budget=(
            DirectInjectionBudget(context_window=10000) if with_budget else None
        ),
    )


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

    with (
        patch(
            "app.api.endpoints.internal.rag.RagRuntimeResolver.build_query_runtime_spec",
            return_value=_make_runtime_spec(
                knowledge_base_ids=[1],
                query=payload["query"],
                with_budget=True,
            ),
        ),
        patch(
            "app.api.endpoints.internal.rag.LocalRagGateway.query",
            new_callable=AsyncMock,
            return_value={
                "mode": "rag_retrieval",
                "records": [
                    {
                        "content": "secret",
                        "title": "doc",
                        "knowledge_base_id": 1,
                    }
                ],
                "total": 1,
                "total_estimated_tokens": 33,
            },
        ),
        patch(
            "app.api.endpoints.internal.rag.retrieval_persistence_service.persist_retrieval_result"
        ) as mock_persist,
        patch(
            "app.api.endpoints.internal.rag.protected_knowledge_mediator.transform",
            new_callable=AsyncMock,
            return_value={
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
                "total_estimated_tokens": 33,
            },
        ) as mock_transform,
    ):
        response = test_client.post("/api/internal/rag/retrieve", json=payload)

    assert response.status_code == 200
    body = response.json()
    assert body["mode"] == "restricted_safe_summary"
    assert body["retrieval_mode"] == "rag_retrieval"
    mock_persist.assert_called_once()
    mock_transform.assert_awaited_once()


def test_internal_all_chunks_routes_protocol_request_through_local_gateway(test_client):
    payload = {
        "knowledge_base_id": 7,
        "user_id": 9,
        "max_chunks": 1000,
        "query": "list_index_chunks",
        "metadata_condition": {
            "operator": "and",
            "conditions": [
                {"key": "lang", "operator": "==", "value": "zh"},
            ],
        },
    }
    runtime_spec = object()
    with (
        patch(
            "app.api.endpoints.internal.rag.runtime_resolver.build_public_list_chunks_runtime_spec",
            return_value=runtime_spec,
        ) as mock_build_spec,
        patch(
            "app.api.endpoints.internal.rag.LocalRagGateway.list_chunks",
            new_callable=AsyncMock,
            return_value={
                "chunks": [
                    {
                        "content": "chunk-1",
                        "title": "Doc 1",
                        "chunk_id": 1,
                        "doc_ref": "doc-1",
                        "metadata": {"page": 1},
                    }
                ],
                "total": 1,
            },
        ) as mock_list_chunks,
    ):
        response = test_client.post("/api/internal/rag/all-chunks", json=payload)

    assert response.status_code == 200
    assert response.json() == {
        "chunks": [
            {
                "content": "chunk-1",
                "title": "Doc 1",
                "chunk_id": 1,
                "doc_ref": "doc-1",
                "metadata": {"page": 1},
            }
        ],
        "total": 1,
    }
    mock_build_spec.assert_called_once_with(
        db=ANY,
        knowledge_base_id=7,
        user_id=9,
        user_name=None,
        max_chunks=1000,
        query="list_index_chunks",
        metadata_condition=payload["metadata_condition"],
    )
    mock_list_chunks.assert_awaited_once_with(runtime_spec, db=ANY)


def test_internal_purge_index_routes_protocol_request_through_local_gateway(
    test_client,
):
    payload = {
        "knowledge_base_id": 7,
        "user_id": 9,
    }
    runtime_spec = object()
    with (
        patch(
            "app.api.endpoints.internal.rag.runtime_resolver.build_public_purge_index_runtime_spec",
            return_value=runtime_spec,
        ) as mock_build_spec,
        patch(
            "app.api.endpoints.internal.rag.LocalRagGateway.purge_knowledge_index",
            new_callable=AsyncMock,
            return_value={
                "status": "deleted",
                "knowledge_id": "7",
                "deleted_chunks": 12,
            },
        ) as mock_purge,
    ):
        response = test_client.post(
            "/api/internal/rag/purge-knowledge-index",
            json=payload,
        )

    assert response.status_code == 200
    assert response.json() == {
        "status": "deleted",
        "knowledge_id": "7",
        "deleted_chunks": 12,
    }
    mock_build_spec.assert_called_once_with(
        db=ANY,
        knowledge_base_id=7,
        user_id=9,
        user_name=None,
    )
    mock_purge.assert_awaited_once_with(runtime_spec, db=ANY)


def test_internal_drop_index_routes_protocol_request_through_local_gateway(
    test_client,
):
    payload = {
        "knowledge_base_id": 7,
        "user_id": 9,
    }
    runtime_spec = object()
    with (
        patch(
            "app.api.endpoints.internal.rag.runtime_resolver.build_public_drop_index_runtime_spec",
            return_value=runtime_spec,
        ) as mock_build_spec,
        patch(
            "app.api.endpoints.internal.rag.LocalRagGateway.drop_knowledge_index",
            new_callable=AsyncMock,
            return_value={
                "status": "dropped",
                "knowledge_id": "7",
                "index_name": "wegent_kb_7",
            },
        ) as mock_drop,
    ):
        response = test_client.post(
            "/api/internal/rag/drop-knowledge-index",
            json=payload,
        )

    assert response.status_code == 200
    assert response.json() == {
        "status": "dropped",
        "knowledge_id": "7",
        "index_name": "wegent_kb_7",
    }
    mock_build_spec.assert_called_once_with(
        db=ANY,
        knowledge_base_id=7,
        user_id=9,
        user_name=None,
    )
    mock_drop.assert_awaited_once_with(runtime_spec, db=ANY)


def test_internal_retrieve_keeps_user_subtask_id_out_of_gateway(test_client):
    payload = {
        "query": "How should we proceed?",
        "knowledge_base_ids": [1],
        "persistence_context": {
            "user_subtask_id": 11,
            "user_id": 7,
            "restricted_mode": False,
        },
    }

    with (
        patch(
            "app.api.endpoints.internal.rag.RagRuntimeResolver.build_query_runtime_spec",
            return_value=_make_runtime_spec(
                knowledge_base_ids=[1],
                query=payload["query"],
            ),
        ),
        patch(
            "app.api.endpoints.internal.rag.LocalRagGateway.query",
            new_callable=AsyncMock,
            return_value={
                "mode": "rag_retrieval",
                "records": [],
                "total": 0,
                "total_estimated_tokens": 0,
            },
        ) as mock_query,
        patch(
            "app.api.endpoints.internal.rag.retrieval_persistence_service.persist_retrieval_result"
        ) as mock_persist,
    ):
        response = test_client.post("/api/internal/rag/retrieve", json=payload)

    assert response.status_code == 200
    mock_query.assert_awaited_once_with(ANY, db=ANY)
    mock_persist.assert_called_once()


def test_internal_retrieve_resolves_document_names_before_query(test_client):
    with (
        patch(
            "app.api.endpoints.internal.rag._resolve_document_names",
            return_value=[101, 102],
        ) as mock_resolve,
        patch(
            "app.api.endpoints.internal.rag.RagRuntimeResolver.build_query_runtime_spec",
            return_value=_make_runtime_spec(
                knowledge_base_ids=[12],
                document_ids=[101, 102],
                query="release checklist",
            ),
        ),
        patch(
            "app.api.endpoints.internal.rag.LocalRagGateway.query",
            new_callable=AsyncMock,
            return_value={
                "mode": "rag_retrieval",
                "records": [],
                "total": 0,
                "total_estimated_tokens": 0,
            },
        ) as mock_query,
    ):
        response = test_client.post(
            "/api/internal/rag/retrieve",
            json={
                "query": "release checklist",
                "knowledge_base_ids": [12],
                "document_names": ["release.md"],
            },
        )

    assert response.status_code == 200
    mock_resolve.assert_called_once()
    mock_query.assert_awaited_once()
    assert mock_query.await_args.args[0].document_ids == [101, 102]


def test_internal_retrieve_returns_error_when_document_names_not_found(test_client):
    with patch(
        "app.api.endpoints.internal.rag._resolve_document_names",
        return_value=[],
    ):
        response = test_client.post(
            "/api/internal/rag/retrieve",
            json={
                "query": "release checklist",
                "knowledge_base_ids": [12],
                "document_names": ["missing.md"],
            },
        )

    assert response.status_code == 200
    assert response.json()["mode"] == "rag_retrieval"
    assert response.json()["records"] == []
    assert response.json()["message"].startswith("Document names not found")


def test_internal_retrieve_keeps_direct_injection_routing_in_backend(
    test_client, monkeypatch
):
    monkeypatch.setattr(settings, "RAG_RUNTIME_MODE", {"query": "remote"})

    payload = {
        "query": "How should we proceed?",
        "knowledge_base_ids": [1],
        "route_mode": "direct_injection",
        "persistence_context": {
            "user_subtask_id": 11,
            "user_id": 7,
            "restricted_mode": False,
        },
    }

    with (
        patch(
            "app.api.endpoints.internal.rag.RagRuntimeResolver.build_query_runtime_spec",
            return_value=_make_runtime_spec(
                knowledge_base_ids=[1],
                query=payload["query"],
                route_mode="direct_injection",
            ),
        ),
        patch(
            "app.api.endpoints.internal.rag.get_query_gateway"
        ) as mock_get_query_gateway,
        patch(
            "app.api.endpoints.internal.rag.LocalRagGateway.query",
            new_callable=AsyncMock,
            return_value={
                "mode": "direct_injection",
                "records": [],
                "total": 0,
                "total_estimated_tokens": 0,
            },
        ) as mock_query,
        patch(
            "app.api.endpoints.internal.rag.retrieval_persistence_service.persist_retrieval_result"
        ) as mock_persist,
    ):
        response = test_client.post("/api/internal/rag/retrieve", json=payload)

    assert response.status_code == 200
    mock_get_query_gateway.assert_not_called()
    mock_query.assert_awaited_once_with(ANY, db=ANY)
    mock_persist.assert_called_once()


def test_internal_retrieve_auto_route_uses_remote_gateway_for_rag_retrieval(
    test_client, monkeypatch
):
    monkeypatch.setattr(settings, "RAG_RUNTIME_MODE", {"query": "remote"})

    payload = {
        "query": "How should we proceed?",
        "knowledge_base_ids": [1],
        "route_mode": "auto",
        "runtime_context": {
            "context_window": 10000,
            "used_context_tokens": 100,
            "reserved_output_tokens": 2048,
            "context_buffer_ratio": 0.1,
            "max_direct_chunks": 500,
        },
    }

    remote_gateway = AsyncMock()
    remote_gateway.query.return_value = {
        "mode": "rag_retrieval",
        "records": [],
        "total": 0,
        "total_estimated_tokens": 0,
    }

    with (
        patch(
            "app.api.endpoints.internal.rag.RagRuntimeResolver.build_query_runtime_spec",
            return_value=_make_runtime_spec(
                knowledge_base_ids=[1],
                query=payload["query"],
                with_budget=True,
            ),
        ),
        patch(
            "app.api.endpoints.internal.rag.RetrievalService.decide_route_mode_for_chat_shell",
            return_value="rag_retrieval",
        ),
        patch(
            "app.api.endpoints.internal.rag.get_query_gateway",
            return_value=remote_gateway,
        ) as mock_get_query_gateway,
        patch(
            "app.api.endpoints.internal.rag.LocalRagGateway.query",
            new_callable=AsyncMock,
        ) as mock_local_query,
    ):
        response = test_client.post("/api/internal/rag/retrieve", json=payload)

    assert response.status_code == 200
    mock_get_query_gateway.assert_called_once()
    remote_gateway.query.assert_awaited_once_with(ANY, db=ANY)
    assert remote_gateway.query.await_args.args[0].route_mode == "rag_retrieval"
    mock_local_query.assert_not_called()


def test_internal_retrieve_auto_route_passes_runtime_budget_to_route_decision(
    test_client, monkeypatch
):
    monkeypatch.setattr(settings, "RAG_RUNTIME_MODE", {"query": "remote"})

    payload = {
        "query": "How should we proceed?",
        "knowledge_base_ids": [1],
        "route_mode": "auto",
        "runtime_context": {
            "context_window": 10000,
            "used_context_tokens": 4200,
            "reserved_output_tokens": 1024,
            "context_buffer_ratio": 0.2,
            "max_direct_chunks": 500,
        },
    }

    with (
        patch(
            "app.api.endpoints.internal.rag.RagRuntimeResolver.build_query_runtime_spec",
            return_value=_make_runtime_spec(
                knowledge_base_ids=[1],
                query=payload["query"],
                with_budget=True,
            ),
        ),
        patch(
            "app.api.endpoints.internal.rag.RetrievalService.decide_route_mode_for_chat_shell",
            return_value="rag_retrieval",
        ) as mock_decide_route_mode,
        patch(
            "app.api.endpoints.internal.rag.get_query_gateway",
            return_value=AsyncMock(
                query=AsyncMock(
                    return_value={
                        "mode": "rag_retrieval",
                        "records": [],
                        "total": 0,
                        "total_estimated_tokens": 0,
                    }
                )
            ),
        ),
    ):
        response = test_client.post("/api/internal/rag/retrieve", json=payload)

    assert response.status_code == 200
    mock_decide_route_mode.assert_called_once_with(
        query=payload["query"],
        knowledge_base_ids=[1],
        db=ANY,
        route_mode="auto",
        document_ids=None,
        metadata_condition=None,
        context_window=10000,
        used_context_tokens=4200,
        reserved_output_tokens=1024,
        context_buffer_ratio=0.2,
        max_direct_chunks=500,
    )


def test_internal_retrieve_auto_route_keeps_local_direct_injection(
    test_client, monkeypatch
):
    monkeypatch.setattr(settings, "RAG_RUNTIME_MODE", {"query": "remote"})

    payload = {
        "query": "How should we proceed?",
        "knowledge_base_ids": [1],
        "route_mode": "auto",
        "runtime_context": {
            "context_window": 10000,
            "used_context_tokens": 100,
            "reserved_output_tokens": 2048,
            "context_buffer_ratio": 0.1,
            "max_direct_chunks": 500,
        },
    }

    with (
        patch(
            "app.api.endpoints.internal.rag.RagRuntimeResolver.build_query_runtime_spec",
            return_value=_make_runtime_spec(
                knowledge_base_ids=[1],
                query=payload["query"],
                with_budget=True,
            ),
        ),
        patch(
            "app.api.endpoints.internal.rag.RetrievalService.decide_route_mode_for_chat_shell",
            return_value="direct_injection",
        ),
        patch(
            "app.api.endpoints.internal.rag.get_query_gateway"
        ) as mock_get_query_gateway,
        patch(
            "app.api.endpoints.internal.rag.LocalRagGateway.query",
            new_callable=AsyncMock,
            return_value={
                "mode": "direct_injection",
                "records": [],
                "total": 0,
                "total_estimated_tokens": 0,
            },
        ) as mock_local_query,
    ):
        response = test_client.post("/api/internal/rag/retrieve", json=payload)

    assert response.status_code == 200
    mock_get_query_gateway.assert_not_called()
    mock_local_query.assert_awaited_once_with(ANY, db=ANY)
    assert mock_local_query.await_args.args[0].route_mode == "direct_injection"


def test_internal_retrieve_falls_back_to_local_when_remote_query_fails(
    test_client, monkeypatch
):
    monkeypatch.setattr(settings, "RAG_RUNTIME_MODE", {"query": "remote"})

    payload = {
        "query": "How should we proceed?",
        "knowledge_base_ids": [1],
        "route_mode": "auto",
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
            "restricted_mode": False,
        },
    }

    remote_gateway = AsyncMock()
    remote_gateway.query.side_effect = RemoteRagGatewayError(
        "knowledge runtime unavailable",
        code="runtime_unavailable",
        retryable=True,
        status_code=503,
    )

    with (
        patch(
            "app.api.endpoints.internal.rag.RagRuntimeResolver.build_query_runtime_spec",
            return_value=_make_runtime_spec(
                knowledge_base_ids=[1],
                query=payload["query"],
                with_budget=True,
            ),
        ),
        patch(
            "app.api.endpoints.internal.rag.RetrievalService.decide_route_mode_for_chat_shell",
            return_value="rag_retrieval",
        ),
        patch(
            "app.api.endpoints.internal.rag.get_query_gateway",
            return_value=remote_gateway,
        ) as mock_get_query_gateway,
        patch(
            "app.api.endpoints.internal.rag.LocalRagGateway.query",
            new_callable=AsyncMock,
            return_value={
                "mode": "rag_retrieval",
                "records": [
                    {
                        "content": "fallback result",
                        "title": "Fallback doc",
                        "knowledge_base_id": 1,
                    }
                ],
                "total": 1,
                "total_estimated_tokens": 4,
            },
        ) as mock_local_query,
        patch(
            "app.api.endpoints.internal.rag.retrieval_persistence_service.persist_retrieval_result"
        ) as mock_persist,
    ):
        response = test_client.post("/api/internal/rag/retrieve", json=payload)

    assert response.status_code == 200
    assert response.json() == {
        "mode": "rag_retrieval",
        "records": [
            {
                "content": "fallback result",
                "score": None,
                "title": "Fallback doc",
                "metadata": None,
                "knowledge_base_id": 1,
            }
        ],
        "total": 1,
        "total_estimated_tokens": 4,
        "message": None,
    }
    mock_get_query_gateway.assert_called_once()
    remote_gateway.query.assert_awaited_once_with(ANY, db=ANY)
    mock_local_query.assert_awaited_once_with(ANY, db=ANY)
    assert mock_local_query.await_args.args[0].route_mode == "rag_retrieval"
    mock_persist.assert_called_once()


def test_internal_retrieve_returns_remote_error_without_local_fallback(
    test_client, monkeypatch
):
    monkeypatch.setattr(settings, "RAG_RUNTIME_MODE", {"query": "remote"})

    remote_gateway = AsyncMock()
    remote_gateway.query.side_effect = RemoteRagGatewayError(
        "remote validation failed",
        code="invalid_runtime_request",
        retryable=False,
        status_code=400,
    )

    with (
        patch(
            "app.api.endpoints.internal.rag.RagRuntimeResolver.build_query_runtime_spec",
            return_value=_make_runtime_spec(
                knowledge_base_ids=[1],
                query="How should we proceed?",
                with_budget=True,
            ),
        ),
        patch(
            "app.api.endpoints.internal.rag.RetrievalService.decide_route_mode_for_chat_shell",
            return_value="rag_retrieval",
        ),
        patch(
            "app.api.endpoints.internal.rag.get_query_gateway",
            return_value=remote_gateway,
        ),
        patch(
            "app.api.endpoints.internal.rag.LocalRagGateway.query",
            new_callable=AsyncMock,
        ) as mock_local_query,
    ):
        response = test_client.post(
            "/api/internal/rag/retrieve",
            json={
                "query": "How should we proceed?",
                "knowledge_base_ids": [1],
                "route_mode": "auto",
                "runtime_context": {
                    "context_window": 10000,
                    "used_context_tokens": 100,
                    "reserved_output_tokens": 2048,
                    "context_buffer_ratio": 0.1,
                    "max_direct_chunks": 500,
                },
            },
        )

    assert response.status_code == 400
    assert response.json()["detail"] == "remote validation failed"
    mock_local_query.assert_not_called()
