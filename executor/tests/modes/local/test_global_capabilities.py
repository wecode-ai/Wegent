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


def test_project_runtime_uses_global_skill_dir_without_merging_global_mcp(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("HOME", str(tmp_path))
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


def test_default_manifest_path_lives_with_device_config(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))

    assert (
        default_manifest_path() == tmp_path / ".wegent-executor" / "capabilities.json"
    )


def test_manifest_store_records_skills_and_drops_stale_mcp_section(tmp_path):
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
    assert "mcps" not in written
    assert written["skills"] == {
        "browser": {
            "skill_id": 101,
            "namespace": "default",
            "updated_at": written["skills"]["browser"]["updated_at"],
        }
    }
    assert written["revision"] == 2


def test_reporter_marks_local_and_managed_skills_without_mcp_report(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("HOME", str(tmp_path))
    skills_root = tmp_path / ".claude" / "skills"
    local_skill = skills_root / "local-review-helper"
    managed_skill = skills_root / "browser"
    local_skill.mkdir(parents=True)
    managed_skill.mkdir(parents=True)
    (local_skill / "SKILL.md").write_text("---\nname: local-review-helper\n---\n")
    (managed_skill / "SKILL.md").write_text("---\nname: browser\n---\n")

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
            "mcps": {"wegent__old_docs": {"id": "dingtalk/old_docs"}},
        }
    )
    reporter = GlobalCapabilityReporter(
        skills_dir=skills_root,
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
    assert "mcps" not in report
