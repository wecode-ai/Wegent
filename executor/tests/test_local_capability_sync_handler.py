# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import hashlib
import io
import json
import tomllib
import zipfile
from pathlib import Path

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


def create_nested_plugin_zip(
    name: str,
    version: str,
    extra_files: dict[str, str] | None = None,
) -> bytes:
    buffer = io.BytesIO()
    root = f"{name}/{version}"
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            f"{root}/.claude-plugin/plugin.json",
            json.dumps({"name": name, "version": version}),
        )
        for path, content in (extra_files or {}).items():
            archive.writestr(f"{root}/{path}", content)
    return buffer.getvalue()


def test_replace_removes_stale_managed_skill_but_keeps_local_user_skill(tmp_path):
    skills_dir = tmp_path / "skills"
    codex_skills_dir = tmp_path / ".codex" / "skills"
    store_dir = tmp_path / "store"
    manifest_path = tmp_path / "capabilities.json"
    old_store_skill = store_dir / "skills" / "1-default-old-managed"
    old_store_skill.mkdir(parents=True)
    (old_store_skill / "SKILL.md").write_text("---\nname: old-managed\n---\n")
    skills_dir.mkdir(parents=True)
    codex_skills_dir.mkdir(parents=True)
    (skills_dir / "old-managed").symlink_to(old_store_skill, target_is_directory=True)
    (codex_skills_dir / "old-managed").symlink_to(
        old_store_skill, target_is_directory=True
    )
    (skills_dir / "local-user").mkdir(parents=True)
    (skills_dir / "keep-managed").mkdir(parents=True)
    (skills_dir / "keep-managed" / "SKILL.md").write_text(
        "---\nname: keep-managed\n---\n"
    )
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
        codex_skills_dir=codex_skills_dir,
        store_dir=store_dir,
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
    assert not (codex_skills_dir / "old-managed").exists()
    assert (skills_dir / "local-user").exists()
    assert (skills_dir / "keep-managed").exists()


