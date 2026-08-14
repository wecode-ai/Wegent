import json
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.models.delivery import (
    CloudProject,
    ProjectAutomationRule,
    ProjectAutomationRun,
)
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.base_role import BaseRole
from app.services.loop_item_executions.profile import WeworkExecutionProfile
from app.services.loop_item_executions.service import (
    TaskContext,
    loop_item_execution_service,
)
from app.services.project_automation_domain import executor_type
from app.services.project_automation_execution import ProjectAutomationExecution
from app.services.project_automation_managed_execution import (
    project_automation_managed_execution_service,
)
from app.services.project_automations import project_automation_service
from app.services.project_chat.service import project_chat_service


@pytest.mark.parametrize("value", [{}, {"executor_type": "automatic"}])
def test_executor_type_rejects_unmigrated_or_unknown_rules(value):
    with pytest.raises(ValueError, match="missing or invalid"):
        executor_type(value)


@pytest.mark.parametrize("configured_executor", ["project_robot", "custom"])
@pytest.mark.asyncio
async def test_wework_executor_sources_never_enter_wegent_task_dispatch(
    configured_executor, monkeypatch
):
    service = ProjectAutomationExecution()
    owner = SimpleNamespace(id=7)
    project = SimpleNamespace(id="project-1")
    rule = SimpleNamespace(
        id="rule-1",
        created_by_user_id=owner.id,
        cloud_project_id=project.id,
        metadata_json={"executor_type": configured_executor},
    )
    run = SimpleNamespace(
        id="run-1", status="pending", source="manual", metadata_json={}
    )
    db = MagicMock()
    db.get.side_effect = lambda model, key: (
        owner if model.__name__ == "User" else project
    )
    monkeypatch.setattr(service, "_ensure_run_task", MagicMock())
    monkeypatch.setattr(
        service,
        "_create_activity",
        MagicMock(return_value=SimpleNamespace(message_id="message-1")),
    )
    project_robot = MagicMock()
    custom = MagicMock()
    wegent = AsyncMock()
    monkeypatch.setattr(service, "_dispatch_project_robot", project_robot)
    monkeypatch.setattr(service, "_dispatch_custom", custom)
    monkeypatch.setattr(service, "_dispatch_wegent", wegent)

    await service.dispatch(db, rule, run)

    if configured_executor == "project_robot":
        project_robot.assert_called_once()
        custom.assert_not_called()
    else:
        custom.assert_called_once()
        project_robot.assert_not_called()
    wegent.assert_not_awaited()


@pytest.mark.asyncio
async def test_wegent_executor_never_enters_wework_queue_dispatch(monkeypatch):
    service = ProjectAutomationExecution()
    owner = SimpleNamespace(id=7)
    project = SimpleNamespace(id="project-1")
    rule = SimpleNamespace(
        id="rule-1",
        created_by_user_id=owner.id,
        cloud_project_id=project.id,
        metadata_json={"executor_type": "wegent_robot"},
    )
    run = SimpleNamespace(
        id="run-1", status="pending", source="manual", metadata_json={}
    )
    db = MagicMock()
    db.get.side_effect = lambda model, key: (
        owner if model.__name__ == "User" else project
    )
    monkeypatch.setattr(service, "_ensure_run_task", MagicMock())
    monkeypatch.setattr(
        service,
        "_create_activity",
        MagicMock(return_value=SimpleNamespace(message_id="message-1")),
    )
    project_robot = MagicMock()
    custom = MagicMock()
    wegent = AsyncMock()
    monkeypatch.setattr(service, "_dispatch_project_robot", project_robot)
    monkeypatch.setattr(service, "_dispatch_custom", custom)
    monkeypatch.setattr(service, "_dispatch_wegent", wegent)

    await service.dispatch(db, rule, run)

    project_robot.assert_not_called()
    custom.assert_not_called()
    wegent.assert_awaited_once()


