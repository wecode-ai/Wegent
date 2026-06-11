# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.models.kind import Kind
from app.models.user import User
from app.services.device.capability_sync_service import (
    DeviceCapabilityResolutionError,
    device_capability_sync_service,
)


def _skill(skill_id: int, user_id: int, name: str, mcp_servers=None) -> Kind:
    return Kind(
        id=skill_id,
        user_id=user_id,
        kind="Skill",
        name=name,
        namespace="default",
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Skill",
            "metadata": {"name": name, "namespace": "default"},
            "spec": {
                "description": "test skill",
                "prompt": "Use the test skill.",
                **({"mcpServers": mcp_servers} if mcp_servers else {}),
            },
        },
    )


def test_resolve_payload_authorizes_skills_without_deriving_mcp(test_db):
    own_skill = _skill(
        101,
        7,
        "image-helper",
        {
            "image-server": {
                "type": "http",
                "url": "https://skill-derived.example/mcp",
            }
        },
    )
    public_skill = _skill(102, 0, "public-helper")
    test_db.add_all([own_skill, public_skill])
    test_db.flush()
    user = User(id=7, user_name="alice")

    resolved = device_capability_sync_service.resolve_payload(
        test_db,
        user=user,
        skill_ids=[101, 102],
        mcp_ids=[],
        mode="merge",
    )

    assert [skill["id"] for skill in resolved["skills"]] == [101, 102]
    assert resolved["skills"][0]["download_path"] == (
        "/api/v1/kinds/skills/101/download?namespace=default"
    )
    assert "mcps" not in resolved


def test_resolve_payload_rejects_mcp_ids(test_db):
    user = User(id=7, user_name="alice")

    with pytest.raises(DeviceCapabilityResolutionError) as exc:
        device_capability_sync_service.resolve_payload(
            test_db,
            user=user,
            skill_ids=[],
            mcp_ids=["dingtalk/docs"],
            mode="merge",
        )

    assert exc.value.status_code == 422
    assert "MCP capability sync is temporarily disabled" in str(exc.value)


def test_resolve_payload_rejects_unauthorized_skill(test_db):
    test_db.add(_skill(201, 99, "other-user-skill"))
    test_db.flush()
    user = User(id=7, user_name="alice")

    with pytest.raises(DeviceCapabilityResolutionError) as exc:
        device_capability_sync_service.resolve_payload(
            test_db,
            user=user,
            skill_ids=[201],
            mcp_ids=[],
            mode="merge",
        )

    assert exc.value.status_code == 404


def test_resolve_payload_includes_selected_installed_plugins(test_db):
    installed = Kind(
        id=301,
        user_id=7,
        kind="InstalledPlugin",
        name="context7",
        namespace="default",
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "InstalledPlugin",
            "metadata": {"name": "context7", "namespace": "default"},
            "spec": {
                "source": {
                    "type": "marketplace",
                    "marketplace": "claude-plugins-official",
                    "plugin": "context7",
                },
                "marketplace": "claude-plugins-official",
                "version": "1057d02c5307",
                "displayName": "Context7",
                "description": "Docs lookup",
                "installState": "installed",
                "enabled": True,
            },
        },
    )
    test_db.add(installed)
    test_db.flush()
    user = User(id=7, user_name="alice")

    resolved = device_capability_sync_service.resolve_payload(
        test_db,
        user=user,
        skill_ids=[],
        installed_plugin_ids=[301],
        mcp_ids=[],
        mode="merge",
    )

    assert resolved["plugins"] == [
        {
            "installed_plugin_id": 301,
            "name": "context7",
            "display_name": "Context7",
            "description": "Docs lookup",
            "marketplace": "claude-plugins-official",
            "version": "1057d02c5307",
            "source": {
                "type": "marketplace",
                "marketplace": "claude-plugins-official",
                "plugin": "context7",
            },
        }
    ]


def test_resolve_payload_uses_uploaded_plugin_key_and_download_ref(test_db):
    installed = Kind(
        id=302,
        user_id=7,
        kind="InstalledPlugin",
        name="superpowers-4ab1d13f2c",
        namespace="default",
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "InstalledPlugin",
            "metadata": {"name": "superpowers-4ab1d13f2c", "namespace": "default"},
            "spec": {
                "source": {
                    "type": "upload",
                    "providerKey": "claude-code",
                    "pluginKey": "superpowers",
                },
                "displayName": "Superpowers",
                "description": "Core skills",
                "version": "5.0.7",
                "installState": "installed",
                "enabled": True,
                "packageRef": {
                    "storageKey": "skill-binaries/302",
                    "checksum": "sha256:abc123",
                    "sizeBytes": 100,
                },
            },
        },
    )
    test_db.add(installed)
    test_db.flush()
    user = User(id=7, user_name="alice")

    resolved = device_capability_sync_service.resolve_payload(
        test_db,
        user=user,
        skill_ids=[],
        installed_plugin_ids=[302],
        mode="merge",
    )

    assert resolved["plugins"] == [
        {
            "installed_plugin_id": 302,
            "name": "superpowers",
            "display_name": "Superpowers",
            "description": "Core skills",
            "marketplace": None,
            "version": "5.0.7",
            "source": {
                "type": "upload",
                "providerKey": "claude-code",
                "pluginKey": "superpowers",
            },
            "checksum": "sha256:abc123",
            "download_path": "/api/plugins/installed/302/download",
        }
    ]
