# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.constants import CLIENT_ORIGIN_FRONTEND, CLIENT_ORIGIN_WEWORK
from app.models.im_session import IMPrivateSession, IMSessionMode
from app.models.kind import Kind
from app.models.project import Project
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.task import TaskResource
from app.models.user import User
from app.services.channels.device_selection import DeviceSelection, DeviceType
from app.services.im.session_service import im_session_service
from app.services.im.task_continuation_service import (
    append_message_to_task,
    bind_task_to_sessions,
    build_existing_task_params,
    build_im_message_source,
    build_new_task_params,
    list_recent_wework_tasks,
    list_wework_projects,
    validate_personal_wework_task,
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


def _create_session(
    db: Session,
    user_id: int,
    *,
    conversation_id: str,
) -> IMPrivateSession:
    return im_session_service.get_or_create_private_session(
        db=db,
        user_id=user_id,
        channel_type="dingtalk",
        channel_id=12,
        conversation_id=conversation_id,
        sender_id=f"staff-{conversation_id}",
        display_name=conversation_id,
    )


def test_validate_accepts_owner_wework_personal_task(
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


def test_validate_rejects_frontend_origin_and_wework_group_task(
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


def test_validate_rejects_shared_member_task_if_approved_member_exists(
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


def test_bind_task_to_sessions_sets_task_mode_and_returns_ids_in_request_order(
    test_db: Session,
    test_user: User,
) -> None:
    task = _create_task(
        test_db,
        task_id=9131,
        user_id=test_user.id,
        title="绑定会话任务",
    )
    first = _create_session(test_db, test_user.id, conversation_id="conv-a")
    second = _create_session(test_db, test_user.id, conversation_id="conv-b")
    test_db.commit()

    result = bind_task_to_sessions(
        test_db,
        test_user.id,
        task.id,
        [second.id, first.id],
    )

    assert result == [second.id, first.id]
    assert first.mode == IMSessionMode.TASK
    assert first.active_task_id == task.id
    assert second.mode == IMSessionMode.TASK
    assert second.active_task_id == task.id


def test_list_recent_wework_tasks_filters_origin_group_shared_and_orders(
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


def test_list_wework_projects_filters_origin_active_and_orders(
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


def test_build_existing_task_params_uses_task_labels_and_im_source_metadata(
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
    message_source = {"source": "im", "session_id": "session-1"}

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


@pytest.mark.asyncio
async def test_build_new_task_params_uses_wework_im_defaults_and_source_metadata(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    message_source = {"source": "im", "session_id": "session-1"}
    test_user.preferences = json.dumps(
        {
            "wework_new_chat_model_selection": {
                "modelName": "kimi",
                "modelType": "user",
                "options": {"reasoning": "medium"},
            }
        }
    )

    async def fake_get_selection(user_id: int) -> DeviceSelection:
        return DeviceSelection(
            device_type=DeviceType.LOCAL,
            device_id="device-default",
            device_name="MacBook",
        )

    monkeypatch.setattr(
        "app.services.channels.device_selection.device_selection_manager.get_selection",
        fake_get_selection,
    )

    params = await build_new_task_params(
        test_db,
        user=test_user,
        message="创建一个新任务",
        title="新 IM 任务",
        project_id=456,
        message_source=message_source,
    )

    assert params.message == "创建一个新任务"
    assert params.title == "新 IM 任务"
    assert params.task_type == "chat"
    assert params.is_group_chat is False
    assert params.model_id == "kimi"
    assert params.force_override_bot_model is True
    assert params.force_override_bot_model_type == "user"
    assert params.model_options == {"reasoning": "medium"}
    assert params.device_id == "device-default"
    assert params.project_id == 456
    assert params.client_origin == CLIENT_ORIGIN_WEWORK
    assert params.source == "im"
    assert params.message_source == message_source
    assert params.message_source is not message_source


@pytest.mark.asyncio
async def test_build_new_task_params_uses_default_execution_target_when_im_device_is_chat(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    test_user.preferences = json.dumps(
        {
            "default_execution_target": "device-from-preferences",
            "wework_new_chat_model_selection": {"modelName": "kimi"},
        }
    )

    async def fake_get_selection(user_id: int) -> DeviceSelection:
        return DeviceSelection(device_type=DeviceType.CHAT)

    monkeypatch.setattr(
        "app.services.channels.device_selection.device_selection_manager.get_selection",
        fake_get_selection,
    )

    params = await build_new_task_params(
        test_db,
        user=test_user,
        message="创建一个新任务",
    )

    assert params.device_id == "device-from-preferences"


def test_build_im_message_source_includes_session_identity_and_extra_metadata(
    test_db: Session,
    test_user: User,
) -> None:
    session = _create_session(
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
        "session_id": str(session.id),
        "channel_type": "dingtalk",
        "channel_id": 12,
        "conversation_id": "source-conv",
        "sender_id": "staff-source-conv",
        "message_id": "msg-123",
        "platform": "mobile",
    }


@pytest.mark.asyncio
async def test_append_message_to_task_preserves_task_id_and_triggers_ai(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    team = Kind(
        user_id=test_user.id,
        kind="Team",
        name="assistant",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": "assistant", "namespace": "default"},
            "spec": {"collaborationModel": "sequential", "members": []},
        },
        is_active=True,
    )
    task = _create_task(
        test_db,
        task_id=9161,
        user_id=test_user.id,
        title="继续任务",
    )
    test_db.add(team)
    test_db.commit()
    calls: list[dict[str, object]] = []

    async def fake_create_chat_task(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(task=task, ai_triggered=True)

    monkeypatch.setattr(
        "app.services.im.task_continuation_service.create_chat_task",
        fake_create_chat_task,
    )

    result = await append_message_to_task(
        test_db,
        user=test_user,
        task_id=task.id,
        message="继续",
        message_source={"source": "im", "session_id": "session-1"},
    )

    assert result.task.id == task.id
    assert calls[0]["task_id"] == task.id
    assert calls[0]["should_trigger_ai"] is True
    assert calls[0]["team"].id == team.id
    assert calls[0]["source"] == "im"
