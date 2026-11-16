# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Authentication contract for internal task and callback endpoints."""

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings


@pytest.fixture(autouse=True)
def configure_internal_service_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "test-internal-token")


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/api/internal/services/update"),
        ("GET", "/api/internal/services/42"),
        ("GET", "/api/internal/bots/example/mcp"),
        ("POST", "/api/internal/callback/batch"),
        ("POST", "/api/internal/workspace-archives/42/archive"),
        ("POST", "/api/internal/workspace-archives/42/archive-sandbox"),
        ("GET", "/api/internal/workspace-archives/42/download-url"),
    ],
)
def test_internal_routes_reject_missing_token(
    method: str, path: str, test_client: TestClient
) -> None:
    response = test_client.request(method, path)

    assert response.status_code == 401


def test_internal_services_update_rejects_invalid_token(
    test_client: TestClient,
) -> None:
    response = test_client.post(
        "/api/internal/services/update",
        headers={"Authorization": "Bearer invalid-token"},
        json={"task_id": 42},
    )

    assert response.status_code == 401


def test_internal_services_update_accepts_internal_token_and_checks_task(
    test_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    mocker,
) -> None:
    mocker.patch("app.stores.tasks.task_store.get_task_by_states", return_value=None)
    monkeypatch.setattr(
        "app.api.endpoints.internal.services.get_extended_emitter",
        lambda: None,
    )
    monkeypatch.setattr(
        "app.api.endpoints.internal.services.get_main_event_loop",
        lambda: None,
    )

    response = test_client.post(
        "/api/internal/services/update",
        headers={"Authorization": "Bearer test-internal-token"},
        json={"task_id": 42},
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Task not found"


def test_bot_mcp_response_omits_env_values(
    test_client: TestClient,
    test_db,
    test_user,
) -> None:
    from app.models.kind import Kind

    def resource(kind: str, name: str, spec: dict) -> Kind:
        return Kind(
            kind=kind,
            name=name,
            namespace="default",
            user_id=test_user.id,
            is_active=True,
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": kind,
                "metadata": {"name": name, "namespace": "default"},
                "spec": spec,
            },
        )

    test_db.add_all(
        [
            resource("Ghost", "secure-ghost", {
                "systemPrompt": "Test",
                "mcpServers": {
                    "search": {
                        "command": "node",
                        "args": ["server.js"],
                        "env": {"API_TOKEN": "internal-secret"},
                    }
                },
            }),
            resource("Bot", "secure-bot", {
                "ghostRef": {"name": "secure-ghost", "namespace": "default"},
                "shellRef": {"name": "Chat", "namespace": "default"},
            }),
        ]
    )
    test_db.commit()

    response = test_client.get(
        "/api/internal/bots/secure-bot/mcp",
        headers={"Authorization": "Bearer test-internal-token"},
    )

    assert response.status_code == 200
    assert response.json()["mcp_servers"] == {
        "search": {"command": "node", "args": ["server.js"]}
    }
