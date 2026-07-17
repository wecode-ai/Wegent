# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings

SITES_API_BASE_URL = "https://sites.example.test"


def _site(**overrides: Any) -> dict[str, Any]:
    site = {
        "siteid": "site-1",
        "taskid": "task-1",
        "username": "testuser",
        "name": "Product site",
        "slug": "product-site",
        "internal_url": "http://site-1.internal.test",
        "external_url": None,
        "publish_status": "unpublished",
        "last_publish_error": None,
        "thumbnail_url": "https://sites.example.test/default-thumbnail.png",
        "created_at": "2026-07-15T08:00:00Z",
        "updated_at": "2026-07-15T08:00:00Z",
        "published_at": None,
    }
    site.update(overrides)
    return site


def _authorization(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_list_sites_requires_authentication(
    test_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "SITES_API_BASE_URL", SITES_API_BASE_URL)

    response = test_client.get("/api/v1/sites")

    assert response.status_code == 401


def test_list_sites_returns_not_available_when_upstream_is_not_configured(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "SITES_API_BASE_URL", "")

    response = test_client.get(
        "/api/v1/sites",
        headers=_authorization(test_token),
    )

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "sites_not_available"


def test_list_sites_injects_authenticated_username(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock,
) -> None:
    monkeypatch.setattr(settings, "SITES_API_BASE_URL", SITES_API_BASE_URL)
    httpx_mock.add_response(
        method="GET",
        url=(
            f"{SITES_API_BASE_URL}/api/v1/sites"
            "?username=testuser&q=product&offset=20&limit=10"
        ),
        json={"items": [_site()], "total": 1, "offset": 20, "limit": 10},
    )

    response = test_client.get(
        "/api/v1/sites",
        params={"q": "product", "offset": 20, "limit": 10},
        headers=_authorization(test_token),
    )

    assert response.status_code == 200
    assert response.json()["items"][0]["username"] == "testuser"
    request = httpx_mock.get_requests()[0]
    assert request.url.params["username"] == "testuser"


def test_publish_site_checks_ownership_before_publishing(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock,
) -> None:
    monkeypatch.setattr(settings, "SITES_API_BASE_URL", SITES_API_BASE_URL)
    httpx_mock.add_response(
        method="GET",
        url=f"{SITES_API_BASE_URL}/api/v1/sites/site-1",
        json=_site(),
    )
    httpx_mock.add_response(
        method="POST",
        url=f"{SITES_API_BASE_URL}/api/v1/sites/site-1/publish",
        json=_site(
            external_url="https://product-site.example.test",
            publish_status="published",
            published_at="2026-07-15T08:10:00Z",
        ),
    )

    response = test_client.post(
        "/api/v1/sites/site-1/publish",
        headers=_authorization(test_token),
    )

    assert response.status_code == 200
    assert response.json()["publish_status"] == "published"
    assert [request.method for request in httpx_mock.get_requests()] == ["GET", "POST"]


def test_delete_site_hides_a_site_owned_by_another_user(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock,
) -> None:
    monkeypatch.setattr(settings, "SITES_API_BASE_URL", SITES_API_BASE_URL)
    httpx_mock.add_response(
        method="GET",
        url=f"{SITES_API_BASE_URL}/api/v1/sites/site-1",
        json=_site(username="another-user"),
    )

    response = test_client.delete(
        "/api/v1/sites/site-1",
        headers=_authorization(test_token),
    )

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "site_not_found"
    assert len(httpx_mock.get_requests()) == 1


def test_delete_site_removes_owned_site(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock,
) -> None:
    monkeypatch.setattr(settings, "SITES_API_BASE_URL", SITES_API_BASE_URL)
    httpx_mock.add_response(
        method="GET",
        url=f"{SITES_API_BASE_URL}/api/v1/sites/site-1",
        json=_site(),
    )
    httpx_mock.add_response(
        method="DELETE",
        url=f"{SITES_API_BASE_URL}/api/v1/sites/site-1",
        status_code=204,
    )

    response = test_client.delete(
        "/api/v1/sites/site-1",
        headers=_authorization(test_token),
    )

    assert response.status_code == 204
    assert response.content == b""
