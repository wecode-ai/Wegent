# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
WebSocket API module for Socket.IO namespaces.

This module provides Socket.IO namespace handlers for real-time
communication features including chat streaming and task events.
"""

from typing import TYPE_CHECKING

from app.api.ws.events import *  # noqa: F401,F403

if TYPE_CHECKING:
    import socketio


def register_chat_namespace(sio: "socketio.AsyncServer") -> None:
    """Register chat handlers without importing the namespace during package init."""
    from app.api.ws.chat_namespace import register_chat_namespace as register

    register(sio)


__all__ = ["register_chat_namespace"]
