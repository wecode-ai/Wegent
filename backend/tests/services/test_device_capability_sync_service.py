# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.models.kind import Kind
from app.services.device.capability_sync_service import (
    DeviceCapabilitySyncError,
    DeviceCapabilitySyncService,
)


class FakeSio:
    def __init__(self, response=None) -> None:
        self.calls = []
        self.response = response or {"success": True}

    async def call(self, event, payload, to, namespace, timeout):
        self.calls.append(
            {
                "event": event,
                "payload": payload,
                "to": to,
                "namespace": namespace,
                "timeout": timeout,
            }
        )
        return self.response


def _create_skill(test_db, user_id: int, name: str = "image-gen") -> Kind:
    row = Kind(
        user_id=user_id,
        kind="Skill",
        name=name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Skill",
            "metadata": {"name": name, "namespace": "default"},
            "spec": {"description": "Generate images"},
        },
        is_active=True,
    )
    test_db.add(row)
    test_db.commit()
    test_db.refresh(row)
    return row


def _create_installed_skill(
    test_db,
    user_id: int,
    skill: Kind,
    *,
    name: str = "builtin-image-gen",
    enabled: bool = True,
    active: bool = True,
) -> Kind:
    row = Kind(
        user_id=user_id,
        kind="InstalledSkill",
        name=name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "InstalledSkill",
            "metadata": {"name": name, "namespace": "default"},
            "spec": {
                "source": {
                    "type": "system",
                    "providerKey": "builtin",
                    "skillKey": skill.name,
                },
                "skillRef": {
                    "kind": "Skill",
                    "name": skill.name,
                    "namespace": skill.namespace,
                    "user_id": skill.user_id,
                },
                "displayName": "Image Gen",
                "description": "Generate images",
                "installState": "installed",
                "enabled": enabled,
            },
            "status": {"state": "Available"},
        },
        is_active=active,
    )
    test_db.add(row)
    test_db.commit()
    test_db.refresh(row)
    return row


def _create_installed_mcp(
    test_db,
    user_id: int,
    *,
    name: str = "docs",
    enabled: bool = True,
    active: bool = True,
) -> Kind:
    row = Kind(
        user_id=user_id,
        kind="InstalledMCP",
        name=name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "InstalledMCP",
            "metadata": {"name": name, "namespace": "default"},
            "spec": {
                "source": {"type": "custom", "serverKey": name},
                "displayName": "Docs MCP",
                "description": "Search docs",
                "server": {
                    "type": "streamable-http",
                    "url": "https://mcp.example.com/docs",
                },
                "installState": "installed",
                "enabled": enabled,
            },
            "status": {"state": "Available"},
        },
        is_active=active,
    )
    test_db.add(row)
    test_db.commit()
    test_db.refresh(row)
    return row


def _create_installed_plugin(
    test_db,
    user_id: int,
    *,
    name: str = "context7",
    marketplace: str = "claude-plugins-official",
    version: str = "1057d02c5307",
    enabled: bool = True,
    active: bool = True,
) -> Kind:
    row = Kind(
        user_id=user_id,
        kind="InstalledPlugin",
        name=name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "InstalledPlugin",
            "metadata": {"name": name, "namespace": "default"},
            "spec": {
                "source": {
                    "type": "marketplace",
                    "marketplace": marketplace,
                    "plugin": name,
                },
                "displayName": "Context7",
                "description": "Docs lookup",
                "marketplace": marketplace,
                "version": version,
                "installState": "installed",
                "enabled": enabled,
            },
            "status": {"state": "Available"},
        },
        is_active=active,
    )
    test_db.add(row)
    test_db.commit()
    test_db.refresh(row)
    return row


