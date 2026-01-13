# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Trace context propagation utilities for OpenTelemetry.

Provides functions for propagating trace context across service boundaries,
including HTTP headers and environment variables for Docker containers.
"""

import logging
import os
from typing import Dict, Optional

from opentelemetry import context, trace
from opentelemetry.trace.propagation.tracecontext import \
    TraceContextTextMapPropagator

logger = logging.getLogger(__name__)

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
    context_dict: Dict[str, str] = {}

    try:
        # Get the current span context
        span = trace.get_current_span()
        if span is None:
            logger.debug("No current span found for trace propagation")
            return context_dict

        span_context = span.get_span_context()
        if not span_context.is_valid:
            logger.debug(
                "Invalid span context for trace propagation: trace_id=%s, span_id=%s",
                (
                    format(span_context.trace_id, "032x")
                    if span_context.trace_id
                    else "None"
                ),
                (
                    format(span_context.span_id, "016x")
                    if span_context.span_id
                    else "None"
                ),
            )
            return context_dict

        # Use W3C TraceContext propagator to inject context
        propagator = TraceContextTextMapPropagator()
        propagator.inject(context_dict)

        logger.debug(
            "Trace context extracted for propagation: traceparent=%s",
            context_dict.get("traceparent", "NOT_SET"),
        )

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
        ctx = get_trace_context_for_propagation()

        if "traceparent" in ctx:
            env_vars[TRACE_PARENT_ENV] = ctx["traceparent"]

        if "tracestate" in ctx:
            env_vars[TRACE_STATE_ENV] = ctx["tracestate"]

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


def inject_trace_context_to_headers(
    headers: Optional[Dict[str, str]] = None,
) -> Dict[str, str]:
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
        ctx = get_trace_context_for_propagation()
        headers.update(ctx)
    except Exception as e:
        logger.debug(f"Failed to inject trace context to headers: {e}")

    return headers


def extract_trace_context_from_headers(
    headers: Dict[str, str],
) -> Optional[context.Context]:
    """
    Extract trace context from HTTP headers.

    This is useful for receiving trace context from incoming HTTP requests.

    Args:
        headers: HTTP headers dictionary containing trace context

    Returns:
        Optional[Context]: Extracted context, or None if extraction failed
    """
    try:
        propagator = TraceContextTextMapPropagator()
        return propagator.extract(headers)
    except Exception as e:
        logger.debug(f"Failed to extract trace context from headers: {e}")
        return None
