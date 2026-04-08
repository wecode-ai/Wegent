# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, patch

from app.services.rag.runtime_specs import ConnectionTestRuntimeSpec


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_retriever_test_connection_uses_gateway_runtime_spec(
    test_client,
    test_token: str,
):
    gateway = AsyncMock()
    gateway.test_connection.return_value = {
        "success": True,
        "message": "Connection successful",
    }

    with patch(
        "app.api.endpoints.adapter.retrievers.get_query_gateway",
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
    gateway.test_connection.assert_awaited_once()

    runtime_spec = gateway.test_connection.await_args.args[0]
    assert isinstance(runtime_spec, ConnectionTestRuntimeSpec)
    assert runtime_spec.retriever_config.storage_config == {
        "type": "qdrant",
        "url": "http://qdrant:6333",
        "username": "alice",
        "password": "secret",
        "apiKey": "api-token",
        "indexStrategy": {"mode": "per_dataset"},
        "ext": {},
    }


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
