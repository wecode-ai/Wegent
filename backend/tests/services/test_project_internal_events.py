# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Internal status automation persists and processes actual Issue transitions."""

from datetime import timedelta
from unittest.mock import AsyncMock

import pytest

from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationRule,
    ProjectAutomationRun,
    ProjectIncomingEvent,
    ProjectIncomingHook,
)
from app.models.project_chat_message import ProjectChatMessage
from app.services.project_automation_domain import ProjectAutomationEvent, utcnow
from app.services.project_automation_execution import project_automation_execution
from app.services.project_automations import (
    project_automation_processor,
    project_automation_service,
)
from app.services.project_chat.service import project_chat_service
from app.services.project_incoming_hooks import project_incoming_hook_service
from app.services.project_internal_events import _restore_event
from tests.utils.collaboration import authorize_project


@pytest.fixture
def review_transition(test_db, test_user):
    project = CloudProject(
        project_key="REVIEWTRIGGER",
        name="Review trigger",
        created_by_user_id=test_user.id,
        storage_prefix="projects/review-trigger",
    )
    authorize_project(test_db, project)
    test_db.add(project)
    test_db.flush()
    issue = LoopItem(
        cloud_project_id=project.id,
        title="Review this Issue",
        status="in_progress",
        assignee_agent_id="agent-1",
        created_by_user_id=test_user.id,
        metadata_json={"workflow_automation": {"rule_id": "previous-rule"}},
    )
    rule = ProjectAutomationRule(
        cloud_project_id=project.id,
        title="Review handler",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={
            "trigger_type": "event",
            "event_type": "task.status_changed",
            "event_config": {
                "transition": "any",
                "statuses": ["in_review"],
                "execution_target": "existing_issue",
            },
        },
    )
    test_db.add_all([issue, rule])
    test_db.commit()
    message = ProjectChatMessage(
        message_id="completed-activity",
        project_id=project.id,
        task_id=issue.id,
        agent_id="agent-1",
    )
    return issue, message, rule


def test_review_transition_and_queued_event_rollback_together(
    test_db, review_transition
):
    issue, message, _ = review_transition
    project_chat_service._advance_task_to_review(test_db, message)
    test_db.flush()
    assert issue.status == "in_review"
    assert test_db.query(ProjectIncomingEvent).count() == 1

    test_db.rollback()

    assert test_db.get(LoopItem, issue.id).status == "in_progress"
    assert test_db.query(ProjectIncomingEvent).count() == 0
    assert test_db.query(ProjectIncomingHook).count() == 0


@pytest.mark.asyncio
async def test_pending_scan_dispatches_review_trigger_once_after_commit(
    test_db, review_transition, monkeypatch
):
    issue, message, rule = review_transition
    dispatch = AsyncMock()
    monkeypatch.setattr(project_automation_execution, "dispatch", dispatch)
    monkeypatch.setattr(
        "app.tasks.robot_queue_tasks.consume_queues_background", AsyncMock()
    )
    project_chat_service._advance_task_to_review(test_db, message)
    project_chat_service._advance_task_to_review(test_db, message)
    test_db.commit()
    test_db.expire_all()

    assert await project_incoming_hook_service.check_pending(test_db) == 1
    assert await project_incoming_hook_service.check_pending(test_db) == 0

    event = test_db.query(ProjectIncomingEvent).one()
    run = test_db.query(ProjectAutomationRun).one()
    assert event.status == "processed"
    assert run.parent_id == rule.id
    assert run.task_id == issue.id
    assert run.metadata_json["event"]["payload"]["previous_status"] == "in_progress"
    dispatch.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("returned_to_target", [False, True])
