# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Stable, bounded names for runtime MCP server registrations."""

import hashlib
import logging
import re

logger = logging.getLogger(__name__)

SKILL_CODE_LENGTH = 7
MAX_SERVER_NAME_LENGTH = 24
MAX_RUNTIME_SERVER_NAME_LENGTH = SKILL_CODE_LENGTH + 1 + MAX_SERVER_NAME_LENGTH
_INVALID_NAME_CHARACTERS = re.compile(r"[^A-Za-z0-9_-]")
_HEX_DIGIT_TO_LETTER = str.maketrans("0123456789", "ghijklmnop")


def _short_code(name: str) -> str:
    code = hashlib.sha256(name.encode("utf-8")).hexdigest()[:SKILL_CODE_LENGTH]
    # Model function names must start with a letter. Keep the code length and
    # collision properties while mapping numeric hexadecimal prefixes to letters.
    return code.translate(_HEX_DIGIT_TO_LETTER)


def _sanitize_name(value: str, fallback: str) -> str:
    """Replace invalid characters and ensure a letter prefix."""
    sanitized = _INVALID_NAME_CHARACTERS.sub("-", value) or fallback
    if not sanitized[0].isalpha():
        sanitized = f"s-{sanitized}"
    return sanitized


def _compact_server_name(server_name: str) -> str:
    """Return a bounded server name safe for model function names."""
    compact_server = _sanitize_name(server_name, "server")
    if len(compact_server) > MAX_SERVER_NAME_LENGTH:
        prefix_length = MAX_SERVER_NAME_LENGTH - SKILL_CODE_LENGTH - 1
        compact_server = f"{compact_server[:prefix_length]}_{_short_code(server_name)}"
    return compact_server


def resolve_skill_mcp_name(
    skill_name: str, server_name: str, *, attempt: int = 0
) -> str:
    """Keep readable names when they fit, otherwise return a compact name."""
    compact_server = _compact_server_name(server_name)
    # Provider Skills already using their own name need no additional namespace.
    if skill_name == server_name and attempt == 0:
        return compact_server

    readable_name = f"{_sanitize_name(skill_name, 'skill')}_{compact_server}"
    if attempt == 0 and len(readable_name) <= MAX_RUNTIME_SERVER_NAME_LENGTH:
        return readable_name

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
