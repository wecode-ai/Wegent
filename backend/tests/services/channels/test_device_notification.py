# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Tests for Pod-local device notification dispatch."""

import threading
from unittest.mock import AsyncMock

import pytest

from app.services.channels import device_notification


@pytest.mark.asyncio
async def test_web_entry_uses_channel_worker_client(monkeypatch) -> None:
    send = AsyncMock(return_value={"success": True, "sent": 1})
    monkeypatch.setattr(
        device_notification.channel_worker_client,
        "send_device_notification",
        send,
    )

    result = await device_notification.send_default_device_notification(
        user_id=12,
        target_type="device",
        device_name="Mac mini",
    )

    assert result == {"success": True, "sent": 1}
    send.assert_awaited_once_with(
        user_id=12,
        target_type="device",
        device_name="Mac mini",
    )


@pytest.mark.asyncio
async def test_worker_local_notification_uses_detached_targets(monkeypatch) -> None:
    db_threads: list[str] = []
    targets = (
        device_notification._DeviceNotificationTarget(
            channel_key="1",
            channel_id=1,
            channel_type="dingtalk",
            sender_id="sender-a",
            config={"clientId": "id", "clientSecret": "secret"},
        ),
        device_notification._DeviceNotificationTarget(
            channel_key="2",
            channel_id=2,
            channel_type="telegram",
            sender_id="sender-b",
            config={"botToken": "token"},
        ),
        device_notification._DeviceNotificationTarget(
            channel_key="invalid",
            channel_id=None,
            channel_type="dingtalk",
            sender_id="sender-c",
            config=None,
        ),
    )

    def load_targets(user_id: int):
        assert user_id == 12
        db_threads.append(threading.current_thread().name)
        return targets

    send_dingtalk = AsyncMock(return_value={"success": True})
    send_telegram = AsyncMock(return_value={"success": True})
    monkeypatch.setattr(
        device_notification,
        "_load_notification_targets_sync",
        load_targets,
    )
    monkeypatch.setattr(
        device_notification,
        "_send_dingtalk_notification",
        send_dingtalk,
    )
    monkeypatch.setattr(
        device_notification,
        "_send_telegram_notification",
        send_telegram,
    )

    result = await device_notification._send_default_device_notification_locally(
        user_id=12,
        target_type="device",
        device_name="Mac mini",
        is_channel_running=lambda channel_id: channel_id == 1,
    )

    assert result["sent"] == 1
    assert result["total"] == 3
    assert db_threads and db_threads[0].startswith("wegent-db")
    send_dingtalk.assert_awaited_once()
    send_telegram.assert_not_awaited()
    assert result["results"][1]["error"] == "Channel not running"
    assert result["results"][2]["error"] == "Invalid channel ID"
