# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from types import SimpleNamespace

import pytest

from app.api.endpoints import users as users_endpoint


class _FakeQuery:
    def __init__(self, result):
        self._result = result

    def filter(self, *args, **kwargs):
        return self

    def first(self):
        return self._result


class _FakeDb:
    def __init__(self, system_config):
        self._system_config = system_config

    def query(self, _model):
        return _FakeQuery(self._system_config)


@pytest.mark.asyncio
async def test_quick_access_response_includes_team_display_name(monkeypatch):
    system_config = SimpleNamespace(version=2, config_value={"teams": [101]})
    db = _FakeDb(system_config)
    current_user = SimpleNamespace(
        id=7,
        preferences=json.dumps({"quick_access": {"version": 1, "teams": []}}),
    )

    def fake_get_team_by_id(team_id: int):
        return {
            "id": team_id,
            "metadata": {
                "name": "system-team",
                "displayName": "Readable System Team",
            },
            "spec": {"recommended_mode": "chat"},
            "agent_type": "claude",
        }

    monkeypatch.setattr(
        users_endpoint.kind_service,
        "get_team_by_id",
        fake_get_team_by_id,
    )

    response = await users_endpoint.get_user_quick_access(
        db=db,
        current_user=current_user,
    )

    assert response.teams[0].name == "system-team"
    assert response.teams[0].display_name == "Readable System Team"


@pytest.mark.asyncio
async def test_quick_access_always_merges_system_teams_and_user_favorites(monkeypatch):
    system_config = SimpleNamespace(version=2, config_value={"teams": [101]})
    db = _FakeDb(system_config)
    current_user = SimpleNamespace(
        id=7,
        preferences=json.dumps({"quick_access": {"version": 2, "teams": [202]}}),
    )

    def fake_get_team_by_id(team_id: int):
        return {
            "id": team_id,
            "metadata": {
                "name": f"team-{team_id}",
                "displayName": f"Team {team_id}",
            },
            "spec": {"recommended_mode": "chat"},
            "agent_type": "claude",
        }

    monkeypatch.setattr(
        users_endpoint.kind_service,
        "get_team_by_id",
        fake_get_team_by_id,
    )

    response = await users_endpoint.get_user_quick_access(
        db=db,
        current_user=current_user,
    )

    assert response.system_team_ids == [101]
    assert [(team.id, team.is_system) for team in response.teams] == [
        (202, False),
        (101, True),
    ]


@pytest.mark.asyncio
async def test_quick_access_uses_saved_order_for_system_and_user_teams(monkeypatch):
    system_config = SimpleNamespace(version=2, config_value={"teams": [101]})
    db = _FakeDb(system_config)
    current_user = SimpleNamespace(
        id=7,
        preferences=json.dumps({"quick_access": {"version": 2, "teams": [101, 202]}}),
    )

    def fake_get_team_by_id(team_id: int):
        return {
            "id": team_id,
            "metadata": {
                "name": f"team-{team_id}",
                "displayName": f"Team {team_id}",
            },
            "spec": {"recommended_mode": "chat"},
            "agent_type": "claude",
        }

    monkeypatch.setattr(
        users_endpoint.kind_service,
        "get_team_by_id",
        fake_get_team_by_id,
    )

    response = await users_endpoint.get_user_quick_access(
        db=db,
        current_user=current_user,
    )

    assert [(team.id, team.is_system) for team in response.teams] == [
        (101, True),
        (202, False),
    ]
