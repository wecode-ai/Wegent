# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json

import pytest

from executor.modes.local.capabilities import (
    CapabilitySyncHandler,
    GlobalCapabilityStore,
)


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
    assert calls == [("image-gen", {"skill_id": 42, "namespace": "default"})]
    manifest = json.loads(manifest_path.read_text())
    assert manifest["skills"]["image-gen"]["skill_id"] == 42
    assert manifest["mcps"]["docs"]["installed_mcp_id"] == 7
