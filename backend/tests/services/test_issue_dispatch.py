# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    Delivery,
    IssueDispatchTask,
    LoopItem,
    ProjectChatAgent,
)
from app.models.loop_item_execution import LoopItemExecution
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.models.wework_notification import WeworkNotification
from app.schemas.base_role import BaseRole
from app.schemas.issue_dispatch import (
    IssueDispatchCreate,
    IssueDispatchDecisionCreate,
    IssueDispatchOutcomeCreate,
    IssueDispatchRoundCreate,
)
from app.services.issue_dispatch import (
    MANAGER_SYSTEM_INSTRUCTIONS,
    issue_dispatch_service,
)
from app.services.wework_notifications import deliver_notification


def _project(db: Session, user: User, *, with_workflow: bool = False) -> CloudProject:
    public_id = str(uuid.uuid4())
    metadata = {}
    if with_workflow:
        metadata["workflow_definition"] = {
            "nodes": [
                {
                    "id": "implement",
                    "name": "实现",
                    "description": "完成实现并提交可验证结果",
                    "node_type": "task",
                }
            ]
        }
    project = CloudProject(
        public_id=public_id,
        project_key=f"DSP{uuid.uuid4().hex[:6].upper()}",
        name="Dispatch project",
        description="",
        created_by_user_id=user.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json=metadata,
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def _issue(db: Session, project: CloudProject, user: User) -> LoopItem:
    issue = LoopItem(
        id=f"{project.project_key}-1",
        cloud_project_id=str(project.id),
        sequence_number=1,
        title="Ship dispatch",
        description="Complete the dispatch flow.",
        status="inbox",
        priority="medium",
        created_by_user_id=user.id,
    )
    db.add(issue)
    project.next_item_number = 2
    db.commit()
    db.refresh(issue)
    return issue


def _agent(
    db: Session, project: CloudProject, user: User, *, title: str
) -> ProjectChatAgent:
    agent = ProjectChatAgent(
        id=f"agent-{uuid.uuid4().hex[:10]}",
        cloud_project_id=str(project.id),
        title=title,
        name=title,
        status="active",
        created_by_user_id=user.id,
        metadata_json={
            "runtime": "codex",
            "execution_mode": "auto",
            "execution_environment": "local",
        },
    )
    db.add(agent)
    db.commit()
    db.refresh(agent)
    return agent


def _project_member(
    db: Session,
    project: CloudProject,
    *,
    name: str,
    role: BaseRole,
) -> User:
    user = User(
        user_name=name,
        password_hash="unused",
        email=f"{name}@example.com",
        is_active=True,
    )
    db.add(user)
    db.flush()
    db.add(
        ResourceMember(
            resource_type=ResourceType.CLOUD_PROJECT.value,
            resource_id=project.id,
            entity_type="user",
            entity_id=str(user.id),
            role=role.value,
            status=MemberStatus.APPROVED.value,
        )
    )
    db.commit()
    db.refresh(user)
    return user


def test_direct_human_delivery_closes_dispatch_and_enters_review(
    test_db: Session, test_user: User
) -> None:
    project = _project(test_db, test_user)
    issue = _issue(test_db, project, test_user)
    dispatch, created = issue_dispatch_service.create(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        values=IssueDispatchCreate(
            target_type="human",
            target_id=str(test_user.id),
            idempotency_key="human-direct",
            task_title="Prepare release evidence",
            instructions="Attach the release evidence.",
        ),
    )
    assert created is True
    round_record = issue_dispatch_service.view(test_db, dispatch).rounds[0]
    task = test_db.get(IssueDispatchTask, round_record.tasks[0].id)
    assert task is not None and task.loop_item_id
    linked_item = test_db.get(LoopItem, task.loop_item_id)
    assert linked_item is not None
    assert linked_item.sequence_number == 2
    assert linked_item.id == f"{project.project_key}-2"
    delivery = Delivery(
        id=str(uuid.uuid4()),
        cloud_project_id=str(project.id),
        loop_item_id=str(task.loop_item_id),
        title="Release evidence",
        description="Evidence attached.",
        status="delivered",
        created_by_user_id=test_user.id,
    )
    test_db.add(delivery)
    test_db.commit()

    issue_dispatch_service.on_delivery_finalized(
        test_db, delivery=delivery, user_id=test_user.id
    )

    test_db.refresh(issue)
    test_db.refresh(dispatch)
    assert issue.status == "in_review"
    assert dispatch.status == "completed"
    assert task.status == "submitted"
    assert task.current_delivery_id == delivery.id
    assert linked_item.status == "inbox"

    returned = issue_dispatch_service.return_for_rework(
        test_db,
        task_id=task.id,
        user_id=test_user.id,
        reason="Evidence is incomplete.",
    )
    assert returned.status == "needs_rework"
    test_db.refresh(issue)
    test_db.refresh(dispatch)
    assert issue.status == "in_progress"
    assert dispatch.status == "active"

    retry_round = issue_dispatch_service.retry_task(
        test_db, task_id=task.id, user_id=test_user.id
    )
    assert issue_dispatch_service.round_view(test_db, retry_round).tasks[
        0
    ].task_title == ("Prepare release evidence")


def test_human_outcome_requires_the_assigned_tasks_finalized_delivery(
    test_db: Session, test_user: User
) -> None:
    project = _project(test_db, test_user)
    issue = _issue(test_db, project, test_user)
    dispatch, _ = issue_dispatch_service.create(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        values=IssueDispatchCreate(
            target_type="human",
            target_id=str(test_user.id),
            idempotency_key="human-delivery-boundary",
            task_title="Prepare evidence",
            instructions="Submit a finalized delivery.",
        ),
    )
    task = issue_dispatch_service.view(test_db, dispatch).rounds[0].tasks[0]

    with pytest.raises(
        HTTPException,
        match="Human dispatch outcomes must come from",
    ) as exc_info:
        issue_dispatch_service.report_outcome(
            test_db,
            task_id=task.id,
            user_id=test_user.id,
            values=IssueDispatchOutcomeCreate(
                event_id="forged-human-outcome",
                status="submitted",
                summary="Claimed without a delivery.",
                delivery_id=str(uuid.uuid4()),
            ),
        )

    assert exc_info.value.status_code == 422
    test_db.refresh(issue)
    test_db.refresh(dispatch)
    assert issue.status == "in_progress"
    assert dispatch.status == "active"


def test_human_task_can_be_cancelled_without_forging_an_outcome(
    test_db: Session, test_user: User
) -> None:
    project = _project(test_db, test_user)
    issue = _issue(test_db, project, test_user)
    dispatch, _ = issue_dispatch_service.create(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        values=IssueDispatchCreate(
            target_type="human",
            target_id=str(test_user.id),
            idempotency_key="human-cancel",
            task_title="Prepare evidence",
            instructions="Submit a finalized delivery.",
        ),
    )
    task = issue_dispatch_service.view(test_db, dispatch).rounds[0].tasks[0]

    cancelled = issue_dispatch_service.cancel_task(
        test_db,
        task_id=task.id,
        user_id=test_user.id,
        reason="No longer required.",
    )

    test_db.refresh(issue)
    test_db.refresh(dispatch)
    assert cancelled.status == "cancelled"
    assert issue.status == "in_progress"
    assert dispatch.status == "active"


async def test_direct_human_assignment_delivers_in_app_and_im_notification(
    test_db: Session, test_user: User
) -> None:
    project = _project(test_db, test_user)
    issue = _issue(test_db, project, test_user)

    with patch("app.core.async_utils.schedule_async_task") as schedule:
        dispatch, created = issue_dispatch_service.create(
            test_db,
            issue_id=issue.id,
            user_id=test_user.id,
            values=IssueDispatchCreate(
                target_type="human",
                target_id=str(test_user.id),
                idempotency_key="human-notification",
                task_title="Prepare release evidence",
                instructions="Attach the release evidence.",
            ),
        )

    assert created is True
    notification = (
        test_db.query(WeworkNotification)
        .filter(WeworkNotification.kind == "issue_dispatch_assignment")
        .one()
    )
    schedule.assert_called_once_with(
        deliver_notification,
        notification.id,
        {"in_app": True, "system": True, "im": True},
    )
    assert notification.payload["dispatchId"] == dispatch.id
    assert notification.payload["action"] == "create_personal_task"
    assert notification.payload["idempotencyKey"].startswith("dispatch-task:")

    session = SimpleNamespace(
        channel_type="dingtalk",
        user_id=test_user.id,
        session_key="dispatch-human",
    )
    with (
        patch("app.db.session.SessionLocal", return_value=test_db),
        patch(
            "app.core.socketio.get_sio",
            return_value=SimpleNamespace(emit=AsyncMock()),
        ),
        patch(
            "app.services.im.session_service.im_session_service.list_user_sessions",
            AsyncMock(return_value=[session]),
        ),
        patch(
            "app.services.im.notification_dispatcher.im_notification_dispatcher.send_notification",
            AsyncMock(return_value={"success": True}),
        ) as send,
    ):
        await deliver_notification(
            notification.id,
            {"in_app": True, "system": True, "im": True},
        )

    push = send.await_args.args[2]
    assert push.kind == "issue_dispatch_assignment"
    assert push.headline == "新任务：Prepare release evidence"
    assert push.payload["dispatchId"] == dispatch.id
    assert {link.label for link in send.await_args.kwargs["links"]} == {
        "在 Wework 中打开",
        "查看任务",
    }


async def test_human_group_leader_receives_manager_turn_over_im(
    test_db: Session, test_user: User, monkeypatch
) -> None:
    project = _project(test_db, test_user)
    issue = _issue(test_db, project, test_user)
    group = {
        "id": "human-led-group",
        "name": "Human led group",
        "instructions": "负责人按证据安排每一轮。",
        "leader": {"kind": "human", "id": str(test_user.id)},
        "members": [{"kind": "human", "id": str(test_user.id)}],
    }
    monkeypatch.setattr(
        "app.services.workspaces.workspace_service.list_project_collaboration_groups",
        lambda *_args, **_kwargs: [group],
    )

    with patch("app.core.async_utils.schedule_async_task") as schedule:
        dispatch, created = issue_dispatch_service.create(
            test_db,
            issue_id=issue.id,
            user_id=test_user.id,
            values=IssueDispatchCreate(
                target_type="group",
                target_id=group["id"],
                idempotency_key="human-leader-notification",
                instructions="Deliver the issue.",
            ),
        )

    assert created is True
    notification = (
        test_db.query(WeworkNotification)
        .filter(WeworkNotification.kind == "issue_dispatch_manager_turn")
        .one()
    )
    schedule.assert_called_once_with(
        deliver_notification,
        notification.id,
        {"in_app": True, "system": True, "im": True},
    )
    assert notification.payload == {
        "projectId": str(project.id),
        "itemId": issue.id,
        "dispatchId": dispatch.id,
        "action": "manage_dispatch",
    }

    session = SimpleNamespace(
        channel_type="dingtalk",
        user_id=test_user.id,
        session_key="dispatch-leader",
    )
    with (
        patch("app.db.session.SessionLocal", return_value=test_db),
        patch(
            "app.core.socketio.get_sio",
            return_value=SimpleNamespace(emit=AsyncMock()),
        ),
        patch(
            "app.services.im.session_service.im_session_service.list_user_sessions",
            AsyncMock(return_value=[session]),
        ),
        patch(
            "app.services.im.notification_dispatcher.im_notification_dispatcher.send_notification",
            AsyncMock(return_value={"success": True}),
        ) as send,
    ):
        await deliver_notification(
            notification.id,
            {"in_app": True, "system": True, "im": True},
        )

    push = send.await_args.args[2]
    assert push.kind == "issue_dispatch_manager_turn"
    assert push.headline == f"需要负责人处理：{issue.title}"
    assert push.payload["dispatchId"] == dispatch.id


def test_developer_group_leader_can_assign_round_tasks(
    test_db: Session, test_user: User, monkeypatch
) -> None:
    project = _project(test_db, test_user)
    issue = _issue(test_db, project, test_user)
    leader = _project_member(
        test_db,
        project,
        name="dispatch-developer-leader",
        role=BaseRole.Developer,
    )
    worker = _agent(test_db, project, test_user, title="Dispatch worker")
    group = {
        "id": "developer-led-group",
        "name": "Developer led group",
        "instructions": "负责人按证据安排每一轮。",
        "leader": {"kind": "human", "id": str(leader.id)},
        "members": [
            {"kind": "human", "id": str(leader.id)},
            {"kind": "agent", "id": worker.id},
        ],
    }
    monkeypatch.setattr(
        "app.services.workspaces.workspace_service.list_project_collaboration_groups",
        lambda *_args, **_kwargs: [group],
    )
    dispatch, _ = issue_dispatch_service.create(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        values=IssueDispatchCreate(
            target_type="group",
            target_id=group["id"],
            idempotency_key="developer-led-dispatch",
            instructions="Deliver the issue.",
        ),
    )

    round_record = issue_dispatch_service.create_round(
        test_db,
        dispatch_id=dispatch.id,
        user_id=leader.id,
        values=IssueDispatchRoundCreate.model_validate(
            {
                "idempotency_key": "developer-round",
                "tasks": [
                    {
                        "task_title": "Collect evidence",
                        "instructions": "Collect independently verifiable evidence.",
                        "assignee_type": "agent",
                        "assignee_id": worker.id,
                    }
                ],
            }
        ),
    )

    task = issue_dispatch_service.round_view(test_db, round_record).tasks[0]
    assert task.task_title == "Collect evidence"
    assert task.assignee_id == worker.id
    task_record = test_db.get(IssueDispatchTask, task.id)
    assert task_record is not None
    linked_item = test_db.get(LoopItem, task_record.loop_item_id)
    assert linked_item is not None
    assert linked_item.assignee_agent_id == worker.id
    execution = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == linked_item.id)
        .one()
    )
    assert execution.assigner_user_id == leader.id
    assert execution.executor_owner_user_id == test_user.id


