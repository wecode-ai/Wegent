# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Factories for owned Device records used by execution identity tests."""

from __future__ import annotations

import uuid

from sqlalchemy.orm import Session

from app.models.kind import Kind

SHARED_APP_DEVICE_ID = "local-device"


def create_app_device(db: Session, *, user_id: int) -> Kind:
    """Register one Wework installation under the shared logical device id.

    Every desktop installation registers as ``local-device``, so only the
    persisted record can tell two installations of one owner apart.
    """

    device = Kind(
        kind="Device",
        name=SHARED_APP_DEVICE_ID,
        namespace="default",
        user_id=user_id,
        is_active=True,
        json={
            "spec": {
                "deviceType": "app",
                "deviceId": SHARED_APP_DEVICE_ID,
                "runtimeInstanceId": f"runtime-{uuid.uuid4().hex[:8]}",
                "appDeviceId": f"electron-{uuid.uuid4().hex[:8]}",
            }
        },
    )
    db.add(device)
    db.commit()
    db.refresh(device)
    return device