async def test_pending_status_event_is_ignored_after_issue_leaves_transition(
    test_db, review_transition, monkeypatch, returned_to_target
):
    issue, message, _ = review_transition
    project_chat_service._advance_task_to_review(test_db, message)
    test_db.commit()
    issue.status = "in_review" if returned_to_target else "completed"
    metadata = dict(issue.metadata_json)
    history = metadata["status_history"]
    metadata["status_history"] = [*history, {"to_status": "completed"}]
    if returned_to_target:
        metadata["status_history"].append({"to_status": "in_review"})
    issue.metadata_json = metadata
    issue.version += 1
    test_db.commit()
    dispatch = AsyncMock()
    monkeypatch.setattr(project_automation_execution, "dispatch", dispatch)

    assert await project_incoming_hook_service.check_pending(test_db) == 0

    assert test_db.query(ProjectIncomingEvent).one().status == "ignored"
    assert test_db.query(ProjectAutomationRun).count() == 0
    dispatch.assert_not_awaited()


@pytest.mark.asyncio
async def test_automation_cannot_trigger_itself_but_manual_reentry_can(
    test_db, review_transition, monkeypatch
):
    issue, message, rule = review_transition
    cause = ProjectAutomationRun(
        cloud_project_id=issue.cloud_project_id,
        parent_id=rule.id,
        status="succeeded",
        created_by_user_id=issue.created_by_user_id,
    )
    test_db.add(cause)
    test_db.commit()
    message.metadata_json = {"automation_run_id": str(cause.id)}
    dispatch = AsyncMock()
    monkeypatch.setattr(project_automation_execution, "dispatch", dispatch)
    monkeypatch.setattr(
        "app.tasks.robot_queue_tasks.consume_queues_background", AsyncMock()
    )
    project_chat_service._advance_task_to_review(test_db, message)
    test_db.commit()

    assert await project_incoming_hook_service.check_pending(test_db) == 0
    dispatch.assert_not_awaited()

    issue.status = "in_progress"
    issue.version += 1
    test_db.commit()
    message.metadata_json = {}
    project_chat_service._advance_task_to_review(test_db, message)
    test_db.commit()

    assert await project_incoming_hook_service.check_pending(test_db) == 1
    assert test_db.query(ProjectAutomationRun).count() == 2
    dispatch.assert_awaited_once()


@pytest.mark.asyncio
async def test_automatic_status_transition_does_not_choose_between_matching_rules(
    test_db, review_transition, monkeypatch
):
    issue, message, first_rule = review_transition
    second_rule = ProjectAutomationRule(
        cloud_project_id=issue.cloud_project_id,
        title="Another review handler",
        status="enabled",
        created_by_user_id=issue.created_by_user_id,
        metadata_json=first_rule.metadata_json,
    )
    test_db.add(second_rule)
    project_chat_service._advance_task_to_review(test_db, message)
    test_db.commit()
    dispatch = AsyncMock()
    monkeypatch.setattr(project_automation_execution, "dispatch", dispatch)

    assert await project_incoming_hook_service.check_pending(test_db) == 0

    event = test_db.query(ProjectIncomingEvent).one()
    assert event.status == "unresolved"
    assert test_db.query(ProjectAutomationRun).count() == 0
    dispatch.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("timestamp_only", [False, True])
async def test_expired_processing_lease_resumes_same_pending_run(
    test_db, review_transition, monkeypatch, timestamp_only
):
    issue, message, rule = review_transition
    project_chat_service._advance_task_to_review(test_db, message)
    test_db.commit()
    event = test_db.query(ProjectIncomingEvent).one()
    hook = test_db.get(ProjectIncomingHook, event.parent_id)
    restored = _restore_event(event, hook)
    run = project_automation_service._create_run(
        test_db,
        rule,
        "event",
        utcnow(),
        public_id=project_automation_processor._event_run_public_id(restored, rule),
    )
    pending_run_id = run.id
    event.status = "processing"
    event.due_at = None if timestamp_only else utcnow() - timedelta(seconds=1)
    event.metadata_json = {
        **event.metadata_json,
        "attempt_count": 1,
        "processing_started_at": (utcnow() - timedelta(minutes=6)).isoformat(),
    }
    test_db.commit()

    async def enqueue(_db, _rule, claimed_run):
        claimed_run.status = "queued"
        _db.commit()

    dispatch = AsyncMock(side_effect=enqueue)
    monkeypatch.setattr(project_automation_execution, "dispatch", dispatch)
    monkeypatch.setattr(
        "app.tasks.robot_queue_tasks.consume_queues_background", AsyncMock()
    )

    assert await project_incoming_hook_service.check_pending(test_db) == 1

    assert test_db.query(ProjectAutomationRun).one().id == pending_run_id
    assert run.task_id == issue.id
    assert event.status == "processed"
    assert event.metadata_json["attempt_count"] == 2
    dispatch.assert_awaited_once()

    # A second crash after dispatch keeps the same already-enqueued Run.
    event.status = "processing"
    event.due_at = utcnow() - timedelta(seconds=1)
    test_db.commit()

    assert await project_incoming_hook_service.check_pending(test_db) == 1
    assert test_db.query(ProjectAutomationRun).count() == 1
    assert event.status == "processed"
    dispatch.assert_awaited_once()


