# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime

import pytest
from sqlalchemy.orm import Session

from app.core.constants import CLIENT_ORIGIN_WEWORK
from app.models.im_session import IMPrivateSession
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.task import TaskResource
from app.models.user import User
from app.services.im.session_service import im_session_service
from app.services.im.task_continuation_service import (
    build_existing_task_params,
    build_im_message_source,
)

pytestmark = pytest.mark.asyncio


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
        db=db,
        user_id=user_id,
        channel_type="dingtalk",
        channel_id=12,
        conversation_id=conversation_id,
        sender_id=f"staff-{conversation_id}",
        display_name=conversation_id,
    )


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
