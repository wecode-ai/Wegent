# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Placeholder replacement utilities for custom headers and configuration.

Shared by Backend (embedding factory, model resolver) and Knowledge Runtime
(config resolver) for processing ${...} placeholder patterns in headers and
configuration dictionaries.
"""

from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)


def resolve_value_from_source(
    data_sources: dict[str, dict[str, Any]], source_spec: str
) -> str:
    """Resolve value from specified data source using flexible notation.

    Supports dot-notation paths like "user.name" within a data source.

    Args:
        data_sources: Dictionary containing all available data sources.
        source_spec: Source specification in format "source_name.path" or just "path".

    Returns:
        The resolved value as a string, or empty string if not found.
    """
    try:
        if "." in source_spec:
            parts = source_spec.split(".", 1)
            source_name = parts[0]
            path = parts[1]
        else:
            source_name = "agent_config"
            path = source_spec

        if source_name not in data_sources:
            return ""

        data = data_sources[source_name]
        keys = path.split(".")
        current = data

        for key in keys:
            if isinstance(current, dict) and key in current:
                current = current[key]
            elif (
                isinstance(current, list) and key.isdigit() and int(key) < len(current)
            ):
                current = current[int(key)]
            else:
                return ""

        return str(current) if current is not None else ""
    except Exception:
        return ""


def replace_placeholders_with_sources(
    template: str, data_sources: dict[str, dict[str, Any]]
) -> str:
    """Replace placeholders in template with values from multiple data sources.

    Args:
        template: The template string with placeholders like ${source.path}.
        data_sources: Dictionary containing all available data sources.

    Returns:
        The template with placeholders replaced with actual values.
    """
    pattern = r"\$\{([^}]+)\}"

    def replace_match(match: re.Match) -> str:
        source_spec = match.group(1)
        value = resolve_value_from_source(data_sources, source_spec)
        return value

    return re.sub(pattern, replace_match, template)


def build_headers_with_placeholders(
    headers: dict[str, Any], data_sources: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    """Build headers dict with placeholder replacement on string values.

    Args:
        headers: Raw headers dictionary (may contain placeholders).
        data_sources: Dictionary containing all available data sources.

    Returns:
        Headers with placeholders replaced.
    """
    result: dict[str, Any] = {}
    try:
        for k, v in headers.items():
            if isinstance(v, str):
                result[k] = replace_placeholders_with_sources(v, data_sources)
            else:
                result[k] = v
    except Exception as e:
        logger.warning(
            "Failed to build headers with placeholders; proceeding without. Error: %s",
            e,
        )
        return {}
    return result


def process_custom_headers_placeholders(
    custom_headers: dict[str, Any],
    user_name: str | None = None,
) -> dict[str, Any]:
    """Process placeholders in custom headers.

    Supports placeholder format: ${user.name}

    Args:
        custom_headers: Custom headers dict (may contain placeholders).
        user_name: User name for placeholder replacement.

    Returns:
        Custom headers with placeholders replaced.
    """
    if not custom_headers or not isinstance(custom_headers, dict):
        return custom_headers

    data_sources: dict[str, dict[str, Any]] = {
        "user": {"name": user_name or ""},
    }

    return build_headers_with_placeholders(custom_headers, data_sources)
