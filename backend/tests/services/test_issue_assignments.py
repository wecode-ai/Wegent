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
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.issue_assignment import IssueAssignmentDecision, IssueAssignmentResult
from app.services.issue_assignment_continuation import (
    issue_assignment_continuation_service,
)
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


@pytest.fixture(autouse=True)
def no_assignment_notification_delivery(monkeypatch):
    monkeypatch.setattr("app.core.async_utils.schedule_async_task", MagicMock())
    monkeypatch.setattr(
        "app.services.project_chat.push.push_project_chat_message", MagicMock()
    )


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
async def test_issue_change_event_survives_its_database_session(
    test_db, test_user, assigned_issue, monkeypatch
):
    from app.services import loop_item_events

    issue, _ = assigned_issue
    expected = {
        "projectId": str(issue.cloud_project_id),
        "itemId": issue.id,
        "version": issue.version,
        "reason": "runtime_status",
    }
    loop = MagicMock()
    loop.is_closed.return_value = False
    monkeypatch.setattr(loop_item_events, "get_socketio_loop", lambda: loop)
    schedule = MagicMock()
    monkeypatch.setattr(loop_item_events.asyncio, "run_coroutine_threadsafe", schedule)
    socket = SimpleNamespace(emit=AsyncMock())
    monkeypatch.setattr("app.core.socketio.get_sio", lambda: socket)
    loop_item_events.publish_loop_item_changed(
        test_db, item=issue, reason="runtime_status", actor_user_id=test_user.id
    )
    test_db.expire(issue)
    test_db.expunge(issue)
    await schedule.call_args.args[0]
    socket.emit.assert_awaited_once()
    assert socket.emit.call_args.args == ("wework:loop_item:changed", expected)


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
async def test_worker_cannot_make_a_coordinator_decision(
    test_db, test_user, assigned_issue
):
    issue, _manager = assigned_issue
    with pytest.raises(IssueAssignmentConflict) as caught:
        await issue_assignment_service.decide(
            test_db,
            issue_id=issue.id,
            user_id=test_user.id,
            decision=command("assign_user", assignee_user_id=test_user.id),
            manager_run_id="",
        )
    assert caught.value.detail["code"] == "coordinator_invalid"
    assert "active AI coordinator" in caught.value.detail["message"]
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
    continuation = AsyncMock(side_effect=lambda db, **_: db.commit())
    monkeypatch.setattr(
        issue_assignment_continuation_service, "continue_coordinator", continuation
    )
    result = await issue_assignment_service.decide(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        decision=command("assign_user", assignee_user_id=test_user.id),
        manager_run_id=manager.id,
    )
    assert issue.assignee_user_id == test_user.id
    assert result["orchestration_status"] == "waiting_human"
    assert result["coordinator_handoff"]["resume_on"] == "human_continue"
    assert "explicit Continue" in result["coordinator_handoff"]["instruction"]
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
    continuation.assert_awaited_once()


@pytest.mark.asyncio
async def test_human_continue_reuses_the_original_coordinator_runtime_task(
    test_db, test_user, assigned_issue, monkeypatch
):
    from app.services import runtime_work_service

    issue, manager = assigned_issue
    activity = (
        test_db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.message_id
            == manager.metadata_json["activity_message_id"]
        )
        .one()
    )
    execution = LoopItemExecution(
        loop_item_id=issue.id,
        cloud_project_id=str(issue.cloud_project_id),
        executor_owner_user_id=test_user.id,
        assigner_user_id=test_user.id,
        automation_run_id=manager.id,
        execution_environment="local",
        execution_device_id="device-1",
        runtime_device_id="device-1",
        runtime_task_id="coordinator-task-1",
        status="completed",
        execution_payload=loop_item_execution_service._serialize_execution_intent(
            runtime_selection={
                "model": "deepseek-v4-flash",
                "model_type": "user",
                "model_options": {
                    "weworkCloudModelNamespace": "private-models",
                    "weworkCloudModelResourceUserId": test_user.id,
                },
            },
            origin_context={},
        ),
    )
    test_db.add(execution)
    test_db.flush()
    activity.runtime_device_id = execution.runtime_device_id
    activity.runtime_task_id = execution.runtime_task_id
    activity.metadata_json = {
        "automation_run_id": manager.id,
        "assignment_mode": "ai_managed",
        "manager_type": "custom",
        "executor_type": "automation_manager",
        "execution_id": execution.id,
    }
    test_db.commit()
    original_workflow_run_id = issue.metadata_json["workflow"]["active_run_id"]
    original_workflow_run_count = test_db.query(ProjectWorkflowRun).count()
    original_automation_run_count = test_db.query(ProjectAutomationRun).count()
    original_execution_count = test_db.query(LoopItemExecution).count()
    await issue_assignment_service.decide(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        decision=command("assign_user", assignee_user_id=test_user.id),
        manager_run_id=manager.id,
    )
    send = AsyncMock(return_value=SimpleNamespace(accepted=True, error=None))
    monkeypatch.setattr(runtime_work_service, "send_runtime_message", send)

    resumed = await issue_assignment_service.submit_result(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        result=IssueAssignmentResult(
            assignment_id="assignment-1", summary="Just test it; choose the details"
        ),
    )

    assert resumed["active_run_id"] == original_workflow_run_id
    assert test_db.query(ProjectWorkflowRun).count() == original_workflow_run_count
    assert test_db.query(ProjectAutomationRun).count() == original_automation_run_count
    assert test_db.query(LoopItemExecution).count() == original_execution_count
    request = send.await_args.kwargs["request"]
    assert request.address.device_id == "device-1"
    assert request.address.task_id == "coordinator-task-1"
    assert request.model_selection.model_name == "deepseek-v4-flash"
    assert request.model_selection.model_type == "user"
    assert request.model_selection.options == {
        "weworkCloudModelNamespace": "private-models",
        "weworkCloudModelResourceUserId": test_user.id,
    }
    assert "Just test it; choose the details" in request.message
    assert "previous request_id was assignment-1" in request.message
    assert "MUST NOT be reused" in request.message
    continuation = (
        test_db.query(ProjectChatMessage)
        .filter(
            ProjectChatMessage.metadata_json["kind"].as_string()
            == "issue_assignment_continuation"
        )
        .one()
    )
    assert continuation.runtime_task_id == "coordinator-task-1"
    assert (
        continuation.thread_root_message_id
        == resumed["assignment"]["thread_root_message_id"]
    )


