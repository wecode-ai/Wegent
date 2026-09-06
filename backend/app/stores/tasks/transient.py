# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource


def build_transient_task(
    *,
    task_id: int,
    user_id: int,
    name: str,
    namespace: str,
    project_id: int,
    client_origin: str,
    payload: dict[str, Any],
) -> TaskResource:
    """Construct a TaskResource for request compilation without persisting it."""

    return TaskResource(
        id=task_id,
        user_id=user_id,
        kind="Task",
        name=name,
        namespace=namespace,
        project_id=project_id,
        client_origin=client_origin,
        json=payload,
    )


def build_transient_assistant_subtask(
    *,
    subtask_id: int,
    user_id: int,
    task_id: int,
    team_id: int,
    title: str,
    prompt: str,
    message_id: int,
) -> Subtask:
    """Construct an assistant Subtask for request compilation without persisting it."""

    return Subtask(
        id=subtask_id,
        user_id=user_id,
        task_id=task_id,
        team_id=team_id,
        title=title,
        bot_ids=[],
        role=SubtaskRole.ASSISTANT,
        prompt=prompt,
        message_id=message_id,
        status=SubtaskStatus.PENDING,
    )
