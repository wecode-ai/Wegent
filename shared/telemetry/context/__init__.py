# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenTelemetry context utilities module.

Provides tools for enhancing spans with business context attributes
and propagating trace context across service boundaries.
"""

# Span attribute keys
from shared.telemetry.context.attributes import SpanAttributes
# Event and span names
from shared.telemetry.context.events import SpanNames, TelemetryEventNames
# Span manager
from shared.telemetry.context.manager import SpanManager
# Trace context propagation
from shared.telemetry.context.propagation import (
    TRACE_PARENT_ENV, TRACE_STATE_ENV, extract_trace_context_from_headers,
    get_trace_context_env_vars, get_trace_context_for_propagation,
    inject_trace_context_to_headers, restore_trace_context_from_env)
# Context setters for common business entities
# Span manipulation utilities
from shared.telemetry.context.span import (add_span_event, attach_otel_context,
                                           copy_context_vars,
                                           create_child_span,
                                           detach_otel_context,
                                           get_business_context,
                                           get_current_span, get_request_id,
                                           get_server_ip, is_websocket_context,
                                           record_stream_error,
                                           restore_context_vars,
                                           set_agent_context, set_bot_context,
                                           set_model_context,
                                           set_repository_context,
                                           set_request_context,
                                           set_span_attributes, set_span_error,
                                           set_span_ok, set_task_context,
                                           set_team_context, set_user_context,
                                           set_websocket_context)

__all__ = [
    # Attributes
    "SpanAttributes",
    # Event and span names
    "TelemetryEventNames",
    "SpanNames",
    # Span manager
    "SpanManager",
    # Span utilities
    "get_current_span",
    "set_span_attributes",
    "add_span_event",
    "set_span_error",
    "set_span_ok",
    "create_child_span",
    "record_stream_error",
    # Context setters
    "set_user_context",
    "set_task_context",
    "set_team_context",
    "set_bot_context",
    "set_model_context",
    "set_agent_context",
    "set_request_context",
    "set_repository_context",
    # Context getters (for SpanProcessor and logging)
    "get_business_context",
    "get_request_id",
    "get_server_ip",
    "is_websocket_context",
    # WebSocket context
    "set_websocket_context",
    # Context copy/restore (for new event loops or threads)
    "copy_context_vars",
    "restore_context_vars",
    # OTEL context management for async boundaries
    "attach_otel_context",
    "detach_otel_context",
    # Propagation
    "get_trace_context_for_propagation",
    "get_trace_context_env_vars",
    "restore_trace_context_from_env",
    "inject_trace_context_to_headers",
    "extract_trace_context_from_headers",
    "TRACE_PARENT_ENV",
    "TRACE_STATE_ENV",
]
