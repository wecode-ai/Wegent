# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Deferred user input helpers for interactive form tools."""

from __future__ import annotations

import json
from typing import Any


class DeferredUserInputExit(Exception):
    """Raised after a deferred form tool result has been emitted."""

    def __init__(self):
        super().__init__("Waiting for user input")


def _parse_json(value: str) -> Any:
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return None


def _iter_records(value: Any, *, depth: int = 0):
    if depth > 5 or value is None:
        return

    if isinstance(value, str):
        parsed = _parse_json(value)
        if parsed is not None:
            yield from _iter_records(parsed, depth=depth + 1)
        return

    if isinstance(value, list):
        for item in value:
            yield from _iter_records(item, depth=depth + 1)
        return

    if not isinstance(value, dict):
        return

    yield value
    for key in ("text", "content"):
        nested = value.get(key)
        if isinstance(nested, (str, dict, list)):
            yield from _iter_records(nested, depth=depth + 1)


def _is_deferred_record(value: dict[str, Any]) -> bool:
    return bool(
        value.get("__deferred_user_input__") is True
        and value.get("success") is True
        and value.get("status") == "waiting_for_user_response"
    )


def is_deferred_user_input_result(value: Any) -> bool:
    """Return whether a tool result asks the run to wait for user input."""
    return any(_is_deferred_record(record) for record in _iter_records(value))
