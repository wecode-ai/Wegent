# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Direct Chat Service Module

This module provides direct chat capabilities for Chat and Dify shell types,
allowing API calls to be made directly from the Backend without Docker containers.
"""

from app.services.direct_chat.base import (
    DirectChatService,
    close_http_client,
    get_http_client,
)
from app.services.direct_chat.chat_service import ChatDirectService
from app.services.direct_chat.dify_service import DifyDirectService
from app.services.direct_chat.session_manager import SessionManager

__all__ = [
    "DirectChatService",
    "ChatDirectService",
    "DifyDirectService",
    "SessionManager",
    "get_http_client",
    "close_http_client",
]
