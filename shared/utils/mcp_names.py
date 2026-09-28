# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Stable, bounded names for runtime MCP server registrations."""

import hashlib
import logging

logger = logging.getLogger(__name__)

SKILL_CODE_LENGTH = 7
MAX_SERVER_NAME_LENGTH = 24


def _short_code(name: str) -> str:
    return hashlib.sha256(name.encode("utf-8")).hexdigest()[:SKILL_CODE_LENGTH]


def resolve_skill_mcp_name(
    skill_name: str, server_name: str, *, attempt: int = 0
) -> str:
    """Reserve at least 25 tool-name characters within the 64-character limit."""
    compact_server = server_name
    if len(server_name) > MAX_SERVER_NAME_LENGTH:
        prefix_length = MAX_SERVER_NAME_LENGTH - SKILL_CODE_LENGTH - 1
        compact_server = f"{server_name[:prefix_length]}_{_short_code(server_name)}"
    # Provider Skills already using their own name need no additional namespace.
    if skill_name == server_name and attempt == 0:
        return compact_server
    identity = skill_name if attempt == 0 else f"{skill_name}\0{server_name}\0{attempt}"
    return f"{_short_code(identity)}_{compact_server}"


class SkillMcpNames:
    """Resolve short-name collisions without overwriting existing MCP registrations."""

    def __init__(self) -> None:
        self._owners: dict[str, tuple[str, str]] = {}
        self._names: dict[tuple[str, str], str] = {}

    def register(self, skill_name: str, server_name: str) -> str:
        identity = (skill_name, server_name)
        if identity in self._names:
            return self._names[identity]
        original_name = resolve_skill_mcp_name(skill_name, server_name)
        name = original_name
        attempt = 0
        while name in self._owners:
            attempt += 1
            name = resolve_skill_mcp_name(skill_name, server_name, attempt=attempt)
        if attempt:
            logger.warning(
                "Skill MCP name collision for %s; using %s for Skill %s server %s",
                original_name,
                name,
                skill_name,
                server_name,
            )
        self._owners[name] = identity
        self._names[identity] = name
        return name
