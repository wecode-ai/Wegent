# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Catalog repair must not discard durable device-uninstall work."""

from contextlib import contextmanager
from datetime import datetime, timedelta
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.plugin_marketplace import PluginDeviceInstallation
from app.models.user import User
from app.schemas.device import DeviceCapabilitySyncResult
from app.services.device import plugin_removal_sync
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


@pytest.mark.asyncio
async def test_catalog_reconcile_preserves_failed_removal_for_heartbeat_retry(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    installed = _installed_kind(test_db, test_user.id, "removed", active=False)
    _installed_kind(test_db, test_user.id, "healthy", active=True)
    row = _removal_row(test_db, installed)
    _record_failed_removal(test_db, test_user.id)

    @contextmanager
    def session():
        yield test_db

    monkeypatch.setattr(plugin_removal_sync, "get_db_session", session)
    sync = AsyncMock(
        return_value=DeviceCapabilitySyncResult(
            device_id="offline-device", success=True, acknowledged=True
        )
    )
    monkeypatch.setattr(
        plugin_removal_sync.device_capability_sync_service,
        "sync_current_device_capabilities",
        sync,
    )
    assert plugin_removal_sync.pending_removal_devices(test_user.id, None) == set()
    row.last_sync_at = datetime.now() - timedelta(seconds=61)
    test_db.commit()

    plugin_marketplace_service.reconcile_stale_installed_catalog_refs(
        test_db, user_id=test_user.id
    )

    assert plugin_removal_sync.pending_removal_devices(test_user.id, None) == {
        "offline-device"
    }
    await plugin_removal_sync.sync_pending_plugin_removals(
        test_user.id, "offline-device"
    )
    sync.assert_awaited_once_with(user_id=test_user.id, device_id="offline-device")
    assert test_db.query(PluginDeviceInstallation).count() == 0


@pytest.mark.parametrize("state", ["installed", "pending"])
def test_catalog_reconcile_clears_stale_rows_without_touching_other_users(
    test_db: Session, test_user: User, state: str
) -> None:
    removed = _installed_kind(test_db, test_user.id, "removed", active=False)
    healthy = _installed_kind(test_db, test_user.id, "healthy", active=True)
    foreign = _installed_kind(test_db, test_user.id + 1, "foreign", active=False)
    stale = PluginDeviceInstallation(
        user_id=test_user.id,
        installed_kind_id=removed.id,
        device_id="stale-device",
        state=state,
    )
    active = PluginDeviceInstallation(
        user_id=test_user.id,
        installed_kind_id=healthy.id,
        device_id="healthy-device",
        state="installed",
    )
    other_user = PluginDeviceInstallation(
        user_id=foreign.user_id,
        installed_kind_id=foreign.id,
        device_id="foreign-device",
        state="uninstalling",
    )
    test_db.add_all([stale, active, other_user])
    test_db.commit()
    stale_id, active_id, foreign_id = stale.id, active.id, other_user.id

    assert (
        plugin_marketplace_service.reconcile_stale_installed_catalog_refs(
            test_db, user_id=test_user.id
        )
        == 1
    )
    test_db.expire_all()
    assert test_db.get(PluginDeviceInstallation, stale_id) is None
    assert test_db.get(PluginDeviceInstallation, active_id).state == "installed"
    assert test_db.get(PluginDeviceInstallation, foreign_id).state == "uninstalling"
    assert (
        plugin_marketplace_service.reconcile_stale_installed_catalog_refs(
            test_db, user_id=test_user.id
        )
        == 0
    )
