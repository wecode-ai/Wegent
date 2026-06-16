#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Utilities for model API request headers."""

import json
from collections.abc import Mapping
from typing import Any

WECODE_PROJECT_HEADER = "wecode-project"
DEFAULT_HEADERS_ENV_KEYS = ("DEFAULT_HEADERS", "default_headers")


def merge_project_header(
    headers: Mapping[str, Any] | str | None,
    project_id: Any,
) -> dict[str, str]:
    """Return headers with the Wegent project header merged."""
    parsed_headers = _parse_header_map(headers)
    normalized_project_id = _normalize_project_id(project_id)
    if not normalized_project_id:
        return parsed_headers

    return merge_header_map(
        parsed_headers, {WECODE_PROJECT_HEADER: normalized_project_id}
    )


def merge_header_map(
    existing_headers: Mapping[str, Any] | str | None,
    new_headers: Mapping[str, Any],
) -> dict[str, str]:
    """Merge header maps case-insensitively while preserving insertion order."""
    result = _parse_header_map(existing_headers)
    for key, value in new_headers.items():
        if value is None:
            continue
        normalized_key = str(key).lower()
        result = {
            existing_key: existing_value
            for existing_key, existing_value in result.items()
            if existing_key.lower() != normalized_key
        }
        result[str(key)] = str(value)
    return result


def headers_to_anthropic_custom_headers(headers: Mapping[str, Any]) -> str:
    """Format a header map for Claude Code's ANTHROPIC_CUSTOM_HEADERS env var."""
    return "\n".join(f"{key}: {value}" for key, value in headers.items())


def merge_anthropic_header_map(
    existing_headers: str,
    headers: Mapping[str, Any],
) -> str:
    """Return Anthropic custom headers with a header map merged."""
    merged = merge_header_map(
        _parse_anthropic_custom_headers(existing_headers), headers
    )
    return headers_to_anthropic_custom_headers(merged)


def merge_anthropic_custom_headers(*header_sets: str | None) -> str:
    """Merge multiple ANTHROPIC_CUSTOM_HEADERS strings."""
    merged: dict[str, str] = {}
    for headers in header_sets:
        if not headers:
            continue
        merged = merge_header_map(
            merged,
            _parse_anthropic_custom_headers(headers),
        )
    return headers_to_anthropic_custom_headers(merged)


def extract_default_headers(env: Mapping[str, Any]) -> dict[str, str]:
    """Extract DEFAULT_HEADERS/default_headers from an environment mapping."""
    for key in DEFAULT_HEADERS_ENV_KEYS:
        headers = _parse_header_map(env.get(key))
        if headers:
            return headers
    return {}


def _parse_header_map(headers: Mapping[str, Any] | str | None) -> dict[str, str]:
    if not headers:
        return {}
    if isinstance(headers, Mapping):
        return {
            str(key): str(value)
            for key, value in headers.items()
            if key is not None and value is not None
        }
    if isinstance(headers, str):
        stripped = headers.strip()
        if not stripped:
            return {}
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            return _parse_header_lines(stripped)
        if isinstance(parsed, Mapping):
            return _parse_header_map(parsed)
    return {}


def _parse_anthropic_custom_headers(headers: str) -> dict[str, str]:
    if not headers:
        return {}
    parsed_json = _parse_header_map(headers)
    if parsed_json:
        return parsed_json
    return _parse_header_lines(headers)


def _parse_header_lines(headers: str) -> dict[str, str]:
    parsed: dict[str, str] = {}
    for line in headers.splitlines():
        stripped = line.strip()
        if not stripped or ":" not in stripped:
            continue
        key, value = stripped.split(":", 1)
        key = key.strip()
        if not key:
            continue
        parsed[key] = value.strip()
    return parsed


def _normalize_project_id(project_id: Any) -> str:
    if project_id is None:
        return ""
    value = str(project_id).strip()
    if not value or value == "0":
        return ""
    return value
