# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Focused contracts for forwarding human submissions to manager Executors."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.services.human_submission_coordination import (
    COORDINATION_FACT_EVENT,
    LOCAL_EXECUTOR_NAMESPACE,
    human_submission_coordination_service,
)


def _project(db: Session, user: User) -> CloudProject:
    public_id = str(uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key=f"FACT{uuid4().hex[:6].upper()}",
        name="Coordination fact",
        description="",
        created_by_user_id=user.id,
        storage_prefix=f"projects/{public_id}",
    )
    db.add(project)
    db.flush()
    return project


def _item(
    db: Session,
    project: CloudProject,
    user: User,
    *,
    title: str,
    parent_id: str | None = None,
) -> LoopItem:
    item = LoopItem(
        id=f"T{uuid4().hex[:12]}",
        cloud_project_id=project.id,
        parent_id=parent_id,
        title=title,
        description="",
        status="in_progress",
        created_by_user_id=user.id,
        metadata_json={},
    )
    db.add(item)
    db.flush()
    return item


def _manager_execution(
    db: Session,
    *,
    item: LoopItem,
    user: User,
    device_id: str,
    status: str = "completed",
) -> LoopItemExecution:
    execution = LoopItemExecution(
        loop_item_id=item.id,
        cloud_project_id=str(item.cloud_project_id),
        executor_owner_user_id=user.id,
        agent_id=f"A{uuid4().hex[:10]}",
        execution_environment="cloud",
        execution_device_id=f"logical-{device_id}",
        runtime_device_id=device_id,
        runtime_task_id=f"loop-item-execution:{uuid4().hex}",
        status=status,
        execution_payload=json.dumps(
            {
                "origin_context": {
                    "dispatch_role": "manager",
                    "collaboration_group_id": "group-1",
                }
            }
        ),
    )
    db.add(execution)
    db.flush()
    return execution


def _submission(
    db: Session,
    *,
    item: LoopItem,
    user: User,
    content: str = "Evidence is ready.",
) -> ProjectChatMessage:
    message = ProjectChatMessage(
        message_id=str(uuid4()),
        client_message_id=str(uuid4()),
        project_id=str(item.cloud_project_id),
        task_id=item.id,
        sender_type="user",
        sender_id=str(user.id),
        sender_name=user.user_name,
        message_type="text",
        content=content,
        metadata_json={"human_work_action": "submitted"},
        status="completed",
    )
    db.add(message)
    db.flush()
    return message


@pytest.mark.asyncio
async def test_human_submission_fact_targets_nearest_manager_executor(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = _project(test_db, test_user)
    root = _item(test_db, project, test_user, title="Root")
    child = _item(
        test_db,
        project,
        test_user,
        title="Human child",
        parent_id=root.id,
    )
    unrelated = _item(test_db, project, test_user, title="Unrelated")
    _manager_execution(
        test_db,
        item=unrelated,
        user=test_user,
        device_id="wrong-device",
    )
    _manager_execution(
        test_db,
        item=root,
        user=test_user,
        device_id="manager-device",
    )
    message = _submission(test_db, item=child, user=test_user)
    test_db.commit()

    resolve = AsyncMock(return_value=SimpleNamespace(socket_id="manager-socket"))
    emit = AsyncMock()
    monkeypatch.setattr(
        "app.services.human_submission_coordination.runtime_route_resolver.resolve",
        resolve,
    )
    monkeypatch.setattr(
        "app.core.socketio.get_sio",
        lambda: SimpleNamespace(emit=emit),
    )

    published = await human_submission_coordination_service.publish(
        test_db,
        item=child,
        message=message,
    )

    assert published is True
    resolve.assert_awaited_once_with(
        user_id=test_user.id,
        submitted_device_id="manager-device",
    )
    emit.assert_awaited_once_with(
        COORDINATION_FACT_EVENT,
        {
            "factType": "human_submitted",
            "itemId": child.id,
            "submissionId": message.message_id,
            "summary": message.content,
        },
        to="manager-socket",
        namespace=LOCAL_EXECUTOR_NAMESPACE,
    )


@pytest.mark.asyncio
async def test_human_submission_without_waiting_manager_is_safe_noop(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = _project(test_db, test_user)
    root = _item(test_db, project, test_user, title="Root")
    child = _item(
        test_db,
        project,
        test_user,
        title="Human child",
        parent_id=root.id,
    )
    _manager_execution(
        test_db,
        item=root,
        user=test_user,
        device_id="stale-manager-device",
    )
    _manager_execution(
        test_db,
        item=root,
        user=test_user,
        device_id="cancelled-manager-device",
        status="cancelled",
    )
    message = _submission(test_db, item=child, user=test_user)
    test_db.commit()
    resolve = AsyncMock()
    monkeypatch.setattr(
        "app.services.human_submission_coordination.runtime_route_resolver.resolve",
        resolve,
    )

    published = await human_submission_coordination_service.publish(
        test_db,
        item=child,
        message=message,
    )

    assert published is False
    resolve.assert_not_awaited()