def test_apply_sync_records_downloaded_skill_and_mcp(tmp_path, monkeypatch):
    skills_dir = tmp_path / ".claude" / "skills"
    store_dir = tmp_path / ".wegent-executor" / "capabilities" / "store"
    manifest_path = tmp_path / "capabilities.json"
    calls = []

    def fake_download(self, skill_name, skill_ref):
        calls.append((skill_name, skill_ref))
        extracted = Path(self.skills_dir) / skill_name
        extracted.mkdir(parents=True, exist_ok=True)
        (extracted / "SKILL.md").write_text(f"---\nname: {skill_name}\n---\n")
        return True

    monkeypatch.setattr(
        "executor.modes.local.capabilities.SkillDownloader._download_single_skill",
        fake_download,
    )

    store = GlobalCapabilityStore(
        manifest_path=manifest_path,
        skills_dir=skills_dir,
        store_dir=store_dir,
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
    store_path = store_dir / "skills" / "42-default-image-gen"
    runtime_link = skills_dir / "image-gen"
    codex_link = tmp_path / ".codex" / "skills" / "image-gen"
    assert store_path.is_dir()
    assert runtime_link.is_symlink()
    assert runtime_link.resolve() == store_path.resolve()
    assert codex_link.is_symlink()
    assert codex_link.resolve() == store_path.resolve()
    assert manifest["skills"]["image-gen"]["store_path"] == str(store_path)
    assert manifest["skills"]["image-gen"]["runtime"]["claude_link"] == str(
        runtime_link
    )
    assert manifest["skills"]["image-gen"]["runtime"]["codex_link"] == str(codex_link)
    assert manifest["mcps"]["docs"]["installed_mcp_id"] == 7


def test_apply_sync_writes_mcps_to_claude_and_codex_global_configs(tmp_path):
    skills_dir = tmp_path / ".claude" / "skills"
    plugins_dir = tmp_path / ".claude" / "plugins"
    store_dir = tmp_path / ".wegent-executor" / "capabilities" / "store"
    manifest_path = tmp_path / ".wegent-executor" / "capabilities" / "manifest.json"
    claude_config_path = tmp_path / ".claude.json"
    codex_config_path = tmp_path / ".codex" / "config.toml"
    claude_config_path.write_text(
        json.dumps(
            {
                "mcpServers": {
                    "local": {"type": "stdio", "command": "local-tool"},
                }
            }
        )
    )
    codex_config_path.parent.mkdir(parents=True)
    codex_config_path.write_text(
        'model = "gpt-5"\n\n' "[mcp_servers.local]\n" 'command = "local-tool"\n'
    )
    store = GlobalCapabilityStore(
        manifest_path=manifest_path,
        skills_dir=skills_dir,
        plugins_dir=plugins_dir,
        store_dir=store_dir,
        claude_mcp_config_path=claude_config_path,
        codex_config_path=codex_config_path,
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
            "plugins": [],
            "mcps": [
                {
                    "name": "docs",
                    "installed_mcp_id": 7,
                    "server": {
                        "type": "streamable-http",
                        "url": "https://mcp.example.com/docs",
                        "headers": {"Authorization": "Bearer test"},
                    },
                },
                {
                    "name": "shell",
                    "installed_mcp_id": 8,
                    "server": {
                        "type": "stdio",
                        "command": "uvx",
                        "args": ["tool", "--flag"],
                        "env": {"FOO": "bar"},
                    },
                },
            ],
        }
    )

    assert result["success"] is True
    claude_config = json.loads(claude_config_path.read_text())
    assert claude_config["mcpServers"]["local"]["command"] == "local-tool"
    assert claude_config["mcpServers"]["docs"] == {
        "type": "http",
        "url": "https://mcp.example.com/docs",
        "headers": {"Authorization": "Bearer test"},
    }
    assert claude_config["mcpServers"]["shell"] == {
        "type": "stdio",
        "command": "uvx",
        "args": ["tool", "--flag"],
        "env": {"FOO": "bar"},
    }
    codex_config = tomllib.loads(codex_config_path.read_text())
    assert codex_config["model"] == "gpt-5"
    assert codex_config["mcp_servers"]["local"]["command"] == "local-tool"
    assert codex_config["mcp_servers"]["docs"]["url"] == "https://mcp.example.com/docs"
    assert codex_config["mcp_servers"]["shell"]["command"] == "uvx"
    assert codex_config["mcp_servers"]["shell"]["args"] == ["tool", "--flag"]
    assert codex_config["mcp_servers"]["shell"]["env"] == {"FOO": "bar"}


def test_replace_sync_removes_stale_managed_mcps_from_global_configs(tmp_path):
    skills_dir = tmp_path / ".claude" / "skills"
    plugins_dir = tmp_path / ".claude" / "plugins"
    store_dir = tmp_path / ".wegent-executor" / "capabilities" / "store"
    manifest_path = tmp_path / ".wegent-executor" / "capabilities" / "manifest.json"
    claude_config_path = tmp_path / ".claude.json"
    codex_config_path = tmp_path / ".codex" / "config.toml"
    manifest_path.parent.mkdir(parents=True)
    manifest_path.write_text(
        json.dumps(
            {
                "version": 1,
                "revision": 1,
                "skills": {},
                "plugins": {},
                "mcps": {"old": {"managed": True, "server": {"command": "old-tool"}}},
            }
        )
    )
    claude_config_path.write_text(
        json.dumps(
            {
                "mcpServers": {
                    "old": {"type": "stdio", "command": "old-tool"},
                    "local": {"type": "stdio", "command": "local-tool"},
                }
            }
        )
    )
    codex_config_path.parent.mkdir(parents=True)
    codex_config_path.write_text(
        "[mcp_servers.old]\n"
        'command = "old-tool"\n\n'
        "[mcp_servers.local]\n"
        'command = "local-tool"\n'
    )
    store = GlobalCapabilityStore(
        manifest_path=manifest_path,
        skills_dir=skills_dir,
        plugins_dir=plugins_dir,
        store_dir=store_dir,
        claude_mcp_config_path=claude_config_path,
        codex_config_path=codex_config_path,
    )
    handler = CapabilitySyncHandler(
        auth_token="token",
        store=store,
        skills_dir=skills_dir,
        plugins_dir=plugins_dir,
    )

    result = handler.apply_sync(
        {"mode": "replace", "skills": [], "plugins": [], "mcps": []}
    )

    assert result["success"] is True
    claude_config = json.loads(claude_config_path.read_text())
    assert "old" not in claude_config["mcpServers"]
    assert claude_config["mcpServers"]["local"]["command"] == "local-tool"
    codex_config = tomllib.loads(codex_config_path.read_text())
    assert "old" not in codex_config["mcp_servers"]
    assert codex_config["mcp_servers"]["local"]["command"] == "local-tool"


