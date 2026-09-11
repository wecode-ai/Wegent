# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for Skill MCP runtime configuration normalization."""

from app.services.execution.skill_mcp import extract_skill_mcp_servers


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


def test_deferred_skill_keeps_mcp_servers_detached() -> None:
    servers = extract_skill_mcp_servers(
        [
            {
                "name": "dingtalk-ai-table",
                "mcp_deferred": True,
                "mcpServers": {
                    "dingtalk-ai-table": {
                        "url": "https://mcp-gw.example.com/server/table",
                    }
                },
            },
            {
                "name": "activated-skill",
                "mcpServers": {
                    "activated-skill": {
                        "url": "https://mcp.example.com/server/activated",
                    }
                },
            },
        ]
    )

    assert servers == [
        {
            "name": "activated-skill",
            "url": "https://mcp.example.com/server/activated",
        }
    ]
