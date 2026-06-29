# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import pytest

from executor_manager.routers import routers


class NamespaceAwareDeleteExecutor:
    def get_executor_task_id(self, executor_name):
        return None

    def delete_executor(self, executor_name, executor_namespace=None):
        return {
            "status": "success",
            "executor_name": executor_name,
            "executor_namespace": executor_namespace,
        }


class LegacyDeleteExecutor:
    def get_executor_task_id(self, executor_name):
        return None

    def delete_executor(self, executor_name):
        return {"status": "success", "executor_name": executor_name}


@pytest.mark.asyncio
async def test_delete_executor_forwards_executor_namespace(mocker):
    http_request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
    mocker.patch.object(
        routers.ExecutorDispatcher,
        "get_executor",
        return_value=NamespaceAwareDeleteExecutor(),
    )

    result = await routers.delete_executor(
        request=routers.DeleteExecutorRequest(
            executor_name="executor-1",
            executor_namespace="test-executor-namespace",
        ),
        http_request=http_request,
    )

    assert result == {
        "status": "success",
        "executor_name": "executor-1",
        "executor_namespace": "test-executor-namespace",
    }


@pytest.mark.asyncio
async def test_delete_executor_supports_legacy_executor_signature(mocker):
    http_request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
    mocker.patch.object(
        routers.ExecutorDispatcher,
        "get_executor",
        return_value=LegacyDeleteExecutor(),
    )

    result = await routers.delete_executor(
        request=routers.DeleteExecutorRequest(
            executor_name="executor-1",
            executor_namespace="test-executor-namespace",
        ),
        http_request=http_request,
    )

    assert result == {"status": "success", "executor_name": "executor-1"}
