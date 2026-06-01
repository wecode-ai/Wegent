# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json

from executor.modes.local.capabilities import (
    GlobalCapabilityReporter,
    GlobalCapabilityStore,
    ManagedCapabilityManifest,
    default_manifest_path,
)


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
    assert options["env"]["SKILLS_DIR"] == str(tmp_path / ".claude" / "skills")
    task_skills_dir = tmp_path / "task" / ".claude" / "skills"
    assert task_skills_dir.is_symlink()
    assert task_skills_dir.resolve() == (tmp_path / ".claude" / "skills").resolve()
    task_plugins_dir = tmp_path / "task" / ".claude" / "plugins"
    assert task_plugins_dir.is_symlink()
    assert task_plugins_dir.resolve() == (tmp_path / ".claude" / "plugins").resolve()
    task_settings = json.loads(
        (tmp_path / "task" / ".claude" / "settings.json").read_text()
    )
    assert task_settings == {
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
    }


def test_default_manifest_path_lives_with_device_config(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))

    assert (
        default_manifest_path() == tmp_path / ".wegent-executor" / "capabilities.json"
    )


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
