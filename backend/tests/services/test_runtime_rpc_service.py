# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock

import pytest


@pytest.mark.asyncio
async def test_runtime_rpc_service_returns_runtime_failure_ack(monkeypatch):
    from app.services.device import runtime_rpc_service as module

    monkeypatch.setattr(
        module.device_service,
        "get_device_online_info",
        AsyncMock(return_value={"socket_id": "socket-1"}),
    )
    sio = type(
        "Sio",
        (),
        {
            "call": AsyncMock(
                return_value={
                    "success": False,
                    "error": "Runtime send adapter is not available",
                }
            )
        },
    )()
    monkeypatch.setattr(module, "get_sio", lambda: sio)

    result = await module.RuntimeRpcService().call(
        user_id=7,
        device_id="device-1",
        method="runtime.tasks.send",
        payload={"localTaskId": "codex-1"},
        timeout_seconds=30,
    )

    assert result == {
        "success": False,
        "error": "Runtime send adapter is not available",
    }
    sio.call.assert_awaited_once_with(
        "runtime:rpc",
        {
            "method": "runtime.tasks.send",
            "payload": {"localTaskId": "codex-1"},
        },
        to="socket-1",
        namespace="/local-executor",
        timeout=35,
    )


@pytest.mark.asyncio
async def test_runtime_rpc_service_can_use_strict_timeout_without_ack_grace(
    monkeypatch,
):
    from app.services.device import runtime_rpc_service as module

    monkeypatch.setattr(
        module.device_service,
        "get_device_online_info",
        AsyncMock(return_value={"socket_id": "socket-1"}),
    )
    sio = type(
        "Sio",
        (),
        {
            "call": AsyncMock(
                return_value={
                    "success": True,
                    "workspaces": [],
                }
            )
        },
    )()
    monkeypatch.setattr(module, "get_sio", lambda: sio)

    result = await module.RuntimeRpcService().call(
        user_id=7,
        device_id="device-1",
        method="runtime.tasks.list",
        payload={},
        timeout_seconds=3,
        ack_grace_seconds=0,
    )

    assert result == {"success": True, "workspaces": []}
    sio.call.assert_awaited_once_with(
        "runtime:rpc",
        {
            "method": "runtime.tasks.list",
            "payload": {},
        },
        to="socket-1",
        namespace="/local-executor",
        timeout=3,
    )
