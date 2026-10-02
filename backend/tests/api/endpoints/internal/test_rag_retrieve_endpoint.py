# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import ANY, AsyncMock, patch

import httpx
import pytest

from app.api.endpoints.internal.rag import RetrieveRecord
from app.core.config import settings
from app.services.rag.runtime_specs import (
    DirectInjectionBudget,
    QueryRuntimeSpec,
)
from app.services.rag.sources import (
    ExternalKnowledgeDocument,
    ExternalKnowledgeDocumentListResult,
    RetrievalSourceSummary,
    retrieval_source_registry,
)
from shared.models import (
    RemoteKnowledgeBaseQueryConfig,
    RetrievalScope,
    RuntimeEmbeddingModelConfig,
    RuntimeRetrievalConfig,
    RuntimeRetrieverConfig,
)


@pytest.fixture(autouse=True)
def configure_internal_service_token(monkeypatch):
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "test-internal-token")


def _internal_headers() -> dict[str, str]:
    token = settings.INTERNAL_SERVICE_TOKEN
    return {"Authorization": f"Bearer {token}"} if token else {}


def _build_remote_response(
    *,
    status_code: int = 200,
    json_body: dict | None = None,
) -> httpx.Response:
    request = httpx.Request("POST", "http://knowledge-runtime/internal/rag/query")
    return httpx.Response(status_code, json=json_body or {}, request=request)