@pytest.mark.asyncio
async def test_developer_managed_cancel_uses_task_owner_and_refreshes_run(monkeypatch):
    """A Developer authorizes the action but cannot replace the Task owner."""

    stale_run = SimpleNamespace(
        id="run-1",
        parent_id="rule-1",
        cloud_project_id="project-1",
        backend_task_id=234,
        created_by_user_id=7,
        status="running",
    )
    cancelled_run = SimpleNamespace(
        id="run-1",
        parent_id="rule-1",
        cloud_project_id="project-1",
        backend_task_id=234,
        created_by_user_id=7,
        status="cancelled",
    )
    rule = SimpleNamespace(metadata_json={"timezone": "Asia/Shanghai"})
    db = MagicMock()
    snapshot_ended = False

    def rollback() -> None:
        nonlocal snapshot_ended
        snapshot_ended = True

    def get(model, key):
        if model.__name__ == "ProjectAutomationRule":
            return rule
        if model.__name__ == "ProjectAutomationRun":
            return cancelled_run if snapshot_ended else stale_run
        return None

    db.rollback.side_effect = rollback
    db.get.side_effect = get
    require_role = MagicMock()
    monkeypatch.setattr(
        "app.services.project_automations.require_cloud_project_role",
        require_role,
    )
    cancel = AsyncMock(return_value=True)
    monkeypatch.setattr(project_automation_managed_execution_service, "cancel", cancel)
    run_view = MagicMock(side_effect=lambda row, _timezone: {"status": row.status})
    monkeypatch.setattr(project_automation_service, "_run_view", run_view)

    result = await project_automation_service.cancel_run(
        db,
        project_id="project-1",
        run_id="run-1",
        user_id=8,
    )

    assert result == {"status": "cancelled"}
    require_role.assert_called_once_with(db, "project-1", 8, BaseRole.Developer)
    db.rollback.assert_called_once_with()
    cancel.assert_awaited_once_with(task_id=234, user_id=7)


