# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from collections.abc import Mapping
from typing import Any

WEWORK_ACCESS_TOKEN_USE = "wework_access"
WEWORK_REFRESH_TOKEN_USE = "wework_refresh"


def is_user_session_payload(payload: Mapping[str, Any]) -> bool:
    """Return whether JWT claims represent an interactive user session."""
    return not payload.get("scope") and payload.get("token_use") in {
        None,
        WEWORK_ACCESS_TOKEN_USE,
    }
