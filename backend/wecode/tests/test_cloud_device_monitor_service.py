# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.schemas.device import DeviceType
from wecode.service.cloud_device_monitor_service import (
    send_monitoring_report,
    trigger_auto_heal_for_offline_devices,
)
from wecode.service.cloud_device_provider import cloud_device_provider


class FakeRedis:
    """Small in-memory Redis stub for monitor service tests."""

    def __init__(self):
        self.store = {}

    async def delete(self, *keys):
        for key in keys:
            self.store.pop(key, None)
        return len(keys)

    async def get(self, key):
        return self.store.get(key)

    async def incr(self, key):
        value = int(self.store.get(key, 0)) + 1
        self.store[key] = value
        return value

    async def expire(self, key, _seconds):
        return key in self.store

    async def set(self, key, value, ex=None):
        self.store[key] = value
        return True


def build_device(device_id: str = "device-1") -> dict:
    return {
        "user_name": "alice",
        "user_id": 7,
        "device_id": device_id,
        "sandbox_id": f"sandbox-{device_id}",
        "client_ip": "10.0.0.8",
    }


@pytest.mark.asyncio
async def test_trigger_auto_heal_requires_consecutive_offline_checks():
    redis_client = FakeRedis()
    db = MagicMock()

    with (
        patch(
            "wecode.service.cloud_device_monitor_service.settings"
        ) as mock_settings,
        patch.object(
            cloud_device_provider, "restart_device", new_callable=AsyncMock
        ) as mock_restart,
    ):
        mock_settings.CLOUD_DEVICE_AUTO_HEAL_ENABLED = True
        mock_settings.CLOUD_DEVICE_AUTO_HEAL_OFFLINE_THRESHOLD = 2
        mock_restart.return_value = {
            "device_id": "device-1",
            "sandbox_id": "sandbox-device-1",
            "result": {"status": "accepted"},
        }

        first_result = {
            "online_devices": [],
            "offline_devices": [build_device()],
        }
        attempts = await trigger_auto_heal_for_offline_devices(
            db, redis_client, first_result
        )
        assert attempts == []
        assert first_result["offline_devices"][0]["offline_streak"] == 1
        mock_restart.assert_not_awaited()

        second_result = {
            "online_devices": [],
            "offline_devices": [build_device()],
        }
        attempts = await trigger_auto_heal_for_offline_devices(
            db, redis_client, second_result
        )

        assert len(attempts) == 1
        assert attempts[0]["status"] == "triggered"
        assert attempts[0]["offline_streak"] == 2
        mock_restart.assert_awaited_once_with(
            db=db,
            user_id=7,
            device_id="device-1",
        )


@pytest.mark.asyncio
async def test_trigger_auto_heal_only_runs_once_per_offline_incident():
    redis_client = FakeRedis()
    db = MagicMock()

    with (
        patch(
            "wecode.service.cloud_device_monitor_service.settings"
        ) as mock_settings,
        patch.object(
            cloud_device_provider, "restart_device", new_callable=AsyncMock
        ) as mock_restart,
    ):
        mock_settings.CLOUD_DEVICE_AUTO_HEAL_ENABLED = True
        mock_settings.CLOUD_DEVICE_AUTO_HEAL_OFFLINE_THRESHOLD = 1
        mock_restart.return_value = {
            "device_id": "device-1",
            "sandbox_id": "sandbox-device-1",
            "result": {"status": "accepted"},
        }

        offline_result = {
            "online_devices": [],
            "offline_devices": [build_device()],
        }
        attempts = await trigger_auto_heal_for_offline_devices(
            db, redis_client, offline_result
        )
        assert len(attempts) == 1

        still_offline_result = {
            "online_devices": [],
            "offline_devices": [build_device()],
        }
        attempts = await trigger_auto_heal_for_offline_devices(
            db, redis_client, still_offline_result
        )
        assert attempts == []

        another_offline_result = {
            "online_devices": [],
            "offline_devices": [build_device()],
        }
        attempts = await trigger_auto_heal_for_offline_devices(
            db, redis_client, another_offline_result
        )
        assert attempts == []

        recovered_result = {
            "online_devices": [build_device()],
            "offline_devices": [],
        }
        attempts = await trigger_auto_heal_for_offline_devices(
            db, redis_client, recovered_result
        )
        assert attempts == []

        retried_result = {
            "online_devices": [],
            "offline_devices": [build_device()],
        }
        attempts = await trigger_auto_heal_for_offline_devices(
            db, redis_client, retried_result
        )
        assert len(attempts) == 1
        assert mock_restart.await_count == 2


@pytest.mark.asyncio
async def test_send_monitoring_report_includes_auto_heal_section():
    webhook_sender = MagicMock()
    webhook_sender.send_markdown = AsyncMock(return_value=True)

    result = {
        "total": 3,
        "online_count": 2,
        "offline_count": 1,
        "online_devices": [],
        "offline_devices": [build_device()],
        "new_offline": [],
        "recovered": [],
        "auto_heal_attempts": [
            {
                **build_device(),
                "offline_streak": 2,
                "status": "triggered",
                "message": "已触发重启",
            }
        ],
    }

    success = await send_monitoring_report(MagicMock(), result, webhook_sender)

    assert success is True
    kwargs = webhook_sender.send_markdown.await_args.kwargs
    assert "自动自愈操作" in kwargs["content"]
    assert "已触发重启" in kwargs["content"]
    assert "自动自愈触发: 1" in kwargs["content"]


@pytest.mark.asyncio
async def test_cloud_device_provider_restart_device_uses_sandbox_id():
    device_kind = MagicMock()
    device_kind.json = {
        "spec": {
            "deviceType": DeviceType.CLOUD.value,
            "cloudConfig": {"sandboxId": "sandbox-123"},
        }
    }

    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = device_kind

    with patch.object(
        cloud_device_provider._client,  # noqa: SLF001 - test shared singleton wiring
        "restart_sandbox",
        new_callable=AsyncMock,
    ) as mock_restart:
        mock_restart.return_value = {"status": "accepted"}

        result = await cloud_device_provider.restart_device(
            db=db,
            user_id=7,
            device_id="device-1",
        )

        assert result["sandbox_id"] == "sandbox-123"
        mock_restart.assert_awaited_once_with("sandbox-123")
