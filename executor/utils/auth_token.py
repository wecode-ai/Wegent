# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authentication token helpers for executor.

Executor authentication supports:
- JWT access tokens (3 dot-separated segments)
- Personal API keys starting with "wg-" (recommended for local executor)
"""

from __future__ import annotations

import re


API_KEY_PREFIX = "wg-"


def normalize_auth_token(token: str | None) -> str:
    """Normalize auth token by stripping whitespace and optional Bearer prefix."""
    if not token:
        return ""
    normalized = token.strip()
    match = re.match(r"(?i)^bearer\s+(.+)$", normalized)
    if match:
        return match.group(1).strip()
    return normalized


def is_api_key(token: str | None) -> bool:
    """Return True if token is a personal API key (wg-...)."""
    normalized = normalize_auth_token(token)
    return normalized.startswith(API_KEY_PREFIX)


def looks_like_jwt(token: str | None) -> bool:
    """Return True if token looks like a JWT (3 dot-separated segments)."""
    normalized = normalize_auth_token(token)
    if normalized.count(".") != 2:
        return False
    header, payload, signature = normalized.split(".", 2)
    return bool(header and payload and signature)


def is_supported_auth_token(token: str | None) -> bool:
    """Return True if token is a supported auth token type."""
    return is_api_key(token) or looks_like_jwt(token)