def test_apply_sync_redownloads_managed_skill_when_runtime_link_is_broken(
    tmp_path, monkeypatch
):
    skills_dir = tmp_path / ".claude" / "skills"
    store_dir = tmp_path / ".wegent-executor" / "capabilities" / "store"
    manifest_path = tmp_path / "capabilities.json"
    missing_store_skill = store_dir / "skills" / "42-default-image-gen"
    runtime_link = skills_dir / "image-gen"
    runtime_link.parent.mkdir(parents=True)
    runtime_link.symlink_to(missing_store_skill, target_is_directory=True)
    manifest_path.write_text(
        json.dumps(
            {
                "skills": {
                    "image-gen": {
                        "skill_id": 42,
                        "namespace": "default",
                        "managed": True,
                        "store_path": str(missing_store_skill),
                        "runtime": {"claude_link": str(runtime_link)},
                    }
                },
                "plugins": {},
                "mcps": {},
            }
        )
    )

    def fake_download(self, skill_name, skill_ref):
        extracted = Path(self.skills_dir) / skill_name
        extracted.mkdir(parents=True, exist_ok=True)
        (extracted / "SKILL.md").write_text(f"---\nname: {skill_name}\n---\n")
        return True

    monkeypatch.setattr(
        "executor.modes.local.capabilities.SkillDownloader._download_single_skill",
        fake_download,
    )

    store = GlobalCapabilityStore(
        manifest_path=manifest_path,
        skills_dir=skills_dir,
        store_dir=store_dir,
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
            "plugins": [],
            "mcps": [],
        }
    )

    assert result["success"] is True
    assert result["skills"] == [{"id": 42, "name": "image-gen", "status": "synced"}]
    assert (missing_store_skill / "SKILL.md").exists()
    assert runtime_link.is_symlink()
    assert runtime_link.resolve() == missing_store_skill.resolve()
    manifest = json.loads(manifest_path.read_text())
    assert manifest["skills"]["image-gen"]["store_path"] == str(missing_store_skill)


