from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.api.endpoints.adapter import tasks as task_endpoints
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


@pytest.mark.asyncio
async def test_runtime_check_uses_active_streaming_fallback(monkeypatch):
    """runtime-check should recover active streams through the shared helper."""
    monkeypatch.setattr(
        task_endpoints.task_kinds_service,
        "get_task_by_id",
        lambda db, task_id, user_id: {
            "id": task_id,
            "status": "RUNNING",
            "updated_at": datetime(2026, 6, 1, 10, 0, 0),
        },
    )
    get_active_streaming = AsyncMock(
        return_value={
            "subtask_id": 77,
            "user_id": 7,
            "started_at": "2026-06-01T10:00:00",
        }
    )
    monkeypatch.setattr(
        task_endpoints,
        "get_active_streaming",
        get_active_streaming,
    )
    monkeypatch.setattr(
        task_endpoints.session_manager,
        "get_streaming_content",
        AsyncMock(return_value="running output"),
    )

    response = await task_endpoints.get_task_runtime_check(
        task_id=42,
        current_user=SimpleNamespace(id=7),
        db=object(),
    )

    get_active_streaming.assert_awaited_once_with(42)
    assert response.active_stream is not None
    assert response.active_stream.subtask_id == 77
    assert response.active_stream.cursor == len("running output")
    assert response.active_stream.last_activity_at is None
