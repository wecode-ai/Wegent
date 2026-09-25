# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Per-route request metrics for HTTP API endpoints.

The Wegent Rust gateway records one API metric per HTTP status class for every
route it serves, named ``<route>_<class>`` (``2xx`` .. ``5xx``). Python-served
routes record through :class:`ApiRouteMetrics` with the same names so a route
keeps one set of series while it moves between the gateway and Python.
"""

from __future__ import annotations

import inspect
import time
from functools import wraps
from typing import Any, Awaitable, Callable, TypeVar

from shared.metrics.metric import Metric

STATUS_CLASSES = ("2xx", "3xx", "4xx", "5xx")

_F = TypeVar("_F", bound=Callable[..., Awaitable[Any]])
_S = TypeVar("_S", bound=Callable[..., Any])


class ApiRouteMetrics:
    """Records request latency of one route, split by HTTP status class."""

    __slots__ = ("_classes", "_slow_threshold_ms")

    def __init__(self, route: str, slow_threshold_ms: int | None = None) -> None:
        self._classes = {
            status_class: Metric.api(
                f"{route}_{status_class}", slow_threshold_ms=slow_threshold_ms
            )
            for status_class in STATUS_CLASSES
        }
        self._slow_threshold_ms = slow_threshold_ms

    def record(self, status_code: int, elapsed_seconds: float) -> None:
        """Record one completed request against its HTTP status class."""
        if not isinstance(status_code, int) or isinstance(status_code, bool):
            raise TypeError(f"status_code must be an int, got {status_code!r}")
        metric = self._classes.get(f"{status_code // 100}xx")
        if metric is not None:
            # 2xx/3xx are successes; 4xx/5xx are failures. The slow threshold
            # is per-route when provided so chat tasks can use 500 ms.
            metric.record(
                elapsed_seconds,
                success=status_code < 400,
                slow_threshold_ms=self._slow_threshold_ms,
            )

    @property
    def slow_threshold_ms(self) -> int | None:
        return self._slow_threshold_ms


def track_api(route_metrics: ApiRouteMetrics) -> Callable[[_F], _F]:
    """Decorate an async request handler to record its status class and latency.

    The status comes from the raised error or the returned response, so the
    decorator stays independent of the web framework's exception types.
    """

    def decorator(func: _F) -> _F:
        if not inspect.iscoroutinefunction(func):
            raise TypeError(f"track_api expects an async handler, got {func!r}")

        @wraps(func)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            started = time.perf_counter()
            try:
                result = await func(*args, **kwargs)
            except Exception as exc:
                route_metrics.record(
                    _status_code(exc, default=500), time.perf_counter() - started
                )
                raise
            route_metrics.record(
                _status_code(result, default=200), time.perf_counter() - started
            )
            return result

        return wrapper  # type: ignore[return-value]

    return decorator


def track_api_sync(route_metrics: ApiRouteMetrics) -> Callable[[_S], _S]:
    """Decorate a synchronous request handler to record its status and latency.

    FastAPI runs ``def`` handlers in a thread pool; this mirrors
    :func:`track_api` for those handlers.
    """

    def decorator(func: _S) -> _S:
        if inspect.iscoroutinefunction(func):
            raise TypeError(f"track_api_sync expects a sync handler, got {func!r}")

        @wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            started = time.perf_counter()
            try:
                result = func(*args, **kwargs)
            except Exception as exc:
                route_metrics.record(
                    _status_code(exc, default=500), time.perf_counter() - started
                )
                raise
            route_metrics.record(
                _status_code(result, default=200), time.perf_counter() - started
            )
            return result

        return wrapper  # type: ignore[return-value]

    return decorator


def _status_code(source: Any, default: int) -> int:
    """Read the HTTP status of a response or error, falling back to `default`."""
    code = getattr(source, "status_code", None)
    if isinstance(code, int) and not isinstance(code, bool):
        return code
    return default