def _make_remote_query_config(knowledge_base_id: int) -> RemoteKnowledgeBaseQueryConfig:
    return RemoteKnowledgeBaseQueryConfig(
        knowledge_base_id=knowledge_base_id,
        index_owner_user_id=7,
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


def _make_runtime_spec(
    *,
    route_mode: str = "auto",
    knowledge_base_ids: list[int] | None = None,
    document_ids: list[int] | None = None,
    query: str = "test",
    with_budget: bool = False,
    with_remote_configs: bool = True,
    user_id: int | None = None,
) -> QueryRuntimeSpec:
    return QueryRuntimeSpec(
        knowledge_base_ids=knowledge_base_ids or [1],
        scope=(
            RetrievalScope(document_ids=document_ids)
            if document_ids is not None
            else None
        ),
        query=query,
        route_mode=route_mode,
        user_id=user_id,
        knowledge_base_configs=(
            [
                _make_remote_query_config(knowledge_base_id)
                for knowledge_base_id in (knowledge_base_ids or [1])
            ]
            if with_remote_configs
            else []
        ),
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
            "app.api.endpoints.internal.rag.runtime_resolver.build_query_runtime_spec",
            return_value=_make_runtime_spec(
                knowledge_base_ids=[1],
                query=payload["query"],
                with_budget=True,
            ),
        ),
        patch(
            "app.api.endpoints.internal.rag._execute_query",
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
        response = test_client.post(
            "/api/internal/rag/retrieve",
            json=payload,
            headers=_internal_headers(),
        )

    assert response.status_code == 200
    body = response.json()
    assert body["mode"] == "restricted_safe_summary"
    assert body["retrieval_mode"] == "rag_retrieval"
    assert "source_summaries" not in body
    mock_persist.assert_called_once()
    mock_transform.assert_awaited_once()


@pytest.mark.parametrize(
    "path",
    [
        "/api/internal/rag/all-chunks",
        "/api/internal/rag/purge-knowledge-index",
        "/api/internal/rag/drop-knowledge-index",
    ],
)
def test_local_only_internal_endpoints_are_not_exposed(test_client, path) -> None:
    """Index administration lives in knowledge_runtime and must not be re-exposed."""
    response = test_client.post(
        path,
        json={"knowledge_base_id": 7, "user_id": 9},
        headers=_internal_headers(),
    )

    assert response.status_code == 404


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
            "app.api.endpoints.internal.rag.runtime_resolver.build_query_runtime_spec",
            return_value=_make_runtime_spec(
                knowledge_base_ids=[1],
                query=payload["query"],
            ),
        ),
        patch(
            "app.api.endpoints.internal.rag._execute_query",
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
        response = test_client.post(
            "/api/internal/rag/retrieve",
            json=payload,
            headers=_internal_headers(),
        )

    assert response.status_code == 200
    mock_query.assert_awaited_once_with(ANY, ANY)
    mock_persist.assert_called_once()


def test_internal_retrieve_resolves_document_names_before_query(test_client):
    with (
        patch(
            "app.api.endpoints.internal.rag._resolve_document_names",
            return_value=[101, 102],
        ) as mock_resolve,
        patch(
            "app.api.endpoints.internal.rag.runtime_resolver.build_query_runtime_spec",
            return_value=_make_runtime_spec(
                knowledge_base_ids=[12],
                document_ids=[101, 102],
                query="release checklist",
            ),
        ),
        patch(
            "app.api.endpoints.internal.rag._execute_query",
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
            headers=_internal_headers(),
        )

    assert response.status_code == 200
    mock_resolve.assert_called_once()
    mock_query.assert_awaited_once()
    assert mock_query.await_args.args[0].scope.document_ids == [101, 102]


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
            headers=_internal_headers(),
        )

    assert response.status_code == 200
    assert response.json()["mode"] == "rag_retrieval"
    assert response.json()["records"] == []
    assert response.json()["message"].startswith("Document names not found")


def test_internal_retrieve_direct_injection_hit_never_queries_knowledge_runtime(
    test_client,
):
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
    injected_records = [
        {
            "content": "full document",
            "title": "Internal doc",
            "knowledge_base_id": 1,
        }
    ]

    with (
        patch(
            "app.api.endpoints.internal.rag.runtime_resolver.build_query_runtime_spec",
            return_value=_make_runtime_spec(
                knowledge_base_ids=[1],
                query=payload["query"],
                route_mode="direct_injection",
                with_remote_configs=False,
            ),
        ),
        patch(
            "app.api.endpoints.internal.rag.runtime_resolver."
            "build_query_knowledge_base_configs",
            side_effect=AssertionError("direct injection must not resolve configs"),
        ),
        patch(
            "app.api.endpoints.internal.rag.direct_injection."
            "try_direct_injection_with_budget",
            new_callable=AsyncMock,
            return_value={
                "mode": "direct_injection",
                "records": injected_records,
                "total": 1,
                "total_estimated_tokens": 10,
            },
        ) as mock_direct_injection,
        patch("httpx.AsyncClient.post") as mock_remote_post,
        patch(
            "app.api.endpoints.internal.rag.retrieval_persistence_service.persist_retrieval_result"
        ) as mock_persist,
    ):
        response = test_client.post(
            "/api/internal/rag/retrieve",
            json=payload,
            headers=_internal_headers(),
        )

    assert response.status_code == 200
    assert "source_summaries" not in response.json()
    assert response.json()["mode"] == "direct_injection"
    assert response.json()["records"][0]["content"] == "full document"
    # Direct injection stays in the Backend and never reaches the knowledge runtime.
    assert mock_direct_injection.await_args.kwargs["knowledge_base_ids"] == [1]
    assert mock_direct_injection.await_args.kwargs["route_mode"] == "direct_injection"
    mock_remote_post.assert_not_called()
    mock_persist.assert_called_once()


def test_internal_retrieve_rejected_direct_injection_queries_knowledge_runtime(
    test_client,
):
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
    remote_response = _build_remote_response(
        json_body={
            "records": [
                {
                    "content": "retrieved chunk",
                    "title": "Chunk doc",
                    "score": 0.5,
                    "knowledge_base_id": 1,
                    "document_id": 10,
                }
            ],
            "total": 1,
            "total_estimated_tokens": 4,
        }
    )

    with (
        patch(
            "app.api.endpoints.internal.rag.runtime_resolver.build_query_runtime_spec",
            return_value=_make_runtime_spec(
                knowledge_base_ids=[1],
                query=payload["query"],
                route_mode="direct_injection",
                with_remote_configs=False,
                user_id=7,
            ),
        ),
        patch(
            "app.api.endpoints.internal.rag.runtime_resolver."
            "build_query_knowledge_base_configs",
            return_value=[_make_remote_query_config(1)],
        ) as mock_build_configs,
        patch(
            "app.api.endpoints.internal.rag.direct_injection."
            "try_direct_injection_with_budget",
            new_callable=AsyncMock,
            return_value=None,
        ) as mock_direct_injection,
        patch(
            "httpx.AsyncClient.post",
            return_value=remote_response,
        ) as mock_remote_post,
        patch(
            "app.api.endpoints.internal.rag.retrieval_persistence_service.persist_retrieval_result"
        ) as mock_persist,
    ):
        response = test_client.post(
            "/api/internal/rag/retrieve",
            json=payload,
            headers=_internal_headers(),
        )

    assert response.status_code == 200
    body = response.json()
    assert body["mode"] == "rag_retrieval"
    assert [record["content"] for record in body["records"]] == ["retrieved chunk"]
    mock_direct_injection.assert_awaited_once()
    # The rejected injection is executed by the knowledge runtime, carrying the
    # resolved runtime config of the knowledge base.
    mock_remote_post.assert_awaited_once()
    assert mock_remote_post.await_args.args[0].endswith("/internal/rag/query")
    posted_body = mock_remote_post.await_args.kwargs["json"]
    assert posted_body["knowledge_base_ids"] == [1]
    assert posted_body["query"] == payload["query"]
    posted_configs = posted_body["knowledge_base_configs"]
    assert [config["knowledge_base_id"] for config in posted_configs] == [1]
    assert posted_configs[0]["retriever_config"]["name"] == "retriever-a"
    assert posted_configs[0]["embedding_model_config"]["model_name"] == "embed-a"
    mock_build_configs.assert_called_once_with(
        db=ANY,
        knowledge_base_ids=[1],
        current_user_id=7,
        user_name=None,
    )
    mock_persist.assert_called_once()


def test_internal_retrieve_mixed_external_records_uses_rag_response_mode(
    test_client,
):
    payload = {
        "query": "How should we proceed?",
        "user_id": 7,
        "knowledge_base_ids": [1],
        "external_knowledge_refs": [
            {
                "provider": "fake",
                "mode": "explicit",
                "id": "external-kb-1",
            }
        ],
        "route_mode": "direct_injection",
        "persistence_context": {
            "user_subtask_id": 11,
            "user_id": 7,
            "restricted_mode": False,
        },
    }
    internal_records = [
        {
            "content": "complete internal content",
            "title": "Internal doc",
            "knowledge_base_id": 1,
            "document_id": 10,
        }
    ]
    external_records = [
        RetrieveRecord(
            content="external snippet",
            title="External doc",
            source_type="fake",
            source_id="external-kb-1",
            source_uri="fake://external-kb-1/doc-1",
            source_name="External KB",
        )
    ]

    with (
        patch(
            "app.api.endpoints.internal.rag.runtime_resolver.build_query_runtime_spec",
            return_value=_make_runtime_spec(
                knowledge_base_ids=[1],
                query=payload["query"],
                route_mode="direct_injection",
            ),
        ),
        patch(
            "app.api.endpoints.internal.rag.direct_injection."
            "try_direct_injection_with_budget",
            new_callable=AsyncMock,
            return_value={
                "mode": "direct_injection",
                "records": internal_records,
                "total": 1,
                "total_estimated_tokens": 10,
            },
        ),
        patch(
            "app.api.endpoints.internal.rag._retrieve_external_sources",
            new_callable=AsyncMock,
            return_value=(
                external_records,
                [
                    RetrievalSourceSummary(
                        provider="fake",
                        searched_source_ids=["external-kb-1"],
                        ignored_source_ids=[],
                    )
                ],
            ),
        ) as mock_external_retrieve,
        patch(
            "app.api.endpoints.internal.rag.retrieval_persistence_service.persist_retrieval_result"
        ) as mock_persist,
    ):
        response = test_client.post(
            "/api/internal/rag/retrieve",
            json=payload,
            headers=_internal_headers(),
        )

    assert response.status_code == 200
    body = response.json()
    assert body["mode"] == "rag_retrieval"
    assert body["total"] == 2
    assert [record["content"] for record in body["records"]] == [
        "complete internal content",
        "external snippet",
    ]
    assert body["records"][1]["source_type"] == "fake"
    assert body["source_summaries"][0]["provider"] == "fake"
    mock_external_retrieve.assert_awaited_once()
    mock_persist.assert_called_once()
    assert mock_persist.call_args.kwargs["mode"] == "direct_injection"
    assert mock_persist.call_args.kwargs["records"] == internal_records


def test_internal_retrieve_requires_user_id_for_external_refs(test_client):
    response = test_client.post(
        "/api/internal/rag/retrieve",
        json={
            "query": "plan",
            "external_knowledge_refs": [
                {"provider": "fake", "mode": "explicit", "id": "external-kb-1"}
            ],
        },
        headers=_internal_headers(),
    )

    assert response.status_code == 400
    assert (
        response.json()["detail"]
        == "user_id is required for external knowledge retrieval"
    )


def test_internal_list_documents_requires_user_id_for_external_refs(test_client):
    response = test_client.post(
        "/api/internal/knowledge/list-documents",
        json={
            "external_knowledge_refs": [
                {"provider": "fake", "mode": "explicit", "id": "external-kb-1"}
            ],
            "limit": 20,
            "offset": 0,
        },
        headers=_internal_headers(),
    )

    assert response.status_code == 400
    assert (
        response.json()["detail"]
        == "user_id is required for external knowledge document listing"
    )


def test_internal_list_documents_reports_per_provider_pagination_scope(
    test_client, monkeypatch
):
    provider = AsyncMock()
    provider.name = "fake"
    provider.list_documents = AsyncMock(
        return_value=ExternalKnowledgeDocumentListResult(
            documents=[
                ExternalKnowledgeDocument(
                    provider="fake",
                    source_id="external-kb-1",
                    source_name="Fake KB",
                    document_id="doc-1",
                    title="Doc 1",
                )
            ]
        )
    )
    monkeypatch.setitem(retrieval_source_registry._providers, "fake", provider)

    response = test_client.post(
        "/api/internal/knowledge/list-documents",
        json={
            "user_id": 7,
            "external_knowledge_refs": [
                {"provider": "fake", "mode": "explicit", "id": "external-kb-1"}
            ],
            "limit": 20,
            "offset": 0,
        },
        headers=_internal_headers(),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["total_returned"] == 1
    assert body["pagination_scope"] == "per_provider"
    provider.list_documents.assert_awaited_once()


def test_internal_retrieve_auto_route_queries_knowledge_runtime(test_client):
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
            "app.api.endpoints.internal.rag.runtime_resolver.build_query_runtime_spec",
            return_value=_make_runtime_spec(
                knowledge_base_ids=[1],
                query=payload["query"],
                with_budget=True,
                with_remote_configs=False,
            ),
        ),
        patch(
            "app.api.endpoints.internal.rag.direct_injection.decide_route_mode_for_chat_shell",
            return_value="rag_retrieval",
        ),
        patch(
            "app.api.endpoints.internal.rag.runtime_resolver."
            "build_query_knowledge_base_configs",
            return_value=[_make_remote_query_config(1)],
        ) as mock_build_configs,
        patch(
            "httpx.AsyncClient.post",
            return_value=_build_remote_response(
                json_body={"records": [], "total": 0, "total_estimated_tokens": 0}
            ),
        ) as mock_remote_post,
    ):
        response = test_client.post(
            "/api/internal/rag/retrieve",
            json=payload,
            headers=_internal_headers(),
        )

    assert response.status_code == 200
    mock_remote_post.assert_awaited_once()
    assert mock_remote_post.await_args.args[0].endswith("/internal/rag/query")
    posted_body = mock_remote_post.await_args.kwargs["json"]
    assert [
        config["knowledge_base_id"] for config in posted_body["knowledge_base_configs"]
    ] == [1]
    mock_build_configs.assert_called_once()


def test_internal_retrieve_auto_route_passes_runtime_budget_to_route_decision(
    test_client,
):
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
            "app.api.endpoints.internal.rag.runtime_resolver.build_query_runtime_spec",
            return_value=_make_runtime_spec(
                knowledge_base_ids=[1],
                query=payload["query"],
                with_budget=True,
            ),
        ),
        patch(
            "app.api.endpoints.internal.rag.direct_injection.decide_route_mode_for_chat_shell",
            return_value="rag_retrieval",
        ) as mock_decide_route_mode,
        patch(
            "httpx.AsyncClient.post",
            return_value=_build_remote_response(
                json_body={"records": [], "total": 0, "total_estimated_tokens": 0}
            ),
        ),
    ):
        response = test_client.post(
            "/api/internal/rag/retrieve",
            json=payload,
            headers=_internal_headers(),
        )

    assert response.status_code == 200
    mock_decide_route_mode.assert_called_once_with(
        query=payload["query"],
        knowledge_base_ids=[1],
        db=ANY,
        route_mode="auto",
        scope=None,
        metadata_condition=None,
        context_window=10000,
        used_context_tokens=4200,
        reserved_output_tokens=1024,
        context_buffer_ratio=0.2,
        max_direct_chunks=500,
    )


