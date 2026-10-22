# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.api.ws.events import ContextItem
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.subtask_context import ContextStatus, ContextType
from app.models.task import TaskResource
from app.models.user import User
from app.services.chat.preprocessing.contexts import (
    link_contexts_to_subtask,
    prepare_contexts_for_chat,
)
from app.services.chat.preprocessing.conversation_references import (
    _bounded_transcript,
    build_conversation_references_prompt,
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

    assert isinstance(result.final_message, list)
    reference_block, user_block = result.final_message
    assert reference_block["type"] == "input_text"
    assert reference_block["text"].startswith("<referenced_conversations>")
    assert reference_block["text"].endswith("</referenced_conversations>")
    assert "explicitly referenced the following earlier conversations" in (
        reference_block["text"]
    )
    assert "interpret it as continuing that work" in reference_block["text"]
    assert 'title="Launch checklist"' in reference_block["text"]
    assert "[user]\nRemember the launch code ORBIT-42." in reference_block["text"]
    assert "[assistant]\nThe launch code is ORBIT-42." in reference_block["text"]
    assert user_block == {"type": "input_text", "text": "Continue this work."}


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


def test_unavailable_reference_is_skipped_without_dropping_valid_ones(
    test_db: Session,
    test_user: User,
) -> None:
    available_task = _create_task(test_db, test_user, "Still here")
    _add_message(
        test_db,
        user=test_user,
        task=available_task,
        message_id=1,
        role=SubtaskRole.USER,
        prompt="Keep this transcript.",
    )
    removed_task = _create_task(test_db, test_user, "Already gone")

    def _context(task_id: int) -> SimpleNamespace:
        return SimpleNamespace(
            context_type=ContextType.CONVERSATION.value,
            status=ContextStatus.READY.value,
            type_data={"task_id": task_id},
        )

    prompt = build_conversation_references_prompt(
        test_db,
        contexts=[_context(removed_task.id), _context(available_task.id)],
        user_id=test_user.id,
    )

    assert "Keep this transcript." in prompt
    assert "no longer available: 1" in prompt


def test_transcript_budget_counts_escaped_characters() -> None:
    rendered, omitted = _bounded_transcript(
        [("user", "&" * 10_000)],
        max_chars=100,
    )

    assert len(rendered) <= 100
    assert omitted == 0


def test_transcript_drops_repeated_entries() -> None:
    rendered, omitted = _bounded_transcript(
        [
            ("user", "first question"),
            ("assistant", "same answer"),
            ("user", "second question"),
            ("assistant", "same answer"),
        ],
        max_chars=10_000,
    )

    assert rendered.count("same answer") == 1
    assert omitted == 0


def test_transcript_keeps_repeated_user_turns() -> None:
    rendered, omitted = _bounded_transcript(
        [
            ("user", "next round"),
            ("assistant", "970"),
            ("user", "next round"),
            ("assistant", "940"),
        ],
        max_chars=10_000,
    )

    assert rendered.count("[user]") == 2
    assert "970" in rendered and "940" in rendered
    assert omitted == 0


def test_transcript_keeps_only_recent_tool_attempt_notes() -> None:
    attempts = [("assistant_attempt", f"attempt-{index}") for index in range(25)]

    rendered, omitted = _bounded_transcript(attempts, max_chars=10_000)

    assert "attempt-24" in rendered
    assert "attempt-0\n" not in rendered
    assert "attempt-4\n" not in rendered
    assert "attempt-5\n" in rendered
    assert omitted == 0


def test_transcript_shortens_older_assistant_replies_before_dropping() -> None:
    old_reply = "A" * 3_000
    latest_reply = "B" * 500

    rendered, omitted = _bounded_transcript(
        [
            ("user", "start"),
            ("assistant", old_reply),
            ("user", "continue"),
            ("assistant", latest_reply),
        ],
        max_chars=2_000,
    )

    assert "characters omitted" in rendered
    assert omitted == 0
    assert latest_reply in rendered
