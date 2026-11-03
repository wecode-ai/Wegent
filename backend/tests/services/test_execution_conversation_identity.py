# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Collaboration dispatches expose the manager session, not the handoff task."""

import json
from unittest.mock import MagicMock

import pytest
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem, LoopItemTaskBinding
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.schemas.runtime_work import RuntimeTranscriptRequest
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.project_chat.service import project_chat_service
from app.services.project_chat.session_access import resolve_project_transcript
from tests.services.test_loop_item_executions import (
    _make_bot,
    _make_execution,
    _make_item,
    _make_project,
)


@pytest.fixture
def manager_execution(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> tuple[CloudProject, LoopItem, LoopItemExecution]:
    project = _make_project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    item = _make_item(test_db, project, test_user)
    execution = _make_execution(
        test_db,
        item,
        bot,
        test_user,
        automation_context={"dispatch_role": "manager", "manager_agent_id": bot.id},
    )
    intent = execution.execution_intent
    intent["runtime_selection"]["executor_kind"] = "collaboration_group_dispatch"
    execution.execution_payload = json.dumps(intent)
    execution.status = "claimed"
    execution.runtime_device_id = "cloud-device-1"
    execution.runtime_task_id = f"codex-queue-{execution.id}"
    test_db.commit()
    monkeypatch.setattr(
        "app.services.project_chat.push.push_project_chat_message", MagicMock()
    )
    return project, item, execution


@pytest.fixture
def manager_device_record(test_db: Session, test_user: User) -> str:
    device = Kind(
        user_id=test_user.id,
        kind="Device",
        name="manager-app",
        namespace="default",
        is_active=True,
        json={
            "spec": {
                "deviceType": "app",
                "deviceId": "manager-app",
                "appDeviceId": "cloud-device-1",
            }
        },
    )
    test_db.add(device)
    test_db.commit()
    return f"app-record-{device.id}"


def test_initial_manager_binding_authorizes_and_projects_the_real_session(
    test_db: Session, test_user: User, manager_execution
) -> None:
    project, item, execution = manager_execution
    loop_item_execution_service._bind_issue_execution_task(test_db, execution=execution)
    first = loop_item_execution_service.open_execution_activity(
        test_db, execution=execution
    )
    second = loop_item_execution_service.open_execution_activity(
        test_db, execution=execution
    )
    manager_task_id = f"{execution.runtime_task_id}-manager-initial"

    assert first.message_id == second.message_id
    activity = (
        test_db.query(ProjectChatMessage).filter_by(message_id=first.message_id).one()
    )
    assert activity.runtime_task_id == manager_task_id
    binding = test_db.query(LoopItemTaskBinding).filter_by(loop_item_id=item.id).one()
    assert binding.task_id == manager_task_id
    owner_id, address = resolve_project_transcript(
        test_db,
        test_user.id,
        RuntimeTranscriptRequest(
            deviceId="cloud-device-1",
            taskId=manager_task_id,
            projectSession={"projectId": str(project.id), "issueId": item.id},
        ),
    )
    assert owner_id == test_user.id
    assert address.local_task_id == manager_task_id
    projected = project_chat_service.project_runtime_event(
        test_db,
        device_id="cloud-device-1",
        runtime_task_id=manager_task_id,
        event_name="response.created",
        payload={"data": {}},
        owner_user_id=test_user.id,
    )
    assert projected is not None
    assert projected[0].message_id == first.message_id
    assert projected[0].metadata["run_status"] == "running"
    assert execution.runtime_task_id == f"codex-queue-{execution.id}"


@pytest.mark.parametrize("event_name", ["response.created", "response.in_progress"])
def test_reopening_manager_activity_refreshes_independently_projected_progress(
    test_db: Session, test_user: User, manager_execution, event_name: str
) -> None:
    _, _, execution = manager_execution
    first = loop_item_execution_service.open_execution_activity(
        test_db, execution=execution
    )
    activity = (
        test_db.query(ProjectChatMessage).filter_by(message_id=first.message_id).one()
    )
    assert activity.status == "pending"
    with Session(
        bind=test_db.get_bind(),
        expire_on_commit=False,
        join_transaction_mode="create_savepoint",
    ) as event_db:
        projected = project_chat_service.project_runtime_event(
            event_db,
            device_id=execution.runtime_device_id,
            runtime_task_id=activity.runtime_task_id,
            event_name=event_name,
            payload={"data": {}},
            owner_user_id=test_user.id,
        )
        assert projected is not None
        assert projected[0].metadata["run_status"] == "running"
    assert (
        activity.status == "pending"
    ), "The reconciliation Session retains its old row"

    reopened = loop_item_execution_service.open_execution_activity(
        test_db, execution=execution
    )

    assert reopened is not None
    assert reopened.message_id == first.message_id
    assert reopened.status == "streaming"
    assert reopened.metadata["run_status"] == "running"
    test_db.refresh(activity)
    assert activity.status == "streaming"
    assert activity.metadata_json["run_status"] == "running"
    assert execution.status == "claimed"


@pytest.mark.parametrize("event_name", ["response.created", "response.in_progress"])
@pytest.mark.parametrize("device_identity", ["stored", "record"])
def test_initial_manager_event_opens_activity_before_transport_acceptance(
    test_db: Session,
    test_user: User,
    manager_execution,
    manager_device_record: str,
    event_name: str,
    device_identity: str,
) -> None:
    _, item, execution = manager_execution
    loop_item_execution_service._bind_issue_execution_task(test_db, execution=execution)
    test_db.commit()
    assert test_db.query(ProjectChatMessage).filter_by(task_id=item.id).count() == 0
    manager_task_id = f"{execution.runtime_task_id}-manager-initial"

    assert (
        loop_item_execution_service.execution_for_runtime(
            test_db,
            runtime_device_id=execution.runtime_device_id,
            runtime_task_id=manager_task_id,
            owner_user_id=test_user.id,
        )
        is None
    )
    projected = project_chat_service.project_runtime_event(
        test_db,
        device_id=(
            manager_device_record
            if device_identity == "record"
            else execution.runtime_device_id
        ),
        runtime_task_id=manager_task_id,
        event_name=event_name,
        payload={"data": {}},
        owner_user_id=test_user.id,
    )

    assert projected is not None
    assert projected[0].status == "streaming"
    assert projected[0].metadata["run_status"] == "running"
    accepted = loop_item_execution_service.accept_runtime_and_open_activity(
        test_db,
        execution_id=execution.id,
        runtime_device_id=execution.runtime_device_id,
        runtime_task_id=execution.runtime_task_id,
        prompt=None,
    )
    assert accepted is not None and accepted.status == "claimed"
    activity = test_db.query(ProjectChatMessage).filter_by(task_id=item.id).one()
    assert activity.message_id == projected[0].message_id
    assert activity.runtime_task_id == manager_task_id
    assert activity.runtime_device_id == execution.runtime_device_id
    assert activity.status == "streaming"
    assert activity.metadata_json["run_status"] == "running"


@pytest.mark.parametrize(
    "mismatch",
    ["device", "owner", "record_owner", "suffix", "nested_suffix", "executor_kind"],
)
def test_initial_manager_activity_rejects_unowned_or_unrelated_identity(
    test_db: Session,
    test_user: User,
    manager_execution,
    manager_device_record: str,
    mismatch: str,
) -> None:
    _, item, execution = manager_execution
    device_id = execution.runtime_device_id
    owner_id = test_user.id
    manager_task_id = f"{execution.runtime_task_id}-manager-initial"
    if mismatch == "device":
        device_id = "unrelated-device"
    elif mismatch == "owner":
        owner_id += 1000
    elif mismatch == "record_owner":
        owner_id += 1000
        device_id = manager_device_record
    elif mismatch == "suffix":
        manager_task_id += "-extra"
    elif mismatch == "nested_suffix":
        manager_task_id += "-manager-initial"
    else:
        intent = execution.execution_intent
        intent["runtime_selection"]["executor_kind"] = "project_robot"
        execution.execution_payload = json.dumps(intent)
        test_db.commit()

    projected = project_chat_service.project_runtime_event(
        test_db,
        device_id=device_id,
        runtime_task_id=manager_task_id,
        event_name="response.created",
        payload={"data": {}},
        owner_user_id=owner_id,
    )

    assert projected is None
    assert test_db.query(ProjectChatMessage).filter_by(task_id=item.id).count() == 0
    assert execution.status == "claimed"
