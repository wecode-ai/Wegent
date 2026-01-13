# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenTelemetry decorators for tracing functions and methods.

Provides decorators to add tracing to functions without modifying business logic.
"""

import functools
import logging
import os
from typing import Any, Callable, Dict, Optional, TypeVar, Union

logger = logging.getLogger(__name__)

# Type variable for generic function signatures
F = TypeVar("F", bound=Callable[..., Any])


def _is_telemetry_enabled() -> bool:
    """Check if telemetry is enabled."""
    otel_enabled = os.getenv("OTEL_ENABLED", "false").lower() == "true"
    if not otel_enabled:
        return False
    try:
        from shared.telemetry.core import is_telemetry_enabled

        return is_telemetry_enabled()
    except Exception:
        return False


def _get_tracer(name: str):
    """Get a tracer instance."""
    try:
        from shared.telemetry.core import get_tracer

        return get_tracer(name)
    except Exception:
        return None


def trace_async(
    span_name: Optional[str] = None,
    tracer_name: str = "executor",
    attributes: Optional[Dict[str, Any]] = None,
    extract_attributes: Optional[Callable[..., Dict[str, Any]]] = None,
):
    """
    Decorator to add tracing to async functions.

    The span will start when the async function begins and end when it completes.
    This is ideal for async tasks that need to track their entire execution lifecycle.

    Args:
        span_name: Name of the span (defaults to function name)
        tracer_name: Name of the tracer module
        attributes: Static attributes to add to the span
        extract_attributes: Function to extract dynamic attributes from function args
                           Signature: (self, *args, **kwargs) -> Dict[str, Any]

    Example:
        @trace_async(
            span_name="execute_task",
            tracer_name="executor.agents.claude_code",
            extract_attributes=lambda self, *args, **kwargs: {
                "task.id": str(self.task_id),
                "agent.type": self.get_name(),
            }
        )
        async def execute_async(self) -> TaskStatus:
            # Business logic here
            pass
    """

    def decorator(func: F) -> F:
        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            # Check if telemetry is enabled
            if not _is_telemetry_enabled():
                return await func(*args, **kwargs)

            tracer = _get_tracer(tracer_name)
            if tracer is None:
                return await func(*args, **kwargs)

            # Determine span name
            name = span_name or func.__name__

            # Build attributes
            span_attributes = dict(attributes or {})

            # Extract dynamic attributes if extractor provided
            if extract_attributes:
                try:
                    dynamic_attrs = extract_attributes(*args, **kwargs)
                    if dynamic_attrs:
                        span_attributes.update(dynamic_attrs)
                except Exception as e:
                    logger.debug(f"Failed to extract attributes: {e}")

            # Import OpenTelemetry types
            try:
                from opentelemetry import trace

                with tracer.start_as_current_span(
                    name, kind=trace.SpanKind.INTERNAL, attributes=span_attributes
                ) as span:
                    try:
                        result = await func(*args, **kwargs)

                        # Set span status based on result
                        # Check if result has a 'value' attribute (like TaskStatus)
                        if hasattr(result, "value"):
                            result_value = (
                                result.value.lower()
                                if hasattr(result.value, "lower")
                                else str(result.value).lower()
                            )
                            if result_value in ("completed", "success"):
                                span.set_status(trace.Status(trace.StatusCode.OK))
                            elif result_value in ("failed", "error"):
                                span.set_status(
                                    trace.Status(trace.StatusCode.ERROR, "Task failed")
                                )

                        return result
                    except Exception as e:
                        span.set_status(trace.Status(trace.StatusCode.ERROR, str(e)))
                        span.record_exception(e)
                        raise
            except ImportError:
                return await func(*args, **kwargs)

        return wrapper  # type: ignore

    return decorator


def trace_sync(
    span_name: Optional[str] = None,
    tracer_name: str = "executor",
    attributes: Optional[Dict[str, Any]] = None,
    extract_attributes: Optional[Callable[..., Dict[str, Any]]] = None,
):
    """
    Decorator to add tracing to sync functions.

    Args:
        span_name: Name of the span (defaults to function name)
        tracer_name: Name of the tracer module
        attributes: Static attributes to add to the span
        extract_attributes: Function to extract dynamic attributes from function args

    Example:
        @trace_sync(
            span_name="process_task",
            extract_attributes=lambda task_data: {"task.id": task_data.get("task_id")}
        )
        def process(task_data: Dict) -> TaskStatus:
            # Business logic here
            pass
    """

    def decorator(func: F) -> F:
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            # Check if telemetry is enabled
            if not _is_telemetry_enabled():
                return func(*args, **kwargs)

            tracer = _get_tracer(tracer_name)
            if tracer is None:
                return func(*args, **kwargs)

            # Determine span name
            name = span_name or func.__name__

            # Build attributes
            span_attributes = dict(attributes or {})

            # Extract dynamic attributes if extractor provided
            if extract_attributes:
                try:
                    dynamic_attrs = extract_attributes(*args, **kwargs)
                    if dynamic_attrs:
                        span_attributes.update(dynamic_attrs)
                except Exception as e:
                    logger.debug(f"Failed to extract attributes: {e}")

            # Import OpenTelemetry types
            try:
                from opentelemetry import trace

                with tracer.start_as_current_span(
                    name, kind=trace.SpanKind.INTERNAL, attributes=span_attributes
                ) as span:
                    try:
                        result = func(*args, **kwargs)

                        # Set span status based on result
                        if hasattr(result, "value"):
                            result_value = (
                                result.value.lower()
                                if hasattr(result.value, "lower")
                                else str(result.value).lower()
                            )
                            if result_value in ("completed", "success"):
                                span.set_status(trace.Status(trace.StatusCode.OK))
                            elif result_value in ("failed", "error"):
                                span.set_status(
                                    trace.Status(trace.StatusCode.ERROR, "Task failed")
                                )

                        return result
                    except Exception as e:
                        span.set_status(trace.Status(trace.StatusCode.ERROR, str(e)))
                        span.record_exception(e)
                        raise
            except ImportError:
                return func(*args, **kwargs)

        return wrapper  # type: ignore

    return decorator


def add_span_event(
    event_name: str, attributes: Optional[Dict[str, Any]] = None
) -> None:
    """
    Add an event to the current span.

    This is a utility function that can be called from within traced functions
    to add events without coupling to OpenTelemetry directly.

    Args:
        event_name: Name of the event
        attributes: Optional attributes for the event
    """
    if not _is_telemetry_enabled():
        return

    try:
        from opentelemetry import trace

        span = trace.get_current_span()
        if span and span.is_recording():
            span.add_event(event_name, attributes=attributes)
    except Exception as e:
        logger.debug(f"Failed to add span event: {e}")


def set_span_attribute(key: str, value: Any) -> None:
    """
    Set an attribute on the current span.

    Args:
        key: Attribute key
        value: Attribute value
    """
    if not _is_telemetry_enabled():
        return

    try:
        from opentelemetry import trace

        span = trace.get_current_span()
        if span and span.is_recording():
            span.set_attribute(key, value)
    except Exception as e:
        logger.debug(f"Failed to set span attribute: {e}")


def trace_async_generator(
    span_name: Optional[str] = None,
    tracer_name: str = "chat_shell",
    attributes: Optional[Dict[str, Any]] = None,
    extract_attributes: Optional[Callable[..., Dict[str, Any]]] = None,
):
    """
    Decorator to add tracing to async generator functions.

    The span will start when the generator begins and end when it completes or errors.
    This is ideal for streaming responses that yield multiple values.

    Args:
        span_name: Name of the span (defaults to function name)
        tracer_name: Name of the tracer module
        attributes: Static attributes to add to the span
        extract_attributes: Function to extract dynamic attributes from function args
                           Signature: (*args, **kwargs) -> Dict[str, Any]

    Example:
        @trace_async_generator(
            span_name="stream_response",
            extract_attributes=lambda request, *args, **kwargs: {
                "task.id": request.metadata.task_id if request.metadata else 0,
            }
        )
        async def _stream_response(request, cancel_event, request_id):
            yield "chunk1"
            yield "chunk2"
    """

    def decorator(func: F) -> F:
        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            # Check if telemetry is enabled
            if not _is_telemetry_enabled():
                async for item in func(*args, **kwargs):
                    yield item
                return

            tracer = _get_tracer(tracer_name)
            if tracer is None:
                async for item in func(*args, **kwargs):
                    yield item
                return

            # Determine span name
            name = span_name or func.__name__

            # Build attributes
            span_attributes = dict(attributes or {})

            # Extract dynamic attributes if extractor provided
            if extract_attributes:
                try:
                    dynamic_attrs = extract_attributes(*args, **kwargs)
                    if dynamic_attrs:
                        span_attributes.update(dynamic_attrs)
                except Exception as e:
                    logger.debug(f"Failed to extract attributes: {e}")

            # Import OpenTelemetry types
            try:
                from opentelemetry import trace

                with tracer.start_as_current_span(
                    name, kind=trace.SpanKind.INTERNAL, attributes=span_attributes
                ) as span:
                    try:
                        async for item in func(*args, **kwargs):
                            yield item
                        span.set_status(trace.Status(trace.StatusCode.OK))
                    except Exception as e:
                        span.set_status(trace.Status(trace.StatusCode.ERROR, str(e)))
                        span.record_exception(e)
                        raise
            except ImportError:
                async for item in func(*args, **kwargs):
                    yield item

        return wrapper  # type: ignore

    return decorator
