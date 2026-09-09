"""Database-backed routing tests; Runtime execution is the external boundary."""

from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationRule,
    RuntimeProfile,
)
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.schemas.project_event_center import (
    EventCenterConfig,
    EventReply,
    EventRoutingDecision,
    EventSubmission,
    ExternalReference,
)
from app.services.issue_workflow_start import issue_workflow_start_service
from app.services.project_event_center import project_event_center_service as service


@pytest.fixture
def event_board(test_db, test_user):
    project = CloudProject(
        project_key="EVT" + uuid4().hex[:6],
        name="Events",
        public_id=str(uuid4()),
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    device = Kind(
        kind="Device",
        name="event-device",
        namespace="default",
        user_id=test_user.id,
        is_active=True,
        json={"spec": {"deviceType": "local"}},
    )
    test_db.add_all([project, device])
    test_db.flush()
    profile = RuntimeProfile(
        user_id=test_user.id,
        created_by_user_id=test_user.id,
        name="Router",
        device_id="event-device",
        metadata_json={
            "execution_environment": "local",
            "model": "codex",
            "model_type": "runtime",
        },
    )
    test_db.add(profile)
    test_db.commit()
    service.configure(
        test_db,
        project.id,
        test_user.id,
        EventCenterConfig(enabled=True, runtime_profile_id=profile.id),
    )
    return project


def incoming(db, project, user):
    event = service.submit(
        db,
        project.id,
        user.id,
        EventSubmission(title="Process invoices", request_id=str(uuid4())),
    )
    execution = db.get(LoopItemExecution, event.metadata_json["execution_id"])
    execution.status = "running"
    db.commit()
    return event, execution


def draft(version):
    return EventRoutingDecision(
        version=version,
        action="create_workflow",
        goal="List invoice differences",
        reason="No existing experience covers reconciliation",
        workflow={
            "name": "Reconcile invoices",
            "description": "Compare invoices and payments",
            "coordinator_prompt": "Assign roles based on the goal and available evidence",
            "roles": [
                {
                    "name": "Reconcile",
                    "instruction": "Compare each invoice with its payment",
                }
            ],
        },
    )


@pytest.mark.asyncio
async def test_clarifies_before_creating_flow_and_issue(
    test_db, test_user, event_board, monkeypatch
):
    event, execution = incoming(test_db, event_board, test_user)
    assert execution.executor_type == "event_router"
    assert execution.runtime_request["origin"]["type"] == "project_event"
    assert test_db.query(LoopItem).count() == 0
    result = await service.decide(
        test_db,
        event_board.id,
        event.id,
        test_user.id,
        execution.id,
        EventRoutingDecision(
            version=event.version,
            action="clarify",
            reason="Goal unclear",
            question="Which outcome?",
        ),
    )
    assert result["status"] == "clarifying"
    execution.status = "completed"
    test_db.commit()
    service.reply(
        test_db,
        event_board.id,
        event.id,
        test_user.id,
        EventReply(version=event.version, content="List differences"),
    )
    next_execution = test_db.get(LoopItemExecution, event.metadata_json["execution_id"])
    next_execution.status = "running"
    test_db.commit()
    start = AsyncMock(return_value=1)
    monkeypatch.setattr(issue_workflow_start_service, "start", start)
    decision = draft(event.version)
    result = await service.decide(
        test_db, event_board.id, event.id, test_user.id, next_execution.id, decision
    )
    assert result["status"] == "routed"
    issue = test_db.get(LoopItem, result["issue_id"])
    assert issue.description == "List invoice differences"
    assert issue.metadata_json["workflow"]["nodes"][0]["name"] == "Reconcile"
    assert test_db.query(ProjectAutomationRule).count() == 0
    assert test_db.query(LoopItem).count() == 1
    start.assert_awaited_once()
    await service.decide(
        test_db, event_board.id, event.id, test_user.id, next_execution.id, decision
    )
    assert test_db.query(LoopItem).count() == 1


@pytest.mark.asyncio
async def test_known_reference_returns_to_same_completed_issue(
    test_db, test_user, event_board, monkeypatch
):
    issue = LoopItem(
        cloud_project_id=event_board.id,
        title="Existing",
        created_by_user_id=test_user.id,
        metadata_json={
            "workflow": {
                "orchestration_status": "completed",
                "intent": "Original goal",
                "nodes": [],
            }
        },
    )
    test_db.add(issue)
    test_db.commit()
    reference = ExternalReference(
        provider="gitlab", external_id="https://gitlab.test/repo/-/merge_requests/8"
    )
    service.bind_reference(test_db, event_board.id, issue.id, test_user.id, reference)
    test_db.commit()
    event, _ = service.accept(
        test_db,
        project_id=event_board.id,
        user_id=test_user.id,
        identity=uuid4().hex,
        title="Review",
        content="Fix IPv6",
        provider="gitlab",
        reference=reference.model_dump(),
    )
    execution = test_db.get(LoopItemExecution, event.metadata_json["execution_id"])
    execution.status = "running"
    test_db.commit()
    with pytest.raises(HTTPException, match="existing Issue"):
        await service.decide(
            test_db,
            event_board.id,
            event.id,
            test_user.id,
            execution.id,
            draft(event.version),
        )
    monkeypatch.setattr(
        issue_workflow_start_service, "start", AsyncMock(return_value=1)
    )
    result = await service.decide(
        test_db,
        event_board.id,
        event.id,
        test_user.id,
        execution.id,
        EventRoutingDecision(
            version=event.version,
            action="route_existing",
            issue_id=issue.id,
            reason="Matching artifact",
        ),
    )
    assert result["issue_id"] == issue.id
    assert issue.metadata_json["workflow"]["intent"] == "Original goal"
    assert issue.metadata_json["workflow"]["orchestration_status"] == "planning"
    assert test_db.query(LoopItem).count() == 1


def test_router_requires_current_execution_and_deduplicates_intake(
    test_db, test_user, event_board
):
    request = EventSubmission(title="Review", request_id="same-delivery")
    first = service.submit(test_db, event_board.id, test_user.id, request)
    second = service.submit(test_db, event_board.id, test_user.id, request)
    assert first.id == second.id
    assert test_db.query(LoopItemExecution).count() == 1
    with pytest.raises(HTTPException):
        service.context(test_db, event_board.id, first.id, test_user.id, 9999)


def test_router_completion_without_decision_is_failure(test_db, test_user, event_board):
    event, execution = incoming(test_db, event_board, test_user)
    service.finish_execution(test_db, execution, None)
    assert event.status == "failed"
    assert "without recording" in event.metadata_json["error"]


@pytest.mark.asyncio
async def test_generated_experience_executes_without_publishing_rule(
    test_db, test_user, event_board
):
    event, execution = incoming(test_db, event_board, test_user)
    result = await service.decide(
        test_db,
        event_board.id,
        event.id,
        test_user.id,
        execution.id,
        draft(event.version),
    )
    assert result["status"] == "routed"
    assert test_db.query(ProjectAutomationRule).count() == 0
    issue = test_db.get(LoopItem, result["issue_id"])
    assert issue.metadata_json["workflow"]["ai_automation_rule_id"] is None
    coordinator = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == issue.id)
        .one()
    )
    assert coordinator.executor_type == "automation_manager"
    assert coordinator.runtime_request["origin"]["automationRole"] == "manager"
    assert "Compare invoices" not in coordinator.runtime_request.get("message", "")
    assert (
        service.context(test_db, event_board.id, event.id, test_user.id, execution.id)[
            "automations"
        ]
        == []
    )


