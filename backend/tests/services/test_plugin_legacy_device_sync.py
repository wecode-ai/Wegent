from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.models.plugin_marketplace import PluginDeviceInstallation
from app.services.device.capability_sync_service import DeviceCapabilitySyncService
from app.services.plugin_device_installation_service import (
    PluginDeviceInstallationService,
)
from app.services.plugin_marketplace_service import PluginMarketplaceService
from app.services.plugin_package_storage import plugin_package_storage
from tests.services.test_plugin_marketplace_v2 import _create_marketplace_update_install
from tests.services.test_plugin_sync_protocol import _wire_ack, _wire_route

pytestmark = pytest.mark.usefixtures("plugin_write_sessions")


def blocked_install(db, user_id):
    installed, _, old, new = _create_marketplace_update_install(
        db, user_id=user_id, index=86
    )
    db.commit()
    PluginMarketplaceService().update_release(
        db, user_id=user_id, installed_id=installed.id, release_id=new.id
    )
    row = PluginDeviceInstallation(
        installed_kind_id=installed.id,
        user_id=user_id,
        device_id="device",
        desired_release_id=new.id,
        actual_release_id=old.id,
        state="failed",
        attempt_count=3,
    )
    db.add(row)
    db.commit()
    return installed, old, new, row


@pytest.mark.asyncio
async def test_legacy_single_plugin_dispatch_and_ack_preserve_device_release(
    test_db, test_user, monkeypatch
):
    installed, old, new, row = blocked_install(test_db, test_user.id)
    monkeypatch.setattr(
        plugin_package_storage,
        "presign_download",
        lambda key: (f"https://objects.example/{key}", datetime.now()),
    )
    sent = []

    async def acknowledge(_event, payload, **_kwargs):
        sent.append(payload)
        return _wire_ack(payload)

    monkeypatch.setattr(
        "app.services.device.capability_sync_service.runtime_route_resolver.resolve",
        AsyncMock(return_value=_wire_route(versioned=False)),
    )
    monkeypatch.setattr(
        "app.services.device.capability_sync_service.get_sio",
        lambda: SimpleNamespace(call=acknowledge),
    )
    service = DeviceCapabilitySyncService()
    monkeypatch.setattr(service, "supports_plugin_delta", AsyncMock(return_value=False))
    response = await service.sync_installed_plugin_to_device_result(
        test_db,
        user_id=test_user.id,
        device_id="device",
        installed_plugin_id=installed.id,
    )
    assert sent[0]["plugins"][0]["release_id"] == old.id
    assert "plugin_sync" not in sent[0]
    PluginDeviceInstallationService().record_plugin_sync_response(
        test_db, user_id=test_user.id, installed_kind_id=installed.id, response=response
    )
    test_db.refresh(row)
    assert row.actual_release_id == old.id
    assert row.desired_release_id == new.id
    assert row.state == "failed"
    assert row.attempt_count == 3
