# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Remove backend-only workflow URLs from client-facing payloads."""

from __future__ import annotations

from typing import Any

_PRIVATE_WORKFLOW_URL_KEYS = {
    "polling_url",
    "query_url",
    "task_url",
}


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