def test_runtime_rejection_preserves_event_and_allows_recovery(
    test_db, test_user, event_board, monkeypatch
):
    from app.services.runtime_profiles import runtime_profile_service

    original = runtime_profile_service.require_runnable

    def unavailable(*args, **kwargs):
        raise HTTPException(409, "Runtime unavailable")

    monkeypatch.setattr(runtime_profile_service, "require_runnable", unavailable)
    event = service.submit(
        test_db,
        event_board.id,
        test_user.id,
        EventSubmission(title="Keep my work", request_id="retain"),
    )
    assert event.status == "failed"
    assert event.description == ""
    assert event.metadata_json["error"] == "Runtime unavailable"
    monkeypatch.setattr(runtime_profile_service, "require_runnable", original)
    service.enqueue(test_db, event)
    test_db.commit()
    assert event.status == "queued"
    assert test_db.query(LoopItemExecution).count() == 1


def test_manual_request_identity_cannot_discard_changed_content(
    test_db, test_user, event_board
):
    service.submit(
        test_db,
        event_board.id,
        test_user.id,
        EventSubmission(title="First", request_id="same"),
    )
    with pytest.raises(HTTPException, match="different event content"):
        service.submit(
            test_db,
            event_board.id,
            test_user.id,
            EventSubmission(title="Second", request_id="same"),
        )


