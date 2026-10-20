# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for DingTalk provider runtime skill initialization assets."""

from pathlib import Path
from shutil import copytree
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock
from urllib.parse import parse_qs, urlparse

import pytest
import yaml
from packaging.version import Version
from sqlalchemy.orm import Session

from app.core.yaml_init import _package_skill_directory, apply_skills_from_directory
from app.models.kind import Kind
from app.models.skill_binary import SkillBinary
from app.services.adapters.skill_kinds import skill_kinds_service
from app.services.execution.provider_guidance import (
    apply_provider_configuration_guidance,
)
from app.services.execution.request_builder import TaskRequestBuilder
from app.services.mcp_provider_registry import (
    MCPProviderServiceDefinition,
    get_mcp_provider_service,
    list_mcp_provider_services,
)
from app.services.skill_service import SkillValidator
from shared.models import ExecutionRequest

SKILLS_DIR = Path(__file__).parents[2] / "init_data" / "skills"


@pytest.fixture(
    params=[
        ("docs", "dingtalk_docs"),
        ("table", "dingtalk_table"),
        ("ai_table", "dingtalk_ai_table"),
        ("wikispace", "dingtalk_wikispace"),
    ],
    ids=["docs", "table", "ai_table", "wikispace"],
)
def service(request: pytest.FixtureRequest) -> MCPProviderServiceDefinition:
    service_id, server_name = request.param
    definition = get_mcp_provider_service("dingtalk", service_id)
    assert definition is not None
    assert definition["server_name"] == server_name
    assert definition["skill_name"]
    return definition


@pytest.fixture
def asset_metadata(service: MCPProviderServiceDefinition) -> dict[str, Any]:
    name = service["skill_name"]
    assert name is not None
    return SkillValidator.validate_zip(
        _package_skill_directory(SKILLS_DIR / name), f"{name}.zip"
    )


def test_dingtalk_service_has_runtime_skill_asset(
    service: MCPProviderServiceDefinition,
    asset_metadata: dict[str, Any],
) -> None:
    """Every package must retain its own MCP and actionable configuration link."""
    server = asset_metadata["mcpServers"][service["server_name"]]
    assert server["type"] == "streamable-http"
    assert server["url"] == (
        "${{task_data.user_mcps.dingtalk.services."
        f"{service['service_id']}.credentials.url"
        "}}"
    )
    guide = asset_metadata["config"]["unconfiguredGuide"]
    link = urlparse(guide["modalLink"])
    assert (link.scheme, link.netloc, link.path) == (
        "wegent",
        "modal",
        "/mcp-provider-config",
    )
    assert parse_qs(link.query) == {
        "provider": ["dingtalk"],
        "service": [service["service_id"]],
    }
    assert service["display_name"] in guide["modalText"]
    assert f"[{guide['modalText']}]({guide['modalLink']})" in asset_metadata["prompt"]
    assert Version(asset_metadata["version"]) > Version("1.0.0")


@pytest.mark.parametrize("configured", [False, True], ids=["missing", "configured"])
def test_runtime_guidance_matches_each_asset_configuration_link(
    service: MCPProviderServiceDefinition,
    asset_metadata: dict[str, Any],
    configured: bool,
) -> None:
    """Each unconfigured service targets its own popup, without exposing its MCP."""
    name = service["skill_name"]
    assert name is not None
    skill = Kind(
        id=101,
        user_id=0,
        namespace="default",
        name=name,
        kind="Skill",
        json={
            "kind": "Skill",
            "metadata": {"name": name, "namespace": "default"},
            "spec": asset_metadata,
        },
    )
    preferences = {}
    if configured:
        preferences = {
            "mcps": {
                "dingtalk": {
                    "services": {
                        service["service_id"]: {
                            "enabled": True,
                            "credentials": {"url": "https://example.com/mcp"},
                        }
                    }
                }
            }
        }
    skill_data = TaskRequestBuilder(MagicMock())._build_skill_data(
        skill, user=SimpleNamespace(preferences=preferences)
    )
    request = ExecutionRequest(
        system_prompt="Base instructions.",
        bot=[{"shell_type": "Chat", "system_prompt": "Bot instructions."}],
        skill_names=[name],
        skill_configs=[skill_data],
        preload_skills=[name],
    )

    apply_provider_configuration_guidance(request)

    guide = asset_metadata["config"]["unconfiguredGuide"]
    assert skill_data["config"]["unconfiguredGuide"] == guide
    if configured:
        assert request.system_prompt == "Base instructions."
        assert "configuration_required" not in skill_data
        assert service["server_name"] in skill_data["mcpServers"]
    else:
        assert skill_data["configuration_required"] is True
        assert "mcpServers" not in skill_data
        assert request.system_prompt.count(guide["modalLink"]) == 1
        assert f"[{guide['modalText']}]({guide['modalLink']})" in request.system_prompt


def test_existing_dingtalk_skill_upgrades_metadata_and_download_package(
    service: MCPProviderServiceDefinition,
    asset_metadata: dict[str, Any],
    test_db: Session,
    tmp_path: Path,
) -> None:
    """Normal initialization upgrades 1.0.0 without deleting the existing Skill."""
    name = service["skill_name"]
    assert name is not None
    skill_dir = copytree(SKILLS_DIR / name, tmp_path / name)
    skill_md = skill_dir / "SKILL.md"
    current_content = skill_md.read_text(encoding="utf-8")
    old_frontmatter = SkillValidator._parse_skill_md(current_content)
    old_frontmatter["version"] = "1.0.0"
    old_frontmatter.pop("config")
    skill_md.write_text(
        f"---\n{yaml.safe_dump(old_frontmatter)}---\n\nUse the provider MCP directly.",
        encoding="utf-8",
    )
    existing = skill_kinds_service.create_skill(
        test_db,
        name=name,
        namespace="default",
        user_id=0,
        file_content=_package_skill_directory(skill_dir),
        file_name=f"{name}.zip",
    )
    skill_md.write_text(current_content, encoding="utf-8")

    results = apply_skills_from_directory(test_db, 0, tmp_path)

    assert len(results) == 1
    assert results[0]["success"] is True
    assert results[0]["operation"] == "updated"
    updated = skill_kinds_service.get_skill_by_name(
        test_db, name=name, namespace="default", user_id=0
    )
    assert updated is not None
    assert updated.metadata.labels["id"] == existing.metadata.labels["id"]
    assert updated.spec.version == asset_metadata["version"]
    assert updated.spec.config == asset_metadata["config"]
    assert updated.spec.mcpServers == asset_metadata["mcpServers"]
    binary = (
        test_db.query(SkillBinary)
        .filter(SkillBinary.kind_id == int(updated.metadata.labels["id"]))
        .one()
    )
    downloaded = SkillValidator.validate_zip(binary.binary_data, binary.file_name)
    assert downloaded["config"] == updated.spec.config
    assert downloaded["prompt"] == asset_metadata["prompt"]
    assert not downloaded["mcpServers"]


def test_all_dingtalk_services_declare_oauth_support() -> None:
    """All four DingTalk integrations must support OAuth and API-key URLs."""
    services = list_mcp_provider_services("dingtalk")

    assert {service["service_id"] for service in services} == {
        "docs",
        "table",
        "ai_table",
        "wikispace",
    }
    assert all(service["oauth_supported"] for service in services)
