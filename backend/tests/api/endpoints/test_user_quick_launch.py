# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app.api.endpoints import users as users_endpoint
from app.schemas.quick_launch import QuickLaunchPreparePresetRequest


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
                    "input_presets": [
                        {
                            "id": "roadmap",
                            "title": "产品路线图",
                            "prompt": "帮我创建一个 xxx 的 PPT",
                            "source_attachment_ids": [300, 301],
                            "options": {
                                "enable_deep_thinking": False,
                                "enable_clarification": True,
                                "force_override": True,
                                "selected_skill_names": ["ppt"],
                            },
                        }
                    ],
                    "enabled": True,
                    "order": 10,
                },
                {
                    "id": "disabled_function",
                    "title": "Disabled function",
                    "team_id": 303,
                    "enabled": False,
                    "order": 1,
                },
                {
                    "id": "malformed_function",
                    "title": "Malformed function",
                    "team_id": 404,
                    "quick_phrases": ["valid", {"bad": "item"}],
                    "enabled": True,
                    "order": 2,
                },
                "not-a-function",
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
    assert [function.id for function in response.system_functions] == ["create_ppt"]
    assert response.system_functions[0].team_id == 101
    assert response.system_functions[0].name == "team-101"
    assert response.system_functions[0].input_presets[0].id == "roadmap"
    assert (
        response.system_functions[0].input_presets[0].prompt
        == "帮我创建一个 xxx 的 PPT"
    )
    assert response.system_functions[0].input_presets[0].source_attachment_ids == [
        300,
        301,
    ]
    assert (
        response.system_functions[0].input_presets[0].options.enable_deep_thinking
        is False
    )
    assert (
        response.system_functions[0].input_presets[0].options.enable_clarification
        is True
    )
    assert response.system_functions[0].input_presets[0].options.force_override is True
    assert response.system_functions[0].input_presets[
        0
    ].options.selected_skill_names == ["ppt"]
    assert response.favorite_agents[0].team_id == 202
    assert response.favorite_agents[0].title == "Team 202"
    assert response.favorite_agents[0].quick_phrases == ["agent phrase 202"]
    assert response.favorite_agents[0].input_presets[0].prompt == "agent phrase 202"


def _attachment_context(context_id: int, user_id: int):
    return SimpleNamespace(
        id=context_id,
        subtask_id=0,
        user_id=user_id,
        context_type="attachment",
        name=f"attachment-{context_id}.pdf",
        status="ready",
        text_length=128,
        error_message="",
        created_at=datetime.now(timezone.utc),
        type_data={
            "original_filename": f"attachment-{context_id}.pdf",
            "file_extension": ".pdf",
            "file_size": 2048,
            "mime_type": "application/pdf",
        },
    )


@pytest.mark.asyncio
async def test_prepare_quick_launch_preset_copies_source_attachments(monkeypatch):
    function_config = SimpleNamespace(
        version=1,
        config_value={
            "functions": [
                {
                    "id": "create_ppt",
                    "title": "创建 PPT",
                    "team_id": 101,
                    "input_presets": [
                        {
                            "id": "roadmap",
                            "title": "产品路线图",
                            "prompt": "帮我创建一个 xxx 的 PPT",
                            "source_attachment_ids": [300, 301],
                        }
                    ],
                    "enabled": True,
                    "order": 10,
                }
            ]
        },
    )
    db = _FakeDb(function_config)
    source_contexts = {
        300: _attachment_context(300, user_id=1),
        301: _attachment_context(301, user_id=1),
    }
    copied_source_ids = []

    def fake_get_team_by_id(team_id: int):
        return {"id": team_id, "metadata": {"name": f"team-{team_id}"}}

    def fake_get_context_optional(_db, context_id: int):
        return source_contexts.get(context_id)

    def fake_copy_attachment_for_user(
        *,
        db,
        source_context,
        target_user_id: int,
        source_metadata: dict,
    ):
        assert db is not None
        copied_source_ids.append(source_context.id)
        assert target_user_id == 7
        assert source_metadata == {
            "source": "quick_launch_preset",
            "quick_launch_function_id": "create_ppt",
            "quick_launch_preset_id": "roadmap",
        }
        return _attachment_context(source_context.id + 1000, user_id=target_user_id)

    monkeypatch.setattr(
        users_endpoint.kind_service,
        "get_team_by_id",
        fake_get_team_by_id,
    )
    monkeypatch.setattr(
        users_endpoint.context_service,
        "get_context_optional",
        fake_get_context_optional,
    )
    monkeypatch.setattr(
        users_endpoint.context_service,
        "copy_attachment_for_user",
        fake_copy_attachment_for_user,
    )

    response = await users_endpoint.prepare_quick_launch_preset(
        request=QuickLaunchPreparePresetRequest(
            function_id="create_ppt",
            preset_id="roadmap",
        ),
        db=db,
        current_user=SimpleNamespace(id=7),
    )

    assert copied_source_ids == [300, 301]
    assert [attachment.id for attachment in response.attachments] == [1300, 1301]
    assert [attachment.filename for attachment in response.attachments] == [
        "attachment-1300.pdf",
        "attachment-1301.pdf",
    ]
