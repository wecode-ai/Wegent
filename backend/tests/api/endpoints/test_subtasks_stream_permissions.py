# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session, sessionmaker

from app.api.endpoints import subtasks as subtasks_endpoint
from app.api.endpoints.subtasks import subscribe_group_stream
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User


def _task(task_id: int, owner_id: int) -> TaskResource:
    return TaskResource(
        id=task_id,
        user_id=owner_id,
        kind="Task",
        name=f"task-{task_id}",
        namespace="default",
        json={
            "kind": "Task",
            "metadata": {"name": f"task-{task_id}", "namespace": "default"},
            "spec": {"is_group_chat": True},
            "status": {"status": "PENDING"},
        },
        is_active=TaskResource.STATE_ACTIVE,
        is_group_chat=True,
    )


def _subtask(subtask_id: int, task_id: int, user_id: int) -> Subtask:
    return Subtask(
        id=subtask_id,
        user_id=user_id,
        task_id=task_id,
        team_id=1,
        title="streaming",
        bot_ids=[],
        role=SubtaskRole.ASSISTANT,
        prompt="",
        status=SubtaskStatus.RUNNING,
        progress=1,
        message_id=1,
        parent_id=0,
        error_message="",
        completed_at=datetime.now(),
    )


@pytest.mark.asyncio
async def test_subscribe_group_stream_rejects_subtask_from_other_task(
    test_db: Session,
    monkeypatch,
) -> None:
    user = User(
        id=901,
        user_name="stream-owner",
        password_hash="hash",
        email="stream-owner@example.com",
        is_active=True,
    )
    test_db.add(user)
    test_db.add(_task(9011, owner_id=user.id))
    test_db.add(_task(9012, owner_id=user.id))
    test_db.add(_subtask(90121, task_id=9012, user_id=user.id))
    test_db.commit()
    from app.db import session as db_session

    monkeypatch.setattr(
        db_session,
        "SessionLocal",
        sessionmaker(
            bind=test_db.connection(),
            autoflush=False,
            expire_on_commit=False,
        ),
    )

    with pytest.raises(HTTPException) as exc_info:
        await subscribe_group_stream(
            task_id=9011,
            subtask_id=90121,
            current_user=user,
        )

    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_subscribe_stream_only_relays_worker_bytes(monkeypatch) -> None:
    calls = []

    async def worker_stream(operation, payload):
        calls.append((operation, payload))
        yield b'event: message\ndata: {"content":"first","done":false}\n\n'
        yield b'event: message\ndata: {"content":"","done":true}\n\n'

    monkeypatch.setattr(
        subtasks_endpoint,
        "_can_subscribe_stream_sync",
        lambda task_id, subtask_id, user_id: True,
    )
    web_redis_read = AsyncMock(side_effect=AssertionError("Web touched Redis"))
    web_redis_subscribe = AsyncMock(side_effect=AssertionError("Web touched Redis"))
    monkeypatch.setattr(
        subtasks_endpoint.session_manager,
        "get_streaming_content",
        web_redis_read,
    )
    monkeypatch.setattr(
        subtasks_endpoint.session_manager,
        "subscribe_streaming_channel",
        web_redis_subscribe,
    )
    monkeypatch.setattr(
        subtasks_endpoint.web_stream_worker_client,
        "stream",
        worker_stream,
    )

    response = await subscribe_group_stream(
        task_id=1,
        subtask_id=2,
        offset=0,
        current_user=SimpleNamespace(id=3),
    )

    events = [event async for event in response.body_iterator]
    assert events == [
        b'event: message\ndata: {"content":"first","done":false}\n\n',
        b'event: message\ndata: {"content":"","done":true}\n\n',
    ]
    assert calls == [("subtask_subscription", {"subtask_id": 2, "offset": 0})]
    web_redis_read.assert_not_awaited()
    web_redis_subscribe.assert_not_awaited()
