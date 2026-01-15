# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
WebSocket event decorators for tracing and context management.
"""

import logging
import uuid
from functools import wraps
from typing import Any, Callable, Optional

from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode
from shared.telemetry.context import (
    SpanNames,
    set_request_context,
    set_user_context,
    set_websocket_context,
)
from shared.telemetry.core import is_telemetry_enabled

from app.core.config import settings

logger = logging.getLogger(__name__)


def trace_websocket_event(
    exclude_events: Optional[set] = None,
    extract_event_data: bool = True,
):
    """
    Decorator to add OpenTelemetry tracing to WebSocket event handlers.

    This decorator:
    1. Generates a unique request_id for each event (except 'connect')
    2. Restores user context from session
    3. Creates an OpenTelemetry span with event metadata
    4. Handles exceptions and marks span status

    Args:
        exclude_events: Set of event names to exclude from tracing (e.g., {'connect', 'ping'})
        extract_event_data: Whether to extract task_id/team_id/subtask_id from event data

    Usage:
        class ChatNamespace(socketio.AsyncNamespace):
            @trace_websocket_event()
            async def trigger_event(self, event: str, sid: str, *args):
                # Your event handling logic
                return await self._execute_handler(event, sid, *args)

    Example with custom config:
        @trace_websocket_event(
            exclude_events={'ping', 'pong'},
            extract_event_data=True
        )
        async def trigger_event(self, event: str, sid: str, *args):
            ...
    """
    if exclude_events is None:
        exclude_events = set()

    def decorator(func: Callable) -> Callable:
        @wraps(func)
        async def wrapper(self, event: str, sid: str, *args):
            # Mark this as WebSocket context to filter Redis spans
            set_websocket_context(True)

            # Skip tracing for excluded events
            if event in exclude_events:
                return await func(self, event, sid, *args)

            # Generate a new request_id for each WebSocket event (except connect)
            if event != "connect":
                event_request_id = str(uuid.uuid4())[:8]
                set_request_context(event_request_id)

                # Restore user context from session
                try:
                    session = await self.get_session(sid)
                    user_id = session.get("user_id")
                    user_name = session.get("user_name")
                    if user_id:
                        set_user_context(user_id=str(user_id), user_name=user_name)
                except Exception as e:
                    logger.debug(f"Failed to restore user context: {e}")

            # Create OpenTelemetry span for WebSocket event tracing
            span_context = None
            try:
                if settings.OTEL_ENABLED and is_telemetry_enabled():
                    tracer = trace.get_tracer(__name__)
                    span_name = SpanNames.WEBSOCKET_EVENT.format(event=event)
                    span_context = tracer.start_as_current_span(span_name)
            except Exception as e:
                logger.debug(f"Failed to create span for WebSocket event: {e}")

            # Execute handler with or without span
            if span_context:
                with span_context as span:
                    # Set base attributes
                    span.set_attribute("websocket.event", event)
                    span.set_attribute("websocket.sid", sid)
                    span.set_attribute("websocket.namespace", self.namespace)

                    # Extract and set event data attributes
                    if (
                        extract_event_data
                        and args
                        and len(args) > 0
                        and isinstance(args[0], dict)
                    ):
                        event_data = args[0]
                        _set_event_data_attributes(span, event_data)

                    try:
                        result = await func(self, event, sid, *args)

                        # Mark span as successful
                        if span.is_recording():
                            span.set_status(Status(StatusCode.OK))

                        return result
                    except Exception as e:
                        # Record exception in span
                        if span.is_recording():
                            span.record_exception(e)
                            span.set_status(
                                Status(StatusCode.ERROR, description=str(e))
                            )
                        raise
            else:
                # No span, execute without tracing
                return await func(self, event, sid, *args)

        return wrapper

    return decorator


def _set_event_data_attributes(span, event_data: dict) -> None:
    """
    Helper function to safely set event data attributes on span.

    Only sets attributes if the value is not None to avoid OTLP export issues.

    Args:
        span: OpenTelemetry span
        event_data: Event payload dict
    """
    # Common event data fields (using dot notation for OpenTelemetry standards)
    _safe_set_attribute(span, "task.id", event_data.get("task_id"))
    _safe_set_attribute(span, "team_id", event_data.get("team_id"))
    _safe_set_attribute(span, "subtask.id", event_data.get("subtask_id"))


def _safe_set_attribute(span, key: str, value: Any) -> None:
    """
    Safely set span attribute only if value is not None.

    Args:
        span: OpenTelemetry span
        key: Attribute key
        value: Attribute value
    """
    if value is not None:
        try:
            span.set_attribute(key, value)
        except Exception as e:
            logger.debug(f"Failed to set span attribute {key}={value}: {e}")
