# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Standardized event and span names for OpenTelemetry tracking.

This module provides centralized constants for event names and span names
used across all services for consistent observability.
"""


class TelemetryEventNames:
    """Standardized event names for OpenTelemetry tracking (success and errors)."""

    # Error events
    BOT_NOT_FOUND = "BotNotFound"
    PROVIDER_CREATION_FAILED = "ProviderCreationFailed"
    STREAM_CHUNK_ERROR = "StreamChunkError"
    GENERAL_ERROR = "GeneralError"

    # Success events
    STREAM_COMPLETED = "StreamCompleted"
    MODEL_REQUEST_SUCCESS = "ModelRequestSuccess"


class SpanNames:
    """Standardized span names for common operations."""

    # Chat operations
    CHAT_STREAM_RESPONSE = "chat.stream_response"
    WEBSOCKET_EVENT = "websocket.{event}"  # Format with event name

    # Future: Add more span names as needed
    # EXECUTOR_RUN_TASK = "executor.run_task"
    # EXECUTOR_STREAM_OUTPUT = "executor.stream_output"
    # WEBHOOK_PROCESS = "webhook.process"
