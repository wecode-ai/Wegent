# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, patch

from app.services.rag.remote_gateway import RemoteRagGatewayError
from shared.models import RemoteTestConnectionRequest


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_retriever_test_connection_forwards_to_knowledge_runtime(
    test_client,
    test_token: str,
):
    gateway = AsyncMock()
    gateway.test_connection.return_value = {
        "success": True,
        "message": "Connection successful",
    }

    with patch(
        "app.api.endpoints.adapter.retrievers.get_rag_gateway",
        return_value=gateway,
    ) as mock_get_gateway:
        response = test_client.post(
            "/api/retrievers/test-connection",
            headers=_auth_header(test_token),
            json={
                "storage_type": "qdrant",
                "url": "http://qdrant:6333",
                "username": "alice",
                "password": "secret",
                "api_key": "api-token",
            },
        )

    assert response.status_code == 200
    assert response.json() == {
        "success": True,
        "message": "Connection successful",
    }
    mock_get_gateway.assert_called_once()
    gateway.test_connection.assert_awaited_once_with(
        RemoteTestConnectionRequest(
            storage_type="qdrant",
            url="http://qdrant:6333",
            username="alice",
            password="secret",
            api_key="api-token",
        )
    )


def test_retriever_test_connection_maps_gateway_failure_to_false(
    test_client,
    test_token: str,
):
    gateway = AsyncMock()
    gateway.test_connection.side_effect = RemoteRagGatewayError(
        "knowledge_runtime transport error: connection refused"
    )

    with patch(
        "app.api.endpoints.adapter.retrievers.get_rag_gateway",
        return_value=gateway,
    ):
        response = test_client.post(
            "/api/retrievers/test-connection",
            headers=_auth_header(test_token),
            json={"storage_type": "qdrant", "url": "http://qdrant:6333"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "success": False,
        "message": "knowledge_runtime transport error: connection refused",
    }


def test_retriever_test_connection_reports_malformed_payload(
    test_client,
    test_token: str,
):
    response = test_client.post(
        "/api/retrievers/test-connection",
        headers=_auth_header(test_token),
        json={"storage_type": {"unexpected": "shape"}, "url": "http://qdrant:6333"},
    )

    assert response.status_code == 200
    assert response.json()["success"] is False


def test_retriever_test_connection_validates_required_fields(
    test_client,
    test_token: str,
):
    response = test_client.post(
        "/api/retrievers/test-connection",
        headers=_auth_header(test_token),
        json={"storage_type": "qdrant"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "success": False,
        "message": "Missing required fields: storage_type, url",
    }


def test_list_storage_retrieval_methods_returns_capability_registry(
    test_client,
    test_token: str,
):
    response = test_client.get(
        "/api/retrievers/storage-types/retrieval-methods",
        headers=_auth_header(test_token),
    )

    assert response.status_code == 200
    assert response.json() == {
        "data": {
            "elasticsearch": ["vector", "keyword", "hybrid"],
            "qdrant": ["vector"],
            "milvus": ["vector", "keyword", "hybrid"],
        },
        "storage_types": ["elasticsearch", "qdrant", "milvus"],
    }


def test_get_storage_retrieval_methods_rejects_unknown_storage_type(
    test_client,
    test_token: str,
):
    response = test_client.get(
        "/api/retrievers/storage-types/unknown/retrieval-methods",
        headers=_auth_header(test_token),
    )

    assert response.status_code == 400
    assert response.json() == {
        "detail": (
            "Unsupported storage type: unknown. "
            "Supported types: ['elasticsearch', 'qdrant', 'milvus']"
        )
    }
