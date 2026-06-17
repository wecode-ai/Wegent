# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json

from executor.modes.local.capabilities import (
    CapabilitySyncHandler,
    GlobalCapabilityReporter,
    GlobalCapabilityStore,
    ManagedCapabilityManifest,
    default_manifest_path,
    get_project_id,
    is_project_task,
)
from shared.models.execution import ExecutionRequest


def test_wework_standalone_chat_uses_global_capabilities():
    request = ExecutionRequest(
        task_id=1901,
        project_id=0,
        standalone_chat_workspace=True,
    )

    assert is_project_task(request) is True


def test_frontend_device_chat_project_zero_does_not_use_project_capabilities():
    request = ExecutionRequest(
        task_id=1902,
        project_id=0,
    )

    assert get_project_id(request) == ""
    assert is_project_task(request) is False


def test_wework_standalone_chat_project_zero_keeps_project_header_id():
    request = ExecutionRequest(
        task_id=1904,
        project_id=0,
        standalone_chat_workspace=True,
    )

    assert get_project_id(request) == "0"
    assert is_project_task(request) is True


def test_project_id_can_be_read_from_execution_workspace_project():
    request = ExecutionRequest(
        task_id=1903,
        workspace={"project": {"project_id": 42}},
    )

    assert get_project_id(request) == "42"
    assert is_project_task(request) is True


def test_project_runtime_uses_global_claude_capability_dirs_without_merging_global_mcp(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / ".claude" / "plugins").mkdir(parents=True)
    (tmp_path / ".claude" / "settings.json").write_text(
        json.dumps(
            {
                "enabledPlugins": {
                    "superpowers@claude-plugins-official": True,
                    "context7@claude-plugins-official": True,
                },
                "extraKnownMarketplaces": {
                    "claude-code-warp": {
                        "source": {
                            "source": "github",
                            "repo": "warpdotdev/claude-code-warp",
                        }
                    }
                },
                "ANTHROPIC_AUTH_TOKEN": "must-not-be-copied",
                "model": "must-not-be-copied",
            }
        )
    )
    (tmp_path / ".claude.json").write_text(
        json.dumps(
            {
                "mcpServers": {
                    "global_only": {
                        "type": "http",
                        "url": "https://global-only.example/mcp",
                    },
                }
            }
        )
    )

    from executor.agents.claude_code.local_mode_strategy import LocalModeStrategy

    strategy = LocalModeStrategy()
    strategy.use_global_capabilities(True)
    options = strategy.configure_client_options(
        options={
            "mcp_servers": {
                "task_only": {"type": "http", "url": "https://task.example/mcp"}
            }
        },
        config_dir=str(tmp_path / "task" / ".claude"),
        env_config={},
        task_identity_env={},
    )

    assert options["mcp_servers"] == {
        "task_only": {"type": "http", "url": "https://task.example/mcp"}
    }
    assert options["env"]["CLAUDE_CONFIG_DIR"] == str(tmp_path / ".claude")
    assert options["env"]["SKILLS_DIR"] == str(tmp_path / ".claude" / "skills")
    task_skills_dir = tmp_path / "task" / ".claude" / "skills"
    task_plugins_dir = tmp_path / "task" / ".claude" / "plugins"
    assert not task_skills_dir.exists()
    assert not task_plugins_dir.exists()


