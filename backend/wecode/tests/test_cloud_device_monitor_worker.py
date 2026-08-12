# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for cloud-device monitor worker orchestration."""

from contextlib import nullcontext
from unittest.mock import AsyncMock, MagicMock, call

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


def test_worker_delays_nevis_ip_sync_until_one_hour(monkeypatch):
    stop_event = MagicMock()
    stop_event.is_set.side_effect = [False, False, True]
    run_monitor_check = MagicMock(return_value=object())
    run_async = MagicMock()

    monkeypatch.setattr(
        cloud_device_monitor_worker.time,
        "monotonic",
        MagicMock(side_effect=[0, 0, 3600, 3600]),
    )
    monkeypatch.setattr(
        cloud_device_monitor_worker,
        "_run_monitor_check",
        run_monitor_check,
    )
    monkeypatch.setattr(cloud_device_monitor_worker.asyncio, "run", run_async)

    cloud_device_monitor_worker.cloud_device_monitor_worker(stop_event)

    assert run_monitor_check.call_args_list == [
        call(run_nevis_ip_sync=False),
        call(run_nevis_ip_sync=True),
    ]
    assert stop_event.wait.call_args_list == [
        call(timeout=cloud_device_monitor_worker.MONITOR_INTERVAL_SECONDS),
        call(timeout=cloud_device_monitor_worker.MONITOR_INTERVAL_SECONDS),
    ]


@pytest.mark.asyncio
async def test_nevis_ip_sync_window_is_one_hour():
    redis_client = AsyncMock()
    redis_client.set.return_value = True

    claimed = await cloud_device_monitor_worker.claim_nevis_ip_sync_window(redis_client)

    assert claimed is True
    redis_client.set.assert_awaited_once_with(
        cloud_device_monitor_worker.NEVIS_IP_SYNC_WINDOW_KEY,
        "1",
        nx=True,
        ex=3600,
    )


@pytest.mark.asyncio
async def test_ip_index_refresh_runs_when_offline_alert_is_disabled(monkeypatch):
    """Index maintenance must not depend on DingTalk alert configuration."""
    redis_client = _FakeRedis()
    db = MagicMock()
    sync_missing = AsyncMock(
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
    monkeypatch.setattr(
        cloud_device_monitor_worker,
        "claim_nevis_ip_sync_window",
        AsyncMock(return_value=True),
    )
    monkeypatch.setattr(
        cloud_device_ip_index_service,
        "sync_missing",
        sync_missing,
    )
    monkeypatch.setattr(
        cloud_device_monitor_service,
        "check_cloud_devices_status",
        monitor_check,
    )
    monkeypatch.setattr(settings, "CLOUD_DEVICE_OFFLINE_ALERT_ENABLED", False)

    await cloud_device_monitor_worker._run_monitor_check(run_nevis_ip_sync=True)

    sync_missing.assert_awaited_once_with(db, redis_client)
    monitor_check.assert_not_awaited()


@pytest.mark.asyncio
async def test_ip_index_refresh_does_not_depend_on_offline_monitor_lock(monkeypatch):
    redis_client = _FakeRedis()
    db = MagicMock()
    sync_missing = AsyncMock(
        return_value=CloudDeviceIpSyncSummary(
            total=0,
            persisted=0,
            missing_ip=0,
            failed=0,
        )
    )

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
        "claim_nevis_ip_sync_window",
        AsyncMock(return_value=True),
    )
    monkeypatch.setattr(
        cloud_device_monitor_worker,
        "acquire_monitor_lock",
        AsyncMock(return_value=False),
    )
    monkeypatch.setattr(
        cloud_device_ip_index_service,
        "sync_missing",
        sync_missing,
    )

    await cloud_device_monitor_worker._run_monitor_check(run_nevis_ip_sync=True)

    sync_missing.assert_awaited_once_with(db, redis_client)


@pytest.mark.asyncio
async def test_ip_index_failure_does_not_block_offline_monitoring(monkeypatch):
    """Index persistence failures must remain isolated from existing monitoring."""
    redis_client = _FakeRedis()
    db = MagicMock()
    sync_missing = AsyncMock(side_effect=RuntimeError("database write failed"))
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
    monkeypatch.setattr(
        cloud_device_monitor_worker,
        "claim_nevis_ip_sync_window",
        AsyncMock(return_value=True),
    )
    monkeypatch.setattr(
        cloud_device_ip_index_service,
        "sync_missing",
        sync_missing,
    )
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

    await cloud_device_monitor_worker._run_monitor_check(run_nevis_ip_sync=True)

    sync_missing.assert_awaited_once_with(db, redis_client)
    monitor_check.assert_awaited_once_with(db, redis_client)
    auto_heal.assert_awaited_once_with(db, redis_client, monitor_result)
