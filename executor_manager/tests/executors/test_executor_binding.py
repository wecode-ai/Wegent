# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import json
from unittest.mock import Mock, patch

import httpx
import pytest

from executor_manager.clients import executor_binding
from executor_manager.executors.docker.executor import DockerExecutor
from executor_manager.routers.routers import app

TOKEN = "test-dispatch-credential"


@pytest.mark.parametrize("status", [200, 409])
def test_ready_container_requires_binding_before_dispatch(status):
    metadata = {
        "task_id": 42,
        "subtask_id": 43,
        "executor_binding_token": TOKEN,
        "executor_callback_token": "callback-token",
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

    with (
        patch.object(
            executor_binding,
            "traced_sync_client",
            return_value=httpx.Client(transport=httpx.MockTransport(handle)),
        ),
        patch(
            "executor_manager.services.sandbox.repository.get_sandbox_repository"
        ) as repository_factory,
    ):
        repository = repository_factory.return_value
        repository.load_executor_callback_token.return_value = "callback-token"
        if status == 200:
            assert DockerExecutor.dispatch_task_to_instance(
                executor, task, "executor-1", {"port": 8080}
            ) == {"status": "success"}
            dispatch.assert_called_once_with(
                {
                    "metadata": {
                        "task_id": 42,
                        "subtask_id": 43,
                    }
                },
                "executor-1",
                8080,
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
    repository.save_executor_binding.assert_not_called()


@pytest.mark.parametrize(
    ("authorization", "internal_authorization", "expected_credential", "expected"),
    [
        (f"WegentExecutorBinding {TOKEN}", "Bearer service-token", TOKEN, 200),
        ("Bearer service-token", None, None, 200),
        (f"WegentExecutorBinding {TOKEN}", "Bearer wrong-token", None, 401),
        (f"WegentExecutorBinding {TOKEN}", None, None, 401),
        (None, None, None, 401),
    ],
)
@pytest.mark.asyncio
async def test_enqueue_requires_service_auth_and_accepts_binding_only_from_dispatch_header(
    authorization, internal_authorization, expected_credential, expected, monkeypatch
):
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "service-token")
    headers = {}
    if authorization:
        headers["Authorization"] = authorization
    if internal_authorization:
        headers["X-Wegent-Internal-Authorization"] = internal_authorization

    with patch(
        "executor_manager.services.task_queue_service.TaskQueueService"
    ) as queue:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://manager.example"
        ) as client:
            response = await client.post(
                "/executor-manager/v1/responses",
                headers=headers,
                json={
                    "metadata": {
                        "task_id": 42,
                        "subtask_id": 43,
                        "backend_url": "https://backend.example/api",
                        "executor_binding_token": "body",
                        "executor_callback_token": "body",
                        "callback_url": "https://callback.example/",
                    }
                },
            )

    assert response.status_code == expected
    if expected == 401:
        queue.assert_not_called()
        return
    queued = queue.return_value.enqueue_task.call_args.args[0]
    assert queued["metadata"].get("executor_binding_token") == expected_credential
    assert queued["metadata"]["backend_url"] == "https://backend.example/api"
    assert "executor_callback_token" not in queued["metadata"]
    assert "callback_url" not in queued["metadata"]


@pytest.mark.parametrize("request_id", ["new-turn", "pipeline-42-43"])
@pytest.mark.parametrize(
    "backend_context",
    [
        {},
        {"backend_url": None},
        {"backend_url": ""},
        {"backend_url": " \t\n"},
        {"backend_url": "https://backend.example/deployment/api/"},
    ],
)
@pytest.mark.asyncio
async def test_responses_preserve_optional_backend_context_for_each_queue(
    request_id: str, backend_context: dict[str, object], monkeypatch
) -> None:
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "service-token")
    metadata = {
        "task_id": 42,
        "subtask_id": 43,
        "request_id": request_id,
        **backend_context,
    }
    with patch(
        "executor_manager.services.task_queue_service.TaskQueueService"
    ) as queue:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://manager.example"
        ) as client:
            response = await client.post(
                "/executor-manager/v1/responses",
                headers={"Authorization": "Bearer service-token"},
                json={"model": "test-model", "input": "hello", "metadata": metadata},
            )

    assert response.status_code == 200
    assert response.json()["status"] == "queued"
    enqueue, unused_enqueue = (
        (queue.return_value.enqueue_pipeline_task, queue.return_value.enqueue_task)
        if request_id.startswith("pipeline-")
        else (queue.return_value.enqueue_task, queue.return_value.enqueue_pipeline_task)
    )
    enqueue.assert_called_once()
    unused_enqueue.assert_not_called()
    assert enqueue.call_args.args[0]["metadata"] == metadata


@pytest.mark.parametrize(
    "binding",
    [
        {"executor_name": "executor-1", "callback_token": "callback-token"},
        {"executor_name": "executor-replacement", "callback_token": "callback-token"},
        None,
    ],
)
def test_legacy_dispatch_requires_a_prepared_callback_credential(binding):
    from executor_manager.services.sandbox.repository import SandboxRepository

    task = {
        "metadata": {
            "task_id": 42,
            "subtask_id": 43,
            "executor_callback_token": "callback-token",
        }
    }
    dispatch = Mock(return_value={"status": "success"})
    executor = Mock(_dispatch_initial_task_to_new_container=dispatch)
    repository = Mock(load_executor_binding_full=Mock(return_value=binding))
    repository.load_executor_callback_token = (
        SandboxRepository.load_executor_callback_token.__get__(repository)
    )

    with patch(
        "executor_manager.services.sandbox.repository.get_sandbox_repository",
        return_value=repository,
    ):
        if binding and binding["executor_name"] == "executor-1":
            assert DockerExecutor.dispatch_task_to_instance(
                executor, task, "executor-1", {"port": 8080}
            ) == {"status": "success"}
            dispatched_task = dispatch.call_args.args[0]
            assert dispatched_task == {"metadata": {"task_id": 42, "subtask_id": 43}}
        else:
            with pytest.raises(
                RuntimeError, match="no callback credential provisioned"
            ):
                DockerExecutor.dispatch_task_to_instance(
                    executor, task, "executor-1", {"port": 8080}
                )
            dispatch.assert_not_called()

    repository.save_executor_binding.assert_not_called()
