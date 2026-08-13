# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for the shared project-scoped GitLab/GitHub client."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from app.models.cloud_project import CloudProject
from app.services.gitlab import client as client_module
from app.services.gitlab.client import (
    ProjectScopedGitlabClient,
    request_project_api,
    request_project_api_text,
)


class _FakeResponse:
    def __init__(self, payload: Any, status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code
        self.content = b"{}" if isinstance(payload, dict) else str(payload).encode()

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                "boom",
                request=httpx.Request("GET", "https://gitlab.invalid"),
                response=httpx.Response(self.status_code),
            )

    def json(self) -> Any:
        return self._payload

    @property
    def text(self) -> str:
        return self._payload if isinstance(self._payload, str) else str(self._payload)


def _project(provider: str = "gitlab", **config: object) -> CloudProject:
    cfg: dict[str, object] = {
        "repository": "group/project",
        "domain": "gitlab.internal",
        "token": "t",
    }
    cfg.update(config)
    return CloudProject(
        project_key="PRJ",
        metadata_json={"task_provider": provider, "provider_config": cfg},
    )


@pytest.fixture(autouse=True)
def _fake_provider_config(monkeypatch: pytest.MonkeyPatch) -> None:
    """Bypass credential decryption; honor per-test provider_config fields."""

    def fake(project: CloudProject) -> tuple[dict[str, object], str]:
        metadata = (
            project.metadata_json if isinstance(project.metadata_json, dict) else {}
        )
        config = metadata.get("provider_config")
        return (dict(config) if isinstance(config, dict) else {}), "t"

    monkeypatch.setattr(client_module, "resolve_provider_config", fake)


def test_gitlab_request_uses_private_token_and_default_api_base(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_httpx_request(method, url, **kwargs):
        captured["url"] = url
        captured["headers"] = kwargs.get("headers", {})
        return _FakeResponse({"ok": True})

    monkeypatch.setattr(httpx, "request", fake_httpx_request)
    result = request_project_api(_project(), "GET", "/projects/group%2Fproject/issues")
    assert result == {"ok": True}
    assert (
        captured["url"]
        == "https://gitlab.internal/api/v4/projects/group%2Fproject/issues"
    )
    assert captured["headers"].get("PRIVATE-TOKEN") == "t"


def test_github_request_uses_bearer_and_github_api_base(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_httpx_request(method, url, **kwargs):
        captured["url"] = url
        captured["headers"] = kwargs.get("headers", {})
        return _FakeResponse([])

    monkeypatch.setattr(httpx, "request", fake_httpx_request)
    request_project_api(
        _project("github", repository="owner/repo"), "GET", "/repos/x/issues"
    )
    assert captured["url"] == "https://api.github.com/repos/x/issues"
    assert captured["headers"].get("Authorization") == "Bearer t"


def test_gitlab_custom_api_base_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    def fake_httpx_request(method, url, **kwargs):
        captured["url"] = url
        return _FakeResponse({})

    monkeypatch.setattr(httpx, "request", fake_httpx_request)
    request_project_api(
        _project(api_base="https://git.internal/custom/api"),
        "GET",
        "/projects/x",
    )
    assert captured["url"] == "https://git.internal/custom/api/projects/x"


def test_404_maps_to_todo_not_found(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        httpx,
        "request",
        lambda *a, **k: _FakeResponse({}, status_code=404),
    )
    with pytest.raises(Exception) as exc_info:
        request_project_api(_project(), "GET", "/projects/x")
    assert exc_info.value.status_code == 404


def test_404_with_not_found_ok_returns_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        httpx,
        "request",
        lambda *a, **k: _FakeResponse({}, status_code=404),
    )
    result = request_project_api(_project(), "GET", "/projects/x", not_found_ok=True)
    assert result is None


def test_500_maps_to_502(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        httpx,
        "request",
        lambda *a, **k: _FakeResponse({}, status_code=500),
    )
    with pytest.raises(Exception) as exc_info:
        request_project_api(_project(), "GET", "/projects/x")
    assert exc_info.value.status_code == 502


def test_text_variant_returns_raw_body(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        httpx,
        "request",
        lambda *a, **k: _FakeResponse("line1\nline2", status_code=200),
    )
    assert (
        request_project_api_text(_project(), "GET", "/jobs/1/trace") == "line1\nline2"
    )


def test_client_retries_transient_connect_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    def fake_httpx_request(method, url, **kwargs):
        calls.append(method)
        if len(calls) < 3:
            raise httpx.ConnectError("boom")
        return _FakeResponse({"ok": True})

    monkeypatch.setattr(httpx, "request", fake_httpx_request)
    monkeypatch.setattr(client_module, "_PROVIDER_RETRY_DELAYS", (0, 0, 0))
    result = request_project_api(_project(), "GET", "/projects/x")
    assert result == {"ok": True}
    assert len(calls) == 3


def test_client_retries_5xx_get_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def fake_httpx_request(method, url, **kwargs):
        calls.append(method)
        if len(calls) < 2:
            return _FakeResponse({}, status_code=503)
        return _FakeResponse({"ok": True}, status_code=200)

    monkeypatch.setattr(httpx, "request", fake_httpx_request)
    monkeypatch.setattr(client_module, "_PROVIDER_RETRY_DELAYS", (0, 0, 0))
    result = request_project_api(_project(), "GET", "/projects/x")
    assert result == {"ok": True}
    assert len(calls) == 2


def test_client_exposes_repository_and_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        client_module,
        "resolve_provider_config",
        lambda project: (
            {"repository": "group/project", "domain": "gitlab.internal"},
            "secret-token",
        ),
    )
    client = ProjectScopedGitlabClient(_project())
    assert client.repository == "group/project"
    assert client.domain == "gitlab.internal"
    assert client.token == "secret-token"
    assert client.api_base == "https://gitlab.internal/api/v4"
