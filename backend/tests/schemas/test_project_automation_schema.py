# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Schema tests for explicit project automation dispatch targets."""

from datetime import datetime

import pytest
from pydantic import ValidationError

from app.schemas.project_automation import (
    ProjectAutomationCreate,
    ProjectAutomationRunView,
    ProjectAutomationUpdate,
    ProjectAutomationView,
)


def _base_create() -> dict[str, object]:
    return {
        "name": "Board automation",
        "prompt": "Dispatch the project work.",
        "cronExpression": "0 3 * * *",
        "targetKind": "agent",
        "targetId": "agent-1",
    }


def test_create_requires_explicit_dispatch_target() -> None:
    values = _base_create()
    values.pop("targetId")

    with pytest.raises(ValidationError, match="targetId"):
        ProjectAutomationCreate.model_validate(values)


def test_create_rejects_removed_manager_contract() -> None:
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        ProjectAutomationCreate.model_validate(
            {
                **_base_create(),
                "assignmentMode": "ai_managed",
                "managerType": "custom",
            }
        )


def test_human_target_rejects_execution_device() -> None:
    with pytest.raises(ValidationError, match="human targets"):
        ProjectAutomationCreate.model_validate(
            {
                **_base_create(),
                "targetKind": "human",
                "targetId": "42",
                "executionDeviceId": "device-b",
            }
        )


def test_partial_update_does_not_require_target_change() -> None:
    update = ProjectAutomationUpdate.model_validate({"version": 2, "enabled": False})

    assert update.target_kind is None
    assert update.target_id is None


def test_partial_update_requires_target_pair() -> None:
    with pytest.raises(ValidationError, match="must be changed together"):
        ProjectAutomationUpdate.model_validate({"version": 2, "targetKind": "agent"})


def test_workflow_trigger_accepts_explicit_target_without_schedule_fields() -> None:
    value = ProjectAutomationCreate.model_validate(
        {
            "name": "Workflow · Development robot",
            "prompt": "Use the workflow stage prompt.",
            "triggerType": "workflow",
            "eventType": None,
            "cronExpression": None,
            "targetKind": "agent",
            "targetId": "agent-1",
        }
    )

    assert value.trigger_type == "workflow"
    assert value.cron_expression is None


def test_views_accept_explicit_target_and_queued_run() -> None:
    now = datetime(2026, 9, 25)
    rule = ProjectAutomationView.model_validate(
        {
            "id": "rule-1",
            "projectId": "project-1",
            "name": "Agent rule",
            "prompt": "Dispatch work.",
            "triggerType": "schedule",
            "eventType": None,
            "eventConfig": {},
            "cronExpression": "0 3 * * *",
            "timezone": "Asia/Shanghai",
            "executionDeviceId": None,
            "targetKind": "agent",
            "targetId": "agent-1",
            "targetName": "Agent one",
            "enabled": True,
            "nextRunAt": now,
            "lastRunAt": None,
            "lastRunStatus": "queued",
            "version": 1,
            "createdAt": now,
            "updatedAt": now,
        }
    )
    run = ProjectAutomationRunView.model_validate(
        {
            "id": "run-1",
            "automationId": rule.id,
            "projectId": rule.project_id,
            "trigger": "scheduled",
            "status": "queued",
            "timezone": rule.timezone,
            "scheduledFor": now,
            "expiresAt": None,
            "taskId": None,
            "deviceId": None,
            "error": None,
            "createdAt": now,
            "updatedAt": now,
        }
    )

    assert rule.target_kind == "agent"
    assert rule.target_id == "agent-1"
    assert run.status == "queued"
