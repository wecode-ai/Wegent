# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from executor_manager.wecode import routers as wecode_routers


class DeleteByTaskIdExecutor:
    def get_executor_task_id(self, executor_name):
        return None

    def delete_executor(self, executor_name, executor_namespace=None):
        return {"status": "success"}

    def delete_executor_by_task_id(self, task_id):
        return {"status": "success", "deleted_pods": [f"wegent-task-{task_id}-abc"]}


class DeleteByTaskIdNotFoundExecutor:
    def delete_executor_by_task_id(self, task_id):
        return {
            "status": "not_found",
            "error_msg": f"No pod found with task_id '{task_id}'",
        }


class NoDeleteByTaskIdExecutor:
    def delete_executor(self, executor_name, executor_namespace=None):
        return {"status": "success"}


class DeletePodByNameExecutor:
    def delete_executor(self, pod_name, executor_namespace=None):
        return {"status": "success"}


class OldTaskIdsExecutor:
    def get_old_task_ids(self, older_than_hours: int = 48):
        return {
            "status": "success",
            "pods": [
                {
                    "task_id": "100",
                    "pod_name": "wegent-task-100-aaa",
                    "runtime_type": "executor",
                },
                {
                    "task_id": "200",
                    "pod_name": "wegent-task-200-bbb",
                    "runtime_type": "executor",
                },
                {
                    "task_id": None,
                    "pod_name": "sandbox-unlabeled-ccc",
                    "runtime_type": "sandbox",
                },
                {
                    "task_id": "300",
                    "pod_name": "sandbox-300-xyz",
                    "runtime_type": "sandbox",
                },
            ],
        }


class NoOldTaskIdsExecutor:
    def delete_executor(self, executor_name, executor_namespace=None):
        return {"status": "success"}


@pytest.mark.asyncio
async def test_delete_executor_by_task_id_success(mocker):
    http_request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
    mocker.patch.object(
        wecode_routers.ExecutorDispatcher,
        "get_executor",
        return_value=DeleteByTaskIdExecutor(),
    )

    result = await wecode_routers.delete_executor_by_task_id(
        request=wecode_routers.DeleteExecutorByTaskIdRequest(task_id=1234),
        http_request=http_request,
    )

    assert result["status"] == "success"
    assert result["deleted_pods"] == ["wegent-task-1234-abc"]


@pytest.mark.asyncio
async def test_delete_executor_by_task_id_not_found(mocker):
    http_request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
    mocker.patch.object(
        wecode_routers.ExecutorDispatcher,
        "get_executor",
        return_value=DeleteByTaskIdNotFoundExecutor(),
    )

    result = await wecode_routers.delete_executor_by_task_id(
        request=wecode_routers.DeleteExecutorByTaskIdRequest(task_id=9999),
        http_request=http_request,
    )

    assert result["status"] == "not_found"


@pytest.mark.asyncio
async def test_delete_executor_by_task_id_unsupported_executor(mocker):
    http_request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
    mocker.patch.object(
        wecode_routers.ExecutorDispatcher,
        "get_executor",
        return_value=NoDeleteByTaskIdExecutor(),
    )

    with pytest.raises(HTTPException) as exc_info:
        await wecode_routers.delete_executor_by_task_id(
            request=wecode_routers.DeleteExecutorByTaskIdRequest(task_id=1234),
            http_request=http_request,
        )

    assert exc_info.value.status_code == 501


@pytest.mark.asyncio
async def test_delete_pod_by_name_success(mocker):
    http_request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
    mocker.patch.object(
        wecode_routers.ExecutorDispatcher,
        "get_executor",
        return_value=DeletePodByNameExecutor(),
    )

    result = await wecode_routers.delete_pod_by_name(
        request=wecode_routers.DeletePodByNameRequest(pod_name="wegent-task-999-xyz"),
        http_request=http_request,
    )

    assert result["status"] == "success"


@pytest.mark.asyncio
async def test_delete_pod_by_name_with_namespace(mocker):
    http_request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
    calls = []

    class TrackingExecutor:
        def delete_executor(self, pod_name, executor_namespace=None):
            calls.append(
                {"pod_name": pod_name, "executor_namespace": executor_namespace}
            )
            return {"status": "success"}

    mocker.patch.object(
        wecode_routers.ExecutorDispatcher,
        "get_executor",
        return_value=TrackingExecutor(),
    )

    await wecode_routers.delete_pod_by_name(
        request=wecode_routers.DeletePodByNameRequest(
            pod_name="sandbox-abc",
            executor_namespace="wb-plat-ide",
        ),
        http_request=http_request,
    )

    assert calls[0]["pod_name"] == "sandbox-abc"
    assert calls[0]["executor_namespace"] == "wb-plat-ide"


@pytest.mark.asyncio
async def test_get_old_task_ids_returns_pods(mocker):
    http_request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
    mocker.patch.object(
        wecode_routers.ExecutorDispatcher,
        "get_executor",
        return_value=OldTaskIdsExecutor(),
    )

    result = await wecode_routers.get_old_task_ids(
        older_than_hours=48, http_request=http_request
    )

    assert result["status"] == "success"
    assert len(result["pods"]) == 4
    assert result["pods"][0]["task_id"] == "100"
    assert result["pods"][0]["pod_name"] == "wegent-task-100-aaa"
    assert result["pods"][0]["runtime_type"] == "executor"
    assert result["pods"][2]["task_id"] is None
    assert result["pods"][2]["runtime_type"] == "sandbox"
    assert result["pods"][3]["runtime_type"] == "sandbox"


@pytest.mark.asyncio
async def test_get_old_task_ids_unsupported_executor_returns_empty(mocker):
    http_request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
    mocker.patch.object(
        wecode_routers.ExecutorDispatcher,
        "get_executor",
        return_value=NoOldTaskIdsExecutor(),
    )

    result = await wecode_routers.get_old_task_ids(
        older_than_hours=48, http_request=http_request
    )

    assert result == {"status": "success", "pods": []}