@pytest.mark.asyncio
async def test_only_human_session_can_return_control_to_ai(
    test_db,
    test_user,
    test_client,
    test_token,
    test_task_token,
    assigned_issue,
    monkeypatch,
):
    issue, manager = assigned_issue
    continuation = AsyncMock(side_effect=lambda db, **_: db.commit())
    monkeypatch.setattr(
        issue_assignment_continuation_service, "continue_coordinator", continuation
    )
    await issue_assignment_service.decide(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        decision=command("assign_user", assignee_user_id=test_user.id),
        manager_run_id=manager.id,
    )
    path = f"/api/v1/loop-items/{issue.id}/assignment/result"
    payload = {"assignment_id": "assignment-1", "summary": "I approve this proposal"}
    response = test_client.post(
        path, headers={"Authorization": f"Bearer {test_task_token}"}, json=payload
    )
    assert response.status_code == 401
    assert issue.metadata_json["workflow"]["orchestration_status"] == "waiting_human"
    continuation.assert_not_awaited()

    for _ in range(2):
        response = test_client.post(
            path, headers={"Authorization": f"Bearer {test_token}"}, json=payload
        )
        assert response.status_code == 200, response.text
        assert response.json()["orchestration_status"] == "planning"
    continuation.assert_awaited_once()


@pytest.mark.asyncio
async def test_human_control_blocks_coordinator_and_ordinary_workflow_replacement(
    test_db, test_user, assigned_issue, monkeypatch
):
    from fastapi import HTTPException

    from app.schemas.delivery import LoopItemUpdate
    from app.schemas.project_chat import ProjectChatSend
    from app.services.issue_workflow_planning import issue_workflow_planning_service
    from app.services.loop_items.service import loop_item_service
    from app.services.project_chat.service import project_chat_service

    issue, manager = assigned_issue
    await issue_assignment_service.decide(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
        decision=command("assign_user", assignee_user_id=test_user.id),
        manager_run_id=manager.id,
    )
    dispatch = AsyncMock(return_value=1)
    monkeypatch.setattr(issue_workflow_start_service, "_start_ai", dispatch)
    project = test_db.get(CloudProject, issue.cloud_project_id)
    assert (
        await issue_workflow_start_service.start(
            test_db, item=issue, project=project, user_id=test_user.id
        )
        == 0
    )
    dispatch.assert_not_awaited()
    with pytest.raises(ValueError, match="Continue"):
        issue_workflow_planning_service.ensure_run(
            test_db, issue=issue, user_id=test_user.id
        )
    with pytest.raises(IssueAssignmentConflict, match="waiting_human"):
        await issue_assignment_service.decide(
            test_db,
            issue_id=issue.id,
            user_id=test_user.id,
            decision=command("complete").model_copy(
                update={
                    "request_id": "premature-complete",
                    "expected_assignment_version": 1,
                }
            ),
            manager_run_id=manager.id,
        )
    loop_item_service.update(
        test_db,
        issue.id,
        test_user.id,
        LoopItemUpdate(version=issue.version, description="Still reviewing two tasks"),
    )
    project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=ProjectChatSend(
            client_message_id=str(uuid4()),
            project_id=str(project.id),
            task_id=str(issue.id),
            content="The first task looks good. I have not finished reviewing the second.",
        ),
    )
    assert issue.metadata_json["workflow"]["orchestration_status"] == "waiting_human"
    changed = {**issue.metadata_json["workflow"], "orchestration_status": "planning"}
    with pytest.raises(HTTPException) as caught:
        loop_item_service.update(
            test_db,
            issue.id,
            test_user.id,
            LoopItemUpdate(version=issue.version, workflow=changed),
        )
    assert caught.value.status_code == 409
    assert issue.metadata_json["workflow"]["orchestration_status"] == "waiting_human"


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
    role_run.status = "running"
    sync_automation_workflow_node(test_db, role_run)
    assert issue.metadata_json["workflow"]["nodes"][0]["status"] == "running"
    role_run.status = "failed"
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


