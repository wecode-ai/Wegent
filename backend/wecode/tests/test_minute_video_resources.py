# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for internal one-minute video preset resources."""

from pathlib import Path

from app.core.yaml_init import _package_skill_directory, load_yaml_documents
from app.schemas.kind import Team
from app.services.skill_service import SkillValidator
from chat_shell.skills.registry import SkillToolRegistry

SKILL_DIR = Path(__file__).parents[1] / "init_data" / "skills" / "wegent-minute-video"


def test_minute_video_bot_uses_video_primary_and_planning_llm() -> None:
    resources_path = (
        Path(__file__).parents[1] / "init_data" / "02-minute-video-resources.yaml"
    )
    resources = load_yaml_documents(resources_path)
    bot = next(
        resource
        for resource in resources
        if resource["kind"] == "Bot"
        and resource["metadata"]["name"] == "minute-video-bot"
    )

    assert bot["spec"]["modelRef"] == {
        "name": "行业领先旗舰模型",
        "namespace": "default",
    }
    assert bot["spec"]["secondaryModelRef"] == {
        "name": "ali-deepseek-v4-flash",
        "namespace": "default",
    }

    ghost = next(
        resource
        for resource in resources
        if resource["kind"] == "Ghost"
        and resource["metadata"]["name"] == "minute-video-ghost"
    )
    assert ghost["spec"]["preload_skills"] == ["wegent-minute-video"]


def test_minute_video_team_exposes_only_video_model_in_chat() -> None:
    resources_path = (
        Path(__file__).parents[1] / "init_data" / "02-minute-video-resources.yaml"
    )
    resources = load_yaml_documents(resources_path)
    team = next(
        resource
        for resource in resources
        if resource["kind"] == "Team"
        and resource["metadata"]["name"] == "minute-video-team"
    )
    Team.model_validate(team)

    assert team["spec"]["modeSpec"] == {
        "allowedModelCategories": ["video"],
        "hiddenVideoParams": ["duration"],
    }


def test_minute_video_team_does_not_duplicate_bot_model_binding() -> None:
    resources_path = (
        Path(__file__).parents[1] / "init_data" / "02-minute-video-resources.yaml"
    )
    resources = load_yaml_documents(resources_path)
    team = next(
        resource
        for resource in resources
        if resource["kind"] == "Team"
        and resource["metadata"]["name"] == "minute-video-team"
    )
    Team.model_validate(team)

    assert "defaultModelRefs" not in team["spec"]["modeSpec"]


def test_minute_video_skill_declares_provider_tools_and_generic_card_mcp() -> None:
    metadata = SkillValidator.validate_zip(
        _package_skill_directory(SKILL_DIR),
        "wegent-minute-video.zip",
    )

    assert metadata["version"] == "2.0.0"
    assert metadata["config"] == {"inject_generation_context": True}
    assert metadata["provider"] == {
        "module": "provider",
        "class": "MinuteVideoProvider",
    }
    assert [tool["name"] for tool in metadata["tools"]] == [
        "analyze_video_material",
        "save_draft_script",
        "create_script_by_draft",
        "generate_storyboard_videos",
        "generate_final_video",
    ]
    assert set(metadata["mcpServers"]) == {
        "wegent-cards",
        "wegent-interactive-form-question",
    }
    assert (
        metadata["mcpServers"]["wegent-cards"]["url"]
        == "${{backend_url}}/mcp/cards/sse"
    )
    assert "private QIA" not in metadata["mcpServers"]


def test_minute_video_skill_package_loads_executable_provider() -> None:
    provider = SkillToolRegistry.get_instance().load_provider_from_zip(
        zip_content=_package_skill_directory(SKILL_DIR),
        provider_config={
            "module": "provider",
            "class": "MinuteVideoProvider",
        },
        skill_name="wegent-minute-video",
    )

    assert provider is not None
    assert provider.provider_name == "wegent-minute-video"
    assert provider.supported_tools == [
        "analyze_video_material",
        "save_draft_script",
        "create_script_by_draft",
        "generate_storyboard_videos",
        "generate_final_video",
    ]


def test_minute_video_skill_does_not_delegate_to_ordinary_video_tool() -> None:
    content = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")

    assert "Never call `generate_video`" in content
    assert "generation context is injected into this Skill" in content
    assert "video_director_generation" in content