@pytest.mark.anyio
async def test_build_desired_capabilities_includes_only_enabled_installed_items(
    test_db, test_user
):
    skill = _create_skill(test_db, test_user.id)
    enabled_skill = _create_installed_skill(test_db, test_user.id, skill)
    _create_installed_skill(
        test_db,
        test_user.id,
        skill,
        name="builtin-disabled",
        enabled=False,
    )
    enabled_mcp = _create_installed_mcp(test_db, test_user.id)
    _create_installed_mcp(test_db, test_user.id, name="disabled", enabled=False)
    enabled_plugin = _create_installed_plugin(test_db, test_user.id)
    _create_installed_plugin(test_db, test_user.id, name="disabled", enabled=False)

    service = DeviceCapabilitySyncService()

    payload = service.build_desired_capabilities(test_db, user_id=test_user.id)

    assert [item["installed_skill_id"] for item in payload["skills"]] == [
        enabled_skill.id
    ]
    assert payload["skills"][0]["skill_id"] == skill.id
    assert payload["skills"][0]["name"] == skill.name
    assert [item["installed_mcp_id"] for item in payload["mcps"]] == [enabled_mcp.id]
    assert [item["installed_plugin_id"] for item in payload["plugins"]] == [
        enabled_plugin.id
    ]
    assert payload["plugins"][0]["name"] == "context7"
    assert payload["plugins"][0]["marketplace"] == "claude-plugins-official"
    assert payload["plugins"][0]["version"] == "1057d02c5307"
    assert payload["mode"] == "replace"


@pytest.mark.anyio
async def test_sync_user_global_capabilities_replaces_all_online_devices(
    test_db, test_user, monkeypatch
):
    skill = _create_skill(test_db, test_user.id)
    _create_installed_skill(test_db, test_user.id, skill)
    _create_installed_mcp(test_db, test_user.id)
    fake_sio = FakeSio()

    async def fake_online_devices(db, user_id):
        return [{"device_id": "device-a"}, {"device_id": "device-b"}]

    async def fake_online_info(user_id, device_id):
        return {"socket_id": f"socket-{device_id}", "status": "online"}

    monkeypatch.setattr(
        "app.services.device.capability_sync_service.device_service.get_online_devices",
        fake_online_devices,
    )
    monkeypatch.setattr(
        "app.services.device.capability_sync_service.device_service.get_device_online_info",
        fake_online_info,
    )
    monkeypatch.setattr(
        "app.services.device.capability_sync_service.get_sio",
        lambda: fake_sio,
    )

    service = DeviceCapabilitySyncService()

    result = await service.sync_user_global_capabilities(
        test_db,
        user_id=test_user.id,
    )

    assert result.synced == 2
    assert result.failed == 0
    assert [call["to"] for call in fake_sio.calls] == [
        "socket-device-a",
        "socket-device-b",
    ]
    assert all(call["event"] == "device:sync_capabilities" for call in fake_sio.calls)
    assert all(call["payload"]["mode"] == "replace" for call in fake_sio.calls)


@pytest.mark.anyio
async def test_sync_user_global_capabilities_uses_cloud_socket_device_id(
    test_db, test_user, monkeypatch
):
    fake_sio = FakeSio()
    seen_device_ids = []

    async def fake_online_devices(db, user_id):
        return [{"device_id": "sandbox-1", "socket_device_id": "executor-device-1"}]

    async def fake_online_info(user_id, device_id):
        seen_device_ids.append(device_id)
        return {"socket_id": "socket-cloud", "status": "online"}

    monkeypatch.setattr(
        "app.services.device.capability_sync_service.device_service.get_online_devices",
        fake_online_devices,
    )
    monkeypatch.setattr(
        "app.services.device.capability_sync_service.device_service.get_device_online_info",
        fake_online_info,
    )
    monkeypatch.setattr(
        "app.services.device.capability_sync_service.get_sio",
        lambda: fake_sio,
    )

    service = DeviceCapabilitySyncService()

    result = await service.sync_user_global_capabilities(
        test_db,
        user_id=test_user.id,
    )

    assert result.synced == 1
    assert seen_device_ids == ["executor-device-1"]
    assert fake_sio.calls[0]["to"] == "socket-cloud"


