# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for device slot usage service helpers."""

from unittest.mock import Mock

from app.schemas.device import DeviceType
from app.services.device_service import DeviceService


def test_get_device_slot_usage_delegates_to_provider(monkeypatch):
    """The sync slot usage API should delegate to the local device provider."""
    db = Mock()
    provider = Mock()
    provider.get_slot_usage_sync.return_value = {
        "used": 1,
        "max": 5,
        "running_tasks": [{"task_id": 123}],
    }

    monkeypatch.setattr(
        DeviceService,
        "_get_provider",
        staticmethod(lambda device_type=DeviceType.LOCAL: provider),
    )

    result = DeviceService.get_device_slot_usage(db, user_id=7, device_id="device-1")

    assert result == {
        "used": 1,
        "max": 5,
        "running_tasks": [{"task_id": 123}],
    }
    provider.get_slot_usage_sync.assert_called_once_with(db, 7, "device-1")
