from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.delivery import loop_unset_datetime_for_connection
from app.services.project_automations import _next_run, project_automation_service


def test_next_run_respects_rule_timezone():
    result = _next_run(
        "0 3 * * *",
        "Asia/Shanghai",
        datetime(2026, 8, 11, 0, 0),
    )

    assert result == datetime(2026, 8, 11, 19, 0)


@pytest.mark.parametrize("expression", ["", "not-a-cron", "0 3 *"])
def test_next_run_rejects_invalid_cron(expression: str):
    with pytest.raises(HTTPException) as exc_info:
        _next_run(expression, "UTC", datetime(2026, 8, 11, 0, 0))

    assert exc_info.value.status_code == 422


def test_next_run_rejects_unknown_timezone():
    with pytest.raises(HTTPException) as exc_info:
        _next_run("0 3 * * *", "Mars/Olympus", datetime(2026, 8, 11, 0, 0))

    assert exc_info.value.status_code == 422


def test_nullable_schema_uses_null_for_unset_due_at(test_db):
    assert loop_unset_datetime_for_connection(test_db.connection(), "due_at") is None


@pytest.mark.parametrize(
    ("status", "description", "expected_error"),
    [
        ("succeeded", "Completed result", None),
        ("cancelled", "Run cancelled.", None),
        ("failed", "Model is unavailable", "Model is unavailable"),
    ],
)
def test_run_view_exposes_only_failure_descriptions_as_errors(
    status: str, description: str, expected_error: str | None
):
    now = datetime(2026, 8, 14, 0, 0)
    row = SimpleNamespace(
        id="run-1",
        parent_id="rule-1",
        cloud_project_id="project-1",
        source="manual",
        status=status,
        task_id="task-1",
        backend_task_id=None,
        device_id="local-device",
        description=description,
        created_at=now,
        updated_at=now,
        completed_at=now,
        metadata_json={"scheduled_for": now.isoformat(), "timezone": "Asia/Shanghai"},
    )

    result = project_automation_service._run_view(row)

    assert result["error"] == expected_error
