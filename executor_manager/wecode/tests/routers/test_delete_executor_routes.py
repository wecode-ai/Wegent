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


class OldTaskIdsExecutor:
    def get_old_task_ids(self, older_than_hours: int = 48):
        return {"status": "success", "task_ids": ["100", "200", "300"]}


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
async def test_get_old_task_ids_returns_task_ids(mocker):
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
    assert result["task_ids"] == ["100", "200", "300"]


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

    assert result == {"status": "success", "task_ids": []}
