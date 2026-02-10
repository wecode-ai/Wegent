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
- WebSocketProgressReporter: Progress reporter via WebSocket
- HeartbeatService: Heartbeat service for connection health
- Events: Event type definitions (Socket.IO events and unified ExecutionEvent)
"""

from executor.modes.local.events import (
    ChatEvents,
    DeviceEvents,
    EventType,
    ExecutionEvent,
    TaskEvents,
)
from executor.modes.local.progress_reporter import WebSocketProgressReporter
from executor.modes.local.runner import LocalRunner

__all__ = [
    "LocalRunner",
    "WebSocketProgressReporter",
    # Event classes
    "DeviceEvents",
    "TaskEvents",
    "ChatEvents",
    # Unified event types (re-exported from shared)
    "EventType",
    "ExecutionEvent",
]
