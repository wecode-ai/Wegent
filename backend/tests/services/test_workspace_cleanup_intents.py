# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import uuid
from datetime import datetime, timedelta, timezone

from app.models.delivery import (
    CloudProject,
    LoopItemTaskBinding,
    WorkspaceCleanupIntent,
)
from app.models.kind import Kind
from app.schemas.delivery import LoopItemCreate, LoopItemUpdate
from app.services.loop_items.service import loop_item_service
from app.services.workspace_cleanup_intents import (
    acknowledge,
    claim,
    due_execution_targets,
    pull_due,
)


def _project(db, user) -> CloudProject:
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key=f"WC{uuid.uuid4().hex[:6].upper()}",
        name="Workspace cleanup",
        description="",
        created_by_user_id=user.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json={},
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def test_issue_close_and_reopen_project_executor_cleanup_intent(
    test_db, test_user, monkeypatch
) -> None:
    from app.services import workspace_cleanup_intents

    monkeypatch.setattr(
        workspace_cleanup_intents.settings,
        "WORKTREE_CLEANUP_RETENTION_DAYS",
        0,
    )
    project = _project(test_db, test_user)
    item = loop_item_service.create(
        test_db,
        project.id,
        test_user.id,
        LoopItemCreate(title="Clean worktree"),
    )
    binding = LoopItemTaskBinding(
        cloud_project_id=project.id,
        loop_item_id=item.id,
        task_user_id=test_user.id,
        device_id="runtime-device",
        task_id="runtime-task-1",
        task_title=item.title,
        linked_by_user_id=test_user.id,
    )
    test_db.add(binding)
    test_db.commit()

    closed = loop_item_service.update(
        test_db,
        item.id,
        test_user.id,
        LoopItemUpdate(version=item.version, status="completed"),
    )

    intent = (
        test_db.query(WorkspaceCleanupIntent)
        .filter(WorkspaceCleanupIntent.loop_item_id == item.id)
        .one()
    )
    assert intent.device_id == "runtime-device"
    assert intent.task_user_id == test_user.id
    assert intent.status == "pending"
    assert intent.version == closed.version
    assert intent.metadata_json["runtime_task_ids"] == ["runtime-task-1"]
    assert (
        pull_due(
            test_db,
            owner_user_id=test_user.id,
            runtime_device_id="runtime-device",
            now=_utcnow() + timedelta(seconds=1),
        )[0]["action"]
        == "release"
    )
    assert due_execution_targets(
        test_db,
        now=_utcnow() + timedelta(seconds=1),
    ) == [(test_user.id, "runtime-device")]
    assert claim(
        test_db,
        owner_user_id=test_user.id,
        runtime_device_id="runtime-device",
        intent_id=intent.id,
        issue_version=closed.version,
        now=_utcnow() + timedelta(seconds=1),
    )
    test_db.refresh(intent)
    assert intent.status == "executing"

    reopened = loop_item_service.update(
        test_db,
        item.id,
        test_user.id,
        LoopItemUpdate(version=closed.version, status="in_progress"),
    )
    test_db.refresh(intent)
    assert intent.status == "cancelled"
    assert intent.version == reopened.version
    assert not claim(
        test_db,
        owner_user_id=test_user.id,
        runtime_device_id="runtime-device",
        intent_id=intent.id,
        issue_version=closed.version,
        now=_utcnow() + timedelta(minutes=10),
    )
    retain = pull_due(
        test_db,
        owner_user_id=test_user.id,
        runtime_device_id="runtime-device",
    )
    assert retain[0]["action"] == "retain"
    assert acknowledge(
        test_db,
        owner_user_id=test_user.id,
        runtime_device_id="runtime-device",
        intent_id=intent.id,
        issue_version=reopened.version,
    )
    test_db.refresh(intent)
    assert intent.status == "acknowledged"


def test_cleanup_ack_rejects_stale_issue_version(test_db, test_user) -> None:
    project = _project(test_db, test_user)
    intent = WorkspaceCleanupIntent(
        cloud_project_id=project.id,
        loop_item_id=None,
        task_user_id=test_user.id,
        device_id="runtime-device",
        status="pending",
        version=4,
        due_at=_utcnow(),
        metadata_json={"runtime_task_ids": ["runtime-task-1"]},
    )
    test_db.add(intent)
    test_db.commit()

    assert not acknowledge(
        test_db,
        owner_user_id=test_user.id,
        runtime_device_id="runtime-device",
        intent_id=intent.id,
        issue_version=3,
    )
    test_db.refresh(intent)
    assert intent.status == "pending"


def test_cleanup_intent_routes_app_alias_to_executor_record(
    test_db, test_user, monkeypatch
) -> None:
    from app.services import workspace_cleanup_intents

    monkeypatch.setattr(
        workspace_cleanup_intents.settings,
        "WORKTREE_CLEANUP_RETENTION_DAYS",
        0,
    )
    device = Kind(
        kind="Device",
        name="desktop-device",
        namespace="default",
        user_id=test_user.id,
        is_active=True,
        json={
            "spec": {
                "deviceId": "electron-device",
                "deviceType": "app",
                "appDeviceId": "electron-ipc-device",
            }
        },
    )
    test_db.add(device)
    test_db.commit()
    route_id = f"app-record-{device.id}"
    project = _project(test_db, test_user)
    item = loop_item_service.create(
        test_db,
        project.id,
        test_user.id,
        LoopItemCreate(title="Canonical cleanup route"),
    )
    test_db.add(
        LoopItemTaskBinding(
            cloud_project_id=project.id,
            loop_item_id=item.id,
            task_user_id=test_user.id,
            device_id=route_id,
            task_id="runtime-task-1",
            task_title=item.title,
            linked_by_user_id=test_user.id,
        )
    )
    test_db.commit()

    closed = loop_item_service.update(
        test_db,
        item.id,
        test_user.id,
        LoopItemUpdate(version=item.version, status="completed"),
    )

    intent = (
        test_db.query(WorkspaceCleanupIntent)
        .filter(WorkspaceCleanupIntent.loop_item_id == item.id)
        .one()
    )
    assert intent.device_id == route_id
    assert intent.metadata_json["execution_target_id"] == "electron-ipc-device"
    assert due_execution_targets(
        test_db,
        now=_utcnow() + timedelta(seconds=1),
    ) == [(test_user.id, "electron-ipc-device")]
    assert (
        pull_due(
            test_db,
            owner_user_id=test_user.id,
            runtime_device_id=route_id,
            now=_utcnow() + timedelta(seconds=1),
        )[0]["issue_version"]
        == closed.version
    )
