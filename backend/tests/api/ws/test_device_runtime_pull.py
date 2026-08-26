# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock

import pytest

import app.api.ws.device_namespace as device_namespace_module
from app.api.ws.device_namespace import DeviceNamespace


@pytest.mark.asyncio
async def test_registered_device_pulls_work_with_socket_identity(monkeypatch):
    namespace = DeviceNamespace()
    namespace.get_session = AsyncMock(
        return_value={
            "user_id": 17,
            "device_id": "cloud-device",
            "runtime_instance_id": "runtime-1",
        }
    )
    calls = []

    def pull(**kwargs):
        calls.append(kwargs)
        return {"success": True, "task": {"execution_id": 268}}

    monkeypatch.setattr(device_namespace_module, "pull_cloud_execution", pull)

    runtime_capacity = {
        "limit": 4,
        "active": 1,
        "active_task_ids": ["manual-1"],
        "queued": 0,
    }
    result = await namespace.on_runtime_tasks_pull(
        "socket-1",
        {"runtime_capacity": runtime_capacity},
    )

    assert result == {"success": True, "task": {"execution_id": 268}}
    assert calls == [
        {
            "owner_user_id": 17,
            "device_id": "cloud-device",
            "runtime_instance_id": "runtime-1",
            "runtime_capacity": runtime_capacity,
        }
    ]


@pytest.mark.asyncio
async def test_registered_device_reports_runtime_acceptance(monkeypatch):
    namespace = DeviceNamespace()
    namespace.get_session = AsyncMock(
        return_value={
            "user_id": 17,
            "device_id": "cloud-device",
            "runtime_instance_id": "runtime-1",
        }
    )
    calls = []

    def acknowledge(**kwargs):
        calls.append(kwargs)
        return {"success": True}

    monkeypatch.setattr(
        device_namespace_module,
        "acknowledge_cloud_execution",
        acknowledge,
    )

    result = await namespace.on_runtime_tasks_accept(
        "socket-1",
        {
            "execution_id": 268,
            "runtime_task_id": "codex-queue-268",
            "accepted": True,
            "prompt": "Build the calculator",
        },
    )

    assert result == {"success": True}
    assert calls == [
        {
            "owner_user_id": 17,
            "device_id": "cloud-device",
            "runtime_instance_id": "runtime-1",
            "execution_id": 268,
            "runtime_task_id": "codex-queue-268",
            "accepted": True,
            "prompt": "Build the calculator",
            "error": None,
        }
    ]
