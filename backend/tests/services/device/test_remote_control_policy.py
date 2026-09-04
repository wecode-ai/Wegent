# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the server-side remote-control boundary."""

from contextlib import contextmanager
from unittest.mock import patch

import pytest

from app.models.kind import Kind
from app.schemas.device import DeviceType
from app.services.device.remote_control_policy import (
    REMOTE_CONTROL_DISABLED_MESSAGE,
    RemoteControlDisabledError,
    ensure_remote_control_enabled_for_device,
)


def _device(user_id: int, device_type: DeviceType) -> Kind:
    return Kind(
        user_id=user_id,
        kind="Device",
        name="logical-device",
        namespace="default",
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Device",
            "metadata": {"name": "logical-device", "namespace": "default"},
            "spec": {
                "deviceId": "runtime-device",
                "appDeviceId": "app-device",
                "deviceType": device_type.value,
            },
        },
    )


@pytest.mark.parametrize(
    "submitted_device_id",
    ["logical-device", "runtime-device", "app-device"],
)
def test_app_device_rejects_every_registered_identity(
    test_db,
    test_user,
    submitted_device_id,
):
    test_db.add(_device(test_user.id, DeviceType.APP))
    test_db.commit()

    @contextmanager
    def session():
        yield test_db

    with patch(
        "app.services.device.remote_control_policy.get_db_session",
        session,
    ):
        with pytest.raises(
            RemoteControlDisabledError,
            match=REMOTE_CONTROL_DISABLED_MESSAGE,
        ):
            ensure_remote_control_enabled_for_device(
                user_id=test_user.id,
                device_id=submitted_device_id,
            )


def test_remote_device_allows_backend_dispatch(test_db, test_user):
    test_db.add(_device(test_user.id, DeviceType.REMOTE))
    test_db.commit()

    @contextmanager
    def session():
        yield test_db

    with patch(
        "app.services.device.remote_control_policy.get_db_session",
        session,
    ):
        ensure_remote_control_enabled_for_device(
            user_id=test_user.id,
            device_id="logical-device",
        )