def test_direct_agent_execution_uses_executor_dispatch_context(
    test_db: Session, test_user: User
) -> None:
    project = _project(test_db, test_user)
    issue = _issue(test_db, project, test_user)
    worker = _agent(test_db, project, test_user, title="Worker")

    dispatch, _ = issue_dispatch_service.create(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        values=IssueDispatchCreate(
            target_type="agent",
            target_id=worker.id,
            idempotency_key="agent-direct",
            task_title="Inspect the change",
            instructions="Inspect and report evidence.",
        ),
    )

    task = issue_dispatch_service.view(test_db, dispatch).rounds[0].tasks[0]
    execution = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == task.linked_item_id)
        .one()
    )
    assert execution.runtime_origin_context["dispatch_id"] == dispatch.id
    assert execution.runtime_origin_context["dispatch_task_id"] == task.id
    assert execution.runtime_origin_context["dispatch_role"] == "executor"
    execution.status = "completed"
    test_db.commit()
    issue_dispatch_service.on_execution_terminal(
        test_db, execution=execution, summary="Inspection passed."
    )
    test_db.refresh(issue)
    test_db.refresh(dispatch)
    assert issue.status == "in_review"
    assert dispatch.status == "completed"


def test_running_agent_cancel_waits_for_runtime_confirmation(
    test_db: Session, test_user: User
) -> None:
    project = _project(test_db, test_user)
    issue = _issue(test_db, project, test_user)
    worker = _agent(test_db, project, test_user, title="Worker")
    dispatch, _ = issue_dispatch_service.create(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        values=IssueDispatchCreate(
            target_type="agent",
            target_id=worker.id,
            idempotency_key="agent-running-cancel",
            task_title="Inspect the change",
            instructions="Inspect and report evidence.",
        ),
    )
    task_view = issue_dispatch_service.view(test_db, dispatch).rounds[0].tasks[0]
    execution = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == task_view.linked_item_id)
        .one()
    )
    execution.status = "running"
    execution.runtime_device_id = "device-1"
    execution.runtime_task_id = "runtime-task-1"
    test_db.commit()

    with patch(
        "app.services.board_team_execution.request_execution_cancellations"
    ) as request_cancellations:
        task = issue_dispatch_service.cancel_task(
            test_db,
            task_id=task_view.id,
            user_id=test_user.id,
            reason="Stop the running task.",
        )

    test_db.refresh(execution)
    test_db.refresh(issue)
    test_db.refresh(dispatch)
    assert execution.status == "cancel_requested"
    assert task.status == "queued"
    assert issue.status == "in_progress"
    assert dispatch.status == "active"
    request_cancellations.assert_called_once()
    assert request_cancellations.call_args.args[0][0].id == execution.id


