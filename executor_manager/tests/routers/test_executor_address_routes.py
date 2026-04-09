# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import pytest

from executor_manager.routers import routers


class LegacyAddressExecutor:
    def get_container_address(self, executor_name):
        return {
            "status": "success",
            "base_url": f"http://{executor_name}.local:8000",
        }


@pytest.mark.asyncio
async def test_get_executor_address_supports_legacy_executor_signature(mocker):
    http_request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
    mocker.patch.object(
        routers.ExecutorDispatcher,
        "get_executor",
        return_value=LegacyAddressExecutor(),
    )

    result = await routers.get_executor_address(
        executor_name="executor-1",
        executor_namespace="wegent-pod",
        http_request=http_request,
    )

    assert result == {
        "status": "success",
        "base_url": "http://executor-1.local:8000",
    }
