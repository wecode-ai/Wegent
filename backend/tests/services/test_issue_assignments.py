"""Database-backed regression cases for assigning work on the same Issue."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest
from sqlalchemy import text

from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationRun,
    ProjectWorkflowRun,
)
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.issue_assignment import IssueAssignmentDecision, IssueAssignmentResult
from app.services.issue_assignment_errors import IssueAssignmentConflict
from app.services.issue_assignments import issue_assignment_service
from app.services.issue_workflow_start import issue_workflow_start_service
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.project_automations import project_automation_service
from app.services.project_workflow_projection import sync_automation_workflow_node


@pytest.fixture
def assigned_issue(test_db, test_user):
    project = CloudProject(
        public_id=str(uuid4()),
        project_key=f"EXP{uuid4().hex[:6].upper()}",
        name="Experience",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    test_db.add(project)
    test_db.flush()
    issue = LoopItem(
        cloud_project_id=project.id,
        title="Release checkout",
        description="Meet checkout requirements",
        status="in_progress",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    test_db.add(issue)
    test_db.flush()
    planning = ProjectWorkflowRun(
        cloud_project_id=project.id,
        parent_id=issue.id,
        status="planning",
        created_by_user_id=test_user.id,
        metadata_json={"stage_id": "__issue__", "plan_version": 1},
    )
    test_db.add(planning)
    test_db.flush()
    activity = ProjectChatMessage(
        message_id=str(uuid4()),
        project_id=project.id,
        task_id=issue.id,
        sender_type="agent",
        sender_id="manager",
        content="Planning",
        metadata_json={},
    )
    test_db.add(activity)
    manager = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=project.id,
        task_id=issue.id,
        status="running",
        created_by_user_id=test_user.id,
        metadata_json={
            "activity_message_id": activity.message_id,
            "event": {"payload": {"workflow_run_id": planning.id}},
        },
    )
    test_db.add(manager)
    test_db.flush()
    issue.metadata_json = {
        "workflow": {
            "version": 1,
            "definition_version": 1,
            "advancement_policy": "ai",
            "stage_mode": "dag",
            "ai_automation_rule_id": "manager",
            "intent": issue.description,
            "orchestration_status": "planning",
            "active_run_id": planning.id,
            "active_plan_version": 1,
            "execution_config": {
                "execution_device_id": "device",
                "model": "test-model",
                "workspace_binding": {"type": "standalone"},
            },
            "nodes": [
                {
                    "id": "release",
                    "name": "Release",
                    "prompt": "Release responsibility",
                    "execution_mode": "robot",
                    "status": "blocked",
                    "depends_on": [],
                }
            ],
        }
    }
    test_db.commit()
    return issue, manager


def command(action="assign_role", **kwargs):
    return IssueAssignmentDecision(
        request_id="assignment-1",
        expected_assignment_version=0,
        action=action,
        node_id="release" if action == "assign_role" else None,
        instruction="Deploy the approved checkout",
        reason="Requirements are implemented",
        **kwargs,
    )


@pytest.mark.asyncio
async def test_http_assignment_conflict_preserves_state_and_recovers(
    test_db, test_user, test_client, test_token, assigned_issue
):
    issue, manager = assigned_issue
    issue.priority = "medium"
    issue.sequence_number = 1
    issue.metadata_json = {
        "workflow": {
            **issue.metadata_json["workflow"],
            "version": 13,
            "assignment_version": 1,
        }
    }
    test_db.commit()
    headers = {
        "Authorization": f"Bearer {test_token}",
        "X-Wegent-Automation-Run-ID": str(manager.id),
    }
    payload = command("complete").model_dump(mode="json")
    for version in (13, 14, 15):
        payload["expected_assignment_version"] = version
        response = test_client.post(
            f"/api/v1/loop-items/{issue.id}/assignment", headers=headers, json=payload
        )
        assert response.status_code == 409
        detail = response.json()["detail"]
        assert detail["code"] == "assignment_version_conflict"
        assert detail["expected_assignment_version"] == version
        assert detail["current_assignment_version"] == 1
        assert detail["next_action"] == "read_issue"
    read = test_client.get(f"/api/v1/loop-items/{issue.id}", headers=headers)
    assert read.status_code == 200
    workflow = read.json()["workflow"]
    assert workflow["version"] == 13
    assert workflow["assignment_version"] == 1
    payload["expected_assignment_version"] = workflow["assignment_version"]
    response = test_client.post(
        f"/api/v1/loop-items/{issue.id}/assignment", headers=headers, json=payload
    )
    assert response.status_code == 200
    assert response.json()["assignment_version"] == 2
    assert response.json()["orchestration_status"] == "completed"
    replay = test_client.post(
        f"/api/v1/loop-items/{issue.id}/assignment", headers=headers, json=payload
    )
    assert replay.status_code == 200
    assert replay.json()["assignment_version"] == 2


@pytest.mark.asyncio
async def test_stale_coordinator_conflict_ends_turn(test_db, test_user, assigned_issue):
    issue, manager = assigned_issue
    manager.status = "failed"
    test_db.commit()
    with pytest.raises(IssueAssignmentConflict) as caught:
        await issue_assignment_service.decide(
            test_db,
            issue_id=issue.id,
            user_id=test_user.id,
            decision=command("complete"),
            manager_run_id=manager.id,
        )
    assert caught.value.detail["code"] == "coordinator_invalid"
    assert caught.value.detail["next_action"] == "end_turn"
    assert "not active" in caught.value.detail["message"]
    test_db.rollback()
    assert issue.metadata_json["workflow"].get("assignment") is None


@pytest.mark.asyncio
async def test_role_assignment_dispatches_once_without_creating_child_issue(
    test_db,
    test_user,
    assigned_issue,
    monkeypatch,
):
    issue, manager = assigned_issue
    dispatch = AsyncMock(wraps=project_automation_service.run_direct_workflow_node)
    enqueue = MagicMock(
        return_value=SimpleNamespace(
            id=4, status="queued", execution_device_id="device"
        )
    )
    monkeypatch.setattr(loop_item_execution_service, "enqueue_generic_robot", enqueue)
    monkeypatch.setattr(
        project_automation_service, "run_direct_workflow_node", dispatch
    )
    before = test_db.query(LoopItem).count()
    result = await issue_assignment_service.decide(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        decision=command(),
        manager_run_id=manager.id,
    )
    assert result["current_stage_id"] == "release"
    assert result["coordinator_handoff"]["end_turn"] is True
    assert result["coordinator_handoff"]["resume_on"] == "assignment_result_callback"
    assert "coordinator_handoff" not in issue.metadata_json["workflow"]
    role_run = test_db.get(
        ProjectAutomationRun, result["assignment"]["automation_run_id"]
    )
    assert role_run.metadata_json["issue_assignment_id"] == "assignment-1"
    assert (
        "Deploy the approved checkout" in role_run.metadata_json["instruction_override"]
    )
    assert enqueue.call_args.kwargs["loop_item_id"] == issue.id
    assert enqueue.call_args.kwargs["model"] == "test-model"
    assert test_db.query(LoopItem).count() == before
    dispatch.assert_awaited_once_with(
        test_db, str(issue.cloud_project_id), issue.id, "release", test_user.id
    )
    await issue_assignment_service.decide(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        decision=command(),
        manager_run_id=manager.id,
    )
    assert dispatch.await_count == 1
    assert (
        test_db.query(ProjectChatMessage)
        .filter(ProjectChatMessage.sender_id == "issue_assignment")
        .count()
        == 1
    )


@pytest.mark.asyncio
async def test_human_result_resumes_same_issue_and_preserves_original_goal(
    test_db,
    test_user,
    assigned_issue,
    monkeypatch,
):
    issue, manager = assigned_issue
    start = AsyncMock(return_value=1)
    monkeypatch.setattr(issue_workflow_start_service, "start", start)
    result = await issue_assignment_service.decide(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        decision=command("assign_user", assignee_user_id=test_user.id),
        manager_run_id=manager.id,
    )
    assert issue.assignee_user_id == test_user.id
    assert result["orchestration_status"] == "waiting_human"
    resumed = await issue_assignment_service.submit_result(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        result=IssueAssignmentResult(
            assignment_id="assignment-1", summary="Approved by release owner"
        ),
    )
    assert resumed["orchestration_status"] == "planning"
    assert resumed["intent"] == "Meet checkout requirements"
    assert issue.status == "in_progress"
    start.assert_awaited_once()


@pytest.mark.asyncio
async def test_runtime_result_returns_to_coordinator_and_ignores_stale_replay(
    test_db,
    test_user,
    assigned_issue,
    monkeypatch,
):
    issue, manager = assigned_issue
    test_db.execute(
        text(
            "CREATE UNIQUE INDEX uq_project_chat_client_message "
            "ON project_chat_messages (sender_type, sender_id, client_message_id)"
        )
    )
    monkeypatch.setattr(
        project_automation_service,
        "run_direct_workflow_node",
        AsyncMock(return_value={"id": "role-run"}),
    )
    await issue_assignment_service.decide(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        decision=command(),
        manager_run_id=manager.id,
    )
    role_run = ProjectAutomationRun(
        cloud_project_id=issue.cloud_project_id,
        parent_id=issue.id,
        task_id=issue.id,
        status="failed",
        description="Checkout smoke test failed",
        created_by_user_id=test_user.id,
        metadata_json={
            "issue_assignment_id": "assignment-1",
            "workflow_node_id": "release",
        },
    )
    test_db.add(role_run)
    test_db.flush()
    sync_automation_workflow_node(test_db, role_run)
    test_db.flush()
    workflow = issue.metadata_json["workflow"]
    assert workflow["orchestration_status"] == "planning"
    assert workflow["active_run_id"] is None
    assert workflow["nodes"][0]["status"] == "failed"
    assert workflow["assignment"]["result"] == "Checkout smoke test failed"
    messages = (
        test_db.query(ProjectChatMessage)
        .filter(ProjectChatMessage.sender_id == "issue_assignment")
        .all()
    )
    assert len(messages) == 2
    assert all(message.client_message_id for message in messages)
    assert len({message.client_message_id for message in messages}) == 2
    version = issue.version
    sync_automation_workflow_node(test_db, role_run)
    assert issue.version == version


@pytest.mark.asyncio
async def test_off_graph_work_dispatches_same_issue_without_a_false_role(
    test_db,
    test_user,
    assigned_issue,
    monkeypatch,
):
    issue, manager = assigned_issue
    enqueue = MagicMock(
        return_value=SimpleNamespace(
            id=5, status="queued", execution_device_id="device"
        )
    )
    monkeypatch.setattr(loop_item_execution_service, "enqueue_generic_robot", enqueue)
    result = await issue_assignment_service.decide(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        decision=command(action="execute"),
        manager_run_id=manager.id,
    )
    assert result["current_stage_id"] is None
    assert result["assignment"]["status"] == "running"
    run = test_db.get(ProjectAutomationRun, result["assignment"]["automation_run_id"])
    assert run.task_id == issue.id
    assert run.metadata_json["workflow_node_id"] is None
    assert enqueue.call_args.kwargs["loop_item_id"] == issue.id


@pytest.mark.asyncio
async def test_non_member_cannot_receive_assignment(test_db, test_user, assigned_issue):
    issue, manager = assigned_issue
    with pytest.raises(ValueError, match="not a project member"):
        await issue_assignment_service.decide(
            test_db,
            issue_id=issue.id,
            user_id=test_user.id,
            decision=command(action="assign_user", assignee_user_id=99999),
            manager_run_id=manager.id,
        )
    test_db.rollback()
    assert issue.metadata_json["workflow"].get("assignment") is None
    assert manager.status == "running"


@pytest.mark.asyncio
async def test_explicit_adoption_retains_history_and_assigns_original_issue(
    test_db,
    test_user,
    assigned_issue,
):
    from app.models.delivery import ProjectAutomationRule
    from app.services.issue_experience_migration import (
        adopt_experience,
        available_experiences,
    )

    issue, manager = assigned_issue
    old = dict(issue.metadata_json["workflow"])
    old.update(
        migration_required=True, semantics_version=1, orchestration_status="paused"
    )
    issue.metadata_json = {"workflow": old}
    rule = ProjectAutomationRule(
        cloud_project_id=issue.cloud_project_id,
        title="Reviewed experience",
        status="disabled",
        created_by_user_id=test_user.id,
        metadata_json={
            "event_config": {
                "wework_flow": {"version": 3},
                "runtime_workflow_definition": {
                    "version": 1,
                    "stage_mode": "dag",
                    "advancement_policy": "manual",
                    "nodes": [
                        {
                            "id": "review",
                            "name": "Review",
                            "prompt": "Check checkout",
                            "depends_on": [],
                            "execution_mode": "human",
                            "assignee_user_id": test_user.id,
                        }
                    ],
                },
            }
        },
    )
    test_db.add(rule)
    test_db.commit()
    assert available_experiences(test_db, issue_id=issue.id, user_id=test_user.id) == [
        {"id": rule.id, "name": "Reviewed experience"}
    ]
    count = test_db.query(LoopItem).count()
    result = await adopt_experience(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        automation_id=rule.id,
        intent="Confirm checkout works",
    )
    assert result["migration_required"] is False
    assert result["orchestration_status"] == "waiting_human"
    assert result["current_stage_id"] == "review"
    assert issue.assignee_user_id == test_user.id
    assert issue.metadata_json["experience_migration"]["previous_workflow"] == old
    assert test_db.query(LoopItem).count() == count
    completed = await issue_assignment_service.submit_result(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        result=IssueAssignmentResult(
            assignment_id=result["assignment"]["id"], summary="Checkout verified"
        ),
    )
    assert completed["orchestration_status"] == "completed"
    assert completed["intent"] == "Confirm checkout works"


@pytest.mark.parametrize("status", ["succeeded", "failed"])
def test_off_graph_result_emits_callback_without_a_node_binding(
    test_db, test_user, assigned_issue, status
):
    from app.api.ws.device_namespace import _project_execution_workflow_status

    issue, _ = assigned_issue
    issue.metadata_json = {
        **issue.metadata_json,
        "workflow": {
            **issue.metadata_json["workflow"],
            "orchestration_status": "planning",
            "assignment": {
                "id": "off-graph-result",
                "status": "completed",
                "automation_run_id": "worker-run",
                "execution_status": status,
                "result": "Worker returned",
            },
        },
    }
    test_db.flush()
    execution = SimpleNamespace(
        id=507,
        loop_item_id=issue.id,
        executor_owner_user_id=test_user.id,
        runtime_device_id="callback-device",
        runtime_task_id="callback-task",
        automation_run_id="worker-run",
    )
    intent = _project_execution_workflow_status(
        test_db, execution=execution, projected_status=status, ready_before=set()
    )
    assert intent == {"item_id": issue.id, "user_id": test_user.id, "stage_ids": []}
    execution.automation_run_id = "earlier-worker-run"
    assert (
        _project_execution_workflow_status(
            test_db, execution=execution, projected_status=status, ready_before=set()
        )
        is None
    )


@pytest.fixture
def stoppable_assignment(test_db, test_user, assigned_issue):
    from app.models.loop_item_execution import LoopItemExecution
    from app.services.loop_item_executions.service import utcnow

    issue, manager = assigned_issue
    worker = ProjectAutomationRun(
        cloud_project_id=issue.cloud_project_id,
        parent_id=issue.id,
        task_id=issue.id,
        status="running",
        created_by_user_id=test_user.id,
        metadata_json={
            "issue_assignment_id": "stop-work",
            "workflow_node_id": "release",
        },
    )
    test_db.add(worker)
    test_db.flush()
    issue.metadata_json = {
        "workflow": {
            **issue.metadata_json["workflow"],
            "orchestration_status": "running",
            "assignment_version": 1,
            "assignment": {
                "id": "stop-work",
                "status": "running",
                "node_id": "release",
                "automation_run_id": str(worker.id),
            },
        }
    }
    execution = LoopItemExecution(
        loop_item_id=issue.id,
        cloud_project_id=str(issue.cloud_project_id),
        executor_owner_user_id=test_user.id,
        automation_run_id=str(worker.id),
        status="running",
        runtime_device_id="stop-device",
        runtime_task_id="stop-task",
        start_requested_at=utcnow(),
    )
    test_db.add(execution)
    test_db.commit()
    return issue, worker, execution


@pytest.mark.parametrize("terminal_status", ["cancelled", "failed", "succeeded"])
@pytest.mark.parametrize("already_requested", [False, True])
def test_user_stop_blocks_callback_even_if_runtime_reports_a_late_result(
    test_db, test_user, stoppable_assignment, terminal_status, already_requested
):
    from app.services.issue_assignments import assignment_callback_intent

    issue, worker, execution = stoppable_assignment
    if already_requested:
        loop_item_execution_service.cancel(test_db, execution_id=execution.id)
    requested = loop_item_execution_service.cancel(
        test_db, execution_id=execution.id, user_initiated=True
    )
    assert requested.status == "cancel_requested"
    assert issue.metadata_json["workflow"]["orchestration_status"] == "paused"
    worker.status = terminal_status
    worker.description = "Runtime acknowledged the final result"
    sync_automation_workflow_node(test_db, worker)
    workflow = issue.metadata_json["workflow"]
    assert workflow["orchestration_status"] == "paused"
    assert workflow["assignment"]["execution_status"] == terminal_status
    assert assignment_callback_intent(test_db, execution, terminal_status) is None
    with pytest.raises(IssueAssignmentConflict, match="automation_paused"):
        from app.services.issue_assignment_state import decide_assignment

        decide_assignment(
            workflow,
            command("complete").model_copy(update={"expected_assignment_version": 1}),
        )
    from app.services.issue_workflow_planning import issue_workflow_planning_service

    resumed = issue_workflow_planning_service.resume(
        test_db, issue_id=issue.id, user_id=test_user.id
    )
    assert resumed.status == "planning"


def test_runtime_cancel_without_stop_request_also_pauses_assignment(
    test_db, stoppable_assignment
):
    from app.services.issue_assignments import assignment_callback_intent

    issue, worker, execution = stoppable_assignment
    worker.status = "cancelled"
    sync_automation_workflow_node(test_db, worker)
    assert issue.metadata_json["workflow"]["orchestration_status"] == "paused"
    assert assignment_callback_intent(test_db, execution, "cancelled") is None


def test_stopping_an_old_run_does_not_pause_current_assignment(
    test_db, stoppable_assignment
):
    from app.services.issue_assignments import pause_assignment_for_user_stop

    issue, worker, execution = stoppable_assignment
    issue.metadata_json = {
        "workflow": {
            **issue.metadata_json["workflow"],
            "assignment": {
                "id": "new-work",
                "status": "running",
                "automation_run_id": "new-run",
            },
        }
    }
    test_db.commit()
    pause_assignment_for_user_stop(test_db, worker.id)
    assert issue.metadata_json["workflow"]["orchestration_status"] == "running"


@pytest.mark.asyncio
async def test_runtime_stop_pauses_before_rpc_and_keeps_intent_on_rpc_failure(
    test_db, test_user, stoppable_assignment, monkeypatch
):
    from fastapi import HTTPException

    from app.schemas.runtime_work import RuntimeTaskAddress
    from app.services import runtime_work_service

    issue, worker, execution = stoppable_assignment
    monkeypatch.setattr(
        runtime_work_service.device_service,
        "get_device_by_device_id",
        lambda *_: object(),
    )

    async def reject_cancel(**kwargs):
        assert issue.metadata_json["workflow"]["orchestration_status"] == "paused"
        raise runtime_work_service.RuntimeRpcError("Device disconnected")

    rpc = AsyncMock(side_effect=reject_cancel)
    monkeypatch.setattr(runtime_work_service.runtime_rpc_service, "call", rpc)
    with pytest.raises(HTTPException) as caught:
        await runtime_work_service.cancel_runtime_task(
            db=test_db,
            user_id=test_user.id,
            address=RuntimeTaskAddress(deviceId="stop-device", localTaskId="stop-task"),
        )
    assert caught.value.status_code == 502
    test_db.rollback()
    assert issue.metadata_json["workflow"]["orchestration_status"] == "paused"


@pytest.mark.parametrize("terminal_status", ["cancelled", "failed"])
def test_stopped_coordinator_stays_paused_until_explicit_resume(
    test_db, test_user, assigned_issue, terminal_status
):
    from app.services.issue_assignments import pause_assignment_for_user_stop
    from app.services.issue_workflow_planning import issue_workflow_planning_service

    issue, manager = assigned_issue
    previous_run = issue.metadata_json["workflow"]["active_run_id"]
    pause_assignment_for_user_stop(test_db, manager.id)
    manager.status = terminal_status
    sync_automation_workflow_node(test_db, manager)
    assert issue.metadata_json["workflow"]["orchestration_status"] == "paused"
    resumed = issue_workflow_planning_service.resume(
        test_db, issue_id=issue.id, user_id=test_user.id
    )
    assert resumed.status == "planning"
    assert resumed.run_id != previous_run


@pytest.mark.asyncio
async def test_paused_assignment_ignores_an_already_queued_callback(
    test_db, test_user, stoppable_assignment, monkeypatch
):
    from contextlib import nullcontext

    from app.api.ws import device_namespace
    from app.services.issue_assignments import pause_assignment_for_user_stop

    issue, worker, execution = stoppable_assignment
    pause_assignment_for_user_stop(test_db, worker.id)
    test_db.commit()
    assert (
        await issue_workflow_start_service.start(
            test_db,
            item=issue,
            project=test_db.get(CloudProject, issue.cloud_project_id),
            user_id=test_user.id,
        )
        == 0
    )
    start = AsyncMock()
    monkeypatch.setattr(issue_workflow_start_service, "start", start)
    monkeypatch.setattr(
        device_namespace, "get_db_session", lambda: nullcontext(test_db)
    )
    await device_namespace._continue_projected_workflow(
        {"item_id": issue.id, "user_id": test_user.id, "stage_ids": []}
    )
    start.assert_not_awaited()


@pytest.mark.asyncio
async def test_managed_coordinator_stop_pauses_before_backend_task_cancellation(
    test_db, test_user, assigned_issue, monkeypatch
):
    from app.services.project_automation_managed_execution import (
        project_automation_managed_execution_service,
    )

    issue, manager = assigned_issue
    manager.backend_task_id = 12345
    test_db.commit()

    async def acknowledge_cancel(**kwargs):
        assert issue.metadata_json["workflow"]["orchestration_status"] == "paused"
        return True

    cancel = AsyncMock(side_effect=acknowledge_cancel)
    monkeypatch.setattr(project_automation_managed_execution_service, "cancel", cancel)
    await project_automation_service.cancel_run(
        test_db, str(issue.cloud_project_id), str(manager.id), test_user.id
    )
    cancel.assert_awaited_once()
    assert issue.metadata_json["workflow"]["orchestration_status"] == "paused"