@pytest.mark.asyncio
async def test_incoming_event_invalidates_stale_coordinator_without_replacing_work(
    test_db, test_user, event_board, monkeypatch
):
    from app.schemas.issue_assignment import IssueAssignmentDecision
    from app.services.issue_assignment_state import decide_assignment

    issue = LoopItem(
        cloud_project_id=event_board.id,
        title="Active Issue",
        created_by_user_id=test_user.id,
        metadata_json={
            "workflow": {
                "advancement_policy": "ai",
                "orchestration_status": "running",
                "assignment_version": 5,
                "assignment": {"id": "current-work", "status": "running"},
                "nodes": [],
            }
        },
    )
    test_db.add(issue)
    test_db.commit()
    event, execution = incoming(test_db, event_board, test_user)
    monkeypatch.setattr(
        issue_workflow_start_service, "start", AsyncMock(return_value=0)
    )
    result = await service.decide(
        test_db,
        event_board.id,
        event.id,
        test_user.id,
        execution.id,
        EventRoutingDecision(
            version=event.version,
            action="route_existing",
            issue_id=issue.id,
            reason="Continue the existing task",
        ),
    )
    assert result["status"] == "routed"
    workflow = issue.metadata_json["workflow"]
    assert workflow["assignment"]["id"] == "current-work"
    assert workflow["orchestration_status"] == "running"
    assert workflow["incoming_events"][0]["id"] == event.id
    with pytest.raises(ValueError, match="assignment_version_conflict"):
        decide_assignment(
            workflow,
            IssueAssignmentDecision(
                request_id="stale",
                expected_assignment_version=5,
                action="complete",
                reason="Old goal met",
            ),
        )


def test_router_can_be_delivered_without_issue_task_binding(
    test_db, test_user, event_board
):
    from app.models.delivery import LoopItemTaskBinding
    from app.services.loop_item_executions.service import loop_item_execution_service

    event, execution = incoming(test_db, event_board, test_user)
    execution.status = "claimed"
    execution.runtime_device_id = "event-device"
    test_db.commit()
    assert (
        loop_item_execution_service.mark_start_requested(
            test_db, execution_ids=[execution.id]
        )
        == 1
    )
    assert test_db.query(LoopItemTaskBinding).count() == 0
    assert (
        loop_item_execution_service.open_execution_activity(
            test_db, execution=execution
        )
        is None
    )


@pytest.mark.asyncio
async def test_recovered_handoff_keeps_already_queued_issue_coordinator(
    test_db, test_user, event_board
):
    from app.services.project_event_handoff import resume_handoff

    event, execution = incoming(test_db, event_board, test_user)
    await service.decide(
        test_db,
        event_board.id,
        event.id,
        test_user.id,
        execution.id,
        draft(event.version),
    )
    event.status = "dispatching"
    test_db.commit()
    await resume_handoff(test_db, event.id)
    assert event.status == "routed"
    assert (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == event.loop_item_id)
        .count()
        == 1
    )


def test_runtime_task_credential_can_read_only_current_execution(
    test_client, test_db, test_user, event_board
):
    from app.services.auth import create_task_token

    event, execution = incoming(test_db, event_board, test_user)
    token = create_task_token(
        task_id=0, subtask_id=0, user_id=test_user.id, user_name=test_user.user_name
    )
    endpoint = f"/api/v1/cloud-projects/{event_board.id}/events/{event.id}/context"
    headers = {
        "Authorization": f"Bearer {token}",
        "X-Event-Execution-Id": str(execution.id),
    }
    assert test_client.get(endpoint, headers=headers).status_code == 200
    assert (
        test_client.get(
            endpoint, headers={**headers, "X-Event-Execution-Id": "999999"}
        ).status_code
        == 403
    )