@pytest.mark.parametrize("terminal_status", ["failed", "cancelled"])
def test_direct_agent_unsuccessful_terminal_state_does_not_move_issue(
    test_db: Session,
    test_user: User,
    terminal_status: str,
) -> None:
    project = _project(test_db, test_user)
    issue = _issue(test_db, project, test_user)
    worker = _agent(test_db, project, test_user, title="Worker")
    dispatch, _ = issue_dispatch_service.create(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        values=IssueDispatchCreate(
            target_type="agent",
            target_id=worker.id,
            idempotency_key=f"agent-direct-{terminal_status}",
            task_title="Inspect the change",
            instructions="Inspect and report evidence.",
        ),
    )
    task_view = issue_dispatch_service.view(test_db, dispatch).rounds[0].tasks[0]
    execution = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == task_view.linked_item_id)
        .one()
    )
    execution.status = terminal_status
    test_db.commit()

    issue_dispatch_service.on_execution_terminal(
        test_db,
        execution=execution,
        summary=f"Execution {terminal_status}.",
    )

    test_db.refresh(issue)
    test_db.refresh(dispatch)
    task = test_db.get(IssueDispatchTask, task_view.id)
    assert issue.status == "in_progress"
    assert dispatch.status == "active"
    assert task is not None and task.status == terminal_status


