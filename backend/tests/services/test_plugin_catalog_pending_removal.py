# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Catalog repair must not discard durable device-uninstall work."""

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.plugin_marketplace import PluginDeviceInstallation
from app.models.user import User
from app.schemas.device import DeviceCapabilitySyncResult
from app.services.plugin_device_installation_service import (
    plugin_device_installation_service,
)
from app.services.plugin_marketplace_service import plugin_marketplace_service


def _installed_kind(db: Session, user_id: int, name: str, *, active: bool) -> Kind:
    kind = Kind(
        user_id=user_id,
        kind="InstalledPlugin",
        namespace="default",
        name=name,
        is_active=active,
        json={
            "spec": {
                "source": {"type": "upload", "pluginKey": name},
                "enabled": active,
                "installState": "installed" if active else "uninstalled",
            }
        },
    )
    db.add(kind)
    db.flush()
    return kind


def _removal_row(db: Session, installed: Kind) -> PluginDeviceInstallation:
    row = PluginDeviceInstallation(
        installed_kind_id=installed.id,
        user_id=installed.user_id,
        device_id="offline-device",
        desired_release_id=17,
        actual_release_id=17,
        state="installed",
    )
    db.add(row)
    db.commit()
    plugin_device_installation_service.mark_uninstalling(
        db, user_id=installed.user_id, installed_kind_id=installed.id
    )
    return row


def _record_failed_removal(db: Session, user_id: int) -> None:
    plugin_device_installation_service.record_device_sync_result(
        db,
        user_id=user_id,
        result=DeviceCapabilitySyncResult(
            device_id="offline-device", success=False, error="device disconnected"
        ),
    )


@pytest.mark.parametrize("another_active_plugin", [False, True])
@pytest.mark.parametrize("removal_failed", [False, True])
def test_catalog_reconcile_preserves_unfinished_removal_until_acknowledged(
    test_db: Session,
    test_user: User,
    another_active_plugin: bool,
    removal_failed: bool,
) -> None:
    installed = _installed_kind(test_db, test_user.id, "removed", active=False)
    if another_active_plugin:
        _installed_kind(test_db, test_user.id, "healthy", active=True)
    row = _removal_row(test_db, installed)
    if removal_failed:
        _record_failed_removal(test_db, test_user.id)
    before = {
        column.name: getattr(row, column.name) for column in row.__table__.columns
    }

    for _ in range(2):
        assert (
            plugin_marketplace_service.reconcile_stale_installed_catalog_refs(
                test_db, user_id=test_user.id
            )
            == 0
        )
        test_db.expire_all()
        current = test_db.get(PluginDeviceInstallation, before["id"])
        assert current is not None
        assert {
            column.name: getattr(current, column.name)
            for column in current.__table__.columns
        } == before

    plugin_device_installation_service.record_device_sync_result(
        test_db,
        user_id=test_user.id,
        result=DeviceCapabilitySyncResult(
            device_id="offline-device", success=True, acknowledged=True
        ),
    )
    assert test_db.get(PluginDeviceInstallation, before["id"]) is None
    assert (
        plugin_marketplace_service.reconcile_stale_installed_catalog_refs(
            test_db, user_id=test_user.id
        )
        == 0
    )
