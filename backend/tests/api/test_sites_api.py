# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.core.config import settings

SITES_API_BASE_URL = "https://sites.example.test"
SITES_API_TOKEN = "sites-platform-test-token"
PROJECT_CURSOR = "prj_01KXN31C03C3MVD878RPP1PFX7"


def _project(**overrides: Any) -> dict[str, Any]:
    project = {
        "id": "prj_01KXN31C03C3MVD878RPP1PFX7",
        "network": "outer",
        "title": "Product site",
        "url": "https://product.example.test/",
        "snapshot": "https://sites.example.test/snapshots/product.png",
        "created_at": "2026-07-15T08:00:00Z",
    }
    project.update(overrides)
    return project


def _authorization(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _configure_sites(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "SITES_API_BASE_URL", SITES_API_BASE_URL)
    monkeypatch.setattr(
        settings,
        "SITES_API_TOKEN",
        SecretStr(SITES_API_TOKEN),
    )


def test_list_sites_requires_authentication(test_client: TestClient) -> None:
    response = test_client.get("/api/v1/sites")

    assert response.status_code == 401


@pytest.mark.parametrize(
    ("base_url", "platform_token"),
    [
        (SITES_API_BASE_URL, SecretStr("")),
        ("", SecretStr(SITES_API_TOKEN)),
    ],
)
def test_list_sites_requires_complete_upstream_configuration(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    base_url: str,
    platform_token: SecretStr,
) -> None:
    monkeypatch.setattr(settings, "SITES_API_BASE_URL", base_url)
    monkeypatch.setattr(
        settings,
        "SITES_API_TOKEN",
        platform_token,
    )

    response = test_client.get(
        "/api/v1/sites",
        headers=_authorization(test_token),
    )

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "sites_not_available"


def test_list_sites_proxies_cursor_search_with_authenticated_identity(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock,
) -> None:
    _configure_sites(monkeypatch)
    project = _project()
    assert set(project) == {
        "id",
        "network",
        "title",
        "url",
        "snapshot",
        "created_at",
    }
    httpx_mock.add_response(
        method="GET",
        url=(
            f"{SITES_API_BASE_URL}/v1/projects/search"
            f"?username=testuser&sitename=product&limit=10&cursor={PROJECT_CURSOR}"
        ),
        json={"items": [project], "next_cursor": "prj_next"},
    )

    response = test_client.get(
        f"/api/v1/sites?q=%20product%20&cursor={PROJECT_CURSOR}&limit=10",
        headers=_authorization(test_token),
    )

    assert response.status_code == 200
    assert response.json() == {"items": [project], "next_cursor": "prj_next"}
    request = httpx_mock.get_requests()[0]
    assert request.method == "GET"
    assert str(request.url.copy_with(query=None)) == (
        f"{SITES_API_BASE_URL}/v1/projects/search"
    )
    assert dict(request.url.params) == {
        "username": "testuser",
        "sitename": "product",
        "limit": "10",
        "cursor": PROJECT_CURSOR,
    }
    assert request.headers["Authorization"] == f"Bearer {SITES_API_TOKEN}"


def test_list_sites_uses_empty_search_and_omits_cursor_by_default(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock,
) -> None:
    _configure_sites(monkeypatch)
    httpx_mock.add_response(
        method="GET",
        url=(
            f"{SITES_API_BASE_URL}/v1/projects/search"
            "?username=testuser&sitename=&limit=20"
        ),
        json={"items": [_project(network="inner")], "next_cursor": None},
    )

    response = test_client.get(
        "/api/v1/sites",
        headers=_authorization(test_token),
    )

    assert response.status_code == 200
    request = httpx_mock.get_requests()[0]
    assert dict(request.url.params) == {
        "username": "testuser",
        "sitename": "",
        "limit": "20",
    }
    assert "cursor" not in request.url.params


def test_list_sites_rejects_invalid_upstream_project(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock,
) -> None:
    _configure_sites(monkeypatch)
    project = _project()
    del project["snapshot"]
    httpx_mock.add_response(
        method="GET",
        url=(
            f"{SITES_API_BASE_URL}/v1/projects/search"
            "?username=testuser&sitename=&limit=20"
        ),
        json={"items": [project], "next_cursor": None},
    )

    response = test_client.get(
        "/api/v1/sites",
        headers=_authorization(test_token),
    )

    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "sites_upstream_unavailable"


def test_sites_api_token_repr_hides_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        settings,
        "SITES_API_TOKEN",
        SecretStr(SITES_API_TOKEN),
    )

    assert SITES_API_TOKEN not in repr(settings.SITES_API_TOKEN)