def test_default_manifest_path_lives_with_device_config(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("WEGENT_EXECUTOR_HOME", raising=False)

    assert default_manifest_path() == (
        tmp_path / ".wegent-executor" / "capabilities" / "manifest.json"
    )


def test_capability_sync_handler_uses_synced_device_config_token(monkeypatch):
    monkeypatch.delenv("WEGENT_AUTH_TOKEN", raising=False)

    from executor.config import config

    previous_token = config.WEGENT_AUTH_TOKEN
    try:
        config.WEGENT_AUTH_TOKEN = "device-config-token"
        handler = CapabilitySyncHandler()
    finally:
        config.WEGENT_AUTH_TOKEN = previous_token

    assert handler.auth_token == "device-config-token"


def test_manifest_store_records_skills_and_preserves_mcp_section(tmp_path):
    manifest = ManagedCapabilityManifest(
        path=tmp_path / ".wegent-executor" / "capabilities.json"
    )
    manifest.save(
        {
            "version": 1,
            "revision": 1,
            "skills": {},
            "mcps": {"wegent__old_docs": {"id": "dingtalk/old_docs"}},
        }
    )

    store = GlobalCapabilityStore(manifest=manifest)
    store.record_skill({"id": 101, "name": "browser", "namespace": "default"})

    written = json.loads(manifest.path.read_text())
    assert written["mcps"] == {"wegent__old_docs": {"id": "dingtalk/old_docs"}}
    assert written["skills"] == {
        "browser": {
            "managed": True,
            "name": "browser",
            "skill_id": 101,
            "namespace": "default",
            "updated_at": written["skills"]["browser"]["updated_at"],
        }
    }
    assert written["revision"] == 2


def test_reporter_marks_local_skills_plugins_and_managed_capabilities(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("HOME", str(tmp_path))
    skills_root = tmp_path / ".claude" / "skills"
    plugins_root = tmp_path / ".claude" / "plugins"
    local_skill = skills_root / "local-review-helper"
    managed_skill = skills_root / "browser"
    local_skill.mkdir(parents=True)
    managed_skill.mkdir(parents=True)
    (local_skill / "SKILL.md").write_text("---\nname: local-review-helper\n---\n")
    (managed_skill / "SKILL.md").write_text("---\nname: browser\n---\n")
    plugins_root.mkdir(parents=True)
    plugin_install_path = (
        plugins_root / "cache" / "claude-plugins-official" / "context7" / "1057d02c5307"
    )
    plugin_skill_path = plugin_install_path / "skills" / "context7" / "SKILL.md"
    plugin_skill_path.parent.mkdir(parents=True)
    plugin_skill_path.write_text(
        "---\n"
        "name: context7\n"
        "description: Look up version-specific documentation.\n"
        "---\n"
        "# Context7\n"
    )
    (plugins_root / "installed_plugins.json").write_text(
        json.dumps(
            {
                "version": 2,
                "plugins": {
                    "context7@claude-plugins-official": [
                        {
                            "scope": "user",
                            "installPath": str(plugin_install_path),
                            "version": "1057d02c5307",
                            "installedAt": "2026-01-30T05:59:58.844Z",
                            "lastUpdated": "2026-04-10T06:11:01.715Z",
                        }
                    ]
                },
            }
        )
    )

    manifest = ManagedCapabilityManifest(
        path=tmp_path / ".wegent-executor" / "capabilities.json"
    )
    manifest.save(
        {
            "version": 1,
            "revision": 1,
            "skills": {
                "browser": {
                    "skill_id": 101,
                    "namespace": "default",
                }
            },
            "mcps": {
                "wegent__old_docs": {
                    "installed_mcp_id": 7,
                    "server": {"url": "https://example.com/mcp"},
                }
            },
        }
    )
    reporter = GlobalCapabilityReporter(
        skills_dir=skills_root,
        plugins_dir=plugins_root,
        manifest=manifest,
    )

    report = reporter.build_report(force_full=True)

    assert report["full"] is True
    assert report["skills"] == [
        {
            "name": "browser",
            "skill_id": 101,
            "namespace": "default",
            "source": "wegent",
        },
        {"name": "local-review-helper", "source": "local_user"},
    ]
    assert report["mcps"] == [
        {
            "name": "wegent__old_docs",
            "installed_mcp_id": 7,
            "server": {"url": "https://example.com/mcp"},
            "source": "wegent",
        }
    ]
    assert report["plugins"] == [
        {
            "name": "context7",
            "marketplace": "claude-plugins-official",
            "scope": "user",
            "version": "1057d02c5307",
            "source": "local_user",
            "installed_at": "2026-01-30T05:59:58.844Z",
            "last_updated": "2026-04-10T06:11:01.715Z",
            "skills": [
                {
                    "name": "context7",
                    "description": "Look up version-specific documentation.",
                    "path": "skills/context7",
                }
            ],
        }
    ]


def test_reporter_scans_managed_plugin_store_when_claude_cache_path_is_missing(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("HOME", str(tmp_path))
    skills_root = tmp_path / ".claude" / "skills"
    plugins_root = tmp_path / ".claude" / "plugins"
    plugins_root.mkdir(parents=True)
    missing_cache_path = plugins_root / "cache" / "wegent" / "superpowers" / "5.0.7"
    store_plugin_path = (
        tmp_path
        / ".wegent-executor"
        / "capabilities"
        / "store"
        / "plugins"
        / "1614-wegent-superpowers-5.0.7"
    )
    plugin_skill_path = store_plugin_path / "skills" / "systematic-debugging"
    plugin_skill_path.mkdir(parents=True)
    (plugin_skill_path / "SKILL.md").write_text(
        "---\n"
        "name: systematic-debugging\n"
        "description: Use when encountering bugs.\n"
        "---\n"
        "# Systematic Debugging\n"
    )
    (plugins_root / "installed_plugins.json").write_text(
        json.dumps(
            {
                "version": 2,
                "plugins": {
                    "superpowers@wegent": [
                        {
                            "scope": "user",
                            "installPath": str(missing_cache_path),
                            "version": "5.0.7",
                            "installedAt": "2026-06-09T08:45:55.290Z",
                            "lastUpdated": "2026-06-09T08:45:55.290Z",
                        }
                    ]
                },
            }
        )
    )
    manifest = ManagedCapabilityManifest(
        path=tmp_path / ".wegent-executor" / "capabilities.json"
    )
    manifest.save(
        {
            "version": 1,
            "revision": 1,
            "skills": {},
            "plugins": {
                "superpowers@wegent": {
                    "installed_plugin_id": 1614,
                    "managed": True,
                    "store_path": str(store_plugin_path),
                    "version": "5.0.7",
                    "component_states": {"skill:systematic-debugging": True},
                }
            },
            "mcps": {},
        }
    )
    reporter = GlobalCapabilityReporter(
        skills_dir=skills_root,
        plugins_dir=plugins_root,
        manifest=manifest,
    )

    report = reporter.build_report(force_full=True)

    assert report["plugins"] == [
        {
            "name": "superpowers",
            "marketplace": "wegent",
            "scope": "user",
            "version": "5.0.7",
            "source": "wegent",
            "installed_at": "2026-06-09T08:45:55.290Z",
            "last_updated": "2026-06-09T08:45:55.290Z",
            "skills": [
                {
                    "name": "systematic-debugging",
                    "description": "Use when encountering bugs.",
                    "path": "skills/systematic-debugging",
                }
            ],
            "installed_plugin_id": 1614,
        }
    ]
