# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.api.ws import device_namespace


@pytest.mark.asyncio
async def test_store_device_capabilities_state_preserves_plugin_report(monkeypatch):
    stored = {}

    async def fake_store(user_id, device_id, capabilities):
        stored["user_id"] = user_id
        stored["device_id"] = device_id
        stored["capabilities"] = capabilities
        return True

    monkeypatch.setattr(
        device_namespace.device_service,
        "get_device_capabilities_state",
        AsyncMock(return_value=None),
    )
    monkeypatch.setattr(
        device_namespace.device_service,
        "store_device_capabilities_state",
        fake_store,
    )

    await device_namespace._store_device_capabilities_state(
        1,
        "device-1",
        {
            "revision": 2,
            "digest": "sha256:test",
            "full": True,
            "skills": [{"name": "browser", "source": "local_user"}],
            "mcps": [{"name": "docs", "source": "wegent"}],
            "plugins": [
                {
                    "name": "context7",
                    "marketplace": "claude-plugins-official",
                    "scope": "user",
                    "version": "1057d02c5307",
                    "source": "local_user",
                }
            ],
        },
    )

    assert stored["capabilities"]["plugins"] == [
        {
            "name": "context7",
            "marketplace": "claude-plugins-official",
            "scope": "user",
            "version": "1057d02c5307",
            "source": "local_user",
        }
    ]


def test_runtime_auth_file_missing_requires_explicit_false():
    assert (
        device_namespace._runtime_auth_file_missing(
            {"codex": {"exists": False}},
            "codex",
        )
        is True
    )
    assert (
        device_namespace._runtime_auth_file_missing(
            {"codex": {"exists": True}},
            "codex",
        )
        is False
    )
    assert device_namespace._runtime_auth_file_missing({}, "codex") is False
    assert device_namespace._runtime_auth_file_missing(None, "codex") is False


@pytest.mark.asyncio
async def test_heartbeat_runtime_auth_sync_uses_user_preferences(monkeypatch):
    namespace = device_namespace.DeviceNamespace()
    user = SimpleNamespace(
        id=7,
        preferences=json.dumps(
            {"runtime_configs": {"codex": {"use_user_config": True}}}
        ),
    )
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = user

    @contextmanager
    def fake_db_session():
        yield db

    def fake_get_config(db_arg, *, user_id, runtime, preferences):
        assert db_arg is db
        assert user_id == 7
        assert runtime == "codex"
        assert preferences == user.preferences
        return {"use_user_config": True, "configured": True}

    sync_auth_to_devices = AsyncMock(
        return_value={
            "items": [
                {
                    "device_id": "device-1",
                    "success": True,
                    "status": "written",
                }
            ]
        }
    )
    monkeypatch.setattr(device_namespace, "_db_session", fake_db_session)
    monkeypatch.setattr(
        device_namespace.user_runtime_config_service,
        "get_config",
        fake_get_config,
    )
    monkeypatch.setattr(
        device_namespace.user_runtime_config_service,
        "sync_auth_to_devices",
        sync_auth_to_devices,
    )

    key = (7, "device-1", "codex")
    namespace._runtime_auth_sync_inflight.add(key)

    await namespace._sync_runtime_auth_for_heartbeat_device(
        user_id=7,
        device_id="device-1",
        runtime="codex",
        key=key,
    )

    sync_auth_to_devices.assert_awaited_once_with(
        db,
        user_id=7,
        runtime="codex",
        preferences=user.preferences,
        device_ids=["device-1"],
    )
    assert key not in namespace._runtime_auth_sync_inflight
