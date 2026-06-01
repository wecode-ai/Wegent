# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Deferred user input helpers for interactive form tools."""

from __future__ import annotations

import json
from typing import Any


class DeferredUserInputExit(Exception):
    """Raised after a deferred form tool result has been emitted."""

    def __init__(self, ask_id: str | None = None):
        self.ask_id = ask_id
        message = (
            f"Waiting for user input: {ask_id}" if ask_id else "Waiting for user input"
        )
        super().__init__(message)


def _parse(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def is_deferred_user_input_result(value: Any) -> bool:
    """Return whether a tool result asks the run to wait for user input."""
    parsed = _parse(value)
    return bool(
        parsed
        and parsed.get("__deferred_user_input__") is True
        and parsed.get("success") is True
        and parsed.get("status") == "waiting_for_user_response"
    )


def get_deferred_ask_id(value: Any) -> str | None:
    """Extract ask_id from a deferred user input result."""
    parsed = _parse(value)
    ask_id = parsed.get("ask_id") if parsed else None
    return ask_id if isinstance(ask_id, str) and ask_id else None
