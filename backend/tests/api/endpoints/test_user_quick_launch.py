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
    def __init__(self, config):
        self._config = config

    def query(self, _model):
        return _FakeQuery(self._config)


@pytest.mark.asyncio
async def test_quick_launch_returns_system_functions_and_favorite_agents(monkeypatch):
    function_config = SimpleNamespace(
        version=1,
        config_value={
            "functions": [
                {
                    "id": "create_ppt",
                    "title": "创建 PPT",
                    "team_id": 101,
                    "quick_phrases": ["帮我创建一个 xxx 的 PPT"],
                    "enabled": True,
                    "order": 10,
                }
            ]
        },
    )
    db = _FakeDb(function_config)
    current_user = SimpleNamespace(
        id=7,
        preferences=json.dumps({"quick_access": {"version": 2, "teams": [202]}}),
    )

    def fake_get_team_by_id(team_id: int):
        return {
            "id": team_id,
            "metadata": {"name": f"team-{team_id}", "displayName": f"Team {team_id}"},
            "spec": {
                "description": f"Description {team_id}",
                "icon": "sparkles",
                "quick_phrases": [f"agent phrase {team_id}"],
                "recommended_mode": "chat",
            },
            "agent_type": "claude",
        }

    monkeypatch.setattr(
        users_endpoint.kind_service,
        "get_team_by_id",
        fake_get_team_by_id,
    )

    response = await users_endpoint.get_user_quick_launch(
        db=db,
        current_user=current_user,
    )

    assert response.system_functions[0].id == "create_ppt"
    assert response.system_functions[0].team_id == 101
    assert response.system_functions[0].name == "team-101"
    assert response.system_functions[0].quick_phrases == ["帮我创建一个 xxx 的 PPT"]
    assert response.favorite_agents[0].team_id == 202
    assert response.favorite_agents[0].title == "Team 202"
    assert response.favorite_agents[0].quick_phrases == ["agent phrase 202"]
