"""Tests for the Wework runtime automation API helpers."""

from datetime import datetime, timezone
from types import SimpleNamespace

from app.api.endpoints.runtime_automations import (
    _run_response,
    _subscription_schedule,
)
from app.schemas.runtime_automation import RuntimeAutomationMutation
from app.schemas.subscription import SubscriptionTriggerType


def _mutation(schedule: dict) -> RuntimeAutomationMutation:
    return RuntimeAutomationMutation.model_validate(
        {
            "source": "cloud",
            "name": "Daily brief",
            "prompt": "Summarize the project",
            "schedule": schedule,
            "timezone": "Asia/Shanghai",
            "enabled": True,
            "conversationMode": "independent",
            "taskRequest": {
                "deviceId": "cloud-device",
                "workspacePath": "/workspace",
                "teamId": 1,
                "runtime": "codex",
                "message": "Summarize the project",
            },
        }
    )


def test_one_time_schedule_is_serialized_for_subscription_helper():
    mutation = _mutation(
        {
            "type": "one_time",
            "executeAt": "2026-07-29T01:00:00Z",
        }
    )

    trigger_type, config = _subscription_schedule(mutation)

    assert trigger_type == SubscriptionTriggerType.ONE_TIME
    assert config == {"execute_at": "2026-07-29T01:00:00+00:00"}


def test_completed_execution_is_normalized_to_succeeded():
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    execution = SimpleNamespace(
        id=9,
        subscription_id=3,
        scheduled_for=now,
        created_at=now,
        updated_at=now,
        trigger_type="manual",
        status="COMPLETED",
        runtime_task_id="task-1",
        runtime_device_id="cloud-device",
        error_message="",
    )

    response = _run_response(execution)

    assert response.status == "succeeded"
    assert response.automation_id == "cloud:3"
