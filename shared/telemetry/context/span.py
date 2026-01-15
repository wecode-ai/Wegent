# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Span manipulation utilities for OpenTelemetry.

Provides functions for working with spans, including
setting attributes, adding events, and managing span status.

Also provides ContextVars for automatic propagation of business context
(task_id, subtask_id, user_id, user_name) to all spans within a request.
"""

import logging
from contextvars import ContextVar
from typing import Any, Dict, Optional

from opentelemetry import trace
from opentelemetry.trace import Span, Status, StatusCode

from shared.telemetry.context.attributes import SpanAttributes
from shared.telemetry.core import is_telemetry_enabled

# ============================================================================
# Context Variables for automatic propagation to all spans
# ============================================================================

# These ContextVars store business context that should be automatically
# added to all spans within a request. They are set via set_task_context()
# and set_user_context(), and read by BusinessContextSpanProcessor.

_task_id_var: ContextVar[Optional[int]] = ContextVar("task_id", default=None)
_subtask_id_var: ContextVar[Optional[int]] = ContextVar("subtask_id", default=None)
_user_id_var: ContextVar[Optional[str]] = ContextVar("user_id", default=None)
_user_name_var: ContextVar[Optional[str]] = ContextVar("user_name", default=None)
_request_id_var: ContextVar[Optional[str]] = ContextVar("request_id", default=None)
_websocket_context_var: ContextVar[bool] = ContextVar(
    "websocket_context", default=False
)

# Cached server IP (doesn't change during process lifetime)
_cached_server_ip: Optional[str] = None


def get_server_ip() -> str:
    """
    Get the server IP address with caching.

    The server IP doesn't change during process lifetime, so we cache it
    to avoid repeated socket operations.

    Returns:
        The server IP address
    """
    global _cached_server_ip
    if _cached_server_ip is None:
        from shared.utils.ip_util import get_host_ip

        _cached_server_ip = get_host_ip()
    return _cached_server_ip


def get_request_id() -> Optional[str]:
    """
    Get the current request ID from ContextVar.

    This is used by the logging filter to add request_id to log records.

    Returns:
        The current request ID or None if not set
    """
    return _request_id_var.get()


def is_websocket_context() -> bool:
    """Check if current context is a WebSocket context."""
    return _websocket_context_var.get()


def set_websocket_context(is_websocket: bool = True) -> None:
    """Mark current context as WebSocket context."""
    _websocket_context_var.set(is_websocket)


def copy_context_vars() -> Dict[str, Any]:
    """
    Copy all telemetry ContextVar values to a dictionary.

    This is useful when creating a new event loop or thread where
    ContextVars don't automatically propagate. The returned dict
    can be passed to restore_context_vars() in the new context.

    Returns:
        Dict containing all current ContextVar values
    """
    return {
        "task_id": _task_id_var.get(),
        "subtask_id": _subtask_id_var.get(),
        "user_id": _user_id_var.get(),
        "user_name": _user_name_var.get(),
        "request_id": _request_id_var.get(),
    }


def restore_context_vars(context_dict: Dict[str, Any]) -> None:
    """
    Restore ContextVar values from a dictionary.

    This should be called at the start of a new event loop or thread
    to restore the context that was copied with copy_context_vars().

    Args:
        context_dict: Dict containing ContextVar values from copy_context_vars()
    """
    if context_dict.get("task_id") is not None:
        _task_id_var.set(context_dict["task_id"])
    if context_dict.get("subtask_id") is not None:
        _subtask_id_var.set(context_dict["subtask_id"])
    if context_dict.get("user_id") is not None:
        _user_id_var.set(context_dict["user_id"])
    if context_dict.get("user_name") is not None:
        _user_name_var.set(context_dict["user_name"])
    if context_dict.get("request_id") is not None:
        _request_id_var.set(context_dict["request_id"])


def get_business_context() -> Dict[str, Any]:
    """
    Get the current business context from ContextVars.

    Returns:
        Dict with task_id, subtask_id, user_id, user_name, request_id if set
    """
    context = {}

    task_id = _task_id_var.get()
    if task_id is not None:
        context[SpanAttributes.TASK_ID] = task_id

    subtask_id = _subtask_id_var.get()
    if subtask_id is not None:
        context[SpanAttributes.SUBTASK_ID] = subtask_id

    user_id = _user_id_var.get()
    if user_id is not None:
        context[SpanAttributes.USER_ID] = user_id

    user_name = _user_name_var.get()
    if user_name is not None:
        context[SpanAttributes.USER_NAME] = user_name

    request_id = _request_id_var.get()
    if request_id is not None:
        context[SpanAttributes.REQUEST_ID] = request_id

    return context


logger = logging.getLogger(__name__)


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


def record_stream_error(
    error: Exception,
    event_name: str,
    task_id: Optional[int] = None,
    subtask_id: Optional[int] = None,
    extra_attributes: Optional[Dict[str, Any]] = None,
) -> None:
    """
    Record a stream error with standardized attributes including server IP.

    This is a convenience function that combines set_span_error and add_span_event
    with common attributes for stream errors.

    Args:
        error: The exception that occurred
        event_name: The telemetry event name (e.g., TelemetryEventNames.STREAM_ERROR)
        task_id: Optional task ID
        subtask_id: Optional subtask ID
        extra_attributes: Optional additional attributes to include
    """
    error_type = type(error).__name__
    error_msg = str(error)[:500]  # Truncate long messages

    # Set span error status
    set_span_error(error, description=f"Stream error: {error_type}")

    # Build event attributes
    attributes: Dict[str, Any] = {
        "error.type": error_type,
        "error.message": error_msg,
        "server.ip": get_server_ip(),
    }

    if task_id is not None:
        attributes["task.id"] = task_id
    if subtask_id is not None:
        attributes["subtask.id"] = subtask_id

    # Merge extra attributes
    if extra_attributes:
        attributes.update(extra_attributes)

    # Add span event
    add_span_event(event_name, attributes)


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


# ============================================================================
# Context Setters for Common Business Entities
# ============================================================================


def set_user_context(
    user_id: Optional[str] = None, user_name: Optional[str] = None
) -> None:
    """
    Set user context attributes on the current span AND store in ContextVar
    for automatic propagation to subsequent spans.

    Args:
        user_id: User identifier
        user_name: User name
    """
    # Store in ContextVars for automatic propagation to subsequent spans
    if user_id is not None:
        _user_id_var.set(user_id)
    if user_name is not None:
        _user_name_var.set(user_name)

    # Also set on current span immediately
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
    Set task context attributes on the current span AND store in ContextVar
    for automatic propagation to subsequent spans.

    Args:
        task_id: Task identifier
        subtask_id: Subtask identifier
    """
    # Store in ContextVars for automatic propagation to subsequent spans
    if task_id is not None:
        _task_id_var.set(task_id)
    if subtask_id is not None:
        _subtask_id_var.set(subtask_id)

    # Also set on current span immediately
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
    Set request context attributes on the current span AND store in ContextVar
    for use in logging. Also sets server.ip for request tracing.

    Args:
        request_id: Request identifier
    """
    # Store in ContextVar for logging filter to access
    if request_id is not None:
        _request_id_var.set(request_id)

    # Build attributes to set
    attributes = {}
    if request_id:
        attributes[SpanAttributes.REQUEST_ID] = request_id

    # Always set server IP for request tracing (uses cached value)
    attributes[SpanAttributes.SERVER_IP] = get_server_ip()

    # Set on current span immediately
    if attributes:
        set_span_attributes(attributes)


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
# OpenTelemetry Context Management for Async Boundaries
# ============================================================================


def attach_otel_context(otel_context: Any) -> Optional[object]:
    """
    Safely attach OpenTelemetry context for cross-async-boundary propagation.

    This is useful when creating background tasks with asyncio.create_task(),
    where the OpenTelemetry context doesn't automatically propagate.
    The returned token must be passed to detach_otel_context() for cleanup.

    Args:
        otel_context: OpenTelemetry context object from context.get_current()

    Returns:
        Token for later detachment, or None if attachment failed

    Example:
        ```python
        from opentelemetry import context
        from shared.telemetry.context import attach_otel_context, detach_otel_context

        # Capture context before creating background task
        otel_context = context.get_current()

        async def background_task():
            # Restore context in background task
            token = attach_otel_context(otel_context)
            try:
                # Your logic here - spans will have correct parent
                ...
            finally:
                detach_otel_context(token)
        ```
    """
    if not otel_context:
        return None

    try:
        from opentelemetry import context

        token = context.attach(otel_context)
        logger.debug(
            "Attached OpenTelemetry context for parent-child span relationships"
        )
        return token
    except Exception as e:
        logger.debug(f"Failed to attach OpenTelemetry context: {e}")
        return None


def detach_otel_context(token: Optional[object]) -> None:
    """
    Safely detach OpenTelemetry context.

    This should always be called in a finally block to ensure proper cleanup,
    even if an exception occurs.

    Args:
        token: Token returned from attach_otel_context()

    Example:
        ```python
        token = attach_otel_context(otel_context)
        try:
            # Your logic here
            ...
        finally:
            detach_otel_context(token)
        ```
    """
    if not token:
        return

    try:
        from opentelemetry import context

        context.detach(token)
        logger.debug("Detached OpenTelemetry context")
    except Exception as e:
        logger.debug(f"Failed to detach OpenTelemetry context: {e}")
