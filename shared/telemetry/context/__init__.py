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

# Trace context propagation
from shared.telemetry.context.propagation import (
    TRACE_PARENT_ENV,
    TRACE_STATE_ENV,
    get_trace_context_env_vars,
    get_trace_context_for_propagation,
    inject_trace_context_to_headers,
    restore_trace_context_from_env,
)

# Context setters for common business entities
# Span manipulation utilities
from shared.telemetry.context.span import (
    add_span_event,
    create_child_span,
    get_current_span,
    set_agent_context,
    set_bot_context,
    set_model_context,
    set_repository_context,
    set_request_context,
    set_span_attributes,
    set_span_error,
    set_span_ok,
    set_task_context,
    set_team_context,
    set_user_context,
)

__all__ = [
    # Attributes
    "SpanAttributes",
    # Span utilities
    "get_current_span",
    "set_span_attributes",
    "add_span_event",
    "set_span_error",
    "set_span_ok",
    "create_child_span",
    # Context setters
    "set_user_context",
    "set_task_context",
    "set_team_context",
    "set_bot_context",
    "set_model_context",
    "set_agent_context",
    "set_request_context",
    "set_repository_context",
    # Propagation
    "get_trace_context_for_propagation",
    "get_trace_context_env_vars",
    "restore_trace_context_from_env",
    "inject_trace_context_to_headers",
    "TRACE_PARENT_ENV",
    "TRACE_STATE_ENV",
]
