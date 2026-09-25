# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Runtime boundaries for project automation dispatch."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.project_automation_domain import ProjectAutomationEvent
from app.services.project_automation_execution import (
    ProjectAutomationExecution,
    ProjectAutomationProcessor,
    project_automation_execution,
)


def test_human_assigned_issue_does_not_match_event_automation():
    db = MagicMock()
    legacy_rule = SimpleNamespace(
        id="legacy-rule",
        metadata_json={"trigger_type": "event", "event_type": "task.tag_added"},
    )
    db.query.return_value.filter.return_value.all.return_value = [legacy_rule]
    processor = ProjectAutomationProcessor()

    matches = processor.matching_rules(
        db,
        ProjectAutomationEvent(
            event_type="task.tag_added",
            project_id="project-1",
            subject_id="task-1",
            source="board",
            actor_user_id=7,
            payload={
                "title": "Human-owned Issue",
                "human_work": {
                    "assignment_id": "assignment-1",
                    "assignee_user_id": 7,
                    "state": "none",
                },
            },
        ),
    )

    assert matches == []


@pytest.mark.asyncio
async def test_event_processing_wakes_cloud_executor_after_dispatch(monkeypatch):
    rule = SimpleNamespace(
        id="rule-1",
        status="enabled",
        metadata_json={
            "trigger_type": "event",
            "event_type": "task.created",
        },
    )
    run = SimpleNamespace(
        id="run-1",
        task_id="",
        task_title="",
        metadata_json={},
    )
    query = MagicMock()
    query.filter.return_value = query
    query.all.return_value = [rule]
    db = MagicMock()
    db.query.return_value = query
    dispatch = AsyncMock()
    monkeypatch.setattr(project_automation_execution, "dispatch", dispatch)
    processor = ProjectAutomationProcessor(run_factory=MagicMock(return_value=run))

    with patch(
        "app.tasks.robot_queue_tasks.consume_queues_background",
        new=AsyncMock(),
    ) as wake:
        dispatched = await processor.process(
            db,
            ProjectAutomationEvent(
                event_type="task.created",
                project_id="project-1",
                subject_id="task-1",
                source="local",
                actor_user_id=7,
                payload={"title": "Wake immediately"},
            ),
        )

    assert dispatched == 1
    dispatch.assert_awaited_once_with(db, rule, run)
    wake.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_status_event_dispatches_only_when_processing_boundary_is_crossed(
    monkeypatch,
):
    matching_rule = SimpleNamespace(
        id="matching-rule",
        status="enabled",
        metadata_json={
            "trigger_type": "event",
            "event_type": "task.status_changed",
            "event_config": {"transition": "entered_processing"},
        },
    )
    other_rule = SimpleNamespace(
        id="other-rule",
        status="enabled",
        metadata_json={
            "trigger_type": "event",
            "event_type": "task.created",
        },
    )
    run = SimpleNamespace(
        id="run-1",
        task_id="",
        task_title="",
        metadata_json={},
    )
    query = MagicMock()
    query.filter.return_value = query
    query.all.return_value = [matching_rule, other_rule]
    db = MagicMock()
    db.query.return_value = query
    db.get.return_value = SimpleNamespace(metadata_json={})
    dispatch = AsyncMock()
    monkeypatch.setattr(project_automation_execution, "dispatch", dispatch)
    processor = ProjectAutomationProcessor(run_factory=MagicMock(return_value=run))

    with patch(
        "app.tasks.robot_queue_tasks.consume_queues_background",
        new=AsyncMock(),
    ):
        dispatched = await processor.process(
            db,
            ProjectAutomationEvent(
                event_type="task.status_changed",
                project_id="project-1",
                subject_id="task-1",
                source="board",
                actor_user_id=7,
                payload={
                    "title": "Start implementation",
                    "status": "in_progress",
                    "previous_status": "inbox",
                },
            ),
        )

    assert dispatched == 1
    dispatch.assert_awaited_once_with(db, matching_rule, run)
    assert run.metadata_json["event"]["type"] == "task.status_changed"
    assert run.metadata_json["event"]["payload"]["previous_status"] == "inbox"


@pytest.mark.asyncio
async def test_unbound_issue_does_not_dispatch_multiple_matching_automations(
    monkeypatch,
):
    rules = [
        SimpleNamespace(
            id="rule-1",
            status="enabled",
            metadata_json={
                "trigger_type": "event",
                "event_type": "task.created",
            },
        ),
        SimpleNamespace(
            id="rule-2",
            status="enabled",
            metadata_json={
                "trigger_type": "event",
                "event_type": "task.created",
            },
        ),
    ]
    rule_query = MagicMock()
    rule_query.filter.return_value = rule_query
    rule_query.all.return_value = rules
    item_query = MagicMock()
    item_query.filter.return_value = item_query
    item_query.one_or_none.return_value = SimpleNamespace(metadata_json={})
    db = MagicMock()
    db.query.side_effect = [rule_query, item_query]
    dispatch = AsyncMock()
    monkeypatch.setattr(project_automation_execution, "dispatch", dispatch)
    processor = ProjectAutomationProcessor(run_factory=MagicMock())

    dispatched = await processor.process(
        db,
        ProjectAutomationEvent(
            event_type="task.created",
            project_id="project-1",
            subject_id="task-1",
            source="local",
            actor_user_id=7,
            payload={"title": "Choose one"},
        ),
    )

    assert dispatched == 0
    dispatch.assert_not_awaited()


@pytest.mark.asyncio
async def test_bound_issue_dispatches_only_its_matching_automation(monkeypatch):
    bound_rule = SimpleNamespace(
        id="rule-1",
        status="enabled",
        metadata_json={
            "trigger_type": "event",
            "event_type": "task.status_changed",
            "event_config": {"transition": "entered_processing"},
        },
    )
    other_rule = SimpleNamespace(
        id="rule-2",
        status="enabled",
        metadata_json={
            "trigger_type": "event",
            "event_type": "task.status_changed",
            "event_config": {"transition": "entered_processing"},
        },
    )
    rule_query = MagicMock()
    rule_query.filter.return_value = rule_query
    rule_query.all.return_value = [bound_rule, other_rule]
    item_query = MagicMock()
    item_query.filter.return_value = item_query
    item_query.one_or_none.return_value = SimpleNamespace(
        metadata_json={"workflow_automation": {"rule_id": "rule-1"}}
    )
    db = MagicMock()
    db.query.side_effect = [rule_query, item_query]
    run = SimpleNamespace(
        id="run-1",
        task_id="",
        task_title="",
        metadata_json={},
    )
    dispatch = AsyncMock()
    monkeypatch.setattr(project_automation_execution, "dispatch", dispatch)
    processor = ProjectAutomationProcessor(run_factory=MagicMock(return_value=run))

    dispatched = await processor.process(
        db,
        ProjectAutomationEvent(
            event_type="task.status_changed",
            project_id="project-1",
            subject_id="task-1",
            source="board",
            actor_user_id=7,
            payload={
                "title": "Continue",
                "previous_status": "inbox",
                "status": "pending",
            },
        ),
    )

    assert dispatched == 1
    dispatch.assert_awaited_once_with(db, bound_rule, run)
