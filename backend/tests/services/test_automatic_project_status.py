# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Robot lifecycles keep Issues in their configured board columns."""

import uuid
from collections.abc import Iterator
from unittest.mock import patch

import pytest
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem, ProjectIncomingEvent
from app.models.loop_item_execution import LoopItemExecution
from app.models.user import User
from app.schemas.delivery import LoopItemCreate, LoopItemUpdate
from app.schemas.project_chat import ProjectChatAgentStart, ProjectChatSend
from app.services.collaboration_manager_decisions import (
    apply_collaboration_manager_decision,
)
from app.services.loop_items.service import loop_item_service
from app.services.project_chat.service import project_chat_service
from tests.services.test_loop_item_assignment import (
    _collaboration_group,
    _make_bot,
    _make_project,
)

BOARDS = [
    None,
    ["inbox", "acceptance", "in_review", "completed"],
    ["inbox", "in_progress", "acceptance", "completed"],
    ["inbox", "acceptance", "completed"],
]


@pytest.fixture(autouse=True)
def isolate_notification_delivery() -> Iterator[None]:
    with patch("app.core.async_utils.schedule_async_task"):
        yield


def _set_board(db: Session, project: CloudProject, statuses: list[str] | None) -> None:
    if statuses is not None:
        project.metadata_json = {
            "board_config": {
                "statuses": [{"id": value, "name": value} for value in statuses],
                "processing_start_status_id": None,
            }
        }
        db.commit()


def _complete_agent_run(
    db: Session, user: User, project: CloudProject, issue: LoopItem, agent_id: str
) -> None:
    trigger = project_chat_service.send(
        db,
        user_id=user.id,
        user_name=user.user_name,
        request=ProjectChatSend(
            clientMessageId=str(uuid.uuid4()),
            projectId=project.id,
            taskId=issue.id,
            content="Complete the assigned work",
            mentions=[{"type": "agent", "id": agent_id, "label": "Worker"}],
        ),
    ).message
    runtime_task_id = str(uuid.uuid4())
    project_chat_service.start_agent_response(
        db,
        user_id=user.id,
        request=ProjectChatAgentStart(
            projectId=project.id,
            taskId=issue.id,
            triggerMessageId=trigger.message_id,
            agentId=agent_id,
            runtimeDeviceId="board-status-device",
            runtimeTaskId=runtime_task_id,
        ),
    )
    result = project_chat_service.project_runtime_event(
        db,
        device_id="board-status-device",
        runtime_task_id=runtime_task_id,
        event_name="response.completed",
        payload={"data": {"value": "Work completed"}},
    )
    assert result is not None
    db.refresh(issue)
    assert issue.metadata_json["ai_state"]["status"] == "completed"


@pytest.mark.parametrize(
    "statuses", BOARDS, ids=["default", "no-start", "no-review", "custom"]
)
@pytest.mark.parametrize("entry", ["create", "update"])
@pytest.mark.parametrize("target", ["agent", "group"])
def test_assignment_and_completion_preserve_board_columns(
    test_db: Session,
    test_user: User,
    statuses: list[str] | None,
    entry: str,
    target: str,
) -> None:
    project = _make_project(test_db, test_user)
    _set_board(test_db, project, statuses)
    if target == "group":
        group, agent, _ = _collaboration_group(test_db, project, test_user)
        assignment = {"assignee_group_id": str(group["id"])}
        groups = [group]
    else:
        agent = _make_bot(test_db, project, test_user)
        assignment = {"assignee_agent_id": agent.id}
        groups = []

    with patch(
        "app.services.workspaces.workspace_service.list_project_collaboration_groups",
        return_value=groups,
    ):
        issue = loop_item_service.create(
            test_db,
            project.id,
            test_user.id,
            LoopItemCreate(
                title="Board-aware assignment",
                **(assignment if entry == "create" else {}),
            ),
        )
        if entry == "update":
            issue = loop_item_service.update(
                test_db,
                issue.id,
                test_user.id,
                LoopItemUpdate(version=issue.version, **assignment),
            )

    started = (
        "in_progress" if statuses is None or "in_progress" in statuses else "inbox"
    )
    assert issue.status == started
    before_completion = test_db.query(ProjectIncomingEvent).count()
    if target == "agent":
        _complete_agent_run(test_db, test_user, project, issue, agent.id)
        finished = (
            "in_review" if statuses is None or "in_review" in statuses else started
        )
    else:
        dispatch = (
            test_db.query(LoopItemExecution)
            .filter(LoopItemExecution.loop_item_id == issue.id)
            .one()
        )
        assert dispatch.executor_type == "collaboration_group_dispatch"
        finished = "in_review" if statuses is None else "acceptance"
        apply_collaboration_manager_decision(
            test_db,
            project_id=project.id,
            item_id=issue.id,
            user_id=test_user.id,
            dispatch_id=dispatch.runtime_origin_context["dispatch_id"],
            manager_agent_id=agent.id,
            idempotency_key="board-status-completed",
            target_status=finished,
            reason="The group finished the work",
        )
        test_db.refresh(dispatch)
        assert dispatch.status == "completed"

    assert issue.status == finished
    events = test_db.query(ProjectIncomingEvent).all()
    assert len(events) == before_completion + int(finished != started)
    allowed = set(
        statuses or ["inbox", "pending", "in_progress", "in_review", "completed"]
    )
    history = issue.metadata_json["status_history"]
    assert all(change["to_status"] in allowed for change in history)
    assert all(event.metadata_json["payload"]["status"] in allowed for event in events)
    assert history[-1]["to_status"] == finished


