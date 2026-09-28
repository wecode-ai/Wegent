# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from contextlib import nullcontext
from unittest.mock import AsyncMock, Mock

import pytest

from app.models.kind import Kind
from app.schemas.device import DeviceCapabilitySyncResult, DeviceType
from app.services.device.capability_sync_service import (
    DeviceCapabilitySyncError,
    DeviceCapabilitySyncService,
    capability_snapshot,
)
from app.services.device.runtime_route import RuntimeRoute


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


def _runtime_route(
    *,
    logical_device_id: str,
    runtime_device_id: str | None = None,
    socket_id: str | None = None,
) -> RuntimeRoute:
    resolved_runtime_id = runtime_device_id or logical_device_id
    return RuntimeRoute(
        logical_device_id=logical_device_id,
        runtime_device_id=resolved_runtime_id,
        runtime_instance_id=None,
        device_type=DeviceType.LOCAL,
        socket_id=socket_id or f"socket-{resolved_runtime_id}",
        online_info={"status": "online"},
    )


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
async def test_build_desired_capabilities_keeps_disabled_plugins_installed(
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
    disabled_plugin = _create_installed_plugin(
        test_db, test_user.id, name="disabled", enabled=False
    )

    service = DeviceCapabilitySyncService(session_factory=lambda: nullcontext(test_db))

    payload = service.build_desired_capabilities(test_db, user_id=test_user.id)

    assert [item["installed_skill_id"] for item in payload["skills"]] == [
        enabled_skill.id
    ]
    assert payload["skills"][0]["skill_id"] == skill.id
    assert payload["skills"][0]["name"] == skill.name
    assert [item["installed_mcp_id"] for item in payload["mcps"]] == [enabled_mcp.id]
    plugins_by_id = {item["installed_plugin_id"]: item for item in payload["plugins"]}
    assert plugins_by_id[enabled_plugin.id]["name"] == "context7"
    assert plugins_by_id[enabled_plugin.id]["enabled"] is True
    assert plugins_by_id[disabled_plugin.id]["enabled"] is False
    assert plugins_by_id[enabled_plugin.id]["marketplace"] == "claude-plugins-official"
    assert plugins_by_id[enabled_plugin.id]["version"] == "1057d02c5307"
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

    async def resolve_route(*, user_id, submitted_device_id):
        return _runtime_route(logical_device_id=submitted_device_id)

    monkeypatch.setattr(
        "app.services.device.capability_sync_service.device_service.get_online_devices",
        fake_online_devices,
    )
    monkeypatch.setattr(
        "app.services.device.capability_sync_service.runtime_route_resolver.resolve",
        resolve_route,
    )
    monkeypatch.setattr(
        "app.services.device.capability_sync_service.get_sio",
        lambda: fake_sio,
    )

    service = DeviceCapabilitySyncService(session_factory=lambda: nullcontext(test_db))

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

    async def fake_online_devices(db, user_id):
        return [{"device_id": "sandbox-1", "socket_device_id": "executor-device-1"}]

    async def resolve_route(*, user_id, submitted_device_id):
        assert submitted_device_id == "executor-device-1"
        return _runtime_route(
            logical_device_id=submitted_device_id,
            socket_id="socket-cloud",
        )

    monkeypatch.setattr(
        "app.services.device.capability_sync_service.device_service.get_online_devices",
        fake_online_devices,
    )
    monkeypatch.setattr(
        "app.services.device.capability_sync_service.runtime_route_resolver.resolve",
        resolve_route,
    )
    monkeypatch.setattr(
        "app.services.device.capability_sync_service.get_sio",
        lambda: fake_sio,
    )

    service = DeviceCapabilitySyncService(session_factory=lambda: nullcontext(test_db))

    result = await service.sync_user_global_capabilities(
        test_db,
        user_id=test_user.id,
    )

    assert result.synced == 1
    assert fake_sio.calls[0]["to"] == "socket-cloud"


@pytest.mark.anyio
async def test_sync_latest_device_capabilities_retries_concurrent_install():
    service = DeviceCapabilitySyncService()
    old = {"mode": "replace", "skills": [], "plugins": [], "mcps": []}
    latest = {
        "mode": "replace",
        "skills": [],
        "plugins": [
            {
                "installed_plugin_id": 42,
                "name": "product-design",
                "marketplace": "wegent",
                "download_path": "https://packages.example.com/first",
            }
        ],
        "mcps": [],
    }
    load_payload = Mock(side_effect=[old, latest, latest])
    dispatch = AsyncMock(
        side_effect=[
            DeviceCapabilitySyncResult(
                device_id="device-1",
                success=False,
                acknowledged=True,
                error="Plugin stale-plugin failed during package: unavailable",
                plugins=[
                    {
                        "id": 7,
                        "name": "stale-plugin",
                        "status": "failed",
                        "stage": "package",
                        "error": "unavailable",
                    }
                ],
            ),
            DeviceCapabilitySyncResult(
                device_id="device-1",
                success=False,
                acknowledged=True,
                error="Plugin stale-plugin failed during package: unavailable",
                plugins=[
                    {
                        "id": 42,
                        "name": "product-design",
                        "status": "synced",
                    }
                ],
            ),
        ]
    )
    service.sync_device_payload = dispatch

    result = await service.sync_latest_device_capabilities(
        user_id=7,
        device_id="device-1",
        load_payload=load_payload,
    )

    assert result.acknowledged is True
    assert result.success is False
    assert dispatch.await_count == 2
    assert dispatch.await_args_list[0].kwargs["payload"] == old
    assert dispatch.await_args_list[1].kwargs["payload"] == latest


@pytest.mark.anyio
async def test_sync_latest_device_capabilities_does_not_retry_transport_failure():
    service = DeviceCapabilitySyncService()
    payload = {"mode": "replace", "skills": [], "plugins": [], "mcps": []}
    load_payload = Mock(side_effect=[payload, AssertionError("must not reload")])
    dispatch = AsyncMock(
        return_value=DeviceCapabilitySyncResult(
            device_id="device-1",
            success=False,
            error="device is offline",
        )
    )
    service.sync_device_payload = dispatch

    result = await service.sync_latest_device_capabilities(
        user_id=7,
        device_id="device-1",
        load_payload=load_payload,
    )

    assert result.acknowledged is False
    assert result.success is False
    assert dispatch.await_count == 1


@pytest.mark.anyio
async def test_sync_latest_device_capabilities_stops_after_bounded_retries():
    service = DeviceCapabilitySyncService()
    payloads = [
        {"mode": "replace", "plugins": [{"installed_plugin_id": index}]}
        for index in range(1, 5)
    ]
    load_payload = Mock(side_effect=payloads)
    dispatch = AsyncMock(
        return_value=DeviceCapabilitySyncResult(
            device_id="device-1",
            success=True,
            acknowledged=True,
        )
    )
    service.sync_device_payload = dispatch

    result = await service.sync_latest_device_capabilities(
        user_id=7,
        device_id="device-1",
        load_payload=load_payload,
    )

    assert result.success is False
    assert result.acknowledged is True
    assert (
        result.error == "Capability desired state kept changing during synchronization"
    )
    assert dispatch.await_count == 3
    assert [call.kwargs["payload"] for call in dispatch.await_args_list] == payloads[:3]


def test_capability_snapshot_ignores_rotating_download_urls():
    first = {
        "mode": "replace",
        "skills": [],
        "plugins": [
            {
                "installed_plugin_id": 42,
                "name": "product-design",
                "marketplace": "wegent",
                "release_id": 3,
                "download_path": "https://packages.example.com/first",
                "download_url_expires_at": "2026-09-16T10:00:00Z",
            }
        ],
        "mcps": [],
    }
    second = {
        **first,
        "plugins": [
            {
                **first["plugins"][0],
                "download_path": "https://packages.example.com/second",
                "download_url_expires_at": "2026-09-16T10:05:00Z",
            }
        ],
    }

    assert capability_snapshot(first) == capability_snapshot(second)
    second["plugins"][0]["release_id"] = 4
    assert capability_snapshot(first) != capability_snapshot(second)


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

    async def resolve_route(*, user_id, submitted_device_id):
        assert submitted_device_id == "sandbox-1"
        return _runtime_route(
            logical_device_id=submitted_device_id,
            runtime_device_id="executor-device-1",
            socket_id="socket-cloud",
        )

    monkeypatch.setattr(
        "app.services.device.capability_sync_service.runtime_route_resolver.resolve",
        resolve_route,
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

    async def resolve_route(*, user_id, submitted_device_id):
        return _runtime_route(
            logical_device_id=submitted_device_id,
            socket_id="socket-local",
        )

    monkeypatch.setattr(
        "app.services.device.capability_sync_service.runtime_route_resolver.resolve",
        resolve_route,
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


@pytest.mark.anyio
async def test_plugin_sync_preserves_structured_device_failure(
    test_db, test_user, monkeypatch
):
    installed_plugin = _create_installed_plugin(
        test_db,
        test_user.id,
        name="wegent-sites",
        marketplace="wegent",
    )
    fake_sio = FakeSio(
        {
            "success": False,
            "plugins": [
                {
                    "id": installed_plugin.id,
                    "name": "wegent-sites",
                    "status": "failed",
                    "stage": "codex_config",
                    "error_code": "INVALID_CODEX_CONFIG",
                    "retryable": False,
                    "error": "Invalid Codex config ~/.codex/config.toml",
                }
            ],
        }
    )

    async def resolve_route(*, user_id, submitted_device_id):
        return _runtime_route(logical_device_id=submitted_device_id)

    monkeypatch.setattr(
        "app.services.device.capability_sync_service.runtime_route_resolver.resolve",
        resolve_route,
    )
    monkeypatch.setattr(
        "app.services.device.capability_sync_service.get_sio",
        lambda: fake_sio,
    )
    service = DeviceCapabilitySyncService()

    response = await service.sync_installed_plugin_to_device_result(
        test_db,
        user_id=test_user.id,
        device_id="device-1",
        installed_plugin_id=installed_plugin.id,
    )

    assert response.success is False
    assert response.plugins[0].stage == "codex_config"
    assert response.plugins[0].error_code == "INVALID_CODEX_CONFIG"
    assert response.plugins[0].error == "Invalid Codex config ~/.codex/config.toml"
    assert response.errors[0]["error"] == (
        "Plugin wegent-sites failed during codex_config: "
        "Invalid Codex config ~/.codex/config.toml"
    )
    with pytest.raises(
        DeviceCapabilitySyncError,
        match="Plugin wegent-sites failed during codex_config",
    ):
        await service.sync_installed_plugin_to_device(
            test_db,
            user_id=test_user.id,
            device_id="device-1",
            installed_plugin_id=installed_plugin.id,
        )
