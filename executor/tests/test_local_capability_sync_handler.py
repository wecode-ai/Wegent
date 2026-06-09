# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import hashlib
import io
import json
import zipfile

import pytest
from executor.modes.local.capabilities import (
    CapabilitySyncHandler,
    GlobalCapabilityStore,
)


class Response:
    def __init__(self, content: bytes):
        self.content = content


def create_plugin_zip(name: str, extra_files: dict[str, str] | None = None) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(".claude-plugin/plugin.json", json.dumps({"name": name}))
        for path, content in (extra_files or {}).items():
            archive.writestr(path, content)
    return buffer.getvalue()


def test_replace_removes_stale_managed_skill_but_keeps_local_user_skill(tmp_path):
    skills_dir = tmp_path / "skills"
    manifest_path = tmp_path / "capabilities.json"
    (skills_dir / "old-managed").mkdir(parents=True)
    (skills_dir / "local-user").mkdir(parents=True)
    (skills_dir / "keep-managed").mkdir(parents=True)
    manifest_path.write_text(
        json.dumps(
            {
                "skills": {
                    "old-managed": {"name": "old-managed", "managed": True},
                    "keep-managed": {"name": "keep-managed", "managed": True},
                },
                "mcps": {},
            }
        )
    )

    store = GlobalCapabilityStore(
        manifest_path=manifest_path,
        skills_dir=skills_dir,
    )
    handler = CapabilitySyncHandler(
        auth_token="token",
        store=store,
        skills_dir=skills_dir,
    )

    result = handler.apply_sync(
        {
            "mode": "replace",
            "skills": [{"name": "keep-managed", "skill_id": 1, "namespace": "default"}],
            "mcps": [],
        }
    )

    assert result["success"] is True
    assert not (skills_dir / "old-managed").exists()
    assert (skills_dir / "local-user").exists()
    assert (skills_dir / "keep-managed").exists()


def test_apply_sync_records_downloaded_skill_and_mcp(tmp_path, monkeypatch):
    skills_dir = tmp_path / "skills"
    manifest_path = tmp_path / "capabilities.json"
    calls = []

    def fake_download(self, skill_name, skill_ref):
        calls.append((skill_name, skill_ref))
        (skills_dir / skill_name).mkdir(parents=True, exist_ok=True)
        return True

    monkeypatch.setattr(
        "executor.modes.local.capabilities.SkillDownloader._download_single_skill",
        fake_download,
    )

    store = GlobalCapabilityStore(
        manifest_path=manifest_path,
        skills_dir=skills_dir,
    )
    handler = CapabilitySyncHandler(
        auth_token="token",
        store=store,
        skills_dir=skills_dir,
    )

    result = handler.apply_sync(
        {
            "mode": "replace",
            "skills": [{"name": "image-gen", "skill_id": 42, "namespace": "default"}],
            "mcps": [
                {
                    "name": "docs",
                    "installed_mcp_id": 7,
                    "server": {"type": "streamable-http", "url": "https://example.com"},
                }
            ],
        }
    )

    assert result["success"] is True
    assert calls == [
        (
            "image-gen",
            {"skill_id": 42, "namespace": "default", "is_public": False},
        )
    ]
    manifest = json.loads(manifest_path.read_text())
    assert manifest["skills"]["image-gen"]["skill_id"] == 42
    assert manifest["mcps"]["docs"]["installed_mcp_id"] == 7


