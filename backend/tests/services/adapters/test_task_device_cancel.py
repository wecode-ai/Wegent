# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Task cancellation for Responses turns placed on traditional devices."""

from copy import deepcopy
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.resource_member import MemberStatus, ResourceMember, ResourceRole
from app.models.share_link import ResourceType
from app.models.subtask import (
    SenderType,
    Subtask,
    SubtaskRole,
    SubtaskStatus,
)
from app.models.task import TaskResource
from app.models.user import User
from app.services.adapters.task_kinds import task_kinds_service
from app.services.chat.storage import session_manager


def _task_json(*, name: str, status: str) -> dict:
    now = datetime.now().isoformat()
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Task",
        "metadata": {
            "name": name,
            "namespace": "default",
            "labels": {"source": "chat_shell"},
        },
        "spec": {
            "title": "Device task",
            "prompt": "hello",
            "teamRef": {"name": "test-team", "namespace": "default"},
            "workspaceRef": {"name": "workspace-1", "namespace": "default"},
            "device_id": "logical-device",
        },
        "status": {
            "state": "Available",
            "status": status,
            "progress": 0,
            "result": None,
            "errorMessage": "",
            "createdAt": now,
            "updatedAt": now,
        },
    }


def _create_task(
    db: Session,
    user_id: int,
    *,
    name: str,
    status: str,
    subtask_status: SubtaskStatus | None,
) -> tuple[TaskResource, Subtask | None]:
    task = TaskResource(
        user_id=user_id,
        kind="Task",
        name=name,
        namespace="default",
        json=_task_json(name=name, status=status),
        is_active=TaskResource.STATE_ACTIVE,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    if subtask_status is None:
        return task, None
    subtask = Subtask(
        user_id=user_id,
        task_id=task.id,
        team_id=1,
        title="Assistant response",
        bot_ids=[1],
        role=SubtaskRole.ASSISTANT,
        executor_namespace="",
        executor_name="",
        prompt="",
        status=subtask_status,
        progress=0,
        message_id=1,
        parent_id=0,
        error_message="",
        completed_at=datetime(1970, 1, 1),
        result=None,
        sender_type=SenderType.TEAM,
        sender_user_id=0,
    )
    db.add(subtask)
    db.commit()
    db.refresh(subtask)
    return task, subtask


def _session_local(test_db: Session):
    def session_factory() -> Session:
        return Session(
            bind=test_db.get_bind(),
            autoflush=False,
            expire_on_commit=False,
            join_transaction_mode="create_savepoint",
        )

    return session_factory


def _cancel_detail(task: TaskResource, status: str) -> dict:
    return {"status": status, "updated_at": datetime.now()}


def _add_approved_member(db: Session, task_id: int, user_id: int) -> None:
    db.add(
        ResourceMember(
            resource_type=ResourceType.TASK,
            resource_id=task_id,
            entity_type="user",
            entity_id=str(user_id),
            user_id=user_id,
            role=ResourceRole.Reporter.value,
            status=MemberStatus.APPROVED,
            copied_resource_id=0,
        )
    )
    db.commit()


@pytest.mark.asyncio
async def test_running_device_cancel_emits_to_the_runtime_room(
    test_db: Session, test_user: User
):
    task, subtask = _create_task(
        test_db,
        test_user.id,
        name="task-running-device-cancel",
        status="RUNNING",
        subtask_status=SubtaskStatus.RUNNING,
    )
    runner = MagicMock()
    route = SimpleNamespace(runtime_device_id="runtime-route")
    sio = AsyncMock()

    with (
        patch.object(
            task_kinds_service,
            "get_task_detail",
            return_value=_cancel_detail(task, "RUNNING"),
        ),
        patch("app.db.session.SessionLocal", _session_local(test_db)),
        patch(
            "app.services.device.runtime_route.runtime_route_resolver.resolve",
            AsyncMock(return_value=route),
        ),
        patch("app.core.socketio.get_sio", return_value=sio),
    ):
        result = await task_kinds_service.cancel_task(
            db=test_db,
            task_id=task.id,
            user_id=test_user.id,
            background_task_runner=runner,
        )
        scheduled = runner.call_args.args
        await scheduled[0](*scheduled[1:])

    test_db.expire_all()
    stored_task = test_db.get(TaskResource, task.id)
    stored_subtask = test_db.get(Subtask, subtask.id)
    assert result == {"message": "Cancel request accepted", "status": "CANCELLING"}
    assert stored_task.json["status"]["status"] == "CANCELLING"
    assert "lastDeviceCancelId" not in stored_task.json["metadata"]["labels"]
    assert stored_subtask.status == SubtaskStatus.RUNNING
    sio.emit.assert_awaited_once_with(
        "task:cancel",
        {"task_id": task.id, "subtask_id": subtask.id},
        room=f"device:{test_user.id}:runtime-route",
        namespace="/local-executor",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("member_owns_turn", [False, True])
async def test_approved_member_can_cancel_running_device_task(
    test_db: Session, test_user: User, member_owns_turn: bool
):
    task, subtask = _create_task(
        test_db,
        test_user.id,
        name="task-member-device-cancel",
        status="RUNNING",
        subtask_status=SubtaskStatus.RUNNING,
    )
    member = User(
        user_name="approved-device-member",
        password_hash="hashed",
        email="approved-device-member@example.com",
        is_active=True,
        git_info=None,
    )
    test_db.add(member)
    test_db.commit()
    test_db.refresh(member)
    runner = MagicMock()
    with pytest.raises(HTTPException) as rejected:
        await task_kinds_service.cancel_task(
            db=test_db,
            task_id=task.id,
            user_id=member.id,
            background_task_runner=runner,
        )
    assert rejected.value.status_code == 404
    runner.assert_not_called()
    assert task.json["status"]["status"] == "RUNNING"
    assert subtask.status == SubtaskStatus.RUNNING

    _add_approved_member(test_db, task.id, member.id)
    execution_user_id = member.id if member_owns_turn else test_user.id
    subtask.user_id = execution_user_id
    test_db.commit()
    route = SimpleNamespace(runtime_device_id="runtime-route")
    sio = AsyncMock()

    with (
        patch("app.db.session.SessionLocal", _session_local(test_db)),
        patch(
            "app.services.device.runtime_route.runtime_route_resolver.resolve",
            AsyncMock(return_value=route),
        ),
        patch("app.core.socketio.get_sio", return_value=sio),
    ):
        result = await task_kinds_service.cancel_task(
            db=test_db,
            task_id=task.id,
            user_id=member.id,
            background_task_runner=runner,
        )
        scheduled = runner.call_args.args
        await scheduled[0](*scheduled[1:])

    test_db.expire_all()
    stored_task = test_db.get(TaskResource, task.id)
    assert stored_task.user_id == test_user.id
    assert result == {"message": "Cancel request accepted", "status": "CANCELLING"}
    assert stored_task.json["status"]["status"] == "CANCELLING"
    sio.emit.assert_awaited_once_with(
        "task:cancel",
        {"task_id": task.id, "subtask_id": subtask.id},
        room=f"device:{execution_user_id}:runtime-route",
        namespace="/local-executor",
    )


@pytest.mark.asyncio
async def test_pending_device_cancel_finalizes_without_emitting_to_the_device(
    test_db: Session, test_user: User
):
    task, subtask = _create_task(
        test_db,
        test_user.id,
        name="task-pending-device-cancel",
        status="PENDING",
        subtask_status=SubtaskStatus.PENDING,
    )
    sio = AsyncMock()
    publish_callback = AsyncMock(return_value=True)
    publish_completed = AsyncMock()

    with (
        patch.object(
            task_kinds_service,
            "get_task_detail",
            return_value=_cancel_detail(task, "PENDING"),
        ),
        patch("app.db.session.SessionLocal", _session_local(test_db)),
        patch.object(
            session_manager, "get_streaming_content", AsyncMock(return_value=None)
        ),
        patch.object(session_manager, "publish_callback_event", publish_callback),
        patch(
            "app.services.chat.operations.cancel.publish_task_cancelled_events",
            publish_completed,
        ),
        patch("app.core.socketio.get_sio", return_value=sio),
    ):
        result = await task_kinds_service.cancel_task(
            db=test_db,
            task_id=task.id,
            user_id=test_user.id,
        )

    test_db.expire_all()
    stored_task = test_db.get(TaskResource, task.id)
    stored_subtask = test_db.get(Subtask, subtask.id)
    assert result == {"message": "Cancel request accepted", "status": "CANCELLING"}
    assert stored_task.json["status"]["status"] == "CANCELLED"
    assert stored_subtask.status == SubtaskStatus.CANCELLED
    sio.emit.assert_not_awaited()
    publish_completed.assert_awaited_once_with(task.id, [subtask.id], test_user.id)
    publish_callback.assert_awaited_once()
    assert publish_callback.await_args.args[0] == subtask.id
    assert publish_callback.await_args.args[1].type == "cancelled"


@pytest.mark.asyncio
async def test_device_cancel_without_an_assistant_finalizes_the_task(
    test_db: Session, test_user: User
):
    task, _ = _create_task(
        test_db,
        test_user.id,
        name="task-device-cancel-no-assistant",
        status="RUNNING",
        subtask_status=None,
    )

    with (
        patch.object(
            task_kinds_service,
            "get_task_detail",
            return_value=_cancel_detail(task, "RUNNING"),
        ),
        patch("app.db.session.SessionLocal", _session_local(test_db)),
    ):
        await task_kinds_service.cancel_task(
            db=test_db,
            task_id=task.id,
            user_id=test_user.id,
        )

    test_db.expire_all()
    stored_task = test_db.get(TaskResource, task.id)
    assert stored_task.json["status"]["status"] == "CANCELLED"


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["COMPLETED", "FAILED", "CANCELLED", "CANCELLING"])
async def test_device_cancel_rechecks_status_on_the_locked_task(
    test_db: Session, test_user: User, status: str
):
    task, _ = _create_task(
        test_db, test_user.id, name="cancel-race", status=status, subtask_status=None
    )
    original = deepcopy(task.json)
    runner = MagicMock()
    with patch.object(
        task_kinds_service,
        "get_task_detail",
        return_value=_cancel_detail(task, "RUNNING"),
    ):
        if status == "CANCELLING":
            accepted = await task_kinds_service.cancel_task(
                db=test_db,
                task_id=task.id,
                user_id=test_user.id,
                background_task_runner=runner,
            )
            assert accepted["status"] == "CANCELLING"
        else:
            with pytest.raises(HTTPException) as rejected:
                await task_kinds_service.cancel_task(
                    db=test_db,
                    task_id=task.id,
                    user_id=test_user.id,
                    background_task_runner=runner,
                )
            assert rejected.value.status_code == 400
    runner.assert_not_called()
    test_db.refresh(task)
    assert task.json == original


@pytest.mark.asyncio
async def test_delayed_device_cancel_does_not_stop_a_continuation(
    test_db: Session, test_user: User
):
    task, original = _create_task(
        test_db,
        test_user.id,
        name="cancel-original",
        status="PENDING",
        subtask_status=SubtaskStatus.PENDING,
    )
    _, continuation = _create_task(
        test_db,
        test_user.id,
        name="cancel-continuation",
        status="RUNNING",
        subtask_status=SubtaskStatus.RUNNING,
    )
    runner = MagicMock()
    await task_kinds_service.cancel_task(
        db=test_db, task_id=task.id, user_id=test_user.id, background_task_runner=runner
    )
    # The supervisor settled the original turn, then a continuation reused the Task.
    original.status = SubtaskStatus.CANCELLED
    continuation.task_id = task.id
    continuation.message_id = original.message_id + 1
    task.json = _task_json(name=task.name, status="RUNNING")
    test_db.commit()
    route = AsyncMock()
    callback = AsyncMock()
    with (
        patch("app.db.session.SessionLocal", _session_local(test_db)),
        patch(
            "app.services.device.runtime_route.runtime_route_resolver.resolve", route
        ),
        patch.object(session_manager, "publish_callback_event", callback),
    ):
        scheduled = runner.call_args.args
        await scheduled[0](*scheduled[1:])
    test_db.refresh(task)
    test_db.refresh(continuation)
    assert task.json["status"]["status"] == "RUNNING"
    assert continuation.status == SubtaskStatus.RUNNING
    route.assert_not_awaited()
    callback.assert_not_awaited()


@pytest.mark.asyncio
async def test_offline_device_cancel_preserves_streamed_text(
    test_db: Session, test_user: User
):
    task, subtask = _create_task(
        test_db,
        test_user.id,
        name="cancel-offline",
        status="RUNNING",
        subtask_status=SubtaskStatus.RUNNING,
    )
    partial = "设备断开前的输出🙂"
    callback = AsyncMock()
    with (
        patch("app.db.session.SessionLocal", _session_local(test_db)),
        patch(
            "app.services.device.runtime_route.runtime_route_resolver.resolve",
            AsyncMock(side_effect=RuntimeError("offline")),
        ),
        patch.object(
            session_manager, "get_streaming_content", AsyncMock(return_value=partial)
        ),
        patch.object(session_manager, "publish_callback_event", callback),
    ):
        await task_kinds_service.cancel_task(
            db=test_db, task_id=task.id, user_id=test_user.id
        )
    test_db.refresh(task)
    test_db.refresh(subtask)
    assert task.json["status"]["status"] == "CANCELLED"
    assert subtask.status == SubtaskStatus.CANCELLED
    assert subtask.result["value"] == partial
    callback.assert_awaited_once()
    callback_subtask_id, event = callback.await_args.args
    assert (callback_subtask_id, event.type, event.result["value"]) == (
        subtask.id,
        "cancelled",
        partial,
    )
