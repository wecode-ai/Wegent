# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Unambiguous connector identities in MCP tool names."""


def qualify_connector_tool(slug: str, tool: str) -> str:
    """Escape slug underscores so the first double underscore is a boundary."""
    return f"{slug.replace('_', '_u')}__{tool}"


def split_connector_tool(name: str) -> tuple[str, str]:
    encoded, separator, tool = name.partition("__")
    slug = encoded.replace("_u", "_")
    if (
        not separator
        or not slug
        or not tool
        or qualify_connector_tool(slug, tool) != name
    ):
        raise ValueError("Invalid connector tool name")
    return slug, tool
