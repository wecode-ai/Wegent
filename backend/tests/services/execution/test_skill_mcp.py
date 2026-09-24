# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Skill MCP runtime configuration normalization."""

from app.services.execution.skill_mcp import extract_skill_mcp_servers
from shared.utils import mcp_names


def test_skill_mcp_config_cannot_override_resolved_name() -> None:
    servers = extract_skill_mcp_servers(
        [
            {
                "name": "demo-skill",
                "mcpServers": {
                    "docs": {
                        "name": "untrusted-name",
                        "url": "https://example.test/mcp",
                    }
                },
            }
        ]
    )

    assert servers == [
        {
            "name": "demo-skill_docs",
            "url": "https://example.test/mcp",
        }
    ]


def test_long_skill_names_keep_servers_distinct_within_tool_name_budget() -> None:
    config = {"url": "https://example.test/mcp"}
    servers = extract_skill_mcp_servers(
        [
            {
                "name": skill_name,
                "mcpServers": {"wegent-interactive-form-question": config},
            }
            for skill_name in (
                "a" * 24,
                "b" * 24,
            )
        ]
    )

    assert len({server["name"] for server in servers}) == 2
    for server in servers:
        assert len(f"mcp__{server['name']}__interactive_form_question") <= 64
        assert server["url"] == config["url"]


def test_skill_code_collision_prevents_silent_server_overwrite(monkeypatch) -> None:
    short_code = mcp_names._short_code
    monkeypatch.setattr(
        mcp_names,
        "_short_code",
        lambda name: short_code(name) if "\0" in name else "abcdefg",
    )
    configs = [
        {"name": name, "mcpServers": {"docs": {"url": f"https://example.test/{name}"}}}
        for name in ("skill-one", "skill-two")
    ]

    servers = extract_skill_mcp_servers(configs)

    assert len({server["name"] for server in servers}) == 2
    assert [server["url"] for server in servers] == [
        "https://example.test/skill-one",
        "https://example.test/skill-two",
    ]
    assert extract_skill_mcp_servers(configs) == servers
