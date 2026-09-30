# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import ANY, AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from app.services.rag.remote_gateway import RemoteRagGatewayError
from app.services.rag.runtime_specs import (
    DropKnowledgeIndexRuntimeSpec,
    PurgeKnowledgeRuntimeSpec,
    QueryRuntimeSpec,
)


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_public_rag_retrieve_uses_gateway_runtime_spec(
    test_client,
    test_token: str,
):
    payload = {
        "query": "release checklist",
        "search_hints": {
            "semantic_query": "How to verify the release checklist?",
            "keywords": ["release", "checklist"],
            "phrases": ["release checklist"],
        },
        "knowledge_id": "7",
        "retriever_ref": {
            "name": "retriever-a",
            "namespace": "default",
        },
        "embedding_model_ref": {
            "model_name": "embed-a",
            "model_namespace": "default",
        },
        "top_k": 6,
        "score_threshold": 0.45,
        "retrieval_mode": "hybrid",
        "hybrid_weights": {
            "vector_weight": 0.8,
            "keyword_weight": 0.2,
        },
        "metadata_condition": {
            "operator": "or",
            "conditions": [
                {"key": "source", "operator": "==", "value": "kb"},
                {"key": "lang", "operator": "==", "value": "zh"},
            ],
        },
    }
    runtime_spec = QueryRuntimeSpec(
        knowledge_base_ids=[7],
        query="release checklist",
        search_hints=payload["search_hints"],
        max_results=6,
        route_mode="rag_retrieval",
        metadata_condition=payload["metadata_condition"],
    )
    gateway = AsyncMock()
    gateway.query.return_value = {
        "mode": "rag_retrieval",
        "records": [
            {
                "content": "release checklist",
                "score": 0.91,
                "title": "Checklist",
                "metadata": {"source": "kb"},
            }
        ],
        "total": 1,
        "total_estimated_tokens": 0,
    }

    with (
        patch(
            "app.api.endpoints.rag.runtime_resolver.build_public_query_runtime_spec",
            return_value=runtime_spec,
        ) as mock_build_spec,
        patch(
            "app.api.endpoints.rag.get_query_gateway",
            return_value=gateway,
        ) as mock_get_gateway,
    ):
        response = test_client.post(
            "/api/rag/retrieve",
            headers=_auth_header(test_token),
            json=payload,
        )

    assert response.status_code == 200
    assert response.json() == {
        "records": [
            {
                "content": "release checklist",
                "score": 0.91,
                "title": "Checklist",
                "metadata": {"source": "kb"},
            }
        ]
    }
    mock_build_spec.assert_called_once_with(
        db=ANY,
        knowledge_base_id=7,
        query="release checklist",
        search_hints=ANY,
        max_results=6,
        retriever_name="retriever-a",
        retriever_namespace="default",
        embedding_model_name="embed-a",
        embedding_model_namespace="default",
        user_id=ANY,
        user_name=ANY,
        score_threshold=0.45,
        retrieval_mode="hybrid",
        vector_weight=0.8,
        keyword_weight=0.2,
        metadata_condition=payload["metadata_condition"],
    )
    mock_get_gateway.assert_called_once()
    gateway.query.assert_awaited_once_with(runtime_spec, db=ANY)