def test_apply_sync_records_plugin_when_package_exists(tmp_path):
    skills_dir = tmp_path / "skills"
    plugins_dir = tmp_path / ".claude" / "plugins"
    store_dir = tmp_path / "capability-store"
    manifest_path = tmp_path / "capabilities.json"
    store_plugin_path = (
        store_dir / "plugins" / "9-claude-plugins-official-context7-1057d02c5307"
    )
    store_plugin_path.mkdir(parents=True)
    (store_plugin_path / ".claude-plugin").mkdir()
    (store_plugin_path / ".claude-plugin" / "plugin.json").write_text(
        json.dumps({"name": "context7"})
    )

    store = GlobalCapabilityStore(
        manifest_path=manifest_path,
        skills_dir=skills_dir,
        plugins_dir=plugins_dir,
        store_dir=store_dir,
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
    runtime_link = (
        plugins_dir / "cache" / "claude-plugins-official" / "context7" / "1057d02c5307"
    )
    assert runtime_link.is_symlink()
    assert runtime_link.resolve() == store_plugin_path.resolve()
    codex_link = tmp_path / ".codex" / "plugins" / "context7-claude-plugins-official"
    assert codex_link.is_symlink()
    assert codex_link.resolve() == store_plugin_path.resolve()
    installed = json.loads((plugins_dir / "installed_plugins.json").read_text())
    assert installed["plugins"]["context7@claude-plugins-official"][0][
        "installPath"
    ] == str(runtime_link)
    manifest = json.loads(manifest_path.read_text())
    assert (
        manifest["plugins"]["context7@claude-plugins-official"]["installed_plugin_id"]
        == 9
    )
    assert manifest["plugins"]["context7@claude-plugins-official"]["store_path"] == str(
        store_plugin_path
    )
    assert manifest["plugins"]["context7@claude-plugins-official"]["runtime"][
        "codex_link"
    ] == str(codex_link)
    settings = json.loads((plugins_dir.parent / "settings.json").read_text())
    assert settings["enabledPlugins"]["context7@claude-plugins-official"] is True


def test_reconcile_restores_managed_plugin_enablement_from_manifest(tmp_path):
    skills_dir = tmp_path / ".claude" / "skills"
    plugins_dir = tmp_path / ".claude" / "plugins"
    codex_plugins_dir = tmp_path / ".codex" / "plugins"
    store_dir = tmp_path / "capability-store"
    manifest_path = tmp_path / "capabilities.json"
    store_plugin_path = store_dir / "plugins" / "1614-wegent-superpowers-5.0.7"
    plugin_skill_path = store_plugin_path / "skills" / "systematic-debugging"
    plugin_skill_path.mkdir(parents=True)
    (store_plugin_path / ".claude-plugin").mkdir()
    (store_plugin_path / ".claude-plugin" / "plugin.json").write_text(
        json.dumps({"name": "superpowers", "version": "5.0.7"})
    )
    (plugin_skill_path / "SKILL.md").write_text(
        "---\n"
        "name: systematic-debugging\n"
        "description: Use when encountering bugs.\n"
        "---\n"
    )
    runtime_link = plugins_dir / "cache" / "wegent" / "superpowers" / "5.0.7"
    codex_link = codex_plugins_dir / "superpowers-wegent"
    plugins_dir.mkdir(parents=True)
    (plugins_dir / "installed_plugins.json").write_text(
        json.dumps({"version": 2, "plugins": {}})
    )
    (plugins_dir.parent / "settings.json").write_text(
        json.dumps({"enabledPlugins": {"context7@market": True}})
    )
    manifest_path.write_text(
        json.dumps(
            {
                "version": 1,
                "revision": 1,
                "skills": {},
                "plugins": {
                    "superpowers@wegent": {
                        "name": "superpowers",
                        "key": "superpowers@wegent",
                        "installed_plugin_id": 1614,
                        "marketplace": "wegent",
                        "version": "5.0.7",
                        "checksum": "sha256:abc",
                        "component_states": {"skill:systematic-debugging": True},
                        "store_path": str(store_plugin_path),
                        "runtime": {
                            "claude_link": str(runtime_link),
                            "codex_link": str(codex_link),
                        },
                        "managed": True,
                    }
                },
                "mcps": {},
            }
        )
    )

    store = GlobalCapabilityStore(
        manifest_path=manifest_path,
        skills_dir=skills_dir,
        plugins_dir=plugins_dir,
        codex_plugins_dir=codex_plugins_dir,
        store_dir=store_dir,
    )

    restored = store.reconcile_managed_plugins()

    assert restored == ["superpowers@wegent"]
    assert runtime_link.is_symlink()
    assert runtime_link.resolve() == store_plugin_path.resolve()
    assert codex_link.is_symlink()
    assert codex_link.resolve() == store_plugin_path.resolve()
    installed = json.loads((plugins_dir / "installed_plugins.json").read_text())
    assert installed["plugins"]["superpowers@wegent"][0] == {
        "checksum": "sha256:abc",
        "componentStates": {"skill:systematic-debugging": True},
        "installPath": str(runtime_link),
        "installedAt": installed["plugins"]["superpowers@wegent"][0]["installedAt"],
        "installedPluginId": 1614,
        "lastUpdated": installed["plugins"]["superpowers@wegent"][0]["lastUpdated"],
        "scope": "user",
        "version": "5.0.7",
    }
    settings = json.loads((plugins_dir.parent / "settings.json").read_text())
    assert settings["enabledPlugins"] == {
        "context7@market": True,
        "superpowers@wegent": True,
    }
    known_marketplaces = json.loads(
        (plugins_dir / "known_marketplaces.json").read_text()
    )
    assert known_marketplaces["wegent"]["installLocation"] == str(
        plugins_dir / "marketplaces" / "wegent"
    )
    marketplace_plugin_link = (
        plugins_dir / "marketplaces" / "wegent" / "plugins" / "superpowers-wegent"
    )
    assert marketplace_plugin_link.is_symlink()
    assert marketplace_plugin_link.resolve() == store_plugin_path.resolve()
    marketplace_json = json.loads(
        (
            plugins_dir
            / "marketplaces"
            / "wegent"
            / ".claude-plugin"
            / "marketplace.json"
        ).read_text()
    )
    assert marketplace_json["plugins"] == [
        {
            "description": "",
            "name": "superpowers",
            "source": "./plugins/superpowers-wegent",
            "version": "5.0.7",
        }
    ]


def test_apply_sync_refreshes_plugin_when_checksum_changes(tmp_path, monkeypatch):
    skills_dir = tmp_path / "skills"
    plugins_dir = tmp_path / "plugins"
    store_dir = tmp_path / "store"
    manifest_path = tmp_path / "capabilities.json"
    store_plugin_path = store_dir / "plugins" / "9-market-context7-1.0.0"
    runtime_link = plugins_dir / "cache" / "market" / "context7" / "1.0.0"
    store_plugin_path.mkdir(parents=True)
    (store_plugin_path / ".claude-plugin").mkdir()
    (store_plugin_path / ".claude-plugin" / "plugin.json").write_text(
        json.dumps({"name": "context7"})
    )
    (store_plugin_path / "old.txt").write_text("old")
    plugins_dir.mkdir(parents=True)
    (plugins_dir / "installed_plugins.json").write_text(
        json.dumps(
            {
                "version": 2,
                "plugins": {
                    "context7@market": [
                        {
                            "scope": "user",
                            "installPath": str(runtime_link),
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
        store_dir=store_dir,
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
    assert not (store_plugin_path / "old.txt").exists()
    assert (store_plugin_path / "new.txt").read_text() == "new"
    assert runtime_link.is_symlink()
    assert runtime_link.resolve() == store_plugin_path.resolve()
    codex_link = tmp_path / ".codex" / "plugins" / "context7-market"
    assert codex_link.is_symlink()
    assert codex_link.resolve() == store_plugin_path.resolve()
    installed = json.loads((plugins_dir / "installed_plugins.json").read_text())
    assert installed["plugins"]["context7@market"][0]["checksum"] == checksum


def test_apply_sync_downloads_uploaded_plugin_into_store(tmp_path, monkeypatch):
    skills_dir = tmp_path / "skills"
    plugins_dir = tmp_path / "plugins"
    store_dir = tmp_path / "store"
    manifest_path = tmp_path / "capabilities.json"
    package = create_nested_plugin_zip(
        "superpowers",
        "5.0.7",
        {"skills/debugging/SKILL.md": "# Debug"},
    )
    checksum = "sha256:" + hashlib.sha256(package).hexdigest()

    monkeypatch.setattr(
        "executor.modes.local.capabilities.ApiClient.get",
        lambda *_args, **_kwargs: Response(package),
    )

    store = GlobalCapabilityStore(
        manifest_path=manifest_path,
        skills_dir=skills_dir,
        plugins_dir=plugins_dir,
        store_dir=store_dir,
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
                    "installed_plugin_id": 302,
                    "name": "superpowers",
                    "version": "5.0.7",
                    "source": {
                        "type": "upload",
                        "providerKey": "claude-code",
                        "pluginKey": "superpowers",
                    },
                    "download_path": "/api/plugins/installed/302/download",
                    "checksum": checksum,
                }
            ],
            "mcps": [],
        }
    )

    assert result["success"] is True
    assert result["plugins"] == [{"id": 302, "name": "superpowers", "status": "synced"}]
    store_plugin_path = store_dir / "plugins" / "302-wegent-superpowers-5.0.7"
    assert (store_plugin_path / ".claude-plugin" / "plugin.json").exists()
    assert (store_plugin_path / "skills" / "debugging" / "SKILL.md").read_text() == (
        "# Debug"
    )
    runtime_link = plugins_dir / "cache" / "wegent" / "superpowers" / "5.0.7"
    assert runtime_link.is_symlink()
    assert runtime_link.resolve() == store_plugin_path.resolve()
    codex_link = tmp_path / ".codex" / "plugins" / "superpowers-wegent"
    assert codex_link.is_symlink()
    assert codex_link.resolve() == store_plugin_path.resolve()
    manifest = json.loads(manifest_path.read_text())
    assert manifest["plugins"]["superpowers@wegent"]["store_path"] == str(
        store_plugin_path
    )


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


def test_extract_plugin_zip_normalizes_nested_plugin_root(tmp_path):
    install_path = tmp_path / "plugins" / "superpowers"
    package = create_nested_plugin_zip(
        "superpowers",
        "5.0.7",
        {"skills/debugging/SKILL.md": "# Debug"},
    )

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

    handler._extract_plugin_zip(package, install_path)

    assert (install_path / ".claude-plugin" / "plugin.json").exists()
    assert (install_path / "skills" / "debugging" / "SKILL.md").read_text() == (
        "# Debug"
    )
    assert not (install_path / "superpowers").exists()


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
                    "old-plugin@market": {
                        "managed": True,
                        "runtime": {
                            "claude_link": str(
                                plugins_dir
                                / "cache"
                                / "market"
                                / "old-plugin"
                                / "1.0.0"
                            ),
                            "codex_link": str(
                                tmp_path / ".codex" / "plugins" / "old-plugin-market"
                            ),
                        },
                    },
                    "keep-plugin@market": {"managed": True},
                },
                "mcps": {},
            }
        )
    )
    old_store_plugin = tmp_path / "store" / "plugins" / "old-plugin"
    old_store_plugin.mkdir(parents=True)
    old_claude_link = plugins_dir / "cache" / "market" / "old-plugin" / "1.0.0"
    old_claude_link.parent.mkdir(parents=True)
    old_claude_link.symlink_to(old_store_plugin, target_is_directory=True)
    old_codex_link = tmp_path / ".codex" / "plugins" / "old-plugin-market"
    old_codex_link.parent.mkdir(parents=True)
    old_codex_link.symlink_to(old_store_plugin, target_is_directory=True)
    store = GlobalCapabilityStore(
        manifest_path=manifest_path,
        skills_dir=skills_dir,
        plugins_dir=plugins_dir,
        codex_plugins_dir=tmp_path / ".codex" / "plugins",
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
    assert not old_claude_link.exists()
    assert not old_codex_link.exists()


def test_skill_sync_reports_conflict_for_local_user_skill(tmp_path, monkeypatch):
    skills_dir = tmp_path / ".claude" / "skills"
    store_dir = tmp_path / "store"
    manifest_path = tmp_path / "capabilities.json"
    local_skill = skills_dir / "browser"
    local_skill.mkdir(parents=True)
    (local_skill / "SKILL.md").write_text("---\nname: browser\n---\n")

    monkeypatch.setattr(
        "executor.modes.local.capabilities.SkillDownloader._download_single_skill",
        lambda *_args, **_kwargs: pytest.fail("conflicted skill should not download"),
    )

    store = GlobalCapabilityStore(
        manifest_path=manifest_path,
        skills_dir=skills_dir,
        store_dir=store_dir,
    )
    handler = CapabilitySyncHandler(
        auth_token="token",
        store=store,
        skills_dir=skills_dir,
    )

    result = handler.apply_sync(
        {
            "mode": "replace",
            "skills": [{"name": "browser", "skill_id": 101, "namespace": "default"}],
            "plugins": [],
            "mcps": [],
        }
    )

    assert result["success"] is False
    assert result["skills"] == [
        {
            "id": 101,
            "name": "browser",
            "status": "failed",
            "error": "Runtime Skill path is occupied by a local user item",
        }
    ]
    assert local_skill.is_dir()
    assert not local_skill.is_symlink()
