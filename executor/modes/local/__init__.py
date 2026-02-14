# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Local deployment mode for executor.

This module implements local mode executor that connects to Backend via WebSocket.
Local mode enables running Claude Code Agent without Docker containers.

Key components:
- LocalRunner: Main runner for local mode
- WebSocketClient: WebSocket client for Backend communication
- HeartbeatService: Heartbeat service for connection health
- Events: Event type definitions (Socket.IO events)

Events are sent using OpenAI Responses API event types directly as Socket.IO
event names (e.g., "response.created", "response.completed", "error").
This allows backend's DeviceNamespace to route them correctly.
"""

from executor.modes.local.events import (
    ChatEvents,
    DeviceEvents,
    TaskEvents,
)
from executor.modes.local.runner import LocalRunner

__all__ = [
    "LocalRunner",
    # Event classes
    "DeviceEvents",
    "TaskEvents",
    "ChatEvents",
]