def test_public_rag_chunks_returns_paginated_index_chunks(
    test_client,
    test_token: str,
):
    runtime_spec = MagicMock()
    gateway = AsyncMock()
    gateway.requires_resolved_configs = True
    gateway.list_chunks.return_value = {
        "chunks": [
            {
                "content": "chunk-1",
                "title": "Doc 1",
                "chunk_id": 1,
                "doc_ref": "doc-1",
                "metadata": {"page": 1},
            },
            {
                "content": "chunk-2",
                "title": "Doc 2",
                "chunk_id": 2,
                "doc_ref": "doc-2",
                "metadata": {"page": 2},
            },
            {
                "content": "chunk-3",
                "title": "Doc 3",
                "chunk_id": 3,
                "doc_ref": "doc-3",
                "metadata": {"page": 3},
            },
        ],
        "total": 3,
    }

    with (
        patch(
            "app.api.endpoints.rag.runtime_resolver.build_public_list_chunks_runtime_spec",
            return_value=runtime_spec,
        ) as mock_build_spec,
        patch(
            "app.api.endpoints.rag.get_list_chunks_gateway",
            return_value=gateway,
        ) as mock_get_gateway,
    ):
        response = test_client.get(
            "/api/rag/chunks?knowledge_id=7&page=2&page_size=2",
            headers=_auth_header(test_token),
        )

    assert response.status_code == 200
    assert response.json() == {
        "items": [
            {
                "content": "chunk-3",
                "title": "Doc 3",
                "chunk_id": 3,
                "doc_ref": "doc-3",
                "metadata": {"page": 3},
            }
        ],
        "total": 3,
        "page": 2,
        "page_size": 2,
    }
    mock_build_spec.assert_called_once_with(
        db=ANY,
        knowledge_base_id=7,
        user_id=ANY,
        user_name=ANY,
        max_chunks=10000,
        query="list_index_chunks",
        resolve_execution_configs=True,
    )
    mock_get_gateway.assert_called_once()
    gateway.list_chunks.assert_awaited_once_with(runtime_spec, db=ANY)


def test_public_rag_index_contents_delete_routes_runtime_spec(
    test_client,
    test_token: str,
):
    runtime_spec = PurgeKnowledgeRuntimeSpec(
        knowledge_base_id=7,
        index_owner_user_id=9,
        retriever_config={
            "name": "retriever-a",
            "namespace": "default",
            "storage_config": {"type": "qdrant", "url": "http://qdrant:6333"},
        },
    )
    gateway = AsyncMock()
    gateway.requires_resolved_configs = False
    gateway.purge_knowledge_index.return_value = {
        "status": "deleted",
        "knowledge_id": "7",
        "deleted_chunks": 3,
    }

    with (
        patch(
            "app.api.endpoints.rag.runtime_resolver.build_public_purge_index_runtime_spec",
            return_value=runtime_spec,
        ) as mock_build_spec,
        patch(
            "app.api.endpoints.rag.get_delete_gateway",
            return_value=gateway,
        ) as mock_get_gateway,
    ):
        response = test_client.delete(
            "/api/rag/index-contents?knowledge_id=7",
            headers=_auth_header(test_token),
        )

    assert response.status_code == 200
    assert response.json() == {
        "status": "deleted",
        "knowledge_id": "7",
        "deleted_chunks": 3,
    }
    mock_build_spec.assert_called_once_with(
        db=ANY,
        knowledge_base_id=7,
        user_id=ANY,
        user_name=ANY,
        resolve_execution_configs=False,
    )
    mock_get_gateway.assert_called_once()
    gateway.purge_knowledge_index.assert_awaited_once_with(runtime_spec, db=ANY)


def test_public_rag_index_delete_routes_runtime_spec(
    test_client,
    test_token: str,
):
    runtime_spec = DropKnowledgeIndexRuntimeSpec(
        knowledge_base_id=7,
        index_owner_user_id=9,
        retriever_config={
            "name": "retriever-a",
            "namespace": "default",
            "storage_config": {"type": "qdrant", "url": "http://qdrant:6333"},
        },
    )
    gateway = AsyncMock()
    gateway.requires_resolved_configs = False
    gateway.drop_knowledge_index.return_value = {
        "status": "dropped",
        "knowledge_id": "7",
        "index_name": "wegent_kb_7",
    }

    with (
        patch(
            "app.api.endpoints.rag.runtime_resolver.build_public_drop_index_runtime_spec",
            return_value=runtime_spec,
        ) as mock_build_spec,
        patch(
            "app.api.endpoints.rag.get_delete_gateway",
            return_value=gateway,
        ) as mock_get_gateway,
    ):
        response = test_client.delete(
            "/api/rag/index?knowledge_id=7",
            headers=_auth_header(test_token),
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
        user_id=ANY,
        user_name=ANY,
        resolve_execution_configs=False,
    )
    mock_get_gateway.assert_called_once()
    gateway.drop_knowledge_index.assert_awaited_once_with(runtime_spec, db=ANY)


