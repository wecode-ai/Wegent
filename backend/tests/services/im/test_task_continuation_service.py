# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import threading
from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session, sessionmaker

from app.core.constants import CLIENT_ORIGIN_FRONTEND, CLIENT_ORIGIN_WEWORK
from app.models.im_session import IMPrivateSession, IMSessionMode
from app.models.project import Project
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.task import TaskResource
from app.models.user import User
from app.services.im.session_service import im_session_service
from app.services.im.task_continuation_service import (
    bind_task_to_sessions,
    build_existing_task_params,
    build_im_message_source,
    list_recent_wework_tasks,
    list_wework_projects,
    validate_personal_wework_task,
)

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def _configure_im_worker_session(
    monkeypatch: pytest.MonkeyPatch,
    test_db: Session,
) -> None:
    from app.db import session as db_session

    monkeypatch.setattr(
        db_session,
        "SessionLocal",
        sessionmaker(
            autocommit=False,
            autoflush=False,
            bind=test_db.get_bind(),
            expire_on_commit=False,
            join_transaction_mode="create_savepoint",
        ),
    )


def _task_json(
    task_id: int,
    title: str,
    *,
    labels: dict[str, str] | None = None,
    team_name: str = "assistant",
) -> dict:
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Task",
        "metadata": {
            "name": f"task-{task_id}",
            "namespace": "default",
            "labels": labels or {"taskType": "chat", "type": "online"},
        },
        "spec": {
            "title": title,
            "prompt": title,
            "teamRef": {
                "name": team_name,
                "namespace": "default",
            },
            "workspaceRef": {
                "name": f"workspace-{task_id}",
                "namespace": "default",
            },
        },
        "status": {"status": "COMPLETED"},
    }


def _create_task(
    db: Session,
    *,
    task_id: int,
    user_id: int,
    title: str,
    client_origin: str = CLIENT_ORIGIN_WEWORK,
    is_group_chat: bool = False,
    is_active: int = TaskResource.STATE_ACTIVE,
    updated_at: datetime | None = None,
    labels: dict[str, str] | None = None,
) -> TaskResource:
    now = updated_at or datetime.now()
    task = TaskResource(
        id=task_id,
        user_id=user_id,
        kind="Task",
        name=f"task-{task_id}",
        namespace="default",
        json=_task_json(task_id, title, labels=labels),
        is_active=is_active,
        client_origin=client_origin,
        is_group_chat=is_group_chat,
        created_at=now,
        updated_at=now,
    )
    db.add(task)
    return task


def _add_approved_member(db: Session, task_id: int, user_id: int) -> None:
    db.add(
        ResourceMember.create(
            resource_type=ResourceType.TASK.value,
            resource_id=task_id,
            entity_id=str(user_id),
            status=MemberStatus.APPROVED.value,
        )
    )


async def _create_session(
    db: Session,
    user_id: int,
    *,
    conversation_id: str,
) -> IMPrivateSession:
    return await im_session_service.get_or_create_private_session(
        user_id=user_id,
        channel_type="dingtalk",
        channel_id=12,
        conversation_id=conversation_id,
        sender_id=f"staff-{conversation_id}",
        display_name=conversation_id,
    )


async def test_validate_accepts_owner_wework_personal_task(
    test_db: Session,
    test_user: User,
) -> None:
    task = _create_task(
        test_db,
        task_id=9101,
        user_id=test_user.id,
        title="处理 IM 私聊任务",
    )
    test_db.commit()

    result = validate_personal_wework_task(test_db, test_user.id, task.id)

    assert result.id == task.id
    assert result.client_origin == CLIENT_ORIGIN_WEWORK


async def test_validate_rejects_frontend_origin_and_wework_group_task(
    test_db: Session,
    test_user: User,
) -> None:
    frontend_task = _create_task(
        test_db,
        task_id=9111,
        user_id=test_user.id,
        title="前端任务",
        client_origin=CLIENT_ORIGIN_FRONTEND,
    )
    group_task = _create_task(
        test_db,
        task_id=9112,
        user_id=test_user.id,
        title="群聊任务",
        is_group_chat=True,
    )
    test_db.commit()

    with pytest.raises(HTTPException) as wrong_origin:
        validate_personal_wework_task(test_db, test_user.id, frontend_task.id)
    assert wrong_origin.value.status_code == 404

    with pytest.raises(HTTPException) as group_error:
        validate_personal_wework_task(test_db, test_user.id, group_task.id)
    assert group_error.value.status_code == 400


