# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, patch


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_retriever_test_connection_tests_storage_directly(
    test_client,
    test_token: str,
):
    mock_backend = AsyncMock()
    # test_connection is called via asyncio.to_thread, so it must be a sync function
    mock_backend.test_connection = lambda: True

    with patch(
        "app.api.endpoints.adapter.retrievers.create_storage_backend_from_config",
        return_value=mock_backend,
    ) as mock_create:
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
    mock_create.assert_called_once_with(
        storage_type="qdrant",
        url="http://qdrant:6333",
        username="alice",
        password="secret",
        api_key="api-token",
        index_strategy={"mode": "per_dataset"},
        ext={},
    )


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
