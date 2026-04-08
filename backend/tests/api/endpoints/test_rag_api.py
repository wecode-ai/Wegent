# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import ANY, AsyncMock, MagicMock, patch

from app.services.rag.remote_gateway import RemoteRagGatewayError
from app.services.rag.runtime_specs import QueryRuntimeSpec


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_public_rag_retrieve_uses_gateway_runtime_spec(
    test_client,
    test_token: str,
):
    payload = {
        "query": "release checklist",
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
            "app.api.endpoints.rag.get_query_gateway",
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
    )
    mock_get_gateway.assert_called_once()
    gateway.list_chunks.assert_awaited_once_with(runtime_spec, db=ANY)


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
            "app.api.endpoints.rag.LocalRagGateway.query",
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
