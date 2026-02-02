# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Access control module for Chat Service.

This module provides utilities for checking task access permissions
and token authentication (JWT and API Key).
"""

from .auth import (
    get_token_expiry,
    is_api_key,
    is_token_expired,
    verify_api_key_for_websocket,
    verify_jwt_token,
    verify_websocket_token,
)
from .permissions import can_access_task, can_access_task_sync, get_active_streaming

__all__ = [
    "verify_jwt_token",
    "verify_api_key_for_websocket",
    "verify_websocket_token",
    "is_token_expired",
    "is_api_key",
    "get_token_expiry",
    "can_access_task",
    "can_access_task_sync",
    "get_active_streaming",
]