def test_internal_retrieve_auto_route_injects_documents_in_backend(test_client):
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
    injected_records = [
        {
            "content": "complete document",
            "title": "Internal doc",
            "knowledge_base_id": 1,
        }
    ]

    with (
        patch(
            "app.api.endpoints.internal.rag.runtime_resolver.build_query_runtime_spec",
            return_value=_make_runtime_spec(
                knowledge_base_ids=[1],
                query=payload["query"],
                with_budget=True,
            ),
        ),
        patch(
            "app.api.endpoints.internal.rag.direct_injection.decide_route_mode_for_chat_shell",
            return_value="direct_injection",
        ),
        patch("httpx.AsyncClient.post") as mock_remote_post,
        patch(
            "app.api.endpoints.internal.rag.direct_injection."
            "try_direct_injection_with_budget",
            new_callable=AsyncMock,
            return_value={
                "mode": "direct_injection",
                "records": injected_records,
                "total": 1,
                "total_estimated_tokens": 10,
            },
        ) as mock_direct_injection,
    ):
        response = test_client.post(
            "/api/internal/rag/retrieve",
            json=payload,
            headers=_internal_headers(),
        )

    assert response.status_code == 200
    assert response.json()["mode"] == "direct_injection"
    assert response.json()["records"][0]["content"] == "complete document"
    assert mock_direct_injection.await_args.kwargs["route_mode"] == "direct_injection"
    mock_remote_post.assert_not_called()


