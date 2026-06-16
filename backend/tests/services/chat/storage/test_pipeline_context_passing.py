# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for pipeline context passing between bot stages."""

from datetime import datetime

from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.user import User
from app.services.adapters.pipeline_context import build_pipeline_context_prompt
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


def _build_handoff_prompt(
    db: Session,
    user: User,
    *,
    context_passing: str,
) -> str:
    task_id = 9201
    team_id = 12

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

    return build_pipeline_context_prompt(
        db,
        task_id=task_id,
        current_subtask=last_subtask,
        context_passing=context_passing,
    )


def test_pipeline_context_prompt_keeps_empty_prompt_when_context_passing_none(
    test_db: Session,
    test_user: User,
) -> None:
    assert _build_handoff_prompt(test_db, test_user, context_passing="none") == ""


def test_pipeline_context_prompt_passes_previous_bot_output(
    test_db: Session,
    test_user: User,
) -> None:
    handoff_prompt = _build_handoff_prompt(
        test_db, test_user, context_passing="previous_bot"
    )

    assert (
        handoff_prompt == "Previous stage output:\nStage 1 found three release risks."
    )


def test_pipeline_context_prompt_passes_original_user_message(
    test_db: Session,
    test_user: User,
) -> None:
    handoff_prompt = _build_handoff_prompt(
        test_db, test_user, context_passing="original_user"
    )

    assert handoff_prompt == "Original user request:\nBuild a release checklist."


def test_pipeline_context_prompt_passes_original_user_and_previous_bot_output(
    test_db: Session,
    test_user: User,
) -> None:
    handoff_prompt = _build_handoff_prompt(
        test_db,
        test_user,
        context_passing="original_and_previous",
    )

    assert handoff_prompt == (
        "Original user request:\nBuild a release checklist.\n\n"
        "Previous stage output:\nStage 1 found three release risks."
    )


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
