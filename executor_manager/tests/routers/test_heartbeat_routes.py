# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from executor_manager.routers import routers
from executor_manager.routers import sandbox as sandbox_router


@pytest.mark.asyncio
async def test_task_heartbeat_returns_retryable_error_when_redis_update_fails(mocker):
    heartbeat_manager = mocker.MagicMock()
    heartbeat_manager.update_heartbeat = mocker.AsyncMock(return_value=False)
    mocker.patch(
        "executor_manager.services.heartbeat_manager.get_heartbeat_manager",
        return_value=heartbeat_manager,
    )

    with pytest.raises(HTTPException) as raised:
        await routers.task_heartbeat(
            "task-1",
            SimpleNamespace(client=SimpleNamespace(host="127.0.0.1")),
        )

    assert raised.value.status_code == 503
    assert raised.value.headers == {"Retry-After": "1"}


@pytest.mark.asyncio
async def test_sandbox_heartbeat_returns_retryable_error_when_redis_update_fails(
    mocker,
):
    heartbeat_manager = mocker.MagicMock()
    heartbeat_manager.update_heartbeat = mocker.AsyncMock(return_value=False)
    mocker.patch(
        "executor_manager.services.heartbeat_manager.get_heartbeat_manager",
        return_value=heartbeat_manager,
    )

    with pytest.raises(HTTPException) as raised:
        await sandbox_router.sandbox_heartbeat(
            "sandbox-1",
            SimpleNamespace(client=SimpleNamespace(host="127.0.0.1")),
        )

    assert raised.value.status_code == 503
    assert raised.value.headers == {"Retry-After": "1"}
