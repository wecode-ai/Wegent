# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Manager status decisions retain their real automation execution cause."""

from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy.orm import Session

from app.models.delivery import (
    ProjectAutomationRule,
    ProjectAutomationRun,
    ProjectIncomingEvent,
)
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.schemas.delivery import LoopItemCreate, LoopItemUpdate
from app.services.collaboration_manager_decisions import (
    apply_collaboration_manager_decision,
)
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.loop_items.service import loop_item_service
from app.services.project_automation_execution import project_automation_execution
from app.services.project_chat.service import project_chat_service
from app.services.project_incoming_hooks import project_incoming_hook_service
from tests.services.test_loop_item_assignment import _collaboration_group, _make_project


def test_manager_decision_refreshes_dispatch_before_terminal_transition(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A newer snapshot must not leave an approved dispatch active."""
    monkeypatch.setattr("app.core.async_utils.schedule_async_task", lambda *args: None)
    project = _make_project(test_db, test_user)
    group, manager, _ = _collaboration_group(test_db, project, test_user)
    with patch(
        "app.services.workspaces.workspace_service.list_project_collaboration_groups",
        return_value=[group],
    ):
        issue = loop_item_service.create(
            test_db,
            project.id,
            test_user.id,
            LoopItemCreate(
                title="Snapshot races manager", assignee_group_id=str(group["id"])
            ),
        )
    dispatch = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == issue.id)
        .one()
    )
    dispatch_id = dispatch.runtime_origin_context["dispatch_id"]
    dispatch.status = "claimed"
    dispatch.runtime_device_id = manager.device_id
    dispatch.runtime_task_id = "snapshot-race-root"
    test_db.flush()
    version = dispatch.version
    # Model a snapshot committed after this Session cached the dispatch.
    test_db.query(LoopItemExecution).filter(LoopItemExecution.id == dispatch.id).update(
        {"version": version + 1}, synchronize_session=False
    )
    assert dispatch.version == version
    result = apply_collaboration_manager_decision(
        test_db,
        project_id=project.id,
        item_id=issue.id,
        user_id=test_user.id,
        dispatch_id=dispatch_id,
        manager_agent_id=manager.id,
        idempotency_key="snapshot-race",
        target_status="in_review",
        reason="Manager explicitly finished",
        comment="Ready for review",
    )
    test_db.refresh(dispatch)
    assert dispatch.status == "completed"
    assert dispatch.version == version + 2
    assert dispatch.termination_reason == "manager_status_decision"
    assert result.item.status == "in_review"
    assert result.comment is not None


def _complete_group_conversation(
    db: Session, root: LoopItemExecution, agent, role: str
) -> None:
    leaf = loop_item_execution_service.enqueue_for_assignment(
        db,
        loop_item_id=root.loop_item_id,
        cloud_project_id=root.cloud_project_id,
        agent=agent,
        assigner_user_id=root.assigner_user_id,
        environment="local",
        execution_device_id=agent.device_id,
        priority=None,
        automation_context={
            **root.runtime_origin_context,
            "dispatch_role": role,
            "collaboration_dispatch_execution_id": root.id,
        },
    )
    leaf.status = "claimed"
    leaf.runtime_device_id = agent.device_id
    activity = ProjectChatMessage(
        message_id=f"group-{role}-{leaf.id}",
        project_id=root.cloud_project_id,
        task_id=root.loop_item_id,
        sender_type="agent",
        sender_id=agent.id,
        sender_name=agent.name,
        agent_id=agent.id,
        runtime_device_id=agent.device_id,
        runtime_task_id=leaf.runtime_task_id,
        status="streaming",
        metadata_json={
            "execution_id": leaf.id,
            "automation_run_id": leaf.automation_run_id,
            "dispatch_role": role,
            "run_status": "running",
        },
    )
    db.add(activity)
    db.commit()
    assert leaf.automation_run_id == root.automation_run_id
    assert not leaf.owns_automation_run
    assert (
        project_automation_execution._execution_for_run(db, leaf.automation_run_id)
        == root
    )
    payload = {"eventSeq": 1, "data": {"value": f"{role} finished"}}
    assert (
        project_chat_service.project_runtime_event(
            db,
            device_id=agent.device_id,
            runtime_task_id=leaf.runtime_task_id,
            event_name="response.completed",
            payload=payload,
        )
        is not None
    )
    result = loop_item_execution_service.handle_runtime_event(
        db,
        device_id=agent.device_id,
        runtime_task_id=leaf.runtime_task_id,
        event_name="response.completed",
        payload=payload,
    )
    assert result is not None and result.status == "completed"
    assert not loop_item_execution_service.reconcile_automation_run_projection(
        db, run_id=root.automation_run_id
    )
    assert (
        loop_item_execution_service.reconcile_terminal_automation_projections(
            db, run_ids=[root.automation_run_id]
        )
        == 0
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("origin", "other_rule"),
    [("automation", False), ("automation", True), ("manager", False), ("human", False)],
)
async def test_manager_status_event_preserves_only_its_actual_dispatch_cause(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    origin: str,
    other_rule: bool,
) -> None:
    monkeypatch.setattr("app.core.async_utils.schedule_async_task", lambda *args: None)
    monkeypatch.setattr(
        "app.tasks.robot_queue_tasks.consume_queues_background", AsyncMock()
    )
    project = _make_project(test_db, test_user)
    group, manager, member = _collaboration_group(test_db, project, test_user)
    issue = loop_item_service.create(
        test_db,
        project.id,
        test_user.id,
        LoopItemCreate(title="Manager-controlled Issue"),
    )
    rule_metadata = {
        "trigger_type": "event",
        "event_type": "task.status_changed",
        "event_config": {
            "transition": "any",
            "statuses": ["in_review"],
            "execution_target": "existing_issue",
        },
        "dispatch_target": {"kind": "collaboration_group", "id": str(group["id"])},
    }
    source_rule = ProjectAutomationRule(
        cloud_project_id=project.id,
        title="Source review rule",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json=rule_metadata,
    )
    test_db.add(source_rule)
    test_db.flush()
    expected_rule = source_rule
    if other_rule:
        expected_rule = ProjectAutomationRule(
            cloud_project_id=project.id,
            title="Independent review rule",
            status="enabled",
            created_by_user_id=test_user.id,
            metadata_json=rule_metadata,
        )
        test_db.add(expected_rule)
    cause = None
    with patch(
        "app.services.workspaces.workspace_service.list_project_collaboration_groups",
        return_value=[group],
    ):
        if origin == "automation":
            cause = ProjectAutomationRun(
                cloud_project_id=project.id,
                parent_id=source_rule.id,
                task_id=issue.id,
                status="pending",
                created_by_user_id=test_user.id,
            )
            test_db.add(cause)
            test_db.commit()
            await project_automation_execution.dispatch(test_db, source_rule, cause)
            test_db.refresh(cause)
            assert cause.status == "queued"
        else:
            loop_item_service.update(
                test_db,
                issue.id,
                test_user.id,
                LoopItemUpdate(
                    version=issue.version, assignee_group_id=str(group["id"])
                ),
            )

    group_dispatch = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == issue.id)
        .one()
    )
    assert group_dispatch.executor_type == "collaboration_group_dispatch"
    if cause is not None:
        assert group_dispatch.automation_run_id == str(cause.id)
        assert group_dispatch.runtime_origin_context["rule_id"] == str(source_rule.id)
        assert group_dispatch.owns_automation_run
        for agent, role in [(member, "member"), (manager, "manager")]:
            _complete_group_conversation(test_db, group_dispatch, agent, role)
            test_db.refresh(cause)
            assert cause.status == "queued"
        assert (
            project_automation_execution._execution_for_run(test_db, str(cause.id))
            == group_dispatch
        )
    assert await project_incoming_hook_service.check_pending(test_db) == 0

    issue.metadata_json = {
        **issue.metadata_json,
        "workflow_automation": {"rule_id": str(source_rule.id)},
    }
    test_db.commit()
    if origin == "human":
        loop_item_service.update(
            test_db,
            issue.id,
            test_user.id,
            LoopItemUpdate(version=issue.version, status="in_review"),
        )
    else:
        apply_collaboration_manager_decision(
            test_db,
            project_id=project.id,
            item_id=issue.id,
            user_id=test_user.id,
            dispatch_id=group_dispatch.runtime_origin_context["dispatch_id"],
            manager_agent_id=manager.id,
            idempotency_key="review-current-work",
            target_status="in_review",
            reason="Work is ready for review",
        )
        if cause is not None:
            test_db.refresh(cause)
            assert cause.status == "succeeded"
            assert cause.completed_at is not None
    event = (
        test_db.query(ProjectIncomingEvent)
        .filter(ProjectIncomingEvent.status == "received")
        .one()
    )
    payload = event.metadata_json["payload"]
    assert payload.get("caused_by_automation_rule_id") == (
        str(source_rule.id) if cause is not None else None
    )
    dispatch = AsyncMock()
    monkeypatch.setattr(project_automation_execution, "dispatch", dispatch)

    should_run = cause is None or other_rule
    assert await project_incoming_hook_service.check_pending(test_db) == int(should_run)
    assert dispatch.await_count == int(should_run)
    resulting_runs = [
        run
        for run in test_db.query(ProjectAutomationRun).all()
        if cause is None or run.id != cause.id
    ]
    assert [run.parent_id for run in resulting_runs] == (
        [expected_rule.id] if should_run else []
    )
