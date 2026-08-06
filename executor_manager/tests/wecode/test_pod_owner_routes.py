# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from executor_manager.wecode import routers as wecode_routers


class PodOwnersExecutor:
    def get_pod_owners_by_ip(self, ip_address):
        return {
            "status": "success",
            "pods": [{"pod_name": "pod-1", "user_name": "alice"}],
        }


class UnsupportedExecutor:
    pass


@pytest.mark.asyncio
async def test_get_pod_owners_by_ip(mocker):
    http_request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
    mocker.patch.object(
        wecode_routers.ExecutorDispatcher,
        "get_executor",
        return_value=PodOwnersExecutor(),
    )

    result = await wecode_routers.get_pod_owners_by_ip(
        ip_address="10.0.0.8",
        http_request=http_request,
    )

    assert result == {
        "status": "success",
        "pods": [{"pod_name": "pod-1", "user_name": "alice"}],
    }


@pytest.mark.asyncio
async def test_get_pod_owners_by_ip_rejects_unsupported_executor(mocker):
    http_request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
    mocker.patch.object(
        wecode_routers.ExecutorDispatcher,
        "get_executor",
        return_value=UnsupportedExecutor(),
    )

    with pytest.raises(HTTPException) as exc_info:
        await wecode_routers.get_pod_owners_by_ip(
            ip_address="10.0.0.8",
            http_request=http_request,
        )

    assert exc_info.value.status_code == 501
