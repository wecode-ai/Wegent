# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import threading
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from executor_manager.routers import routers
from shared.telemetry.context import copy_context_vars


class DirectCancelExecutor:
    def __init__(self) -> None:
        self.requested_executor_name: str | None = None

    def _get_container_port(self, executor_name: str) -> tuple[int, None]:
        self.requested_executor_name = executor_name
        return 10005, None

    def cancel_task(self, task_id: int, subtask_id: int | None = None) -> dict:
        raise AssertionError("Known executors must not use task discovery")


class DiscoveryCancelExecutor:
    def __init__(self) -> None:
        self.cancelled_task: tuple[int, int | None] | None = None

    def _get_container_port(self, executor_name: str) -> tuple[int, None]:
        raise AssertionError("Empty executor names must use task discovery")

    def cancel_task(self, task_id: int, subtask_id: int | None = None) -> dict:
        self.cancelled_task = (task_id, subtask_id)
        return {
            "status": "success",
            "task_id": task_id,
            "subtask_id": subtask_id,
        }


@pytest.mark.asyncio
async def test_v1_cancel_uses_known_executor_directly(mocker) -> None:
    executor = DirectCancelExecutor()
    mocker.patch.object(
        routers.ExecutorDispatcher,
        "get_executor",
        return_value=executor,
    )
    mocker.patch.object(
        routers,
        "_cleanup_task_heartbeat",
        AsyncMock(),
    )

    response = MagicMock()
    client = AsyncMock()
    client.__aenter__.return_value = client
    client.post.return_value = response
    mocker.patch.object(
        routers,
        "traced_async_client",
        return_value=client,
    )

    result = await routers.cancel_task_v1(
        request=routers.CancelRequest(
            task_id=101,
            subtask_id=55,
            executor_name="wegent-task-test",
        ),
        http_request=SimpleNamespace(client=SimpleNamespace(host="127.0.0.1")),
    )

    assert result["status"] == "success"
    assert result["executor_name"] == "wegent-task-test"
    assert executor.requested_executor_name == "wegent-task-test"
    client.post.assert_awaited_once_with(
        f"http://{routers.DEFAULT_DOCKER_HOST}:10005"
        "/api/tasks/cancel?task_id=101&subtask_id=55"
    )


@pytest.mark.asyncio
async def test_v1_cancel_discovers_executor_when_name_is_empty(mocker) -> None:
    executor = DiscoveryCancelExecutor()
    mocker.patch.object(
        routers.ExecutorDispatcher,
        "get_executor",
        return_value=executor,
    )
    mocker.patch.object(
        routers,
        "_cleanup_task_heartbeat",
        AsyncMock(),
    )

    result = await routers.cancel_task_v1(
        request=routers.CancelRequest(
            task_id=101,
            subtask_id=55,
            executor_name="",
        ),
        http_request=SimpleNamespace(client=SimpleNamespace(host="127.0.0.1")),
    )

    assert result["status"] == "success"
    assert executor.cancelled_task == (101, 55)


class GatedCancelExecutor:
    def __init__(self, outcome: dict[str, Any] | Exception) -> None:
        self.outcome = outcome
        self.entered = threading.Event()
        self.release = threading.Event()
        self.requested_task: tuple[int, int | None] | None = None
        self.worker_thread_id: int | None = None
        self.context: dict[str, Any] = {}

    def cancel_task(self, task_id: int, subtask_id: int | None = None) -> dict:
        self.requested_task = (task_id, subtask_id)
        self.worker_thread_id = threading.get_ident()
        self.context = copy_context_vars()
        self.entered.set()
        if not self.release.wait(timeout=5):
            raise TimeoutError("Cancellation gate was not released")
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome

    def get_container_address(
        self, executor_name: str, executor_namespace: str | None = None
    ) -> dict[str, str]:
        return {"status": "success", "base_url": f"http://{executor_name}.local:8000"}


@pytest.fixture
def legacy_cancel_cleanup(mocker):
    heartbeat = SimpleNamespace(delete_heartbeat=AsyncMock())
    tracker = MagicMock()
    mocker.patch(
        "executor_manager.services.heartbeat_manager.get_heartbeat_manager",
        return_value=heartbeat,
    )
    mocker.patch(
        "executor_manager.services.task_heartbeat_manager.get_running_task_tracker",
        return_value=tracker,
    )
    return heartbeat, tracker


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("outcome", "status_code", "expected"),
    [
        (
            {"status": "success", "task_id": 101, "subtask_id": 55},
            200,
            {"status": "success", "task_id": 101, "subtask_id": 55},
        ),
        (
            {"status": "failed", "error_msg": "Cancellation rejected"},
            400,
            {"detail": "Cancellation rejected"},
        ),
        (RuntimeError("Executor unavailable"), 500, {"detail": "Executor unavailable"}),
    ],
    ids=["success", "rejected", "exception"],
)
async def test_legacy_cancel_keeps_executor_address_available_while_pending(
    mocker, legacy_cancel_cleanup, outcome, status_code, expected
) -> None:
    executor = GatedCancelExecutor(outcome)
    mocker.patch.object(
        routers.ExecutorDispatcher, "get_executor", return_value=executor
    )
    heartbeat, tracker = legacy_cancel_cleanup
    transport = httpx.ASGITransport(app=routers.app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://manager"
    ) as client:
        cancellation = asyncio.create_task(
            client.post(
                "/executor-manager/tasks/cancel",
                json={"task_id": 101, "subtask_id": 55},
                headers={"X-Request-ID": "cancel-concurrency-regression"},
            )
        )
        try:
            assert await asyncio.to_thread(executor.entered.wait, 5)
            address = await client.get(
                "/executor-manager/executor/address",
                params={"executor_name": "artifact-executor"},
            )
            assert address.status_code == 200
            assert address.json() == {
                "status": "success",
                "base_url": "http://artifact-executor.local:8000",
            }
            assert (
                not cancellation.done()
            ), "Address lookup must not wait for cancellation"
            assert not executor.release.is_set()
            assert executor.worker_thread_id != threading.get_ident()
            assert executor.requested_task == (101, 55)
            assert executor.context["task_id"] == 101
            assert executor.context["subtask_id"] == 55
            assert executor.context["request_id"] == "cancel-concurrency-regression"
            heartbeat.delete_heartbeat.assert_not_awaited()
            tracker.remove_running_task.assert_not_called()
        finally:
            executor.release.set()
            cancelled = await cancellation

    assert cancelled.status_code == status_code
    assert cancelled.json() == expected
    if status_code == 200:
        from executor_manager.services.heartbeat_manager import HeartbeatType

        heartbeat.delete_heartbeat.assert_awaited_once_with("101", HeartbeatType.TASK)
        tracker.remove_running_task.assert_called_once_with(101)
    else:
        heartbeat.delete_heartbeat.assert_not_awaited()
        tracker.remove_running_task.assert_not_called()
