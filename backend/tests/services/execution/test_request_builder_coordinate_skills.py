# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Coding executors must receive member Skills and their MCP dependencies."""

from types import SimpleNamespace

import pytest

from app.services.execution.request_builder import TaskRequestBuilder


@pytest.mark.parametrize("shell_type", ["ClaudeCode", "Codex"])
def test_coordinate_request_preserves_member_capabilities_after_late_preload(
    test_db, mocker, shell_type
):
    builder = TaskRequestBuilder(test_db)
    member_skill = SimpleNamespace(
        id=42,
        user_id=7,
        namespace="default",
        json={
            "kind": "Skill",
            "metadata": {"name": "review", "namespace": "default"},
            "spec": {
                "description": "Review changes",
                "mcpServers": {"review": {"command": "review-mcp", "type": "stdio"}},
            },
            "status": {"fileHash": "member-content-hash"},
        },
    )
    member_mcp = {"name": "member-mcp", "type": "stdio", "command": "member-mcp"}
    bot_configs = [
        {"name": "leader", "shell_type": shell_type, "skills": [], "mcp_servers": []},
        {
            "name": "reviewer",
            "shell_type": shell_type,
            "skills": ["review"],
            "skill_refs": {"review": {"skill_id": 42, "namespace": "default"}},
            "mcp_servers": [member_mcp],
        },
    ]
    team = SimpleNamespace(id=5, user_id=7, name="team", namespace="default", json={})
    user = SimpleNamespace(id=7, user_name="alice")
    bot = SimpleNamespace(id=9)
    mocker.patch(
        "app.services.execution.request_builder.Team.model_validate",
        return_value=SimpleNamespace(
            spec=SimpleNamespace(collaborationModel="coordinate")
        ),
    )
    for method, value in {
        "_get_bot_for_subtask": bot,
        "_build_workspace": {},
        "_build_user_info": {"id": 7},
        "_get_model_config": {},
        "_get_base_system_prompt": "Coordinate the reviewers.",
        "_inject_conditional_provider_skills": [],
        "_get_bot_skills": ([], [], [], {}),
        "_build_bot_config": bot_configs,
        "_build_mcp_servers": [],
        "_is_group_chat": False,
        "_generate_auth_token": "task-jwt",
        "_generate_skill_identity_token": "skill-jwt",
    }.items():
        mocker.patch.object(builder, method, return_value=value)
    find_skill = mocker.patch.object(
        builder, "_find_attached_skill_by_ref", return_value=member_skill
    )

    result = builder.build(
        subtask=SimpleNamespace(id=2, message_id=33),
        task=SimpleNamespace(id=1, json={"spec": {}}, project_id=None),
        user=user,
        team=team,
        message="Review the changes",
    )

    find_skill.assert_called_once_with("review", skill_id=42)
    assert result.skill_names == ["review"]
    assert result.bot[0]["skills"] == ["review"]
    assert result.bot[0]["mcp_servers"] == [
        member_mcp,
        {"name": "review", "command": "review-mcp", "type": "stdio"},
    ]
    expected_ref = {
        "skill_id": 42,
        "namespace": "default",
        "is_public": False,
        "content_hash": "sha256:member-content-hash",
    }
    assert result.skill_refs["review"] == expected_ref
    assert result.bot[0]["skill_refs"]["review"] == expected_ref
    assert result.bot[1]["skill_refs"]["review"] == expected_ref

    # Context processing adds a preload after the initial coordinate request.
    result.preload_skills = ["knowledge"]
    builder._get_bot_skills.return_value = (
        [{"name": "knowledge"}],
        ["knowledge"],
        ["knowledge"],
        {},
    )
    result = builder.resolve_request_preload_skills(
        request=result, bot=bot, team=team, user=user
    )

    assert result.skill_names == ["knowledge", "review"]
    assert result.skill_refs["review"] == expected_ref
    assert result.bot[0]["mcp_servers"] == [
        member_mcp,
        {"name": "review", "command": "review-mcp", "type": "stdio"},
    ]
