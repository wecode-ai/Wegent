# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import json
from unittest.mock import AsyncMock, Mock, patch

import httpx
import pytest

from executor_manager.clients import executor_binding
from executor_manager.executors.docker.executor import DockerExecutor
from executor_manager.routers.routers import openai_responses

TOKEN = "test-dispatch-credential"


@pytest.mark.parametrize("status", [200, 409])
def test_ready_container_requires_binding_before_dispatch(status):
    metadata = {
        "task_id": 42,
        "subtask_id": 43,
        "executor_binding_token": TOKEN,
    }
    task = {"metadata": metadata}
    dispatch = Mock(return_value={"status": "success"})
    executor = Mock(_dispatch_initial_task_to_new_container=dispatch)
    binding_requests: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        binding_requests.append(request)
        assert request.url.path == "/api/internal/tasks/42/subtasks/43/executor-binding"
        assert request.headers["authorization"] == f"Bearer {TOKEN}"
        assert json.loads(request.content) == {
            "executor_name": "executor-1",
            "executor_namespace": "",
        }
        dispatch.assert_not_called()
        return httpx.Response(status, json={"status": "bound"} if status == 200 else {})

    with patch.object(
        executor_binding,
        "traced_sync_client",
        return_value=httpx.Client(transport=httpx.MockTransport(handle)),
    ):
        if status == 200:
            assert DockerExecutor.dispatch_task_to_instance(
                executor, task, "executor-1", {"port": 8080}
            ) == {"status": "success"}
            dispatch.assert_called_once_with(
                {"metadata": {"task_id": 42, "subtask_id": 43}}, "executor-1", 8080
            )
        else:
            with pytest.raises(
                RuntimeError, match="Executor binding failed with HTTP 409"
            ):
                DockerExecutor.dispatch_task_to_instance(
                    executor, task, "executor-1", {"port": 8080}
                )
            dispatch.assert_not_called()

    assert len(binding_requests) == 1
    assert task["metadata"]["executor_binding_token"] == TOKEN


@pytest.mark.parametrize(
    ("authorization", "expected"),
    [(f"WegentExecutorBinding {TOKEN}", TOKEN), ("Bearer dummy", None)],
)
async def test_enqueue_accepts_binding_credential_only_from_dispatch_header(
    authorization, expected
):
    incoming = Mock(
        body=AsyncMock(
            return_value=json.dumps(
                {
                    "metadata": {
                        "task_id": 42,
                        "subtask_id": 43,
                        "executor_binding_token": "body",
                    }
                }
            ).encode()
        ),
        headers={"Authorization": authorization},
    )

    with patch(
        "executor_manager.services.task_queue_service.TaskQueueService"
    ) as queue:
        await openai_responses(incoming)

    queued = queue.return_value.enqueue_task.call_args.args[0]
    assert queued["metadata"].get("executor_binding_token") == expected
