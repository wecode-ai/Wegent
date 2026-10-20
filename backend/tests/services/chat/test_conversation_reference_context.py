# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.api.ws.events import ContextItem
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.services.chat.preprocessing.contexts import (
    link_contexts_to_subtask,
    prepare_contexts_for_chat,
)
from app.services.chat.preprocessing.conversation_references import (
    validate_conversation_references,
)
from app.services.context import context_service


def _create_task(db: Session, user: User, title: str) -> TaskResource:
    task = TaskResource(
        user_id=user.id,
        kind="Task",
        name=f"conversation-{title}",
        namespace="default",
        json={
            "metadata": {
                "name": f"conversation-{title}",
                "namespace": "default",
            },
            "spec": {"title": title},
            "status": {"status": "COMPLETED"},
        },
        is_active=TaskResource.STATE_ACTIVE,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


def _add_message(
    db: Session,
    *,
    user: User,
    task: TaskResource,
    message_id: int,
    role: SubtaskRole,
    prompt: str = "",
    result: dict | None = None,
) -> None:
    db.add(
        Subtask(
            user_id=user.id,
            task_id=task.id,
            team_id=1,
            title=f"message-{message_id}",
            bot_ids=[1],
            role=role,
            executor_namespace="",
            executor_name="",
            prompt=prompt,
            status=SubtaskStatus.COMPLETED,
            progress=100,
            message_id=message_id,
            parent_id=0,
            result=result,
            completed_at=datetime.now(),
        )
    )
    db.commit()


@pytest.mark.asyncio
async def test_conversation_reference_is_injected_as_untrusted_context(
    test_db: Session,
    test_user: User,
) -> None:
    source_task = _create_task(test_db, test_user, "Launch checklist")
    _add_message(
        test_db,
        user=test_user,
        task=source_task,
        message_id=1,
        role=SubtaskRole.USER,
        prompt="Remember the launch code ORBIT-42.",
    )
    _add_message(
        test_db,
        user=test_user,
        task=source_task,
        message_id=2,
        role=SubtaskRole.ASSISTANT,
        result={"value": "The launch code is ORBIT-42."},
    )

    link_contexts_to_subtask(
        db=test_db,
        subtask_id=42,
        user_id=test_user.id,
        contexts=[
            ContextItem(
                type="conversation",
                data={"task_id": source_task.id, "name": "spoofed title"},
            )
        ],
    )
    briefs = context_service.get_briefs_by_subtask(test_db, 42)
    assert briefs[0].task_id == source_task.id
    assert briefs[0].name == "Launch checklist"

    result = await prepare_contexts_for_chat(
        db=test_db,
        user_subtask_id=42,
        user_id=test_user.id,
        message="Continue this work.",
        base_system_prompt="",
        model_config={},
    )

    assert isinstance(result.final_message, str)
    assert "untrusted background context" in result.final_message
    assert 'title="Launch checklist"' in result.final_message
    assert "[user]\nRemember the launch code ORBIT-42." in result.final_message
    assert "[assistant]\nThe launch code is ORBIT-42." in result.final_message
    assert result.final_message.endswith("Continue this work.")


def test_conversation_reference_requires_task_access(
    test_db: Session,
    test_user: User,
) -> None:
    source_task = _create_task(test_db, test_user, "Private task")

    with pytest.raises(HTTPException) as error:
        link_contexts_to_subtask(
            db=test_db,
            subtask_id=42,
            user_id=test_user.id + 1,
            contexts=[
                ContextItem(
                    type="conversation",
                    data={"task_id": source_task.id},
                )
            ],
        )

    assert error.value.status_code == 404


def test_conversation_reference_validation_rejects_current_task(
    test_db: Session,
    test_user: User,
) -> None:
    current_task = _create_task(test_db, test_user, "Current task")

    with pytest.raises(HTTPException) as error:
        validate_conversation_references(
            test_db,
            contexts=[
                ContextItem(
                    type="conversation",
                    data={"task_id": current_task.id},
                )
            ],
            user_id=test_user.id,
            current_task_id=current_task.id,
        )

    assert error.value.status_code == 400


def test_conversation_reference_validation_requires_conversation_content(
    test_db: Session,
    test_user: User,
) -> None:
    empty_task = _create_task(test_db, test_user, "Empty task")

    with pytest.raises(HTTPException) as error:
        validate_conversation_references(
            test_db,
            contexts=[
                ContextItem(
                    type="conversation",
                    data={"task_id": empty_task.id},
                )
            ],
            user_id=test_user.id,
        )

    assert error.value.status_code == 400
