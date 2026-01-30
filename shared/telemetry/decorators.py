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


def capture_trace_context() -> Optional[Dict[str, str]]:
    """
    Capture the current trace context for propagation to background tasks.

    Call this in the main request handler before scheduling a background task,
    then pass the result to the background task function.

    Returns:
        Dict containing trace context headers, or None if telemetry is disabled

    Example:
        # In the API handler
        ctx = capture_trace_context()
        background_tasks.add_task(my_background_task, ..., trace_context=ctx)

        # In the background task
        @trace_background("my_task", "my.tracer")
        def my_background_task(..., trace_context=None):
            ...
    """
    if not _is_telemetry_enabled():
        return None

    try:
        from opentelemetry import trace
        from opentelemetry.trace.propagation.tracecontext import (
            TraceContextTextMapPropagator,
        )

        carrier: Dict[str, str] = {}
        propagator = TraceContextTextMapPropagator()
        propagator.inject(carrier)
        return carrier if carrier else None
    except Exception as e:
        logger.debug(f"Failed to capture trace context: {e}")
        return None


def trace_background(
    span_name: Optional[str] = None,
    tracer_name: str = "background.worker",
    attributes: Optional[Dict[str, Any]] = None,
    extract_attributes: Optional[Callable[..., Dict[str, Any]]] = None,
    context_param: str = "trace_context",
):
    """
    Decorator to add tracing to background task functions.

    This decorator handles trace context propagation for background tasks that run
    in separate threads (e.g., FastAPI BackgroundTasks).

    If a trace_context parameter is provided (captured via capture_trace_context()),
    the span will be linked to the original request's trace. Otherwise, a new
    root span will be created.

    Args:
        span_name: Name of the span (defaults to function name)
        tracer_name: Name of the tracer module
        attributes: Static attributes to add to the span
        extract_attributes: Function to extract dynamic attributes from function args
        context_param: Name of the parameter containing trace context (default: "trace_context")

    Example:
        # In API handler:
        ctx = capture_trace_context()
        background_tasks.add_task(_my_task, data=data, trace_context=ctx)

        # Background task:
        @trace_background("my_background_task", "my.worker")
        def _my_task(data, trace_context=None):
            add_span_event("task.started", {"data": str(data)})
            ...
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
                from opentelemetry import context as otel_context
                from opentelemetry import trace
                from opentelemetry.context import Context
                from opentelemetry.trace.propagation.tracecontext import (
                    TraceContextTextMapPropagator,
                )

                # Try to restore parent context from trace_context parameter
                parent_context = None
                trace_ctx = kwargs.get(context_param)
                if trace_ctx and isinstance(trace_ctx, dict):
                    try:
                        propagator = TraceContextTextMapPropagator()
                        parent_context = propagator.extract(carrier=trace_ctx)
                    except Exception as e:
                        logger.debug(f"Failed to extract parent context: {e}")

                # Use parent context if available, otherwise create root span
                ctx = parent_context if parent_context else Context()

                # Create span with the determined context
                span = tracer.start_span(
                    name,
                    context=ctx,
                    kind=trace.SpanKind.INTERNAL,
                    attributes=span_attributes,
                )

                # Attach the span to context so add_span_event() works
                # IMPORTANT: Use ctx as the base context to preserve parent trace info
                # Without this, trace.set_span_in_context(span) would use the current
                # (possibly empty) context, breaking trace propagation
                token = otel_context.attach(trace.set_span_in_context(span, ctx))

                try:
                    result = func(*args, **kwargs)
                    span.set_status(trace.Status(trace.StatusCode.OK))
                    return result
                except Exception as e:
                    span.set_status(trace.Status(trace.StatusCode.ERROR, str(e)))
                    span.record_exception(e)
                    raise
                finally:
                    span.end()
                    otel_context.detach(token)

            except ImportError:
                return func(*args, **kwargs)

        return wrapper  # type: ignore

    return decorator


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