def test_internal_retrieve_reports_remote_failure_without_local_execution(
    test_client,
):
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

    remote_failure = _build_remote_response(
        status_code=503,
        json_body={
            "code": "runtime_unavailable",
            "message": "knowledge runtime unavailable",
            "retryable": True,
        },
    )

    with (
        patch(
            "app.api.endpoints.internal.rag.runtime_resolver.build_query_runtime_spec",
            return_value=_make_runtime_spec(
                knowledge_base_ids=[1],
                query=payload["query"],
                with_budget=True,
            ),
        ),
        patch(
            "app.api.endpoints.internal.rag.direct_injection.decide_route_mode_for_chat_shell",
            return_value="rag_retrieval",
        ),
        patch(
            "httpx.AsyncClient.post",
            return_value=remote_failure,
        ) as mock_remote_post,
        patch(
            "app.api.endpoints.internal.rag.retrieval_persistence_service.persist_retrieval_result"
        ) as mock_persist,
    ):
        response = test_client.post(
            "/api/internal/rag/retrieve",
            json=payload,
            headers=_internal_headers(),
        )

    assert response.status_code == 503
    assert response.json()["detail"] == "knowledge runtime unavailable"
    mock_remote_post.assert_awaited_once()
    mock_persist.assert_not_called()


def test_internal_retrieve_returns_remote_validation_error(test_client):
    remote_failure = _build_remote_response(
        status_code=400,
        json_body={
            "code": "invalid_runtime_request",
            "message": "remote validation failed",
            "retryable": False,
        },
    )

    with (
        patch(
            "app.api.endpoints.internal.rag.runtime_resolver.build_query_runtime_spec",
            return_value=_make_runtime_spec(
                knowledge_base_ids=[1],
                query="How should we proceed?",
                with_budget=True,
            ),
        ),
        patch(
            "app.api.endpoints.internal.rag.direct_injection.decide_route_mode_for_chat_shell",
            return_value="rag_retrieval",
        ),
        patch(
            "httpx.AsyncClient.post",
            return_value=remote_failure,
        ),
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
            headers=_internal_headers(),
        )

    assert response.status_code == 400
    assert response.json()["detail"] == "remote validation failed"
