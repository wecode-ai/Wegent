# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from executor_manager.routers import routers


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
