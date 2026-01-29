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
"""

from executor.modes.local.runner import LocalRunner

__all__ = ["LocalRunner"]