def test_public_rag_index_delete_returns_conflict_for_shared_strategy(
    test_client,
    test_token: str,
):
    with patch(
        "app.api.endpoints.rag.runtime_resolver.build_public_drop_index_runtime_spec",
        side_effect=ValueError(
            "Physical index drop is only allowed for per_dataset index strategy"
        ),
    ):
        response = test_client.delete(
            "/api/rag/index?knowledge_id=7",
            headers=_auth_header(test_token),
        )

    assert response.status_code == 409
    assert "only allowed" in response.json()["detail"]


def test_public_rag_retrieve_returns_non_retryable_remote_error(
    test_client,
    test_token: str,
):
    runtime_spec = QueryRuntimeSpec(
        knowledge_base_ids=[7],
        query="release checklist",
        route_mode="rag_retrieval",
    )
    gateway = AsyncMock()
    gateway.query.side_effect = RemoteRagGatewayError(
        "remote validation failed",
        code="invalid_runtime_request",
        retryable=False,
        status_code=400,
    )

    with (
        patch(
            "app.api.endpoints.rag.runtime_resolver.build_public_query_runtime_spec",
            return_value=runtime_spec,
        ),
        patch(
            "app.api.endpoints.rag.get_query_gateway",
            return_value=gateway,
        ),
        patch(
            "app.services.rag.local_gateway.LocalRagGateway.query",
            new_callable=AsyncMock,
        ) as mock_local_query,
    ):
        response = test_client.post(
            "/api/rag/retrieve",
            headers=_auth_header(test_token),
            json={
                "query": "release checklist",
                "knowledge_id": "7",
                "retriever_ref": {"name": "retriever-a", "namespace": "default"},
                "embedding_model_ref": {
                    "model_name": "embed-a",
                    "model_namespace": "default",
                },
                "top_k": 6,
                "score_threshold": 0.45,
                "retrieval_mode": "vector",
            },
        )

    assert response.status_code == 400
    assert response.json()["detail"] == "remote validation failed"
    mock_local_query.assert_not_called()


def test_public_rag_chunks_rejects_pages_beyond_scan_limit(
    test_client,
    test_token: str,
):
    response = test_client.get(
        "/api/rag/chunks?knowledge_id=7&page=201&page_size=50",
        headers=_auth_header(test_token),
    )

    assert response.status_code == 400
    assert "chunk scan limit" in response.json()["detail"]


def test_public_rag_chunks_rejects_page_ranges_crossing_scan_limit(
    test_client,
    test_token: str,
):
    response = test_client.get(
        "/api/rag/chunks?knowledge_id=7&page=67&page_size=150",
        headers=_auth_header(test_token),
    )

    assert response.status_code == 400
    assert "chunk scan limit" in response.json()["detail"]


