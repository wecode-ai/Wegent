# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for DingTalk provider runtime skill initialization assets."""

from pathlib import Path

import pytest

from app.services.mcp_provider_registry import list_mcp_provider_services


@pytest.mark.parametrize(
    ("service_id", "server_name"),
    [
        ("docs", "dingtalk_docs"),
        ("table", "dingtalk_table"),
        ("ai_table", "dingtalk_ai_table"),
        ("wikispace", "dingtalk_wikispace"),
    ],
)
def test_dingtalk_service_has_runtime_skill_asset(
    service_id: str,
    server_name: str,
) -> None:
    """Every user-configured DingTalk service must have a loadable Skill."""
    services = list_mcp_provider_services("dingtalk")
    service = next(item for item in services if item["service_id"] == service_id)
    skill_name = service["skill_name"]

    assert skill_name
    skill_path = (
        Path(__file__).parents[3]
        / "backend"
        / "init_data"
        / "skills"
        / skill_name
        / "SKILL.md"
    )
    content = skill_path.read_text(encoding="utf-8")

    assert "mcpServers:" in content
    assert server_name in content
    assert f"services.{service_id}.credentials.url" in content


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
