# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pytest_httpx import HTTPXMock

from app.core.config import settings

SITES_API_BASE_URL = "https://sites.example.test"


def _project(**overrides: Any) -> dict[str, Any]:
    project = {
        "id": "prj_01K0A0BCDEFGHJKMNPQRSTVWXY",
        "network": "inner",
        "title": "Product site",
        "url": "https://product.inner.test",
        "snapshot": "https://sites.example.test/default-thumbnail.png",
        "created_at": "2026-07-15T08:00:00Z",
    }
    project.update(overrides)
    return project


def _mini_program(**overrides: Any) -> dict[str, Any]:
    project = {
        "id": "mini_01K0A0BCDEFGHJKMNPQRSTVWXY",
        "project_type": "miniapp",
        "network": "inner",
        "title": "Campaign assistant",
        "version": "1.2.0",
        "url": "https://mini.example.test/experience/1234567890",
        "snapshot": "https://sites.example.test/mini-program.png",
        "created_at": "2026-07-16T08:00:00Z",
        "updated_at": "2026-07-17T08:00:00Z",
    }
    project.update(overrides)
    return project


def _authorization(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _json_body(request) -> dict[str, Any]:
    return json.loads(request.content.decode("utf-8"))


def test_list_sites_requires_authentication(
    test_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "SITES_API_BASE_URL", SITES_API_BASE_URL)

    response = test_client.get("/api/sites")

    assert response.status_code == 401


def test_list_site_app_types_returns_ordered_capabilities(
    test_client: TestClient,
    test_token: str,
) -> None:
    response = test_client.get(
        "/api/sites/app-types",
        headers=_authorization(test_token),
    )

    assert response.status_code == 200
    assert response.json() == {
        "items": [
            {
                "app_type": "web",
                "enabled": True,
                "order": 10,
                "capabilities": ["create", "publish", "delete"],
            },
            {
                "app_type": "miniapp",
                "enabled": True,
                "order": 20,
                "capabilities": ["create", "open_experience"],
            },
        ]
    }


def test_list_sites_returns_not_available_when_upstream_is_not_configured(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "SITES_API_BASE_URL", "")

    response = test_client.get(
        "/api/sites",
        headers=_authorization(test_token),
    )

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "sites_not_available"


def test_list_sites_searches_platform_projects_with_authenticated_username(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock: HTTPXMock,
) -> None:
    monkeypatch.setattr(settings, "SITES_API_BASE_URL", SITES_API_BASE_URL)
    monkeypatch.setattr(settings, "SITES_API_TOKEN", "platform-token")
    httpx_mock.add_response(
        method="GET",
        url=(
            f"{SITES_API_BASE_URL}/api/v1/projects/search"
            "?username=testuser&limit=100&sitename=product"
        ),
        json={"items": [_project()], "next_cursor": None},
    )

    response = test_client.get(
        "/api/sites",
        params={"q": "product", "offset": 0, "limit": 10},
        headers=_authorization(test_token),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["items"][0] == {
        "app_type": "web",
        "siteid": "prj_01K0A0BCDEFGHJKMNPQRSTVWXY",
        "taskid": "prj_01K0A0BCDEFGHJKMNPQRSTVWXY",
        "username": "testuser",
        "name": "Product site",
        "slug": "prj_01K0A0BCDEFGHJKMNPQRSTVWXY",
        "network": "inner",
        "internal_url": "https://product.inner.test/",
        "external_url": None,
        "publish_status": "unpublished",
        "last_publish_error": None,
        "thumbnail_url": "https://sites.example.test/default-thumbnail.png",
        "created_at": "2026-07-15T08:00:00Z",
        "updated_at": "2026-07-15T08:00:00Z",
        "published_at": None,
    }
    request = httpx_mock.get_requests()[0]
    assert request.headers["authorization"] == "Bearer platform-token"
    assert request.url.params["username"] == "testuser"
    assert request.url.params["sitename"] == "product"


def test_list_sites_accepts_legacy_site_app_type_and_defaults_invalid_network(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock: HTTPXMock,
) -> None:
    monkeypatch.setattr(settings, "SITES_API_BASE_URL", SITES_API_BASE_URL)
    project = _project(app_type="site", network=[])
    httpx_mock.add_response(
        method="GET",
        url=(
            f"{SITES_API_BASE_URL}/api/v1/projects/search"
            "?username=testuser&limit=100"
        ),
        json={"items": [project], "next_cursor": None},
    )

    response = test_client.get(
        "/api/sites",
        params={"app_type": "site", "offset": 0, "limit": 20},
        headers=_authorization(test_token),
    )

    assert response.status_code == 200
    item = response.json()["items"][0]
    assert item["app_type"] == "web"
    assert item["network"] == "inner"
    assert item["publish_status"] == "unpublished"


def test_list_sites_returns_mini_programs_from_the_shared_endpoint(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock: HTTPXMock,
) -> None:
    monkeypatch.setattr(settings, "SITES_API_BASE_URL", SITES_API_BASE_URL)
    httpx_mock.add_response(
        method="GET",
        url=(
            f"{SITES_API_BASE_URL}/api/v1/projects/search"
            "?username=testuser&limit=100&app_type=miniapp"
        ),
        json={"items": [_mini_program()], "next_cursor": None},
    )

    response = test_client.get(
        "/api/sites",
        params={"app_type": "miniapp", "offset": 0, "limit": 20},
        headers=_authorization(test_token),
    )

    assert response.status_code == 200
    assert response.json()["items"] == [
        {
            "app_type": "miniapp",
            "siteid": "mini_01K0A0BCDEFGHJKMNPQRSTVWXY",
            "taskid": "mini_01K0A0BCDEFGHJKMNPQRSTVWXY",
            "username": "testuser",
            "name": "Campaign assistant",
            "slug": "mini_01K0A0BCDEFGHJKMNPQRSTVWXY",
            "app_id": None,
            "status": "experience",
            "version": "1.2.0",
            "experience_url": "https://mini.example.test/experience/1234567890",
            "thumbnail_url": "https://sites.example.test/mini-program.png",
            "created_at": "2026-07-16T08:00:00Z",
            "updated_at": "2026-07-17T08:00:00Z",
        }
    ]


def test_list_sites_accepts_legacy_mini_program_app_type_and_payload_type(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock: HTTPXMock,
) -> None:
    monkeypatch.setattr(settings, "SITES_API_BASE_URL", SITES_API_BASE_URL)
    project = _mini_program(app_type="mini_program")
    project.pop("project_type")
    httpx_mock.add_response(
        method="GET",
        url=(
            f"{SITES_API_BASE_URL}/api/v1/projects/search"
            "?username=testuser&limit=100&app_type=miniapp"
        ),
        json={"items": [project], "next_cursor": None},
    )

    response = test_client.get(
        "/api/sites",
        params={"app_type": "mini_program", "offset": 0, "limit": 20},
        headers=_authorization(test_token),
    )

    assert response.status_code == 200
    item = response.json()["items"][0]
    assert item["app_type"] == "miniapp"
    assert item["status"] == "experience"


def test_list_sites_rejects_an_unknown_application_type(
    test_client: TestClient,
    test_token: str,
) -> None:
    response = test_client.get(
        "/api/sites",
        params={"app_type": "desktop_app"},
        headers=_authorization(test_token),
    )

    assert response.status_code == 422


def test_list_sites_fetches_until_offset_page_is_resolved(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock: HTTPXMock,
) -> None:
    monkeypatch.setattr(settings, "SITES_API_BASE_URL", SITES_API_BASE_URL)
    httpx_mock.add_response(
        method="GET",
        url=(
            f"{SITES_API_BASE_URL}/api/v1/projects/search"
            "?username=testuser&limit=100"
        ),
        json={"items": [], "next_cursor": "page-1"},
    )
    for page in range(1, 11):
        httpx_mock.add_response(
            method="GET",
            url=(
                f"{SITES_API_BASE_URL}/api/v1/projects/search"
                f"?username=testuser&limit=100&cursor=page-{page}"
            ),
            json={"items": [], "next_cursor": f"page-{page + 1}"},
        )
    httpx_mock.add_response(
        method="GET",
        url=(
            f"{SITES_API_BASE_URL}/api/v1/projects/search"
            "?username=testuser&limit=100&cursor=page-11"
        ),
        json={"items": [_project()], "next_cursor": None},
    )

    response = test_client.get(
        "/api/sites",
        params={"offset": 0, "limit": 1},
        headers=_authorization(test_token),
    )

    assert response.status_code == 200
    body = response.json()
    assert [item["siteid"] for item in body["items"]] == [
        "prj_01K0A0BCDEFGHJKMNPQRSTVWXY"
    ]
    assert body["total"] == 1
    assert body["next_cursor"] is None
    assert len(httpx_mock.get_requests()) == 12


def test_list_sites_next_cursor_uses_next_offset(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock: HTTPXMock,
) -> None:
    monkeypatch.setattr(settings, "SITES_API_BASE_URL", SITES_API_BASE_URL)
    httpx_mock.add_response(
        method="GET",
        url=(
            f"{SITES_API_BASE_URL}/api/v1/projects/search"
            "?username=testuser&limit=100"
        ),
        json={
            "items": [
                _project(id="prj_first"),
                _project(id="prj_second", title="Second site"),
            ],
            "next_cursor": None,
        },
    )

    response = test_client.get(
        "/api/sites",
        params={"offset": 0, "limit": 1},
        headers=_authorization(test_token),
    )

    assert response.status_code == 200
    body = response.json()
    assert [item["siteid"] for item in body["items"]] == ["prj_first"]
    assert body["total"] == 2
    assert body["next_cursor"] == "1"


def test_publish_site_sets_network_to_outer(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock: HTTPXMock,
) -> None:
    monkeypatch.setattr(settings, "SITES_API_BASE_URL", SITES_API_BASE_URL)
    monkeypatch.setattr(settings, "SITES_API_TOKEN", "platform-token")
    httpx_mock.add_response(
        method="POST",
        url=f"{SITES_API_BASE_URL}/api/v1/projects/deploy/network",
        json=_project(
            network="outer",
            url="https://product.example.test",
        ),
    )

    response = test_client.post(
        "/api/sites/prj_01K0A0BCDEFGHJKMNPQRSTVWXY/publish",
        headers=_authorization(test_token),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["network"] == "outer"
    assert body["publish_status"] == "published"
    assert body["external_url"] == "https://product.example.test/"
    request = httpx_mock.get_requests()[0]
    assert request.headers["authorization"] == "Bearer platform-token"
    assert _json_body(request) == {
        "username": "testuser",
        "project_id": "prj_01K0A0BCDEFGHJKMNPQRSTVWXY",
        "network": "outer",
    }


def test_publish_site_returns_scanning_status_without_outer_network(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock: HTTPXMock,
) -> None:
    monkeypatch.setattr(settings, "SITES_API_BASE_URL", SITES_API_BASE_URL)
    httpx_mock.add_response(
        method="POST",
        url=f"{SITES_API_BASE_URL}/api/v1/projects/deploy/network",
        json=_project(version_status="scanning"),
    )

    response = test_client.post(
        "/api/sites/prj_01K0A0BCDEFGHJKMNPQRSTVWXY/publish",
        headers=_authorization(test_token),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["network"] == "inner"
    assert body["publish_status"] == "scanning"
    assert body["last_publish_error"] is None


def test_update_site_network_proxies_platform_network_update(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock: HTTPXMock,
) -> None:
    monkeypatch.setattr(settings, "SITES_API_BASE_URL", SITES_API_BASE_URL)
    httpx_mock.add_response(
        method="POST",
        url=f"{SITES_API_BASE_URL}/api/v1/projects/deploy/network",
        json=_project(network="inner"),
    )

    response = test_client.put(
        "/api/sites/prj_01K0A0BCDEFGHJKMNPQRSTVWXY/network",
        json={"network": "inner"},
        headers=_authorization(test_token),
    )

    assert response.status_code == 200
    assert response.json()["network"] == "inner"
    assert response.json()["publish_status"] == "unpublished"
    assert _json_body(httpx_mock.get_requests()[0]) == {
        "username": "testuser",
        "project_id": "prj_01K0A0BCDEFGHJKMNPQRSTVWXY",
        "network": "inner",
    }


def test_update_site_name_proxies_platform_name_update(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock: HTTPXMock,
) -> None:
    monkeypatch.setattr(settings, "SITES_API_BASE_URL", SITES_API_BASE_URL)
    httpx_mock.add_response(
        method="POST",
        url=f"{SITES_API_BASE_URL}/api/v1/projects/update",
        json=_project(title="Renamed site"),
    )

    response = test_client.put(
        "/api/sites/prj_01K0A0BCDEFGHJKMNPQRSTVWXY",
        json={"sitename": "Renamed site"},
        headers=_authorization(test_token),
    )

    assert response.status_code == 200
    assert response.json()["name"] == "Renamed site"
    assert _json_body(httpx_mock.get_requests()[0]) == {
        "username": "testuser",
        "project_id": "prj_01K0A0BCDEFGHJKMNPQRSTVWXY",
        "sitename": "Renamed site",
    }


def test_delete_site_removes_owned_platform_project(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    httpx_mock: HTTPXMock,
) -> None:
    monkeypatch.setattr(settings, "SITES_API_BASE_URL", SITES_API_BASE_URL)
    httpx_mock.add_response(
        method="POST",
        url=f"{SITES_API_BASE_URL}/api/v1/projects/del",
        json={"deleted": True},
    )

    response = test_client.delete(
        "/api/sites/prj_01K0A0BCDEFGHJKMNPQRSTVWXY",
        headers=_authorization(test_token),
    )

    assert response.status_code == 204
    assert response.content == b""
    assert _json_body(httpx_mock.get_requests()[0]) == {
        "username": "testuser",
        "project_id": "prj_01K0A0BCDEFGHJKMNPQRSTVWXY",
    }
