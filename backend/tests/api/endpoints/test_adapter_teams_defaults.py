# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.api.endpoints.adapter import teams as teams_endpoint


def test_default_team_config_includes_wework_mode(monkeypatch):
    monkeypatch.setattr(
        teams_endpoint.settings,
        "DEFAULT_TEAM_WEWORK",
        "wegent-wework-hidden#default",
    )
    monkeypatch.setattr(
        teams_endpoint.settings,
        "DEFAULT_TEAM_CHAT",
        "wegent-chat#default",
    )

    config = teams_endpoint._get_default_teams_config()

    assert config["wework"] == {
        "name": "wegent-wework-hidden",
        "namespace": "default",
    }
    assert config["chat"] == {"name": "wegent-chat", "namespace": "default"}


def test_add_default_for_modes_marks_wework_team():
    items = [
        {"name": "wegent-wework-hidden", "namespace": "default"},
        {"name": "wegent-chat", "namespace": "default"},
    ]
    default_config = {
        "wework": {"name": "wegent-wework-hidden", "namespace": "default"},
        "chat": {"name": "wegent-chat", "namespace": "default"},
    }

    result = teams_endpoint._add_default_for_modes(items, default_config)

    assert result[0]["default_for_modes"] == ["wework"]
    assert result[1]["default_for_modes"] == ["chat"]


def test_list_teams_api_marks_wework_default(monkeypatch):
    from types import SimpleNamespace

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api.dependencies import get_db
    from app.core import security

    monkeypatch.setattr(
        teams_endpoint.settings,
        "DEFAULT_TEAM_WEWORK",
        "wegent-wework-hidden#default",
    )
    monkeypatch.setattr(teams_endpoint.settings, "DEFAULT_TEAM_CHAT", "")
    monkeypatch.setattr(teams_endpoint.settings, "DEFAULT_TEAM_CODE", "")
    monkeypatch.setattr(teams_endpoint.settings, "DEFAULT_TEAM_KNOWLEDGE", "")
    monkeypatch.setattr(teams_endpoint.settings, "DEFAULT_TEAM_TASK", "")
    monkeypatch.setattr(
        teams_endpoint.team_kinds_service,
        "get_user_teams",
        lambda **_: [
            {
                "id": 1,
                "name": "wegent-wework-hidden",
                "namespace": "default",
                "is_active": True,
            }
        ],
    )

    app = FastAPI()
    app.include_router(teams_endpoint.router, prefix="/teams")
    app.dependency_overrides[get_db] = lambda: None
    app.dependency_overrides[security.get_current_user] = lambda: SimpleNamespace(id=1)

    response = TestClient(app).get("/teams?page=1&limit=100")

    assert response.status_code == 200
    assert response.json()["items"][0]["default_for_modes"] == ["wework"]
