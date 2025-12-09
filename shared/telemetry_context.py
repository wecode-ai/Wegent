#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
OpenTelemetry span context utilities.
Provides tools for enhancing spans with business context attributes.
"""

import logging
from typing import Any, Dict, Optional

from opentelemetry import trace
from opentelemetry.trace import Span, Status, StatusCode

from shared.telemetry import is_telemetry_enabled

logger = logging.getLogger(__name__)


# Standard attribute keys for Wegent services
class SpanAttributes:
    """Standard span attribute keys for consistent tracing."""

    # User attributes
    USER_ID = "user.id"
    USER_NAME = "user.name"

    # Task attributes
    TASK_ID = "task.id"
    SUBTASK_ID = "subtask.id"

    # Team attributes
    TEAM_ID = "team.id"
    TEAM_NAME = "team.name"

    # Bot attributes
    BOT_ID = "bot.id"
    BOT_NAME = "bot.name"

    # Model attributes
    MODEL_NAME = "model.name"
    MODEL_PROVIDER = "model.provider"

    # Agent attributes
    AGENT_TYPE = "agent.type"
    AGENT_NAME = "agent.name"

    # Request attributes
    REQUEST_ID = "request.id"

    # Git/Repository attributes
    REPOSITORY_URL = "repository.url"
    BRANCH_NAME = "branch.name"


def get_current_span() -> Optional[Span]:
    """
    Get the current active span.

    Returns:
        Optional[Span]: The current span or None if no span is active
    """
    span = trace.get_current_span()
    if span and span.is_recording():
        return span
    return None


def set_span_attributes(attributes: Dict[str, Any]) -> None:
    """
    Add attributes to the current span.

    Args:
        attributes: Dictionary of attribute key-value pairs
    """
    if not is_telemetry_enabled():
        return

    span = get_current_span()
    if not span:
        return

    try:
        for key, value in attributes.items():
            if value is not None:
                # Convert value to string if not a primitive type
                if isinstance(value, (str, int, float, bool)):
                    span.set_attribute(key, value)
                else:
                    span.set_attribute(key, str(value))
    except Exception as e:
        logger.debug(f"Failed to set span attributes: {e}")


def add_span_event(name: str, attributes: Optional[Dict[str, Any]] = None) -> None:
    """
    Add an event to the current span.

    Args:
        name: Name of the event
        attributes: Optional dictionary of event attributes
    """
    if not is_telemetry_enabled():
        return

    span = get_current_span()
    if not span:
        return

    try:
        event_attributes = {}
        if attributes:
            for key, value in attributes.items():
                if value is not None:
                    if isinstance(value, (str, int, float, bool)):
                        event_attributes[key] = value
                    else:
                        event_attributes[key] = str(value)

        span.add_event(name, event_attributes)
    except Exception as e:
        logger.debug(f"Failed to add span event: {e}")


def set_span_error(
    error: Exception, description: Optional[str] = None, record_exception: bool = True
) -> None:
    """
    Mark the current span as errored and optionally record the exception.

    Args:
        error: The exception that occurred
        description: Optional error description
        record_exception: Whether to record the full exception details (default: True)
    """
    if not is_telemetry_enabled():
        return

    span = get_current_span()
    if not span:
        return

    try:
        if record_exception:
            span.record_exception(error)

        span.set_status(
            Status(status_code=StatusCode.ERROR, description=description or str(error))
        )
    except Exception as e:
        logger.debug(f"Failed to set span error: {e}")


def set_span_ok(description: Optional[str] = None) -> None:
    """
    Mark the current span as successful.

    Args:
        description: Optional success description
    """
    if not is_telemetry_enabled():
        return

    span = get_current_span()
    if not span:
        return

    try:
        span.set_status(Status(status_code=StatusCode.OK, description=description))
    except Exception as e:
        logger.debug(f"Failed to set span OK status: {e}")


def set_user_context(
    user_id: Optional[str] = None, user_name: Optional[str] = None
) -> None:
    """
    Set user context attributes on the current span.

    Args:
        user_id: User identifier
        user_name: User name
    """
    attributes = {}
    if user_id:
        attributes[SpanAttributes.USER_ID] = user_id
    if user_name:
        attributes[SpanAttributes.USER_NAME] = user_name

    if attributes:
        set_span_attributes(attributes)


def set_task_context(
    task_id: Optional[int] = None, subtask_id: Optional[int] = None
) -> None:
    """
    Set task context attributes on the current span.

    Args:
        task_id: Task identifier
        subtask_id: Subtask identifier
    """
    attributes = {}
    if task_id is not None:
        attributes[SpanAttributes.TASK_ID] = task_id
    if subtask_id is not None:
        attributes[SpanAttributes.SUBTASK_ID] = subtask_id

    if attributes:
        set_span_attributes(attributes)


def set_team_context(
    team_id: Optional[str] = None, team_name: Optional[str] = None
) -> None:
    """
    Set team context attributes on the current span.

    Args:
        team_id: Team identifier
        team_name: Team name
    """
    attributes = {}
    if team_id:
        attributes[SpanAttributes.TEAM_ID] = team_id
    if team_name:
        attributes[SpanAttributes.TEAM_NAME] = team_name

    if attributes:
        set_span_attributes(attributes)


def set_bot_context(
    bot_id: Optional[str] = None, bot_name: Optional[str] = None
) -> None:
    """
    Set bot context attributes on the current span.

    Args:
        bot_id: Bot identifier
        bot_name: Bot name
    """
    attributes = {}
    if bot_id:
        attributes[SpanAttributes.BOT_ID] = bot_id
    if bot_name:
        attributes[SpanAttributes.BOT_NAME] = bot_name

    if attributes:
        set_span_attributes(attributes)


def set_model_context(
    model_name: Optional[str] = None, model_provider: Optional[str] = None
) -> None:
    """
    Set model context attributes on the current span.

    Args:
        model_name: Model name
        model_provider: Model provider (e.g., "anthropic", "openai")
    """
    attributes = {}
    if model_name:
        attributes[SpanAttributes.MODEL_NAME] = model_name
    if model_provider:
        attributes[SpanAttributes.MODEL_PROVIDER] = model_provider

    if attributes:
        set_span_attributes(attributes)


def set_agent_context(
    agent_type: Optional[str] = None, agent_name: Optional[str] = None
) -> None:
    """
    Set agent context attributes on the current span.

    Args:
        agent_type: Agent type (e.g., "ClaudeCode", "Agno", "Dify")
        agent_name: Agent name
    """
    attributes = {}
    if agent_type:
        attributes[SpanAttributes.AGENT_TYPE] = agent_type
    if agent_name:
        attributes[SpanAttributes.AGENT_NAME] = agent_name

    if attributes:
        set_span_attributes(attributes)


def set_request_context(request_id: Optional[str] = None) -> None:
    """
    Set request context attributes on the current span.

    Args:
        request_id: Request identifier
    """
    if request_id:
        set_span_attributes({SpanAttributes.REQUEST_ID: request_id})


def set_repository_context(
    repository_url: Optional[str] = None, branch_name: Optional[str] = None
) -> None:
    """
    Set repository context attributes on the current span.

    Args:
        repository_url: Repository URL
        branch_name: Branch name
    """
    attributes = {}
    if repository_url:
        attributes[SpanAttributes.REPOSITORY_URL] = repository_url
    if branch_name:
        attributes[SpanAttributes.BRANCH_NAME] = branch_name

    if attributes:
        set_span_attributes(attributes)


# ============================================================================
# Trace Context Propagation Utilities
# ============================================================================

# Environment variable names for trace context propagation
TRACE_PARENT_ENV = "OTEL_TRACEPARENT"
TRACE_STATE_ENV = "OTEL_TRACESTATE"


def get_trace_context_for_propagation() -> Dict[str, str]:
    """
    Extract current trace context as a dictionary for propagation.

    This function extracts the current trace context (traceparent and tracestate)
    in W3C Trace Context format, suitable for passing to child services via
    HTTP headers or environment variables.

    Returns:
        Dict[str, str]: Dictionary with 'traceparent' and optionally 'tracestate' keys
    """
    from opentelemetry import trace
    from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

    context_dict: Dict[str, str] = {}

    try:
        # Get the current span context
        span = trace.get_current_span()
        if span is None or not span.get_span_context().is_valid:
            return context_dict

        # Use W3C TraceContext propagator to inject context
        propagator = TraceContextTextMapPropagator()
        propagator.inject(context_dict)

    except Exception as e:
        logger.debug(f"Failed to extract trace context for propagation: {e}")

    return context_dict


def get_trace_context_env_vars() -> Dict[str, str]:
    """
    Get trace context as environment variables for Docker container propagation.

    Returns:
        Dict[str, str]: Dictionary with OTEL_TRACEPARENT and optionally OTEL_TRACESTATE
    """
    env_vars: Dict[str, str] = {}

    try:
        context = get_trace_context_for_propagation()

        if "traceparent" in context:
            env_vars[TRACE_PARENT_ENV] = context["traceparent"]

        if "tracestate" in context:
            env_vars[TRACE_STATE_ENV] = context["tracestate"]

    except Exception as e:
        logger.debug(f"Failed to get trace context env vars: {e}")

    return env_vars


def restore_trace_context_from_env() -> None:
    """
    Restore trace context from environment variables.

    This should be called at the start of a child process/container to restore
    the parent trace context and continue the distributed trace.

    The function reads OTEL_TRACEPARENT and OTEL_TRACESTATE environment variables
    and sets them as the current context.
    """
    import os
    from opentelemetry import context
    from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

    try:
        traceparent = os.environ.get(TRACE_PARENT_ENV)
        if not traceparent:
            logger.debug("No trace context found in environment variables")
            return

        # Build carrier dictionary
        carrier = {"traceparent": traceparent}
        tracestate = os.environ.get(TRACE_STATE_ENV)
        if tracestate:
            carrier["tracestate"] = tracestate

        # Extract context from carrier
        propagator = TraceContextTextMapPropagator()
        ctx = propagator.extract(carrier)

        # Attach the extracted context
        context.attach(ctx)

        logger.debug(f"Restored trace context from env: traceparent={traceparent}")

    except Exception as e:
        logger.debug(f"Failed to restore trace context from env: {e}")


def inject_trace_context_to_headers(headers: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """
    Inject current trace context into HTTP headers.

    This is useful for propagating trace context in HTTP requests to other services.

    Args:
        headers: Optional existing headers dictionary to update

    Returns:
        Dict[str, str]: Headers dictionary with trace context headers added
    """
    if headers is None:
        headers = {}

    try:
        context = get_trace_context_for_propagation()
        headers.update(context)
    except Exception as e:
        logger.debug(f"Failed to inject trace context to headers: {e}")

    return headers


def create_child_span(
    name: str,
    attributes: Optional[Dict[str, Any]] = None,
) -> Optional[Span]:
    """
    Create a child span under the current trace context.

    This is useful for creating spans for operations that are part of the current trace.

    Args:
        name: Name of the span
        attributes: Optional attributes to set on the span

    Returns:
        Optional[Span]: The created span, or None if telemetry is disabled
    """
    if not is_telemetry_enabled():
        return None

    try:
        tracer = trace.get_tracer(__name__)
        span = tracer.start_span(name)

        if attributes:
            for key, value in attributes.items():
                if value is not None:
                    if isinstance(value, (str, int, float, bool)):
                        span.set_attribute(key, value)
                    else:
                        span.set_attribute(key, str(value))

        return span

    except Exception as e:
        logger.debug(f"Failed to create child span: {e}")
        return None
