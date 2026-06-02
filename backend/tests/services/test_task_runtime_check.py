from datetime import datetime

from app.schemas.task import (
    TaskRuntimeActiveStream,
    TaskRuntimeCheck,
    TaskStatus,
)


def test_runtime_check_schema_excludes_message_body():
    response = TaskRuntimeCheck(
        task_id=42,
        task_status=TaskStatus.RUNNING,
        status_updated_at=datetime(2026, 6, 1, 10, 0, 0),
        active_stream=TaskRuntimeActiveStream(
            subtask_id=77,
            cursor=128,
            last_activity_at=datetime(2026, 6, 1, 10, 0, 3),
        ),
    ).model_dump(mode="json")

    assert response["task_id"] == 42
    assert response["task_status"] == "RUNNING"
    assert response["active_stream"]["subtask_id"] == 77
    assert response["active_stream"]["cursor"] == 128
    assert "content" not in response["active_stream"]
    assert "messages" not in response
    assert "subtasks" not in response


def test_runtime_check_schema_allows_no_active_stream():
    response = TaskRuntimeCheck(
        task_id=42,
        task_status=TaskStatus.COMPLETED,
        status_updated_at=datetime(2026, 6, 1, 10, 0, 0),
        active_stream=None,
    ).model_dump(mode="json")

    assert response["task_status"] == "COMPLETED"
    assert response["active_stream"] is None