@pytest.mark.anyio
async def test_sync_installed_plugin_to_device_merges_only_target_plugin(
    test_db, test_user, monkeypatch
):
    device = Kind(
        user_id=test_user.id,
        kind="Device",
        name="sandbox-1",
        namespace="default",
        json={
            "spec": {
                "deviceId": "executor-device-1",
                "deviceType": "cloud",
            }
        },
        is_active=True,
    )
    test_db.add(device)
    test_db.commit()
    unrelated_skill = _create_skill(test_db, test_user.id, name="init-project")
    _create_installed_skill(test_db, test_user.id, unrelated_skill)
    installed_plugin = _create_installed_plugin(
        test_db,
        test_user.id,
        name="wegent-sites",
        marketplace="wegent",
    )
    fake_sio = FakeSio(
        {
            "success": True,
            "plugins": [
                {
                    "id": installed_plugin.id,
                    "name": "wegent-sites",
                    "status": "synced",
                }
            ],
        }
    )
    seen_device_ids = []

    async def fake_all_devices(db, user_id):
        return [{"device_id": "sandbox-1", "socket_device_id": "executor-device-1"}]

    async def fake_online_info(user_id, device_id):
        seen_device_ids.append(device_id)
        return {"socket_id": "socket-cloud", "status": "online"}

    monkeypatch.setattr(
        "app.services.device.capability_sync_service.device_service.get_all_devices",
        fake_all_devices,
    )
    monkeypatch.setattr(
        "app.services.device.capability_sync_service.device_service.get_device_online_info",
        fake_online_info,
    )
    monkeypatch.setattr(
        "app.services.device.capability_sync_service.get_sio",
        lambda: fake_sio,
    )

    result = await DeviceCapabilitySyncService().sync_installed_plugin_to_device(
        test_db,
        user_id=test_user.id,
        device_id="sandbox-1",
        installed_plugin_id=installed_plugin.id,
    )

    assert result.success is True
    assert result.mode == "merge"
    assert result.synced == 1
    assert result.failed == 0
    assert seen_device_ids == ["executor-device-1"]
    payload = fake_sio.calls[0]["payload"]
    assert payload["device_id"] == "executor-device-1"
    assert payload["mode"] == "merge"
    assert payload["skills"] == []
    assert payload.get("mcps", []) == []
    assert [item["installed_plugin_id"] for item in payload["plugins"]] == [
        installed_plugin.id
    ]
    assert fake_sio.calls[0]["to"] == "socket-cloud"


@pytest.mark.anyio
async def test_sync_installed_plugin_to_device_rejects_missing_acknowledgement(
    test_db, test_user, monkeypatch
):
    device = Kind(
        user_id=test_user.id,
        kind="Device",
        name="device-1",
        namespace="default",
        json={"spec": {"deviceId": "device-1", "deviceType": "local"}},
        is_active=True,
    )
    installed_plugin = _create_installed_plugin(
        test_db,
        test_user.id,
        name="wegent-sites",
        marketplace="wegent",
    )
    test_db.add(device)
    test_db.commit()
    fake_sio = FakeSio({"success": True, "plugins": []})

    async def fake_all_devices(db, user_id):
        return [{"device_id": "device-1"}]

    async def fake_online_info(user_id, device_id):
        return {"socket_id": "socket-local", "status": "online"}

    monkeypatch.setattr(
        "app.services.device.capability_sync_service.device_service.get_all_devices",
        fake_all_devices,
    )
    monkeypatch.setattr(
        "app.services.device.capability_sync_service.device_service.get_device_online_info",
        fake_online_info,
    )
    monkeypatch.setattr(
        "app.services.device.capability_sync_service.get_sio",
        lambda: fake_sio,
    )

    with pytest.raises(DeviceCapabilitySyncError, match="not acknowledged"):
        await DeviceCapabilitySyncService().sync_installed_plugin_to_device(
            test_db,
            user_id=test_user.id,
            device_id="device-1",
            installed_plugin_id=installed_plugin.id,
        )
