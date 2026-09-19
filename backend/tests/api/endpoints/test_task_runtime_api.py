import threading
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI

from app.api.dependencies import get_db
from app.api.endpoints.adapter import task_runtime, tasks
from app.core import security
from app.models.task import TaskResource


@pytest.fixture
def runtime_app(test_db):
    test_db.add(
        TaskResource(
            id=42,
            user_id=10,
            kind="Task",
            name="checkpoint",
            namespace="default",
            json={
                "status": {
                    "status": "RUNNING",
                    "updatedAt": "2026-09-18T11:50:00",
                    "result": {"messages_chain": ["private content"]},
                }
            },
            updated_at=datetime(2026, 9, 18, 11, 51),
        )
    )
    test_db.flush()
    app = FastAPI()
    app.include_router(tasks.router, prefix="/api/tasks")
    app.dependency_overrides[get_db] = lambda: test_db
    app.dependency_overrides[security.get_current_user] = lambda: SimpleNamespace(id=10)
    return app


@pytest.mark.parametrize(
    "stream,expected",
    [
        (None, None),
        ({"subtask_id": None}, None),
        (
            {"subtask_id": "77", "last_activity_at": "2026-09-18T11:50:01"},
            {"subtask_id": 77, "cursor": 3, "last_activity_at": "2026-09-18T11:50:01"},
        ),
    ],
)
async def test_runtime_api_preserves_checkpoint_and_runs_db_off_loop(
    runtime_app, monkeypatch, stream, expected
):
    storage = SimpleNamespace(
        get_task_streaming_status=AsyncMock(return_value=stream),
        get_streaming_content=AsyncMock(return_value="你🙂a"),
    )
    monkeypatch.setattr(task_runtime, "session_manager", storage)
    original = task_runtime.task_access_store.get_runtime_state
    worker_threads = []

    def observe_thread(*args, **kwargs):
        worker_threads.append(threading.get_ident())
        return original(*args, **kwargs)

    monkeypatch.setattr(
        task_runtime.task_access_store, "get_runtime_state", observe_thread
    )
    loop_thread = threading.get_ident()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=runtime_app), base_url="http://test"
    ) as client:
        response = await client.get("/api/tasks/42/runtime-check")

    assert response.status_code == 200
    assert response.json() == {
        "task_id": 42,
        "task_status": "RUNNING",
        "status_updated_at": "2026-09-18T11:50:00",
        "active_stream": expected,
    }
    assert len(worker_threads) == 1
    assert worker_threads[0] != loop_thread
    storage.get_task_streaming_status.assert_awaited_once_with(42)
    if expected is None:
        storage.get_streaming_content.assert_not_awaited()
    else:
        storage.get_streaming_content.assert_awaited_once_with(77)


@pytest.mark.parametrize("task_id,user_id", [(42, 20), (999, 10)])
async def test_runtime_api_denies_access_before_reading_stream(
    runtime_app, monkeypatch, task_id, user_id
):
    runtime_app.dependency_overrides[security.get_current_user] = (
        lambda: SimpleNamespace(id=user_id)
    )
    storage = SimpleNamespace(get_task_streaming_status=AsyncMock())
    monkeypatch.setattr(task_runtime, "session_manager", storage)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=runtime_app), base_url="http://test"
    ) as client:
        response = await client.get(f"/api/tasks/{task_id}/runtime-check")
    assert response.status_code == 404
    assert response.json() == {"detail": "Task not found"}
    storage.get_task_streaming_status.assert_not_awaited()
