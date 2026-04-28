# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the published apps backend proxy."""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def auth_headers(test_token: str) -> dict[str, str]:
    """Create authentication headers for the test user."""
    return {"Authorization": f"Bearer {test_token}"}


def test_list_published_apps_proxies_current_user(
    test_client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.delenv("RUNTIME_PUBLISHED_APPS_API_URL", raising=False)
    monkeypatch.delenv("RUNTIME_PUBLISHED_APPS_API_TOKEN", raising=False)
    monkeypatch.setenv("PUBLISHED_APPS_API_URL", "http://published-apps.example.com")
    monkeypatch.setenv("PUBLISHED_APPS_API_TOKEN", "service-token")

    response_payload = {
        "code": 0,
        "message": "success",
        "data": {
            "total": 1,
            "page": 1,
            "page_size": 20,
            "apps": [
                {
                    "app_name": "comedy-monitor",
                    "username": "testuser",
                    "namespace": "wb-plat-ide-quickstart",
                    "env": "prod",
                    "pod_name": "wecode-ide-quickstart-1611116-cbfc9f694-wffz5",
                    "pod_ip": "10.36.6.67",
                    "host_ip": "10.34.5.94",
                    "node_name": "10.34.5.94",
                    "status": "running",
                    "ready": True,
                    "restarts": 0,
                    "app_url": "http://comedy-monitor.testuser.wegent.example.com",
                    "admin_port": "8444",
                    "is_online": True,
                    "created_at": 1776951721,
                    "expires_at": 0,
                    "last_check_at": 1777277254,
                }
            ],
        },
    }

    mock_response = MagicMock()
    mock_response.json.return_value = response_payload
    mock_response.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.get.return_value = mock_response
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch(
        "wecode.service.published_apps.httpx.AsyncClient", return_value=mock_client
    ):
        response = test_client.get(
            "/api/published-apps",
            headers=auth_headers,
        )

    assert response.status_code == 200
    assert response.json() == response_payload
    mock_client.get.assert_called_once_with(
        "http://published-apps.example.com/app/list",
        params={"username": "testuser"},
        headers={
            "accept": "application/json",
            "Authorization": "Bearer service-token",
            "Content-Type": "application/json",
        },
    )


def test_list_published_apps_ignores_username_query(
    test_client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.delenv("RUNTIME_PUBLISHED_APPS_API_URL", raising=False)
    monkeypatch.delenv("RUNTIME_PUBLISHED_APPS_API_TOKEN", raising=False)
    monkeypatch.setenv("PUBLISHED_APPS_API_URL", "http://published-apps.example.com")
    monkeypatch.setenv("PUBLISHED_APPS_API_TOKEN", "service-token")

    mock_response = MagicMock()
    mock_response.json.return_value = {
        "code": 0,
        "message": "success",
        "data": {"apps": []},
    }
    mock_response.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.get.return_value = mock_response
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch(
        "wecode.service.published_apps.httpx.AsyncClient", return_value=mock_client
    ):
        response = test_client.get(
            "/api/published-apps?username=other-user",
            headers=auth_headers,
        )

    assert response.status_code == 200
    mock_client.get.assert_called_once_with(
        "http://published-apps.example.com/app/list",
        params={"username": "testuser"},
        headers={
            "accept": "application/json",
            "Authorization": "Bearer service-token",
            "Content-Type": "application/json",
        },
    )


def test_list_published_apps_returns_gateway_timeout_on_service_timeout(
    test_client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.delenv("RUNTIME_PUBLISHED_APPS_API_URL", raising=False)
    monkeypatch.delenv("RUNTIME_PUBLISHED_APPS_API_TOKEN", raising=False)
    monkeypatch.setenv("PUBLISHED_APPS_API_URL", "http://published-apps.example.com")
    monkeypatch.setenv("PUBLISHED_APPS_API_TOKEN", "service-token")

    mock_client = AsyncMock()
    mock_client.get.side_effect = httpx.TimeoutException("timed out")
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch(
        "wecode.service.published_apps.httpx.AsyncClient", return_value=mock_client
    ):
        response = test_client.get("/api/published-apps", headers=auth_headers)

    assert response.status_code == 504
    assert response.json() == {"detail": "Published apps service request timed out"}


def test_delete_published_app_proxies_current_user(
    test_client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.delenv("RUNTIME_PUBLISHED_APPS_API_URL", raising=False)
    monkeypatch.delenv("RUNTIME_PUBLISHED_APPS_API_TOKEN", raising=False)
    monkeypatch.setenv("PUBLISHED_APPS_API_URL", "http://published-apps.example.com")
    monkeypatch.setenv("PUBLISHED_APPS_API_TOKEN", "service-token")

    response_payload = {"code": 0, "message": "success"}
    mock_response = MagicMock()
    mock_response.json.return_value = response_payload
    mock_response.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.delete.return_value = mock_response
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch(
        "wecode.service.published_apps.httpx.AsyncClient", return_value=mock_client
    ):
        response = test_client.delete(
            "/api/published-apps/demo-app2",
            headers=auth_headers,
        )

    assert response.status_code == 200
    assert response.json() == response_payload
    mock_client.delete.assert_called_once_with(
        "http://published-apps.example.com/app/delete",
        json={"username": "testuser", "app_name": "demo-app2"},
        headers={
            "accept": "application/json",
            "Authorization": "Bearer service-token",
            "Content-Type": "application/json",
        },
    )