def test_group_barrier_returns_to_leader_with_rules_and_next_round(
    test_db: Session, test_user: User, monkeypatch
) -> None:
    project = _project(test_db, test_user, with_workflow=True)
    issue = _issue(test_db, project, test_user)
    leader = _agent(test_db, project, test_user, title="Leader")
    worker = _agent(test_db, project, test_user, title="Worker")
    group = {
        "id": "group-1",
        "name": "Delivery group",
        "instructions": "负责人按证据分配下一轮。",
        "leader": {"kind": "agent", "id": leader.id},
        "members": [
            {"kind": "agent", "id": leader.id},
            {"kind": "agent", "id": worker.id},
            {"kind": "human", "id": str(test_user.id)},
        ],
    }
    monkeypatch.setattr(
        "app.services.workspaces.workspace_service.list_project_collaboration_groups",
        lambda *_args, **_kwargs: [group],
    )
    dispatch, _ = issue_dispatch_service.create(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        values=IssueDispatchCreate(
            target_type="group",
            target_id="group-1",
            idempotency_key="group",
            instructions="Deliver the issue.",
        ),
    )
    manager_execution = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.agent_id == leader.id)
        .one()
    )
    manager_context = manager_execution.runtime_origin_context
    assert manager_context["dispatch_role"] == "manager"
    assert manager_context["manager_agent_id"] == leader.id
    assert manager_context["system_prompt"] == MANAGER_SYSTEM_INSTRUCTIONS
    manager_item = test_db.get(LoopItem, manager_execution.loop_item_id)
    assert manager_item is not None
    assert manager_item.sequence_number == 2
    assert manager_item.id == f"{project.project_key}-2"
    assert "负责人按证据分配下一轮。" in manager_item.description
    assert "Configured workflow stages" in manager_item.description
    assert MANAGER_SYSTEM_INSTRUCTIONS not in manager_item.description
    candidates = issue_dispatch_service.candidates(
        test_db, issue_id=issue.id, user_id=test_user.id
    )
    assert {
        (candidate["target_type"], candidate["target_id"]) for candidate in candidates
    } >= {
        ("human", str(test_user.id)),
        ("agent", leader.id),
        ("agent", worker.id),
        ("group", "group-1"),
    }
    assert {
        candidate["target_type"]
        for candidate in issue_dispatch_service.candidates(
            test_db,
            issue_id=issue.id,
            user_id=test_user.id,
            target_type="agent",
        )
    } == {"agent"}

    round_record = issue_dispatch_service.create_round(
        test_db,
        dispatch_id=dispatch.id,
        user_id=test_user.id,
        actor_agent_id=leader.id,
        actor_dispatch_role="manager",
        values=IssueDispatchRoundCreate.model_validate(
            {
                "idempotency_key": "round-1",
                "tasks": [
                    {
                        "task_title": "Implement",
                        "instructions": "Implement the change.",
                        "assignee_type": "agent",
                        "assignee_id": worker.id,
                        "workflow_stage_id": "implement",
                    },
                    {
                        "task_title": "Verify",
                        "instructions": "Verify the result.",
                        "assignee_type": "human",
                        "assignee_id": str(test_user.id),
                        "workflow_stage_id": "implement",
                    },
                ],
            }
        ),
    )
    tasks = issue_dispatch_service.round_view(test_db, round_record).tasks
    agent_task = next(task for task in tasks if task.assignee_type == "agent")
    human_task = next(task for task in tasks if task.assignee_type == "human")
    issue_dispatch_service.report_outcome(
        test_db,
        task_id=agent_task.id,
        user_id=test_user.id,
        values=IssueDispatchOutcomeCreate(
            event_id="agent-result",
            status="submitted",
            summary="Implemented.",
        ),
    )
    test_db.refresh(round_record)
    assert round_record.status == "executing"

    human_record = test_db.get(IssueDispatchTask, human_task.id)
    assert human_record is not None
    delivery = Delivery(
        id=str(uuid.uuid4()),
        cloud_project_id=str(project.id),
        loop_item_id=str(human_record.loop_item_id),
        title="Verification",
        description="Verified.",
        status="delivered",
        created_by_user_id=test_user.id,
    )
    test_db.add(delivery)
    test_db.commit()
    issue_dispatch_service.on_delivery_finalized(
        test_db, delivery=delivery, user_id=test_user.id
    )

    test_db.refresh(round_record)
    test_db.refresh(dispatch)
    test_db.refresh(issue)
    assert round_record.status == "evaluating"
    assert dispatch.status == "active"
    assert issue.status == "in_progress"
    manager_executions = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.agent_id == leader.id)
        .order_by(LoopItemExecution.id)
        .all()
    )
    assert len(manager_executions) == 2
    assert "Completed round outcomes" in (
        test_db.get(LoopItem, manager_executions[-1].loop_item_id).description
    )
    with pytest.raises(
        HTTPException, match="Only the collaboration group leader can act"
    ) as exc_info:
        issue_dispatch_service.decide(
            test_db,
            dispatch_id=dispatch.id,
            user_id=test_user.id,
            values=IssueDispatchDecisionCreate(
                idempotency_key="unauthorized-decision",
                target_status="completed",
                reason="Executor must not decide the parent Issue.",
            ),
        )
    assert exc_info.value.status_code == 403
    with pytest.raises(
        HTTPException, match="must be planned by its leader"
    ) as retry_exc:
        issue_dispatch_service.retry_task(
            test_db,
            task_id=agent_task.id,
            user_id=test_user.id,
        )
    assert retry_exc.value.status_code == 409
    with pytest.raises(
        HTTPException, match="must be planned by its leader"
    ) as rework_exc:
        issue_dispatch_service.return_for_rework(
            test_db,
            task_id=agent_task.id,
            user_id=test_user.id,
            reason="A leader must create the next round.",
        )
    assert rework_exc.value.status_code == 409

    next_round = issue_dispatch_service.create_round(
        test_db,
        dispatch_id=dispatch.id,
        user_id=test_user.id,
        actor_agent_id=leader.id,
        actor_dispatch_role="manager",
        values=IssueDispatchRoundCreate.model_validate(
            {
                "idempotency_key": "round-2",
                "tasks": [
                    {
                        "task_title": "Finalize",
                        "instructions": "Finalize the verified result.",
                        "assignee_type": "agent",
                        "assignee_id": worker.id,
                        "workflow_stage_id": "implement",
                    }
                ],
            }
        ),
    )
    next_task = issue_dispatch_service.round_view(test_db, next_round).tasks[0]
    issue_dispatch_service.report_outcome(
        test_db,
        task_id=next_task.id,
        user_id=test_user.id,
        values=IssueDispatchOutcomeCreate(
            event_id="final-result",
            status="submitted",
            summary="Finalized.",
        ),
    )
    decided = issue_dispatch_service.decide(
        test_db,
        dispatch_id=dispatch.id,
        user_id=test_user.id,
        actor_agent_id=leader.id,
        actor_dispatch_role="manager",
        values=IssueDispatchDecisionCreate(
            idempotency_key="complete",
            target_status="completed",
            reason="All rounds verified.",
        ),
    )
    test_db.refresh(issue)
    assert decided.status == "completed"
    assert issue.status == "completed"
