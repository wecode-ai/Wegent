# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the Wework runtime IPC relay namespace."""

from unittest.mock import AsyncMock

import pytest

from app.api.ws import wework_runtime_namespace
from app.api.ws.wework_runtime_namespace import WeworkRuntimeNamespace


@pytest.mark.asyncio
async def test_runtime_request_relays_to_device_runtime_rpc(monkeypatch):
    namespace = WeworkRuntimeNamespace()
    runtime_rpc = AsyncMock(return_value={"accepted": True})
    monkeypatch.setattr(
        wework_runtime_namespace.runtime_rpc_service,
        "call",
        runtime_rpc,
    )
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value={"user_id": 7}),
    )

    response = await namespace.on_runtime_request(
        "browser-sid",
        {
            "id": "req-1",
            "device_id": "cloud-device",
            "method": "runtime.tasks.create",
            "params": {"message": "hello"},
        },
    )

    assert response == {"id": "req-1", "ok": True, "result": {"accepted": True}}
    runtime_rpc.assert_awaited_once_with(
        user_id=7,
        device_id="cloud-device",
        method="runtime.tasks.create",
        payload={"message": "hello"},
        timeout_seconds=75,
    )


@pytest.mark.asyncio
async def test_runtime_request_requires_device_id(monkeypatch):
    namespace = WeworkRuntimeNamespace()
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(return_value={"user_id": 7}),
    )

    response = await namespace.on_runtime_request(
        "browser-sid",
        {
            "id": "req-1",
            "method": "runtime.tasks.list",
            "params": {},
        },
    )

    assert response == {
        "id": "req-1",
        "ok": False,
        "error": {"code": "bad_request", "message": "device_id is required"},
    }
