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

from typing import TYPE_CHECKING, Any

from executor.modes.local.events import (
    ChatEvents,
    DeviceEvents,
    TaskEvents,
)

if TYPE_CHECKING:
    from executor.modes.local.runner import LocalRunner

__all__ = [
    "LocalRunner",
    # Event classes
    "DeviceEvents",
    "TaskEvents",
    "ChatEvents",
]


def __getattr__(name: str) -> Any:
    """Lazily import heavy local runtime modules on demand."""
    if name == "LocalRunner":
        from executor.modes.local.runner import LocalRunner

        return LocalRunner
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
