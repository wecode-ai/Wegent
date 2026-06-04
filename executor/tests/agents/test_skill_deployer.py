# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for skill deployment resolution strategy."""

from types import SimpleNamespace

from executor.agents.claude_code.skill_deployer import (
    build_skill_emphasis_prompt,
    collect_skill_names_for_deployment,
    download_and_deploy_skills,
    resolve_skill_download_map,
)
from shared.models.execution import ExecutionRequest


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


def test_build_skill_emphasis_prompt_prioritizes_selected_kb_skill():
    prompt = build_skill_emphasis_prompt(["wegent-knowledge"])

    assert "wegent-knowledge" in prompt
    assert "selected knowledge bases" in prompt.lower()
    assert "before web search" in prompt.lower()


def test_coordinate_mode_collects_member_bot_skills_for_deployment():
    task_data = ExecutionRequest(
        mode="coordinate",
        skill_names=["request-skill"],
        preload_skills=["preload-skill"],
        bot=[
            {"name": "leader", "skills": ["leader-skill"]},
            {"name": "dubhe_bot", "skills": ["dubhe-skill"]},
        ],
    )

    skills = collect_skill_names_for_deployment(
        bot_config=task_data.bot[0],
        task_data=task_data,
    )

    assert set(skills) == {
        "leader-skill",
        "dubhe-skill",
        "request-skill",
        "preload-skill",
    }


def test_download_and_deploy_skills_passes_task_id_for_shared_skill_auth(
    monkeypatch,
):
    captured = {}

    class FakeSkillDownloader:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        def download_and_deploy(self, **kwargs):
            captured["download_options"] = kwargs
            return SimpleNamespace(
                success_count=1,
                total_count=1,
                skills_dir="/tmp/skills",
            )

    class FakeModeStrategy:
        def get_skills_directory(self, config_dir=None):
            return "/tmp/skills"

        def get_skills_deployment_options(self):
            return {"clear_cache": True, "skip_existing": False}

    monkeypatch.setattr(
        "executor.services.api_client.SkillDownloader",
        FakeSkillDownloader,
    )

    task_data = ExecutionRequest(
        task_id=5258563,
        auth_token="token",
        team_namespace="default",
        skill_refs={
            "private-skill": {
                "skill_id": 251069,
                "namespace": "default",
                "is_public": False,
            }
        },
    )

    download_and_deploy_skills(
        bot_config={"skills": ["private-skill"]},
        task_data=task_data,
        mode_strategy=FakeModeStrategy(),
    )

    assert captured["task_id"] == 5258563
    assert captured["auth_token"] == "token"
    assert captured["team_namespace"] == "default"
    assert captured["skills_dir"] == "/tmp/skills"
    assert (
        captured["download_options"]["resolved_skill_map"]["private-skill"]["skill_id"]
        == 251069
    )
