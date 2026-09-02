# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
WebSocket API module for Socket.IO namespaces.

This module provides Socket.IO namespace handlers for real-time
communication features including chat streaming and task events.
"""


def register_chat_namespace(*args, **kwargs):
    """Register chat handlers without importing the namespace during package load."""
    from app.api.ws.chat_namespace import register_chat_namespace as register

    return register(*args, **kwargs)


__all__ = ["register_chat_namespace"]
