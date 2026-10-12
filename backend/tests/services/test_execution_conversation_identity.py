# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Collaboration dispatches expose the manager session, not the handoff task."""

import json
from unittest.mock import MagicMock

import pytest
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem, LoopItemTaskBinding
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