def _managed_message(test_db, test_user, *, status: str = "pending"):
    run = ProjectAutomationRun(
        cloud_project_id="project-1",
        title="Managed run",
        status="queued",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    test_db.add(run)
    test_db.flush()
    message = ProjectChatMessage(
        message_id="managed-message-1",
        client_message_id="managed-message-1",
        project_id="project-1",
        task_id="task-1",
        sender_type="agent",
        sender_id="automation:1",
        sender_name="AI 托管",
        message_type="agent_status",
        content="",
        metadata_json={"automation_run_id": run.id, "run_status": "queued"},
        runtime_device_id="device-1",
        runtime_task_id="managed-automation-1",
        status=status,
    )
    test_db.add(message)
    test_db.commit()
    return run, message


def test_runtime_start_moves_managed_comment_and_run_to_running(test_db, test_user):
    run, message = _managed_message(test_db, test_user)

    projected = project_chat_service.project_runtime_event(
        test_db,
        device_id="device-1",
        runtime_task_id="managed-automation-1",
        event_name="response.created",
        payload={"data": {}},
    )

    assert projected is not None
    test_db.refresh(message)
    test_db.refresh(run)
    assert message.status == "streaming"
    assert message.metadata_json["run_status"] == "running"
    assert run.status == "running"


def test_runtime_completion_closes_managed_comment_and_run(test_db, test_user):
    run, message = _managed_message(test_db, test_user, status="streaming")

    projected = project_chat_service.project_runtime_event(
        test_db,
        device_id="device-1",
        runtime_task_id="managed-automation-1",
        event_name="response.completed",
        payload={"data": {"response": {"output_text": "Work completed"}}},
    )

    assert projected is not None
    test_db.refresh(message)
    test_db.refresh(run)
    assert message.status == "completed"
    assert run.status == "succeeded"


def test_unrelated_runtime_event_does_not_claim_managed_comment(test_db, test_user):
    run, message = _managed_message(test_db, test_user)

    projected = project_chat_service.project_runtime_event(
        test_db,
        device_id="device-1",
        runtime_task_id="another-task",
        event_name="response.created",
        payload={"data": {}},
    )

    assert projected is None
    test_db.refresh(message)
    test_db.refresh(run)
    assert message.status == "pending"
    assert run.status == "queued"


def test_late_runtime_event_does_not_revive_cancelled_execution_or_run(
    test_db, test_user
):
    run, message = _managed_message(test_db, test_user, status="streaming")
    run.status = "cancelled"
    execution = LoopItemExecution(
        loop_item_id="task-1",
        cloud_project_id="project-1",
        executor_type="inline_custom",
        executor_owner_user_id=test_user.id,
        automation_run_id=run.id,
        runtime_device_id="device-1",
        runtime_task_id="managed-automation-1",
        status="cancelled",
    )
    test_db.add(execution)
    test_db.commit()

    projected = project_chat_service.project_runtime_event(
        test_db,
        device_id="device-1",
        runtime_task_id="managed-automation-1",
        event_name="response.completed",
        payload={"data": {"response": {"output_text": "late result"}}},
    )
    matched = loop_item_execution_service.handle_runtime_event(
        test_db,
        device_id="device-1",
        runtime_task_id="managed-automation-1",
        event_name="response.completed",
        payload={"data": {"response": {"output_text": "late result"}}},
    )

    assert projected is None
    assert matched is None
    test_db.refresh(run)
    test_db.refresh(execution)
    test_db.refresh(message)
    assert run.status == "cancelled"
    assert execution.status == "cancelled"
    assert message.status == "streaming"
    assert message.content == ""


@pytest.mark.asyncio
async def test_due_scan_never_treats_event_rule_sentinel_as_cron(test_db, test_user):
    rule = ProjectAutomationRule(
        cloud_project_id="project-1",
        title="Event automation",
        description="Handle created tasks",
        status="enabled",
        due_at=datetime(1970, 1, 1, 0, 0, 1),
        created_by_user_id=test_user.id,
        metadata_json={
            "trigger_type": "event",
            "cron_expression": None,
        },
    )
    test_db.add(rule)
    test_db.commit()

    dispatched = await project_automation_service.check_due(test_db)

    test_db.refresh(rule)
    assert dispatched == 0
    assert rule.status == "enabled"


def test_inline_automation_compiles_wework_context_without_mcp(
    test_db, test_user, monkeypatch
):
    project = CloudProject(
        id="project-1",
        project_key="CTX",
        title="Context project",
        description="Project description",
        created_by_user_id=test_user.id,
        metadata_json={"task_provider": "local"},
    )
    test_db.add(project)
    test_db.commit()
    monkeypatch.setattr(
        "app.services.chat.trigger.unified.build_wework_runtime_model_config",
        lambda db, *, model_name, creator: {"model_id": model_name},
    )
    profile = WeworkExecutionProfile.for_inline_custom(
        owner_user_id=test_user.id,
        display_name="AI 托管",
        instruction="Handle the board event",
        model="gpt-5.6-terra",
    )
    payload = profile.build_runtime_payload(
        test_db,
        runtime_task_id="codex-queue-1",
        task=TaskContext(
            id="CTX-1",
            cloud_project_id="project-1",
            title="Current task",
            description="Full task details",
            status="in_progress",
            priority="high",
            tags=["automation"],
        ),
        cloud_project_id="project-1",
        origin_context={
            "rule_id": "automation-1",
            "run_id": "run-1",
            "trigger": "event",
            "event": {"type": "task.created"},
        },
    )
    request = payload["executionRequest"]
    serialized = json.dumps(payload, ensure_ascii=False)

    assert request["mcp_servers"] == []
    assert request["bot"][0]["name"] == "AI 托管"
    assert payload["origin"]["run_id"] == "run-1"
    assert "Context project" in payload["additionalContext"]["project"]["value"]
    assert "Full task details" in payload["additionalContext"]["task"]["value"]
    assert "task.created" in payload["additionalContext"]["event"]["value"]
    assert "wework_space" not in serialized
    assert "get_board_item" not in serialized
