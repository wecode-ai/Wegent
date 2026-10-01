# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Remove backend-only workflow URLs from client-facing payloads."""

from __future__ import annotations

import json
from typing import Any

_PRIVATE_WORKFLOW_URL_KEYS = {
    "polling_url",
    "query_url",
    "task_url",
}

MAX_CLIENT_RESULT_BYTES = 96 * 1024
CLIENT_TRUNCATION_NOTICE = (
    "\n\n[Only a preview is shown because this response is too large to transfer "
    "in the task history. Reloading will not restore omitted content.]"
)


def _json_size(payload: Any) -> int:
    return len(json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8"))


def _truncate_text(value: str, *, max_bytes: int) -> str:
    suffix_bytes = CLIENT_TRUNCATION_NOTICE.encode("utf-8")
    available = max(max_bytes - len(suffix_bytes), 0)
    return (
        value.encode("utf-8")[:available].decode("utf-8", errors="ignore")
        + CLIENT_TRUNCATION_NOTICE
    )


def sanitize_client_payload(payload: Any) -> Any:
    """Recursively remove private workflow URLs while preserving public data."""
    if isinstance(payload, dict):
        return {
            key: sanitize_client_payload(value)
            for key, value in payload.items()
            if key not in _PRIVATE_WORKFLOW_URL_KEYS
        }
    if isinstance(payload, list):
        return [sanitize_client_payload(item) for item in payload]
    return payload


def sanitize_client_result(result: Any) -> Any:
    """Return a bounded result payload suitable for task history transports."""
    sanitized = sanitize_client_payload(result)
    if not isinstance(sanitized, dict):
        return sanitized

    size_bytes = _json_size(sanitized)
    if size_bytes <= MAX_CLIENT_RESULT_BYTES:
        return sanitized

    value = sanitized.get("value")
    preview = (
        _truncate_text(value, max_bytes=MAX_CLIENT_RESULT_BYTES // 2)
        if isinstance(value, str)
        else CLIENT_TRUNCATION_NOTICE.strip()
    )
    return {
        "value": preview,
        "truncated": True,
        "original_size_bytes": size_bytes,
        "truncation_reason": "transport_limit",
    }