@pytest.mark.asyncio
async def test_active_processing_lease_is_not_claimed_again(
    test_db, review_transition, monkeypatch
):
    _, message, _ = review_transition
    project_chat_service._advance_task_to_review(test_db, message)
    test_db.commit()
    event = test_db.query(ProjectIncomingEvent).one()
    assert project_incoming_hook_service._claim_event(test_db, event.id)
    claimed_version = event.version
    dispatch = AsyncMock()
    monkeypatch.setattr(project_automation_execution, "dispatch", dispatch)

    assert await project_incoming_hook_service.process_event(test_db, event.id) == 0
    assert await project_incoming_hook_service.check_pending(test_db) == 0

    assert event.status == "processing"
    assert event.version == claimed_version
    assert event.metadata_json["attempt_count"] == 1
    assert test_db.query(ProjectAutomationRun).count() == 0
    dispatch.assert_not_awaited()


@pytest.mark.asyncio
async def test_internal_lease_recovery_does_not_replay_external_side_effects(
    test_db, review_transition, monkeypatch
):
    _, message, _ = review_transition
    project_chat_service._advance_task_to_review(test_db, message)
    test_db.commit()
    event = test_db.query(ProjectIncomingEvent).one()
    event.status = "processing"
    event.due_at = utcnow() - timedelta(minutes=6)
    event.metadata_json = {**event.metadata_json, "collection_mode": "webhook"}
    test_db.commit()
    dispatch = AsyncMock()
    monkeypatch.setattr(project_automation_execution, "dispatch", dispatch)

    assert await project_incoming_hook_service.process_event(test_db, event.id) == 0
    assert await project_incoming_hook_service.check_pending(test_db) == 0

    assert event.status == "processing"
    assert test_db.query(ProjectAutomationRun).count() == 0
    dispatch.assert_not_awaited()


@pytest.mark.asyncio
async def test_pending_external_create_issue_run_keeps_existing_processing_contract(
    test_db, review_transition, monkeypatch
):
    issue, _, rule = review_transition
    rule.metadata_json = {
        "trigger_type": "event",
        "event_type": "document.changed",
        "event_config": {"execution_target": "create_issue"},
    }
    event = ProjectAutomationEvent(
        event_type="document.changed",
        project_id=str(issue.cloud_project_id),
        subject_id="external-document",
        source="generic",
        actor_user_id=issue.created_by_user_id,
        event_id="external-event-1",
        payload={"title": "Already being processed"},
    )
    run = project_automation_service._create_run(
        test_db,
        rule,
        "event",
        utcnow(),
        public_id=project_automation_processor._event_run_public_id(event, rule),
    )
    dispatch = AsyncMock()
    monkeypatch.setattr(project_automation_execution, "dispatch", dispatch)
    monkeypatch.setattr(
        "app.tasks.robot_queue_tasks.consume_queues_background", AsyncMock()
    )

    runs = await project_automation_processor.process_with_runs(test_db, event)

    assert [row.id for row in runs] == [run.id]
    assert test_db.query(LoopItem).count() == 1
    assert test_db.query(ProjectAutomationRun).count() == 1
    assert run.status == "pending"
    dispatch.assert_not_awaited()
