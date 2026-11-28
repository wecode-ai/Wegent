# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Pipeline prompt resolution tests for TaskRequestBuilder."""

from app.schemas.kind import Team
from app.services.execution.request_builder import TaskRequestBuilder
from shared.models.db import Kind


def _create_ghost(test_db, *, user_id: int, name: str, system_prompt: str) -> Kind:
    ghost = Kind(
        user_id=user_id,
        kind="Ghost",
        name=name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Ghost",
            "metadata": {"name": name, "namespace": "default"},
            "spec": {"systemPrompt": system_prompt, "mcpServers": {}, "skills": []},
        },
        is_active=True,
    )
    test_db.add(ghost)
    test_db.commit()
    test_db.refresh(ghost)
    return ghost


def _create_bot(test_db, *, user_id: int, name: str, ghost_name: str) -> Kind:
    bot = Kind(
        user_id=user_id,
        kind="Bot",
        name=name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Bot",
            "metadata": {"name": name, "namespace": "default"},
            "spec": {
                "ghostRef": {"name": ghost_name, "namespace": "default"},
                "shellRef": {"name": "ClaudeCode", "namespace": "default"},
            },
        },
        is_active=True,
    )
    test_db.add(bot)
    test_db.commit()
    test_db.refresh(bot)
    return bot


def _create_pipeline_team(
    test_db, *, user_id: int, first_bot: Kind, second_bot: Kind
) -> Kind:
    team = Kind(
        user_id=user_id,
        kind="Team",
        name="pipeline-team",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": "pipeline-team", "namespace": "default"},
            "spec": {
                "collaborationModel": "pipeline",
                "members": [
                    {
                        "botRef": {
                            "name": first_bot.name,
                            "namespace": first_bot.namespace,
                        },
                        "prompt": "STAGE_ONE_MEMBER_PROMPT",
                        "role": "leader",
                        "requireConfirmation": True,
                        "contextPassing": "none",
                    },
                    {
                        "botRef": {
                            "name": second_bot.name,
                            "namespace": second_bot.namespace,
                        },
                        "prompt": "STAGE_TWO_MEMBER_PROMPT",
                        "role": "worker",
                        "requireConfirmation": False,
                        "contextPassing": "none",
                    },
                ],
            },
        },
        is_active=True,
    )
    test_db.add(team)
    test_db.commit()
    test_db.refresh(team)
    return team


def test_pipeline_bot_config_uses_current_stage_member_prompt(test_db, mocker):
    """Pipeline stage two uses stage two bot and member prompt in runtime config."""
    user_id = 7
    _create_ghost(
        test_db,
        user_id=user_id,
        name="stage-one-ghost",
        system_prompt="STAGE_ONE_GHOST_PROMPT",
    )
    _create_ghost(
        test_db,
        user_id=user_id,
        name="stage-two-ghost",
        system_prompt="STAGE_TWO_GHOST_PROMPT",
    )
    first_bot = _create_bot(
        test_db,
        user_id=user_id,
        name="stage-one-bot",
        ghost_name="stage-one-ghost",
    )
    second_bot = _create_bot(
        test_db,
        user_id=user_id,
        name="stage-two-bot",
        ghost_name="stage-two-ghost",
    )
    team = _create_pipeline_team(
        test_db, user_id=user_id, first_bot=first_bot, second_bot=second_bot
    )
    team_crd = Team.model_validate(team.json)
    builder = TaskRequestBuilder(test_db)

    mocker.patch.object(
        builder,
        "_resolve_shell_info",
        return_value={"shell_type": "ClaudeCode", "base_image": "executor:latest"},
    )
    mocker.patch(
        "app.services.chat.config.model_resolver.build_agent_config_for_bot",
        return_value={},
    )

    bot_configs = builder._build_bot_config(
        team,
        team_crd,
        second_bot,
        user_id=user_id,
    )

    assert len(bot_configs) == 1
    assert bot_configs[0]["id"] == second_bot.id
    assert bot_configs[0]["name"] == second_bot.name
    assert bot_configs[0]["role"] == "worker"
    assert "STAGE_TWO_GHOST_PROMPT" in bot_configs[0]["system_prompt"]
    assert "STAGE_TWO_MEMBER_PROMPT" in bot_configs[0]["system_prompt"]
    assert "STAGE_ONE_MEMBER_PROMPT" not in bot_configs[0]["system_prompt"]


def test_pending_task_resumes_current_stage_after_session_restart(test_db, test_user):
    from copy import deepcopy

    from sqlalchemy.orm import Session

    from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
    from app.models.task import TaskResource
    from app.schemas.task import TaskCreate
    from app.services.adapters.pipeline_stage import pipeline_stage_service
    from app.services.adapters.task_kinds import task_kinds_service

    owner = test_user.id
    bots = []
    for name in ("author", "reviewer"):
        ghost = _create_ghost(test_db, user_id=owner, name=name, system_prompt=name)
        bot = _create_bot(test_db, user_id=owner, name=name, ghost_name=ghost.name)
        bots.append(bot)
    team = _create_pipeline_team(
        test_db, user_id=owner, first_bot=bots[0], second_bot=bots[1]
    )
    request = TaskCreate(team_id=team.id, prompt="Review", task_type="task")
    old = task_kinds_service.create_task_or_append(
        test_db, obj_in=request, user=test_user
    )
    task = test_db.get(TaskResource, old["id"])
    assistant = (
        test_db.query(Subtask)
        .filter_by(task_id=task.id, role=SubtaskRole.ASSISTANT)
        .one()
    )
    assistant.status = SubtaskStatus.COMPLETED
    test_db.flush()
    assert pipeline_stage_service.should_set_pending_confirmation_on_complete(
        test_db, task.id, assistant.id
    )
    waiting = deepcopy(task.json)
    waiting["status"]["status"] = "PENDING_CONFIRMATION"
    del waiting["spec"]["currentStage"]
    task.json = waiting
    edited = deepcopy(team.json)
    edited["spec"]["members"][1]["botRef"] = edited["spec"]["members"][0]["botRef"]
    team.json = edited
    test_db.commit()
    with Session(bind=test_db.get_bind()) as restarted:
        restored = pipeline_stage_service.pipeline_confirm(restarted, old["id"], owner)
        assert restored["success"] and restored["next_stage_name"] == "author"
