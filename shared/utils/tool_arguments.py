# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Utilities for UI-safe tool argument summaries."""

from __future__ import annotations

import hashlib
from typing import Any

LARGE_ARGUMENT_FIELDS = {
    "base64",
    "bytes",
    "content",
    "data",
    "file_content",
}


def sanitize_tool_arguments(
    tool_name: str,
    arguments: Any,
    *,
    max_string_length: int = 2048,
) -> Any:
    """Return arguments safe to send to UI clients.

    Large payload fields are summarized so file contents and binary data do not
    enter WebSocket payloads, React state, or persisted block history.
    """
    return _sanitize_value(
        arguments,
        field_name="",
        max_string_length=max_string_length,
        force_large_fields=_force_large_fields(tool_name),
    )


def _force_large_fields(tool_name: str) -> set[str]:
    normalized = tool_name.lower()
    if "write" in normalized or "upload" in normalized:
        return LARGE_ARGUMENT_FIELDS
    return LARGE_ARGUMENT_FIELDS


def _sanitize_value(
    value: Any,
    *,
    field_name: str,
    max_string_length: int,
    force_large_fields: set[str],
) -> Any:
    normalized_field = field_name.lower()

    if isinstance(value, dict):
        return {
            str(key): _sanitize_value(
                child,
                field_name=str(key),
                max_string_length=max_string_length,
                force_large_fields=force_large_fields,
            )
            for key, child in value.items()
        }

    if isinstance(value, list):
        return [
            _sanitize_value(
                child,
                field_name=field_name,
                max_string_length=max_string_length,
                force_large_fields=force_large_fields,
            )
            for child in value
        ]

    if isinstance(value, str):
        should_omit = (
            normalized_field in force_large_fields or len(value) > max_string_length
        )
        if should_omit:
            return {
                "omitted": True,
                "length": len(value),
                "preview": value[:max_string_length],
                "sha256": hashlib.sha256(value.encode("utf-8")).hexdigest(),
            }
        return value

    if isinstance(value, (bytes, bytearray)):
        raw = bytes(value)
        return {
            "omitted": True,
            "length": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
        }

    return value
