# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
WebSocket API module for Socket.IO namespaces.

This module provides Socket.IO namespace handlers for real-time
communication features including chat streaming and task events.
"""

from app.api.ws.chat_namespace import register_chat_namespace
from app.api.ws.events import *  # noqa: F401,F403
from app.api.ws.local_executor_namespace import (
    get_local_executor_namespace,
    register_local_executor_namespace,
)

__all__ = [
    "register_chat_namespace",
    "register_local_executor_namespace",
    "get_local_executor_namespace",
]
