# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
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
async def test_runtime_rpc_service_logs_success_metadata(monkeypatch, caplog):
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
                    "accepted": True,
                    "localTaskId": "runtime-1",
                    "runtime": "claude_code",
                }
            )
        },
    )()
    monkeypatch.setattr(module, "get_sio", lambda: sio)

    caplog.set_level(logging.INFO, logger="app.services.device.runtime_rpc_service")

    result = await module.RuntimeRpcService().call(
        user_id=7,
        device_id="device-1",
        method="runtime.tasks.create",
        payload={"message": "secret prompt", "workspacePath": "/repo/Wegent"},
        timeout_seconds=30,
    )

    assert result["accepted"] is True
    assert "Runtime RPC dispatching" in caplog.text
    assert "Runtime RPC completed" in caplog.text
    assert "method=runtime.tasks.create" in caplog.text
    assert "device_id=device-1" in caplog.text
    assert "local_task_id=runtime-1" in caplog.text
    assert "duration_ms=" in caplog.text
    assert "secret prompt" not in caplog.text


@pytest.mark.asyncio
async def test_runtime_rpc_service_logs_invalid_response_context(monkeypatch, caplog):
    from app.services.device import runtime_rpc_service as module

    monkeypatch.setattr(
        module.device_service,
        "get_device_online_info",
        AsyncMock(return_value={"socket_id": "socket-1"}),
    )
    sio = type("Sio", (), {"call": AsyncMock(return_value=["bad-response"])})()
    monkeypatch.setattr(module, "get_sio", lambda: sio)

    caplog.set_level(logging.WARNING, logger="app.services.device.runtime_rpc_service")

    with pytest.raises(module.RuntimeRpcError, match="invalid response"):
        await module.RuntimeRpcService().call(
            user_id=7,
            device_id="device-1",
            method="runtime.tasks.send",
            payload={"message": "secret prompt"},
            timeout_seconds=30,
        )

    assert "Runtime RPC returned invalid response" in caplog.text
    assert "method=runtime.tasks.send" in caplog.text
    assert "device_id=device-1" in caplog.text
    assert "secret prompt" not in caplog.text
