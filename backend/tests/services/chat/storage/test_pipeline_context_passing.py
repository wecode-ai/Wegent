# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for pipeline context passing between bot stages."""

from datetime import datetime
from types import SimpleNamespace

from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.user import User
from app.services.chat.storage.db import DatabaseHandler
from app.services.execution.schedule_helper import _resolve_dispatch_message


def _add_user_subtask(
    db: Session,
    user: User,
    *,
    task_id: int,
    team_id: int,
    message_id: int,
    prompt: str,
) -> Subtask:
    subtask = Subtask(
        user_id=user.id,
        task_id=task_id,
        team_id=team_id,
        title="User",
        bot_ids=[10, 20],
        role=SubtaskRole.USER,
        prompt=prompt,
        status=SubtaskStatus.COMPLETED,
        progress=100,
        message_id=message_id,
        parent_id=0,
        error_message="",
        completed_at=datetime.now(),
        result=None,
    )
    db.add(subtask)
    db.flush()
    return subtask


def _add_completed_stage(
    db: Session,
    user: User,
    *,
    task_id: int,
    team_id: int,
    message_id: int,
    result_value: str,
) -> Subtask:
    subtask = Subtask(
        user_id=user.id,
        task_id=task_id,
        team_id=team_id,
        title="Stage 1",
        bot_ids=[10],
        role=SubtaskRole.ASSISTANT,
        prompt="",
        status=SubtaskStatus.COMPLETED,
        progress=100,
        message_id=message_id,
        parent_id=message_id - 1,
        executor_namespace="default",
        executor_name="wegent-task-user1-pipeline",
        error_message="",
        completed_at=datetime.now(),
        result={"value": result_value},
    )
    db.add(subtask)
    db.flush()
    return subtask


def _auto_advance(
    db: Session,
    user: User,
    *,
    context_passing: str,
) -> tuple[Subtask, Subtask]:
    task_id = 9201
    team_id = 12
    task = SimpleNamespace(id=task_id, user_id=user.id)
    task_crd = SimpleNamespace(
        spec=SimpleNamespace(title="Pipeline task", currentStage=0)
    )

    _add_user_subtask(
        db,
        user,
        task_id=task_id,
        team_id=team_id,
        message_id=1,
        prompt="Build a release checklist.",
    )
    last_subtask = _add_completed_stage(
        db,
        user,
        task_id=task_id,
        team_id=team_id,
        message_id=2,
        result_value="Stage 1 found three release risks.",
    )

    DatabaseHandler()._auto_advance_pipeline(
        db,
        task,
        task_crd,
        last_subtask,
        {
            "next_stage_index": 1,
            "next_bot_id": 20,
            "next_bot_name": "reviewer-bot",
            "context_passing": context_passing,
        },
    )
    db.flush()

    handoff_user = (
        db.query(Subtask)
        .filter(
            Subtask.task_id == task_id,
            Subtask.role == SubtaskRole.USER,
            Subtask.message_id == 3,
        )
        .one()
    )
    next_stage = (
        db.query(Subtask)
        .filter(
            Subtask.task_id == task_id,
            Subtask.role == SubtaskRole.ASSISTANT,
            Subtask.message_id == 4,
        )
        .one()
    )
    return handoff_user, next_stage


def test_pipeline_auto_advance_keeps_empty_prompt_when_context_passing_none(
    test_db: Session,
    test_user: User,
) -> None:
    handoff_user, next_stage = _auto_advance(test_db, test_user, context_passing="none")

    assert handoff_user.prompt == ""
    assert next_stage.prompt == ""
    assert next_stage.parent_id == handoff_user.message_id


def test_pipeline_auto_advance_passes_previous_bot_output(
    test_db: Session,
    test_user: User,
) -> None:
    handoff_user, next_stage = _auto_advance(
        test_db, test_user, context_passing="previous_bot"
    )

    assert (
        handoff_user.prompt
        == "Previous stage output:\nStage 1 found three release risks."
    )
    assert next_stage.prompt == ""
    assert next_stage.parent_id == handoff_user.message_id


def test_pipeline_auto_advance_passes_original_user_message(
    test_db: Session,
    test_user: User,
) -> None:
    handoff_user, next_stage = _auto_advance(
        test_db, test_user, context_passing="original_user"
    )

    assert handoff_user.prompt == "Original user request:\nBuild a release checklist."
    assert next_stage.prompt == ""
    assert next_stage.parent_id == handoff_user.message_id


def test_pipeline_auto_advance_passes_original_user_and_previous_bot_output(
    test_db: Session,
    test_user: User,
) -> None:
    handoff_user, next_stage = _auto_advance(
        test_db,
        test_user,
        context_passing="original_and_previous",
    )

    assert handoff_user.prompt == (
        "Original user request:\nBuild a release checklist.\n\n"
        "Previous stage output:\nStage 1 found three release risks."
    )
    assert next_stage.prompt == ""
    assert next_stage.parent_id == handoff_user.message_id


def test_pipeline_dispatch_uses_parent_user_message_when_assistant_prompt_is_empty(
    test_db: Session,
    test_user: User,
) -> None:
    user_subtask = _add_user_subtask(
        test_db,
        test_user,
        task_id=9301,
        team_id=12,
        message_id=3,
        prompt="Previous stage output:\nReady for review.",
    )
    assistant_subtask = Subtask(
        user_id=test_user.id,
        task_id=9301,
        team_id=12,
        title="Stage 2",
        bot_ids=[20],
        role=SubtaskRole.ASSISTANT,
        prompt="",
        status=SubtaskStatus.PENDING,
        progress=0,
        message_id=4,
        parent_id=user_subtask.message_id,
        executor_namespace="default",
        executor_name="wegent-task-user1-pipeline",
        error_message="",
        completed_at=datetime.now(),
        result=None,
    )
    test_db.add(assistant_subtask)
    test_db.flush()

    assert (
        _resolve_dispatch_message(test_db, assistant_subtask)
        == "Previous stage output:\nReady for review."
    )
