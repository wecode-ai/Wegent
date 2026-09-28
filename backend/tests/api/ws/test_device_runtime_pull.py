# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from contextlib import contextmanager
from unittest.mock import AsyncMock

import pytest

import app.api.ws.device_namespace as device_namespace_module
from app.api.ws.device_namespace import DeviceNamespace


def test_workspace_cleanup_sync_adapters_supply_database_session(monkeypatch):
    database = object()
    calls = []

    @contextmanager
    def database_session():
        yield database

    def claim(db, **kwargs):
        calls.append(("claim", db, kwargs))
        return True

    def acknowledge(db, **kwargs):
        calls.append(("acknowledge", db, kwargs))
        return True

    monkeypatch.setattr(device_namespace_module, "get_db_session", database_session)
    monkeypatch.setattr(device_namespace_module, "_claim_workspace_cleanup", claim)
    monkeypatch.setattr(
        device_namespace_module,
        "_acknowledge_workspace_cleanup",
        acknowledge,
    )
    arguments = {
        "owner_user_id": 17,
        "runtime_device_id": "cloud-device",
        "intent_id": "cleanup-1",
        "issue_version": 4,
    }

    assert device_namespace_module._claim_workspace_cleanup_sync(**arguments)
    assert device_namespace_module._acknowledge_workspace_cleanup_sync(**arguments)
    assert calls == [
        ("claim", database, arguments),
        ("acknowledge", database, arguments),
    ]


@pytest.mark.asyncio
async def test_registered_device_pulls_work_with_socket_identity(monkeypatch):
    namespace = DeviceNamespace()
    namespace.get_session = AsyncMock(
        return_value={
            "user_id": 17,
            "device_id": "cloud-device",
            "execution_target_id": "cloud-device",
            "runtime_instance_id": "runtime-1",
            "device_type": "cloud",
        }
    )
    calls = []

    def pull(**kwargs):
        calls.append(kwargs)
        return {"success": True, "task": {"execution_id": 268}}

    monkeypatch.setattr(device_namespace_module, "pull_execution", pull)

    result = await namespace.on_runtime_tasks_pull("socket-1", {})

    assert result == {"success": True, "task": {"execution_id": 268}}
    assert calls == [
        {
            "owner_user_id": 17,
            "execution_target_id": "cloud-device",
            "runtime_device_id": "cloud-device",
            "runtime_instance_id": "runtime-1",
            "environment": "cloud",
        }
    ]


@pytest.mark.asyncio
async def test_app_executor_pulls_local_work_for_its_app_target(monkeypatch):
    namespace = DeviceNamespace()
    namespace.get_session = AsyncMock(
        return_value={
            "user_id": 17,
            "device_id": "executor-runtime-device",
            "execution_target_id": "electron-app-device",
            "runtime_instance_id": "runtime-1",
            "device_type": "app",
        }
    )
    calls = []

    def pull(**kwargs):
        calls.append(kwargs)
        return {"success": True, "task": None}

    monkeypatch.setattr(device_namespace_module, "pull_execution", pull)

    result = await namespace.on_runtime_tasks_pull("socket-1", {})

    assert result == {"success": True, "task": None}
    assert calls == [
        {
            "owner_user_id": 17,
            "execution_target_id": "electron-app-device",
            "runtime_device_id": "executor-runtime-device",
            "runtime_instance_id": "runtime-1",
            "environment": "local",
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


@pytest.mark.asyncio
async def test_registered_device_acknowledges_workspace_cleanup(monkeypatch):
    namespace = DeviceNamespace()
    namespace.get_session = AsyncMock(
        return_value={
            "user_id": 17,
            "device_id": "cloud-device",
        }
    )
    calls = []

    def acknowledge(**kwargs):
        calls.append(kwargs)
        return True

    monkeypatch.setattr(
        device_namespace_module,
        "_acknowledge_workspace_cleanup_sync",
        acknowledge,
    )

    result = await namespace.on_runtime_workspace_cleanup_accept(
        "socket-1",
        {
            "intent_id": "cleanup-1",
            "issue_version": 4,
        },
    )

    assert result == {"success": True}
    assert calls == [
        {
            "owner_user_id": 17,
            "runtime_device_id": "cloud-device",
            "intent_id": "cleanup-1",
            "issue_version": 4,
        }
    ]


@pytest.mark.asyncio
async def test_registered_device_claims_workspace_cleanup(monkeypatch):
    namespace = DeviceNamespace()
    namespace.get_session = AsyncMock(
        return_value={
            "user_id": 17,
            "device_id": "cloud-device",
        }
    )
    calls = []

    def claim(**kwargs):
        calls.append(kwargs)
        return True

    monkeypatch.setattr(
        device_namespace_module,
        "_claim_workspace_cleanup_sync",
        claim,
    )

    result = await namespace.on_runtime_workspace_cleanup_claim(
        "socket-1",
        {
            "intent_id": "cleanup-1",
            "issue_version": 4,
        },
    )

    assert result == {"success": True}
    assert calls == [
        {
            "owner_user_id": 17,
            "runtime_device_id": "cloud-device",
            "intent_id": "cleanup-1",
            "issue_version": 4,
        }
    ]