def test_apply_sync_records_plugin_when_package_exists(tmp_path):
    skills_dir = tmp_path / "skills"
    plugins_dir = tmp_path / "plugins"
    manifest_path = tmp_path / "capabilities.json"
    plugin_path = (
        plugins_dir / "cache" / "claude-plugins-official" / "context7" / "1057d02c5307"
    )
    plugin_path.mkdir(parents=True)
    (plugin_path / ".claude-plugin").mkdir()
    (plugin_path / ".claude-plugin" / "plugin.json").write_text(
        json.dumps({"name": "context7"})
    )

    store = GlobalCapabilityStore(
        manifest_path=manifest_path,
        skills_dir=skills_dir,
        plugins_dir=plugins_dir,
    )
    handler = CapabilitySyncHandler(
        auth_token="token",
        store=store,
        skills_dir=skills_dir,
        plugins_dir=plugins_dir,
    )

    result = handler.apply_sync(
        {
            "mode": "replace",
            "skills": [],
            "plugins": [
                {
                    "installed_plugin_id": 9,
                    "name": "context7",
                    "marketplace": "claude-plugins-official",
                    "version": "1057d02c5307",
                    "source": {
                        "type": "marketplace",
                        "marketplace": "claude-plugins-official",
                    },
                }
            ],
            "mcps": [],
        }
    )

    assert result["success"] is True
    assert result["plugins"] == [{"id": 9, "name": "context7", "status": "synced"}]
    installed = json.loads((plugins_dir / "installed_plugins.json").read_text())
    assert installed["plugins"]["context7@claude-plugins-official"][0][
        "installPath"
    ] == str(plugin_path)
    manifest = json.loads(manifest_path.read_text())
    assert (
        manifest["plugins"]["context7@claude-plugins-official"]["installed_plugin_id"]
        == 9
    )


def test_apply_sync_refreshes_plugin_when_checksum_changes(tmp_path, monkeypatch):
    skills_dir = tmp_path / "skills"
    plugins_dir = tmp_path / "plugins"
    manifest_path = tmp_path / "capabilities.json"
    plugin_path = plugins_dir / "cache" / "market" / "context7" / "1.0.0"
    plugin_path.mkdir(parents=True)
    (plugin_path / ".claude-plugin").mkdir()
    (plugin_path / ".claude-plugin" / "plugin.json").write_text(
        json.dumps({"name": "context7"})
    )
    (plugin_path / "old.txt").write_text("old")
    (plugins_dir / "installed_plugins.json").write_text(
        json.dumps(
            {
                "version": 2,
                "plugins": {
                    "context7@market": [
                        {
                            "scope": "user",
                            "installPath": str(plugin_path),
                            "installedPluginId": 9,
                            "checksum": "sha256:old",
                            "version": "1.0.0",
                        }
                    ]
                },
            }
        )
    )
    package = create_plugin_zip("context7", {"new.txt": "new"})
    checksum = "sha256:" + hashlib.sha256(package).hexdigest()

    monkeypatch.setattr(
        "executor.modes.local.capabilities.ApiClient.get",
        lambda *_args, **_kwargs: Response(package),
    )

    store = GlobalCapabilityStore(
        manifest_path=manifest_path,
        skills_dir=skills_dir,
        plugins_dir=plugins_dir,
    )
    handler = CapabilitySyncHandler(
        auth_token="token",
        store=store,
        skills_dir=skills_dir,
        plugins_dir=plugins_dir,
    )

    result = handler.apply_sync(
        {
            "mode": "replace",
            "skills": [],
            "plugins": [
                {
                    "installed_plugin_id": 9,
                    "name": "context7",
                    "marketplace": "market",
                    "version": "1.0.0",
                    "download_path": "/api/plugins/installed/9/download",
                    "checksum": checksum,
                }
            ],
            "mcps": [],
        }
    )

    assert result["success"] is True
    assert not (plugin_path / "old.txt").exists()
    assert (plugin_path / "new.txt").read_text() == "new"
    installed = json.loads((plugins_dir / "installed_plugins.json").read_text())
    assert installed["plugins"]["context7@market"][0]["checksum"] == checksum


