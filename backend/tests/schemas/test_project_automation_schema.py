# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Schema tests for the project automation executor contract."""

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
        "prompt": "Handle the current board event.",
        "cronExpression": "0 3 * * *",
    }


@pytest.mark.parametrize(
    "executor",
    [
        {"executorType": "project_robot", "agentId": "agent-1"},
        {
            "executorType": "custom",
            "model": "model-a",
            "executionEnvironment": "local",
            "executionDeviceId": "device-a",
        },
        {"executorType": "wegent_robot", "wegentTeamId": 42},
    ],
)
def test_create_accepts_exactly_one_executor_source(
    executor: dict[str, object],
) -> None:
    value = ProjectAutomationCreate.model_validate({**_base_create(), **executor})

    assert value.executor_type == executor["executorType"]


@pytest.mark.parametrize(
    "legacy_field,legacy_value",
    [
        ("assignmentMode", "automatic"),
        ("wegentTeamName", "shared-agent"),
        ("wegentTeamNamespace", "default"),
    ],
)
def test_create_rejects_removed_executor_fields(
    legacy_field: str,
    legacy_value: str,
) -> None:
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        ProjectAutomationCreate.model_validate(
            {
                **_base_create(),
                "agentId": "agent-1",
                legacy_field: legacy_value,
            }
        )


def test_create_rejects_fields_from_another_executor_source() -> None:
    with pytest.raises(
        ValidationError, match="inline AI configuration is only valid for custom AI"
    ):
        ProjectAutomationCreate.model_validate(
            {
                **_base_create(),
                "executorType": "wegent_robot",
                "wegentTeamId": 42,
                "model": "model-a",
                "executionEnvironment": "local",
                "executionDeviceId": "device-a",
            }
        )


def test_partial_update_does_not_require_resending_executor_config() -> None:
    update = ProjectAutomationUpdate.model_validate({"version": 2, "enabled": False})

    assert update.executor_type is None


def test_partial_update_requires_executor_type_when_changing_its_config() -> None:
    with pytest.raises(ValidationError, match="executor_type is required"):
        ProjectAutomationUpdate.model_validate(
            {"version": 2, "executionDeviceId": "device-b"}
        )


def test_switching_executor_requires_the_new_source_config() -> None:
    with pytest.raises(ValidationError, match="wegent_team_id is required"):
        ProjectAutomationUpdate.model_validate(
            {"version": 2, "executorType": "wegent_robot"}
        )


def test_views_accept_managed_wegent_environment_and_queued_run() -> None:
    now = datetime(2026, 8, 13)
    rule = ProjectAutomationView.model_validate(
        {
            "id": "rule-1",
            "projectId": "project-1",
            "name": "Wegent rule",
            "prompt": "Handle it.",
            "triggerType": "schedule",
            "eventType": None,
            "eventConfig": {},
            "executorType": "wegent_robot",
            "webhookEventId": None,
            "cronExpression": "0 3 * * *",
            "timezone": "Asia/Shanghai",
            "agentId": None,
            "wegentTeamId": 42,
            "model": None,
            "agentName": "Shared robot",
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

    assert rule.execution_environment == "managed"
    assert run.status == "queued"