@pytest.mark.parametrize("target", ["agent", "group"])
@pytest.mark.parametrize("entry", ["create", "update"])
def test_assignment_preserves_explicit_custom_status(
    test_db: Session, test_user: User, target: str, entry: str
) -> None:
    project = _make_project(test_db, test_user)
    _set_board(test_db, project, ["inbox", "in_progress", "acceptance", "completed"])
    if target == "group":
        group, _, _ = _collaboration_group(test_db, project, test_user)
        assignment = {"assignee_group_id": str(group["id"])}
        groups = [group]
    else:
        agent = _make_bot(test_db, project, test_user)
        assignment = {"assignee_agent_id": agent.id}
        groups = []
    with patch(
        "app.services.workspaces.workspace_service.list_project_collaboration_groups",
        return_value=groups,
    ):
        issue = loop_item_service.create(
            test_db,
            project.id,
            test_user.id,
            LoopItemCreate(
                title="Explicit custom status",
                status="acceptance" if entry == "create" else "inbox",
                **(assignment if entry == "create" else {}),
            ),
        )
        if entry == "update":
            loop_item_service.update(
                test_db,
                issue.id,
                test_user.id,
                LoopItemUpdate(
                    version=issue.version, status="acceptance", **assignment
                ),
            )
    assert issue.status == "acceptance"
    assert issue.metadata_json["status_history"][-1]["to_status"] == "acceptance"
    events = test_db.query(ProjectIncomingEvent).all()
    assert len(events) == int(entry == "update")
    assert all(
        event.metadata_json["payload"]["status"] == "acceptance" for event in events
    )


@pytest.mark.parametrize("target", ["agent", "group"])
def test_assignment_respects_explicit_completed_status(
    test_db: Session, test_user: User, target: str
) -> None:
    project = _make_project(test_db, test_user)
    if target == "group":
        group, _, _ = _collaboration_group(test_db, project, test_user)
        assignment = {"assignee_group_id": str(group["id"])}
        groups = [group]
    else:
        agent = _make_bot(test_db, project, test_user)
        assignment = {"assignee_agent_id": agent.id}
        groups = []
    issue = loop_item_service.create(
        test_db,
        project.id,
        test_user.id,
        LoopItemCreate(title="Accepted work", status="completed"),
    )
    completed_at = issue.completed_at
    with patch(
        "app.services.workspaces.workspace_service.list_project_collaboration_groups",
        return_value=groups,
    ):
        loop_item_service.update(
            test_db,
            issue.id,
            test_user.id,
            LoopItemUpdate(version=issue.version, **assignment),
        )
    assert issue.status == "completed"
    assert issue.completed_at == completed_at
    assert test_db.query(ProjectIncomingEvent).count() == 0