@pytest.mark.asyncio
@pytest.mark.parametrize("transport", ["http", "websocket"])
@pytest.mark.parametrize("outcome", ["incomplete", "timeout"])
async def test_task_conversation_stop_prevents_retry_before_runtime_ack(
    test_db, test_user, stoppable_assignment, monkeypatch, transport, outcome
):
    from contextlib import nullcontext

    from fastapi import HTTPException

    from app.api.ws import wework_runtime_namespace
    from app.models.kind import Kind
    from app.models.loop_item_execution import LoopItemExecution
    from app.schemas.runtime_work import RuntimeTaskAddress
    from app.services import runtime_work_service
    from app.services.issue_assignments import assignment_callback_intent

    issue, worker, execution = stoppable_assignment
    execution.max_retries = 3
    test_db.add(
        Kind(
            kind="Device",
            name="stop-device",
            namespace="default",
            user_id=test_user.id,
            is_active=True,
            json={"spec": {"deviceId": "stop-device", "appDeviceId": "app-stop"}},
        )
    )
    test_db.commit()
    initial_count = test_db.query(LoopItemExecution).count()
    monkeypatch.setattr(
        wework_runtime_namespace, "get_db_session", lambda: nullcontext(test_db)
    )

    async def run_in_test_session(fn):
        return fn()

    monkeypatch.setattr(
        wework_runtime_namespace, "run_sync_in_executor", run_in_test_session
    )
    monkeypatch.setattr(
        runtime_work_service.device_service,
        "get_device_by_device_id",
        lambda *_: object(),
    )

    async def runtime_reply(**kwargs):
        test_db.expire_all()
        assert execution.status == "cancel_requested"
        assert issue.metadata_json["workflow"]["orchestration_status"] == "paused"
        if outcome == "timeout":
            raise runtime_work_service.RuntimeRpcError("Device disconnected")
        stopped = loop_item_execution_service.handle_runtime_event(
            test_db,
            device_id="stop-device",
            runtime_task_id="stop-task",
            owner_user_id=test_user.id,
            event_name="response.incomplete",
            payload={"eventSeq": 1, "error": "Task interrupted"},
        )
        assert stopped.id == execution.id
        assert stopped.status == "cancelled"
        assert assignment_callback_intent(test_db, stopped, "failed") is None
        return {"accepted": True, "success": True, "taskId": "stop-task"}

    rpc = AsyncMock(side_effect=runtime_reply)
    monkeypatch.setattr(runtime_work_service.runtime_rpc_service, "call", rpc)

    async def stop():
        if transport == "websocket":
            return await wework_runtime_namespace.relay_ipc_request(
                user_id=test_user.id,
                device_id="app-stop",
                method="runtime.tasks.cancel",
                params={"taskId": "stop-task"},
                timeout_seconds=30,
            )
        return await runtime_work_service.cancel_runtime_task(
            db=test_db,
            user_id=test_user.id,
            address=RuntimeTaskAddress(deviceId="app-stop", localTaskId="stop-task"),
        )

    if outcome == "timeout":
        with pytest.raises((HTTPException, runtime_work_service.RuntimeRpcError)):
            await stop()
    else:
        await stop()
    rpc.assert_awaited_once()
    assert test_db.query(LoopItemExecution).count() == initial_count
    assert issue.metadata_json["workflow"]["orchestration_status"] == "paused"
    assert issue.metadata_json["workflow"]["assignment_version"] == 1


@pytest.mark.parametrize("execution_status", ["queued", "running"])
def test_runtime_stop_does_not_affect_another_owners_task(
    test_db, test_user, stoppable_assignment, execution_status
):
    from app.services.runtime_task_stop import record_runtime_task_user_stop

    issue, worker, execution = stoppable_assignment
    execution.status = execution_status
    test_db.commit()
    record_runtime_task_user_stop(
        test_db,
        user_id=test_user.id + 1000,
        device_id="stop-device",
        task_id="stop-task",
    )
    assert execution.status == execution_status
    assert issue.metadata_json["workflow"]["orchestration_status"] == "running"


def test_runtime_stop_cancels_a_queued_task_without_retry(
    test_db, test_user, stoppable_assignment
):
    from app.services.runtime_task_stop import record_runtime_task_user_stop

    issue, worker, execution = stoppable_assignment
    execution.status = "queued"
    test_db.commit()
    record_runtime_task_user_stop(
        test_db, user_id=test_user.id, device_id="stop-device", task_id="stop-task"
    )
    assert execution.status == "cancelled"
    assert issue.metadata_json["workflow"]["orchestration_status"] == "paused"
