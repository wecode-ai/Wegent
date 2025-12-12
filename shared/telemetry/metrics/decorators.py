# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Metric tracking decorators for OpenTelemetry.

Provides decorators for automatic metric collection on function calls,
including counters and duration histograms.
"""

import functools
import inspect
import logging
import time
from typing import Any, Callable, Dict, List, Optional, TypeVar

from shared.telemetry.core import get_meter, is_telemetry_enabled

logger = logging.getLogger(__name__)

# Type variable for generic decorator
F = TypeVar("F", bound=Callable[..., Any])


def track_metric(
    metric_name: str, labels: Optional[List[str]] = None
) -> Callable[[F], F]:
    """
    Decorator to automatically track a counter metric when a function is called.

    Args:
        metric_name: Name of the metric to record
        labels: List of parameter names to extract as metric labels

    Returns:
        Decorated function

    Example:
        @track_metric("api.requests", labels=["endpoint", "method"])
        def handle_request(endpoint: str, method: str):
            ...
    """

    def decorator(func: F) -> F:
        @functools.wraps(func)
        async def async_wrapper(*args, **kwargs):
            result = await func(*args, **kwargs)
            _record_metric_from_call(metric_name, labels, func, args, kwargs)
            return result

        @functools.wraps(func)
        def sync_wrapper(*args, **kwargs):
            result = func(*args, **kwargs)
            _record_metric_from_call(metric_name, labels, func, args, kwargs)
            return result

        if callable(func) and hasattr(func, "__code__"):
            if func.__code__.co_flags & 0x80:  # CO_COROUTINE flag
                return async_wrapper  # type: ignore
        return sync_wrapper  # type: ignore

    return decorator


def track_duration(
    metric_name: str, labels: Optional[List[str]] = None
) -> Callable[[F], F]:
    """
    Decorator to automatically track execution duration of a function.

    Args:
        metric_name: Name of the histogram metric to record
        labels: List of parameter names to extract as metric labels

    Returns:
        Decorated function

    Example:
        @track_duration("api.request_duration", labels=["endpoint"])
        def handle_request(endpoint: str):
            ...
    """

    def decorator(func: F) -> F:
        @functools.wraps(func)
        async def async_wrapper(*args, **kwargs):
            start_time = time.time()
            try:
                return await func(*args, **kwargs)
            finally:
                duration_ms = (time.time() - start_time) * 1000
                _record_duration_from_call(
                    metric_name, labels, func, args, kwargs, duration_ms
                )

        @functools.wraps(func)
        def sync_wrapper(*args, **kwargs):
            start_time = time.time()
            try:
                return func(*args, **kwargs)
            finally:
                duration_ms = (time.time() - start_time) * 1000
                _record_duration_from_call(
                    metric_name, labels, func, args, kwargs, duration_ms
                )

        if callable(func) and hasattr(func, "__code__"):
            if func.__code__.co_flags & 0x80:  # CO_COROUTINE flag
                return async_wrapper  # type: ignore
        return sync_wrapper  # type: ignore

    return decorator


def track_success_failure(
    success_metric: str,
    failure_metric: str,
    labels: Optional[List[str]] = None,
) -> Callable[[F], F]:
    """
    Decorator to track success and failure counts for a function.

    Args:
        success_metric: Name of the counter metric for successful calls
        failure_metric: Name of the counter metric for failed calls
        labels: List of parameter names to extract as metric labels

    Returns:
        Decorated function

    Example:
        @track_success_failure("task.success", "task.failure", labels=["task_type"])
        def process_task(task_type: str):
            ...
    """

    def decorator(func: F) -> F:
        @functools.wraps(func)
        async def async_wrapper(*args, **kwargs):
            try:
                result = await func(*args, **kwargs)
                _record_metric_from_call(success_metric, labels, func, args, kwargs)
                return result
            except Exception:
                _record_metric_from_call(failure_metric, labels, func, args, kwargs)
                raise

        @functools.wraps(func)
        def sync_wrapper(*args, **kwargs):
            try:
                result = func(*args, **kwargs)
                _record_metric_from_call(success_metric, labels, func, args, kwargs)
                return result
            except Exception:
                _record_metric_from_call(failure_metric, labels, func, args, kwargs)
                raise

        if callable(func) and hasattr(func, "__code__"):
            if func.__code__.co_flags & 0x80:  # CO_COROUTINE flag
                return async_wrapper  # type: ignore
        return sync_wrapper  # type: ignore

    return decorator


def _record_metric_from_call(
    metric_name: str,
    labels: Optional[List[str]],
    func: Callable,
    args: tuple,
    kwargs: dict,
) -> None:
    """Helper to record a counter metric from function call context."""
    if not is_telemetry_enabled():
        return

    try:
        meter = get_meter("wegent.metrics")
        counter = meter.create_counter(
            name=metric_name, description=f"Auto-tracked: {metric_name}"
        )

        attributes = _extract_labels(labels, func, args, kwargs)
        counter.add(1, attributes)

    except Exception as e:
        logger.debug(f"Failed to record metric {metric_name}: {e}")


def _record_duration_from_call(
    metric_name: str,
    labels: Optional[List[str]],
    func: Callable,
    args: tuple,
    kwargs: dict,
    duration_ms: float,
) -> None:
    """Helper to record a histogram metric from function call context."""
    if not is_telemetry_enabled():
        return

    try:
        meter = get_meter("wegent.metrics")
        histogram = meter.create_histogram(
            name=metric_name,
            description=f"Auto-tracked duration: {metric_name}",
            unit="ms",
        )

        attributes = _extract_labels(labels, func, args, kwargs)
        histogram.record(duration_ms, attributes)

    except Exception as e:
        logger.debug(f"Failed to record duration metric {metric_name}: {e}")


def _extract_labels(
    labels: Optional[List[str]], func: Callable, args: tuple, kwargs: dict
) -> Dict[str, str]:
    """Extract label values from function arguments."""
    if not labels:
        return {}

    attributes = {}

    # Get function parameter names
    try:
        sig = inspect.signature(func)
        param_names = list(sig.parameters.keys())

        # Match args to parameter names
        for i, arg in enumerate(args):
            if i < len(param_names) and param_names[i] in labels:
                attributes[param_names[i]] = str(arg)

        # Add kwargs that match labels
        for label in labels:
            if label in kwargs and kwargs[label] is not None:
                attributes[label] = str(kwargs[label])

    except Exception as e:
        logger.debug(f"Failed to extract labels: {e}")

    return attributes