@pytest.mark.parametrize(
    ("method", "url", "patch_target", "builder", "local_method"),
    [
        (
            "get",
            "/api/rag/chunks?knowledge_id=7",
            "app.api.endpoints.rag.get_list_chunks_gateway",
            "build_public_list_chunks_runtime_spec",
            "list_chunks",
        ),
        (
            "delete",
            "/api/rag/index-contents?knowledge_id=7",
            "app.api.endpoints.rag.get_delete_gateway",
            "build_public_purge_index_runtime_spec",
            "purge_knowledge_index",
        ),
        (
            "delete",
            "/api/rag/index?knowledge_id=7",
            "app.api.endpoints.rag.get_delete_gateway",
            "build_public_drop_index_runtime_spec",
            "drop_knowledge_index",
        ),
    ],
)
def test_public_rag_admin_entries_surface_remote_failure_without_local_fallback(
    test_client,
    test_token: str,
    method: str,
    url: str,
    patch_target: str,
    builder: str,
    local_method: str,
):
    """A retryable runtime failure must reach the caller, not the local plane."""

    gateway = AsyncMock()
    gateway.requires_resolved_configs = False
    setattr(
        gateway,
        local_method,
        AsyncMock(
            side_effect=RemoteRagGatewayError(
                "knowledge runtime unavailable",
                code="runtime_unavailable",
                retryable=True,
                status_code=503,
            )
        ),
    )

    with (
        patch(
            f"app.api.endpoints.rag.runtime_resolver.{builder}",
            return_value=MagicMock(),
        ),
        patch(patch_target, return_value=gateway),
        patch(
            f"app.services.rag.local_gateway.LocalRagGateway.{local_method}",
            new_callable=AsyncMock,
        ) as mock_local,
    ):
        response = getattr(test_client, method)(url, headers=_auth_header(test_token))

    assert response.status_code == 503
    assert response.json()["detail"] == "knowledge runtime unavailable"
    mock_local.assert_not_called()


def test_public_rag_index_delete_keeps_conflict_for_remote_shared_strategy(
    test_client,
    test_token: str,
):
    """The runtime's shared-strategy refusal still surfaces as a conflict."""

    gateway = AsyncMock()
    gateway.requires_resolved_configs = False
    gateway.drop_knowledge_index.side_effect = RemoteRagGatewayError(
        "Physical index drop is only allowed for 'per_dataset' index strategy",
        code="invalid_request",
        status_code=400,
    )

    with (
        patch(
            "app.api.endpoints.rag.runtime_resolver.build_public_drop_index_runtime_spec",
            return_value=MagicMock(),
        ),
        patch("app.api.endpoints.rag.get_delete_gateway", return_value=gateway),
    ):
        response = test_client.delete(
            "/api/rag/index?knowledge_id=7", headers=_auth_header(test_token)
        )

    assert response.status_code == 409
    assert "only allowed" in response.json()["detail"]


@pytest.mark.parametrize(
    ("method", "url", "patch_target", "builder", "gateway_method"),
    [
        (
            "get",
            "/api/rag/chunks?knowledge_id=7",
            "app.api.endpoints.rag.get_list_chunks_gateway",
            "build_public_list_chunks_runtime_spec",
            "list_chunks",
        ),
        (
            "delete",
            "/api/rag/index-contents?knowledge_id=7",
            "app.api.endpoints.rag.get_delete_gateway",
            "build_public_purge_index_runtime_spec",
            "purge_knowledge_index",
        ),
        (
            "delete",
            "/api/rag/index?knowledge_id=7",
            "app.api.endpoints.rag.get_delete_gateway",
            "build_public_drop_index_runtime_spec",
            "drop_knowledge_index",
        ),
    ],
)
def test_public_rag_admin_entries_refuse_an_unauthorized_retriever(
    test_client,
    test_token: str,
    method: str,
    url: str,
    patch_target: str,
    builder: str,
    gateway_method: str,
):
    """A denied retriever stops the admin entries before any remote request."""

    gateway = AsyncMock()
    gateway.requires_resolved_configs = False
    gateway_method_mock = AsyncMock()
    setattr(gateway, gateway_method, gateway_method_mock)

    with (
        patch(
            f"app.api.endpoints.rag.runtime_resolver.{builder}",
            side_effect=HTTPException(
                status_code=403, detail="Access denied to this group"
            ),
        ),
        patch(patch_target, return_value=gateway),
    ):
        response = getattr(test_client, method)(url, headers=_auth_header(test_token))

    assert response.status_code == 403
    assert response.json()["detail"] == "Access denied to this group"
    gateway_method_mock.assert_not_awaited()