def test_extract_plugin_zip_keeps_existing_install_when_package_is_invalid(tmp_path):
    install_path = tmp_path / "plugins" / "context7"
    install_path.mkdir(parents=True)
    (install_path / ".claude-plugin").mkdir()
    (install_path / ".claude-plugin" / "plugin.json").write_text(
        json.dumps({"name": "context7"})
    )
    (install_path / "old.txt").write_text("old")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("README.md", "missing manifest")

    store = GlobalCapabilityStore(
        manifest_path=tmp_path / "capabilities.json",
        skills_dir=tmp_path / "skills",
        plugins_dir=tmp_path / "plugins",
    )
    handler = CapabilitySyncHandler(
        auth_token="token",
        store=store,
        skills_dir=tmp_path / "skills",
        plugins_dir=tmp_path / "plugins",
    )

    with pytest.raises(ValueError):
        handler._extract_plugin_zip(buffer.getvalue(), install_path)

    assert (install_path / "old.txt").read_text() == "old"


def test_extract_plugin_zip_ignores_macos_metadata_for_single_root_plugin(tmp_path):
    install_path = tmp_path / "plugins" / "hookify"
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("hookify/.claude-plugin/plugin.json", "{}")
        archive.writestr("hookify/hooks/test.json", "{}")
        archive.writestr("__MACOSX/._hookify", "")
        archive.writestr("__MACOSX/hookify/._hooks", "")

    store = GlobalCapabilityStore(
        manifest_path=tmp_path / "capabilities.json",
        skills_dir=tmp_path / "skills",
        plugins_dir=tmp_path / "plugins",
    )
    handler = CapabilitySyncHandler(
        auth_token="token",
        store=store,
        skills_dir=tmp_path / "skills",
        plugins_dir=tmp_path / "plugins",
    )

    handler._extract_plugin_zip(buffer.getvalue(), install_path)

    assert (install_path / ".claude-plugin" / "plugin.json").exists()
    assert (install_path / "hooks" / "test.json").exists()
    assert not (install_path / "__MACOSX").exists()


def test_replace_removes_stale_managed_plugin_but_keeps_local_user_plugin(tmp_path):
    skills_dir = tmp_path / "skills"
    plugins_dir = tmp_path / "plugins"
    manifest_path = tmp_path / "capabilities.json"
    keep_path = plugins_dir / "cache" / "market" / "keep-plugin" / "1.0.0"
    keep_path.mkdir(parents=True)
    (plugins_dir / "installed_plugins.json").write_text(
        json.dumps(
            {
                "version": 2,
                "plugins": {
                    "old-plugin@market": [
                        {
                            "scope": "user",
                            "installPath": str(
                                plugins_dir
                                / "cache"
                                / "market"
                                / "old-plugin"
                                / "1.0.0"
                            ),
                            "version": "1.0.0",
                        }
                    ],
                    "keep-plugin@market": [
                        {
                            "scope": "user",
                            "installPath": str(keep_path),
                            "version": "1.0.0",
                        }
                    ],
                    "local-plugin@market": [
                        {
                            "scope": "user",
                            "installPath": str(
                                plugins_dir
                                / "cache"
                                / "market"
                                / "local-plugin"
                                / "1.0.0"
                            ),
                            "version": "1.0.0",
                        }
                    ],
                },
            }
        )
    )
    manifest_path.write_text(
        json.dumps(
            {
                "skills": {},
                "plugins": {
                    "old-plugin@market": {"managed": True},
                    "keep-plugin@market": {"managed": True},
                },
                "mcps": {},
            }
        )
    )
    store = GlobalCapabilityStore(
        manifest_path=manifest_path,
        skills_dir=skills_dir,
        plugins_dir=plugins_dir,
    )
    handler = CapabilitySyncHandler(
        auth_token="token",
        store=store,
        skills_dir=skills_dir,
        plugins_dir=plugins_dir,
    )

    result = handler.apply_sync(
        {
            "mode": "replace",
            "skills": [],
            "plugins": [
                {
                    "name": "keep-plugin",
                    "marketplace": "market",
                    "version": "1.0.0",
                }
            ],
            "mcps": [],
        }
    )

    assert result["success"] is True
    installed = json.loads((plugins_dir / "installed_plugins.json").read_text())
    assert "old-plugin@market" not in installed["plugins"]
    assert "keep-plugin@market" in installed["plugins"]
    assert "local-plugin@market" in installed["plugins"]
