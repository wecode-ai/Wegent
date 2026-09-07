# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock

import pytest

import app.api.ws.device_namespace as device_namespace_module
from app.api.ws.device_namespace import DeviceNamespace
from app.schemas.device import DeviceType


@pytest.mark.asyncio
async def test_registered_device_pulls_work_with_socket_identity(monkeypatch):
    namespace = DeviceNamespace()
    namespace.get_session = AsyncMock(
        return_value={
            "user_id": 17,
            "device_id": "cloud-device",
            "device_type": DeviceType.CLOUD.value,
            "execution_target_id": "cloud-device",
            "execution_environment": "cloud",
            "runtime_instance_id": "runtime-1",
        }
    )
    calls = []

    def pull(**kwargs):
        calls.append(kwargs)
        return {"success": True, "task": {"execution_id": 268}}

    monkeypatch.setattr(device_namespace_module, "pull_execution", pull)

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
            "execution_target_id": "cloud-device",
            "runtime_device_id": "cloud-device",
            "runtime_instance_id": "runtime-1",
            "environment": "cloud",
            "runtime_capacity": runtime_capacity,
        }
    ]


@pytest.mark.asyncio
async def test_app_executor_pulls_backend_work_for_its_stable_target(monkeypatch):
    namespace = DeviceNamespace()
    namespace.get_session = AsyncMock(
        return_value={
            "user_id": 17,
            "device_id": "executor-runtime-device",
            "device_type": DeviceType.APP.value,
            "execution_target_id": "electron-app-device",
            "execution_environment": "local",
            "runtime_instance_id": "runtime-1",
        }
    )
    calls = []

    def pull(**kwargs):
        calls.append(kwargs)
        return {"success": True, "task": None}

    monkeypatch.setattr(device_namespace_module, "pull_execution", pull)

    result = await namespace.on_runtime_tasks_pull(
        "socket-1",
        {
            "runtime_capacity": {
                "limit": 1,
                "active": 0,
                "active_task_ids": [],
                "queued": 0,
            }
        },
    )

    assert result == {"success": True, "task": None}
    assert calls == [
        {
            "owner_user_id": 17,
            "execution_target_id": "electron-app-device",
            "runtime_device_id": "executor-runtime-device",
            "runtime_instance_id": "runtime-1",
            "environment": "local",
            "runtime_capacity": {
                "limit": 1,
                "active": 0,
                "active_task_ids": [],
                "queued": 0,
            },
        }
    ]


@pytest.mark.asyncio
async def test_remote_executor_pulls_work_for_its_stable_app_target(monkeypatch):
    namespace = DeviceNamespace()
    namespace.get_session = AsyncMock(
        return_value={
            "user_id": 17,
            "device_id": "executor-runtime-device",
            "device_type": DeviceType.REMOTE.value,
            "execution_target_id": "electron-app-device",
            "execution_environment": "local",
            "runtime_instance_id": "runtime-1",
        }
    )
    calls = []

    def pull(**kwargs):
        calls.append(kwargs)
        return {"success": True, "task": None}

    monkeypatch.setattr(device_namespace_module, "pull_execution", pull)

    runtime_capacity = {
        "limit": 1,
        "active": 0,
        "active_task_ids": [],
        "queued": 0,
    }
    result = await namespace.on_runtime_tasks_pull(
        "socket-1",
        {"runtime_capacity": runtime_capacity},
    )

    assert result == {"success": True, "task": None}
    assert calls == [
        {
            "owner_user_id": 17,
            "execution_target_id": "electron-app-device",
            "runtime_device_id": "executor-runtime-device",
            "runtime_instance_id": "runtime-1",
            "environment": "local",
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
        "acknowledge_execution",
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
            "runtime_device_id": "cloud-device",
            "runtime_instance_id": "runtime-1",
            "execution_id": 268,
            "runtime_task_id": "codex-queue-268",
            "accepted": True,
            "prompt": "Build the calculator",
            "error": None,
        }
    ]
