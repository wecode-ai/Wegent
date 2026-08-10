# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for cloud-device monitor worker orchestration."""

from contextlib import nullcontext
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.core.config import settings
from wecode.service import cloud_device_monitor_service, cloud_device_monitor_worker
from wecode.service.cloud_device_ip_index import (
    CloudDeviceIpSyncSummary,
    cloud_device_ip_index_service,
)


class _FakeRedis:
    async def aclose(self) -> None:
        return None


@pytest.mark.asyncio
async def test_ip_index_refresh_runs_when_offline_alert_is_disabled(monkeypatch):
    """Index maintenance must not depend on DingTalk alert configuration."""
    redis_client = _FakeRedis()
    db = MagicMock()
    sync_all = AsyncMock(
        return_value=CloudDeviceIpSyncSummary(
            total=1,
            persisted=1,
            missing_ip=0,
            failed=0,
        )
    )
    monitor_check = AsyncMock()

    monkeypatch.setattr(
        "redis.asyncio.Redis.from_url",
        lambda *_args, **_kwargs: redis_client,
    )
    monkeypatch.setattr(
        "app.db.session.get_db_session",
        lambda: nullcontext(db),
    )
    monkeypatch.setattr(
        cloud_device_monitor_worker,
        "acquire_monitor_lock",
        AsyncMock(return_value=True),
    )
    monkeypatch.setattr(cloud_device_ip_index_service, "sync_all", sync_all)
    monkeypatch.setattr(
        cloud_device_monitor_service,
        "check_cloud_devices_status",
        monitor_check,
    )
    monkeypatch.setattr(settings, "CLOUD_DEVICE_OFFLINE_ALERT_ENABLED", False)

    await cloud_device_monitor_worker._run_monitor_check()

    sync_all.assert_awaited_once_with(db)
    monitor_check.assert_not_awaited()


@pytest.mark.asyncio
async def test_ip_index_failure_does_not_block_offline_monitoring(monkeypatch):
    """Index persistence failures must remain isolated from existing monitoring."""
    redis_client = _FakeRedis()
    db = MagicMock()
    sync_all = AsyncMock(side_effect=RuntimeError("database write failed"))
    monitor_result = {
        "total": 0,
        "online_count": 0,
        "offline_count": 0,
        "online_devices": [],
        "offline_devices": [],
        "new_offline": [],
        "recovered": [],
    }
    monitor_check = AsyncMock(return_value=monitor_result)
    auto_heal = AsyncMock(return_value=[])

    monkeypatch.setattr(
        "redis.asyncio.Redis.from_url",
        lambda *_args, **_kwargs: redis_client,
    )
    monkeypatch.setattr(
        "app.db.session.get_db_session",
        lambda: nullcontext(db),
    )
    monkeypatch.setattr(
        cloud_device_monitor_worker,
        "acquire_monitor_lock",
        AsyncMock(return_value=True),
    )
    monkeypatch.setattr(cloud_device_ip_index_service, "sync_all", sync_all)
    monkeypatch.setattr(
        cloud_device_monitor_service,
        "check_cloud_devices_status",
        monitor_check,
    )
    monkeypatch.setattr(
        cloud_device_monitor_service,
        "trigger_auto_heal_for_offline_devices",
        auto_heal,
    )
    monkeypatch.setattr(settings, "CLOUD_DEVICE_OFFLINE_ALERT_ENABLED", True)

    await cloud_device_monitor_worker._run_monitor_check()

    sync_all.assert_awaited_once_with(db)
    monitor_check.assert_awaited_once_with(db, redis_client)
    auto_heal.assert_awaited_once_with(db, redis_client, monitor_result)
