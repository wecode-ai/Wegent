# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve MCP server configurations declared by Skills."""

from typing import Any


def resolve_skill_mcp_name(skill_name: str, server_name: str) -> str:
    """Return the runtime MCP name for a Skill server."""
    if skill_name == server_name:
        return server_name
    return f"{skill_name}_{server_name}"


def extract_skill_mcp_servers(
    skill_configs: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Convert Skill MCP mappings to the runtime list representation."""
    result: list[dict[str, Any]] = []
    for skill_config in skill_configs:
        skill_name = skill_config.get("name", "unknown")
        mcp_servers = skill_config.get("mcpServers")
        if not isinstance(mcp_servers, dict):
            continue

        for server_name, server_config in mcp_servers.items():
            if (
                not isinstance(server_name, str)
                or not server_name
                or not isinstance(server_config, dict)
            ):
                continue
            result.append(
                {
                    "name": resolve_skill_mcp_name(skill_name, server_name),
                    **server_config,
                }
            )
    return result
