# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Schema tests for board assignment strategies and AI managers."""

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
        "prompt": "Choose the best project robot.",
        "cronExpression": "0 3 * * *",
    }


@pytest.mark.parametrize(
    ("configuration", "mode", "manager"),
    [
        ({"assignmentMode": "manual", "agentId": "agent-1"}, "manual", None),
        (
            {
                "assignmentMode": "ai_managed",
                "managerType": "custom",
                "runtimeSource": "fixed_profile",
                "runtimeProfileId": "runtime-1",
            },
            "ai_managed",
            "custom",
        ),
        (
            {
                "assignmentMode": "ai_managed",
                "managerType": "wegent",
                "wegentTeamId": 42,
            },
            "ai_managed",
            "wegent",
        ),
    ],
)
def test_create_accepts_two_assignment_modes_and_two_manager_sources(
    configuration: dict[str, object], mode: str, manager: str | None
) -> None:
    value = ProjectAutomationCreate.model_validate({**_base_create(), **configuration})

    assert value.assignment_mode == mode
    assert value.manager_type == manager


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("executorType", "custom"),
        ("wegentTeamName", "shared-agent"),
        ("wegentTeamNamespace", "default"),
    ],
)
def test_create_rejects_removed_executor_contract(field: str, value: str) -> None:
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        ProjectAutomationCreate.model_validate(
            {
                **_base_create(),
                "assignmentMode": "manual",
                "agentId": "agent-1",
                field: value,
            }
        )


def test_manual_assignment_rejects_manager_configuration() -> None:
    with pytest.raises(ValidationError, match="manager_type is only valid"):
        ProjectAutomationCreate.model_validate(
            {
                **_base_create(),
                "assignmentMode": "manual",
                "managerType": "custom",
                "agentId": "agent-1",
            }
        )


def test_partial_update_does_not_require_assignment_configuration() -> None:
    update = ProjectAutomationUpdate.model_validate({"version": 2, "enabled": False})

    assert update.assignment_mode is None


def test_workflow_trigger_accepts_a_robot_profile_without_schedule_fields() -> None:
    value = ProjectAutomationCreate.model_validate(
        {
            "name": "Workflow · Development robot",
            "prompt": "Use the workflow stage prompt.",
            "triggerType": "workflow",
            "eventType": None,
            "cronExpression": None,
            "assignmentMode": "manual",
            "agentId": "agent-1",
        }
    )

    assert value.trigger_type == "workflow"
    assert value.cron_expression is None


def test_partial_update_requires_mode_when_changing_manager_configuration() -> None:
    with pytest.raises(ValidationError, match="assignment_mode is required"):
        ProjectAutomationUpdate.model_validate(
            {"version": 2, "executionDeviceId": "device-b"}
        )


def test_ai_managed_requires_manager_source() -> None:
    with pytest.raises(ValidationError, match="manager_type is required"):
        ProjectAutomationUpdate.model_validate(
            {"version": 2, "assignmentMode": "ai_managed"}
        )


def test_views_accept_managed_wegent_environment_and_queued_run() -> None:
    now = datetime(2026, 8, 13)
    rule = ProjectAutomationView.model_validate(
        {
            "id": "rule-1",
            "projectId": "project-1",
            "name": "Wegent manager rule",
            "prompt": "Choose a robot.",
            "triggerType": "schedule",
            "eventType": None,
            "eventConfig": {},
            "assignmentMode": "ai_managed",
            "managerType": "wegent",
            "webhookEventId": None,
            "cronExpression": "0 3 * * *",
            "timezone": "Asia/Shanghai",
            "agentId": None,
            "wegentTeamId": 42,
            "model": None,
            "agentName": "Shared agent",
            "executionEnvironment": "managed",
            "executionDeviceId": None,
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

    assert rule.manager_type == "wegent"
    assert rule.execution_environment == "managed"
    assert run.status == "queued"