async def test_validate_rejects_shared_member_task_if_approved_member_exists(
    test_db: Session,
    test_user: User,
) -> None:
    task = _create_task(
        test_db,
        task_id=9121,
        user_id=test_user.id,
        title="已共享任务",
    )
    _add_approved_member(test_db, task.id, user_id=test_user.id + 100)
    test_db.commit()

    with pytest.raises(HTTPException) as exc_info:
        validate_personal_wework_task(test_db, test_user.id, task.id)

    assert exc_info.value.status_code == 400


async def test_bind_task_to_sessions_sets_task_mode_and_returns_keys_in_request_order(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services.im import task_continuation_service

    task = _create_task(
        test_db,
        task_id=9131,
        user_id=test_user.id,
        title="绑定会话任务",
    )
    first = await _create_session(test_db, test_user.id, conversation_id="conv-a")
    second = await _create_session(test_db, test_user.id, conversation_id="conv-b")
    test_db.commit()
    loop_thread_id = threading.get_ident()
    worker_thread_ids: list[int] = []
    load_target = task_continuation_service._load_task_binding_target

    def tracked_load_target(user_id: int, task_id: int) -> tuple[int, str]:
        worker_thread_ids.append(threading.get_ident())
        return load_target(user_id, task_id)

    monkeypatch.setattr(
        task_continuation_service,
        "_load_task_binding_target",
        tracked_load_target,
    )

    result = await bind_task_to_sessions(
        test_user.id,
        task.id,
        [second.session_key, first.session_key],
    )

    assert result.task_id == task.id
    assert result.task_title == "绑定会话任务"
    assert result.session_keys == (second.session_key, first.session_key)
    assert [session.session_key for session in result.sessions] == [
        second.session_key,
        first.session_key,
    ]
    assert worker_thread_ids
    assert all(thread_id != loop_thread_id for thread_id in worker_thread_ids)
    bound_first = await im_session_service.get_session(first.session_key)
    bound_second = await im_session_service.get_session(second.session_key)
    assert bound_first is not None
    assert bound_second is not None
    assert bound_first.mode == IMSessionMode.TASK
    assert bound_first.active_task_id == task.id
    assert bound_second.mode == IMSessionMode.TASK
    assert bound_second.active_task_id == task.id


async def test_list_recent_wework_tasks_filters_origin_group_shared_and_orders(
    test_db: Session,
    test_user: User,
) -> None:
    base = datetime(2026, 1, 1, 10, 0, 0)
    older = _create_task(
        test_db,
        task_id=9141,
        user_id=test_user.id,
        title="较早任务",
        updated_at=base,
    )
    tie_low = _create_task(
        test_db,
        task_id=9142,
        user_id=test_user.id,
        title="同时间低 ID",
        updated_at=base + timedelta(minutes=1),
    )
    tie_high = _create_task(
        test_db,
        task_id=9143,
        user_id=test_user.id,
        title="同时间高 ID",
        updated_at=base + timedelta(minutes=1),
    )
    _create_task(
        test_db,
        task_id=9144,
        user_id=test_user.id,
        title="前端任务",
        client_origin=CLIENT_ORIGIN_FRONTEND,
        updated_at=base + timedelta(minutes=2),
    )
    _create_task(
        test_db,
        task_id=9145,
        user_id=test_user.id,
        title="群聊任务",
        is_group_chat=True,
        updated_at=base + timedelta(minutes=3),
    )
    shared = _create_task(
        test_db,
        task_id=9146,
        user_id=test_user.id,
        title="共享任务",
        updated_at=base + timedelta(minutes=4),
    )
    _add_approved_member(test_db, shared.id, user_id=test_user.id + 101)
    test_db.commit()

    result = list_recent_wework_tasks(test_db, test_user.id, limit=5)

    assert result == [
        {"id": tie_high.id, "title": "同时间高 ID"},
        {"id": tie_low.id, "title": "同时间低 ID"},
        {"id": older.id, "title": "较早任务"},
    ]


async def test_list_wework_projects_filters_origin_active_and_orders(
    test_db: Session,
    test_user: User,
) -> None:
    base = datetime(2026, 1, 2, 10, 0, 0)
    first = Project(
        id=9201,
        user_id=test_user.id,
        name="较早项目",
        client_origin=CLIENT_ORIGIN_WEWORK,
        is_active=True,
        updated_at=base,
    )
    tie_low = Project(
        id=9202,
        user_id=test_user.id,
        name="同时间低 ID",
        client_origin=CLIENT_ORIGIN_WEWORK,
        is_active=True,
        updated_at=base + timedelta(minutes=1),
    )
    tie_high = Project(
        id=9203,
        user_id=test_user.id,
        name="同时间高 ID",
        client_origin=CLIENT_ORIGIN_WEWORK,
        is_active=True,
        updated_at=base + timedelta(minutes=1),
    )
    frontend = Project(
        id=9204,
        user_id=test_user.id,
        name="前端项目",
        client_origin=CLIENT_ORIGIN_FRONTEND,
        is_active=True,
        updated_at=base + timedelta(minutes=2),
    )
    inactive = Project(
        id=9205,
        user_id=test_user.id,
        name="停用项目",
        client_origin=CLIENT_ORIGIN_WEWORK,
        is_active=False,
        updated_at=base + timedelta(minutes=3),
    )
    test_db.add_all([first, tie_low, tie_high, frontend, inactive])
    test_db.commit()

    result = list_wework_projects(test_db, test_user.id, limit=8)

    assert result == [
        {"id": tie_high.id, "name": "同时间高 ID"},
        {"id": tie_low.id, "name": "同时间低 ID"},
        {"id": first.id, "name": "较早项目"},
    ]


async def test_build_existing_task_params_uses_task_labels_and_im_source_metadata(
    test_db: Session,
    test_user: User,
) -> None:
    task = _create_task(
        test_db,
        task_id=9151,
        user_id=test_user.id,
        title="继续代码任务",
        labels={
            "taskType": "code",
            "source": "web",
            "modelId": "codex-gpt-5.5",
            "forceOverrideBotModel": "true",
            "forceOverrideBotModelType": "runtime",
            "modelOptions": '{"reasoning": "high", "speed": "standard"}',
        },
    )
    task.project_id = 312
    task.json["spec"]["device_id"] = "device-task"
    test_db.commit()
    message_source = {"source": "im", "session_key": "session-1"}

    params = build_existing_task_params(
        task,
        message="继续处理",
        message_source=message_source,
    )

    assert params.message == "继续处理"
    assert params.title == "继续代码任务"
    assert params.task_type == "code"
    assert params.model_id == "codex-gpt-5.5"
    assert params.force_override_bot_model is True
    assert params.force_override_bot_model_type == "runtime"
    assert params.model_options == {"reasoning": "high", "speed": "standard"}
    assert params.device_id == "device-task"
    assert params.project_id == 312
    assert params.client_origin == CLIENT_ORIGIN_WEWORK
    assert params.source == "im"
    assert params.message_source == message_source


async def test_build_im_message_source_includes_session_identity_and_extra_metadata(
    test_db: Session,
    test_user: User,
) -> None:
    session = await _create_session(
        test_db,
        test_user.id,
        conversation_id="source-conv",
    )
    test_db.commit()

    source = build_im_message_source(
        session,
        message_id="msg-123",
        extra={"platform": "mobile"},
    )

    assert source == {
        "source": "im",
        "session_key": session.session_key,
        "channel_type": "dingtalk",
        "channel_id": 12,
        "conversation_id": "source-conv",
        "sender_id": "staff-source-conv",
        "message_id": "msg-123",
        "platform": "mobile",
    }
