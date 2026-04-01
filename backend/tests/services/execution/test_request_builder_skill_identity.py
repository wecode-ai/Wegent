# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for skill identity generation in TaskRequestBuilder."""

from types import SimpleNamespace

from app.services.auth import verify_skill_identity_token
from app.services.execution.request_builder import TaskRequestBuilder


def test_build_generates_skill_identity_token(test_db, mocker):
    """Builder should attach skill identity token to the execution request."""
    builder = TaskRequestBuilder(test_db)
    subtask = SimpleNamespace(id=2, message_id=33, executor_name="executor-1")
    task = SimpleNamespace(id=1, json={"spec": {}})
    user = SimpleNamespace(id=7, user_name="alice")
    team = SimpleNamespace(id=5, name="team-a", namespace="default", json={})
    bot = SimpleNamespace(id=9)

    mocker.patch(
        "app.services.execution.request_builder.Team.model_validate",
        return_value=SimpleNamespace(spec=SimpleNamespace(collaborationModel="solo")),
    )
    mocker.patch.object(builder, "_get_bot_for_subtask", return_value=bot)
    mocker.patch.object(builder, "_build_workspace", return_value={})
    mocker.patch.object(builder, "_build_user_info", return_value={"id": 7})
    mocker.patch.object(builder, "_get_model_config", return_value={})
    mocker.patch.object(builder, "_get_base_system_prompt", return_value="sys")
    mocker.patch.object(builder, "_inject_conditional_provider_skills", return_value=[])
    mocker.patch.object(builder, "_get_bot_skills", return_value=([], [], [], {}))
    mocker.patch.object(
        builder,
        "_build_bot_config",
        return_value=[{"shell_type": "Chat", "skills": []}],
    )
    mocker.patch.object(builder, "_build_mcp_servers", return_value=[])
    mocker.patch.object(builder, "_is_group_chat", return_value=False)
    mocker.patch.object(builder, "_generate_auth_token", return_value="task-jwt")
    mocker.patch.object(
        builder, "_generate_skill_identity_token", return_value="skill-jwt"
    )

    result = builder.build(
        subtask=subtask,
        task=task,
        user=user,
        team=team,
        message="hello",
    )

    assert result.skill_identity_token == "skill-jwt"


def test_generate_skill_identity_token_uses_sandbox_task_type(test_db):
    """Sandbox tasks should emit sandbox runtime_type in skill identity token."""
    builder = TaskRequestBuilder(test_db)
    subtask = SimpleNamespace(id=2, executor_name="sandbox-executor")
    task = SimpleNamespace(
        id=1,
        json={"metadata": {"labels": {"type": "sandbox"}}, "spec": {}},
    )
    user = SimpleNamespace(id=7, user_name="alice")

    token = builder._generate_skill_identity_token(task, subtask, user)
    info = verify_skill_identity_token(token)

    assert info is not None
    assert info.runtime_type == "sandbox"
