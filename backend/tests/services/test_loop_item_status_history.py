# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Status transition history for cloud projects."""

import uuid

from app.models.delivery import CloudProject, LoopItem
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.schemas.cloud_project import (
    CloudProjectBoardConfig,
    CloudProjectBoardStatus,
    CloudProjectUpdate,
)
from app.schemas.delivery import LoopItemCreate, LoopItemTaskBind, LoopItemUpdate
from app.services.cloud_projects.service import cloud_project_service
from app.services.loop_items.service import loop_item_service


def _make_project(db, user: User) -> CloudProject:
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key=f"SH{uuid.uuid4().hex[:6].upper()}",
        name="Status history project",
        description="",
        created_by_user_id=user.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json={},
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def _create_item(db, project: CloudProject, user: User, **overrides) -> LoopItem:
    values = LoopItemCreate(title="History task", **overrides)
    return loop_item_service.create(db, project.id, user.id, values)


def _history(item: LoopItem) -> list[dict]:
    metadata = item.metadata_json if isinstance(item.metadata_json, dict) else {}
    history = metadata.get("status_history")
    return history if isinstance(history, list) else []


def test_create_records_initial_entry(test_db, test_user) -> None:
    project = _make_project(test_db, test_user)

    item = _create_item(test_db, project, test_user)

    history = _history(item)
    assert len(history) == 1
    assert history[0]["from_status"] == ""
    assert history[0]["to_status"] == "inbox"
    assert history[0]["from_status_name"] == ""
    assert history[0]["to_status_name"] == "收集箱"
    assert history[0]["trigger"] == "create"
    assert history[0]["by_user_id"] == test_user.id
    assert "at" in history[0]


def test_create_with_tags_keeps_initial_entry(test_db, test_user) -> None:
    project = _make_project(test_db, test_user)

    item = _create_item(test_db, project, test_user, tags=["a", "b"])

    history = _history(item)
    assert len(history) == 1
    assert history[0]["trigger"] == "create"
    assert item.metadata_json["tags"] == ["a", "b"]


def test_drag_records_user_update(test_db, test_user) -> None:
    project = _make_project(test_db, test_user)
    item = _create_item(test_db, project, test_user)

    updated = loop_item_service.update(
        test_db,
        item.id,
        test_user.id,
        LoopItemUpdate(version=item.version, status="in_progress"),
    )

    history = _history(updated)
    assert len(history) == 2
    last = history[-1]
    assert last["trigger"] == "user_update"
    assert last["from_status"] == "inbox"
    assert last["to_status"] == "in_progress"
    assert last["from_status_name"] == "收集箱"
    assert last["to_status_name"] == "进行中"
    assert last["by_user_id"] == test_user.id


def test_ai_completed_reconcile_records_entry(test_db, test_user) -> None:
    project = _make_project(test_db, test_user)
    item = _create_item(test_db, project, test_user)
    item.metadata_json = {
        **item.metadata_json,
        "ai_state": {
            "status": "running",
            "project_chat_message_id": "msg-1",
        },
    }
    test_db.commit()
    test_db.add(
        ProjectChatMessage(
            message_id="msg-1",
            client_message_id="msg-1",
            project_id=str(project.id),
            task_id=item.id,
            sender_type="agent",
            sender_id="agent-1",
            sender_name="Bot",
            message_type="agent_chunk",
            content="done",
            status="completed",
        )
    )
    test_db.commit()

    values = loop_item_service.response_values(test_db, item, test_user.id)
    history = values["status_history"]
    assert len(history) == 2
    last = history[-1]
    assert last["trigger"] == "ai_completed"
    assert last["to_status"] == "in_review"
    assert last["to_status_name"] == "待确认"
    assert last["by_user_id"] is None

    test_db.refresh(item)
    values_again = loop_item_service.response_values(test_db, item, test_user.id)
    assert len(values_again["status_history"]) == 2


def test_creator_only_project_still_records(test_db, test_user) -> None:
    """Every cloud project records transitions, not just multi-member ones."""
    project = _make_project(test_db, test_user)

    item = _create_item(test_db, project, test_user)
    assert len(_history(item)) == 1

    updated = loop_item_service.update(
        test_db,
        item.id,
        test_user.id,
        LoopItemUpdate(version=item.version, status="in_progress"),
    )
    assert len(_history(updated)) == 2


def test_from_equals_to_adds_nothing(test_db, test_user) -> None:
    project = _make_project(test_db, test_user)
    item = _create_item(test_db, project, test_user)

    updated = loop_item_service.update(
        test_db,
        item.id,
        test_user.id,
        LoopItemUpdate(version=item.version, status="inbox"),
    )
    assert len(_history(updated)) == 1


def test_status_removal_bulk_clear_appends_entries(test_db, test_user) -> None:
    project = _make_project(test_db, test_user)
    with_done = CloudProjectBoardConfig(
        statuses=[
            CloudProjectBoardStatus(id="inbox", name="收集箱", color="gray"),
            CloudProjectBoardStatus(id="pending", name="待开始", color="blue"),
            CloudProjectBoardStatus(id="in_progress", name="进行中", color="orange"),
            CloudProjectBoardStatus(id="in_review", name="待确认", color="purple"),
            CloudProjectBoardStatus(id="completed", name="已完成", color="green"),
            CloudProjectBoardStatus(id="done", name="已归档", color="gray"),
        ]
    )
    project = cloud_project_service.update(
        test_db,
        project.id,
        test_user.id,
        CloudProjectUpdate(version=project.version, board_config=with_done),
    )
    item = _create_item(test_db, project, test_user, status="done")

    without_done = CloudProjectBoardConfig(
        statuses=[
            CloudProjectBoardStatus(id="inbox", name="收集箱", color="gray"),
            CloudProjectBoardStatus(id="pending", name="待开始", color="blue"),
            CloudProjectBoardStatus(id="in_progress", name="进行中", color="orange"),
            CloudProjectBoardStatus(id="in_review", name="待确认", color="purple"),
            CloudProjectBoardStatus(id="completed", name="已完成", color="green"),
        ]
    )
    cloud_project_service.update(
        test_db,
        project.id,
        test_user.id,
        CloudProjectUpdate(version=project.version, board_config=without_done),
    )
    test_db.refresh(item)

    assert item.status == ""
    history = _history(item)
    assert len(history) == 2
    last = history[-1]
    assert last["trigger"] == "status_removed"
    assert last["from_status"] == "done"
    assert last["from_status_name"] == "已归档"
    assert last["to_status"] == ""
    assert last["by_user_id"] == test_user.id


def test_task_started_binding_records_entry(test_db, test_user) -> None:
    project = _make_project(test_db, test_user)
    item = _create_item(test_db, project, test_user)

    loop_item_service.bind_task(
        test_db,
        item.id,
        LoopItemTaskBind(
            device_id="device-1",
            task_id="task-1",
            task_title="bound task",
        ),
        test_user.id,
    )
    test_db.refresh(item)

    assert item.status == "in_progress"
    history = _history(item)
    assert len(history) == 2
    last = history[-1]
    assert last["trigger"] == "task_started"
    assert last["to_status"] == "in_progress"
    assert last["by_user_id"] == test_user.id
