# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for skill deployment resolution strategy."""

from executor.agents.claude_code.skill_deployer import resolve_skill_download_map


def test_resolve_skill_download_map_prefers_skill_config_and_preload_override():
    resolved = resolve_skill_download_map(
        skills=["dup-skill", "plain-skill"],
        preload_skills=["dup-skill"],
        skill_configs=[
            {
                "name": "dup-skill",
                "skill_id": 100,
                "namespace": "team-a",
                "is_public": False,
            }
        ],
        skill_refs={
            "plain-skill": {
                "skill_id": 200,
                "namespace": "default",
                "is_public": True,
            }
        },
        preload_skill_refs={
            "dup-skill": {
                "skill_id": 300,
                "namespace": "team-b",
                "is_public": False,
            }
        },
    )

    assert resolved["dup-skill"]["skill_id"] == 300
    assert resolved["plain-skill"]["skill_id"] == 200


def test_resolve_skill_download_map_prefers_explicit_refs_over_skill_configs():
    resolved = resolve_skill_download_map(
        skills=["conflict-skill"],
        preload_skills=[],
        skill_configs=[
            {
                "name": "conflict-skill",
                "skill_id": 111,
                "namespace": "default",
                "is_public": False,
            }
        ],
        skill_refs={
            "conflict-skill": {
                "skill_id": 222,
                "namespace": "team-a",
                "is_public": False,
            }
        },
        preload_skill_refs={},
    )

    assert resolved["conflict-skill"]["skill_id"] == 222
