# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Circuit Breaker implementation for external service calls.

This module provides circuit breaker patterns to prevent cascading failures
when external services (like AI providers) are degraded or unavailable.

Circuit Breaker States:
- CLOSED: Normal operation, requests pass through
- OPEN: Service is failing, requests fail fast without calling the service
- HALF-OPEN: Testing if service has recovered

Usage:
    from app.core.circuit_breaker import ai_service_breaker

    @ai_service_breaker
    def call_ai_service():
        # ... call AI service
        pass
"""

import logging
from functools import wraps
from typing import Any, Callable, Optional

import pybreaker
from prometheus_client import Counter, Gauge

from app.core.config import settings

logger = logging.getLogger(__name__)

# Prometheus metrics for circuit breaker
CIRCUIT_BREAKER_STATE = Gauge(
    "circuit_breaker_state",
    "Circuit breaker state (0=closed, 1=open, 2=half-open)",
    ["breaker_name"],
)
CIRCUIT_BREAKER_FAILURES = Counter(
    "circuit_breaker_failures_total",
    "Total circuit breaker failures",
    ["breaker_name"],
)
CIRCUIT_BREAKER_SUCCESS = Counter(
    "circuit_breaker_success_total",
    "Total circuit breaker successes",
    ["breaker_name"],
)
CIRCUIT_BREAKER_REJECTED = Counter(
    "circuit_breaker_rejected_total",
    "Total requests rejected by open circuit",
    ["breaker_name"],
)


class CircuitBreakerListener(pybreaker.CircuitBreakerListener):
    """Listener for circuit breaker state changes and metrics."""

    def __init__(self, breaker_name: str):
        self.breaker_name = breaker_name

    def state_change(
        self,
        cb: pybreaker.CircuitBreaker,
        old_state: pybreaker.CircuitBreakerState,
        new_state: pybreaker.CircuitBreakerState,
    ) -> None:
        """Called when circuit breaker state changes."""
        state_map = {
            pybreaker.STATE_CLOSED: 0,
            pybreaker.STATE_OPEN: 1,
            pybreaker.STATE_HALF_OPEN: 2,
        }
        CIRCUIT_BREAKER_STATE.labels(breaker_name=self.breaker_name).set(
            state_map.get(new_state, 0)
        )
        logger.warning(
            f"[CircuitBreaker] {self.breaker_name} state changed: {old_state} -> {new_state}"
        )

    def failure(self, cb: pybreaker.CircuitBreaker, exc: Exception) -> None:
        """Called when a failure is recorded."""
        CIRCUIT_BREAKER_FAILURES.labels(breaker_name=self.breaker_name).inc()
        logger.warning(f"[CircuitBreaker] {self.breaker_name} recorded failure: {exc}")

    def success(self, cb: pybreaker.CircuitBreaker) -> None:
        """Called when a success is recorded."""
        CIRCUIT_BREAKER_SUCCESS.labels(breaker_name=self.breaker_name).inc()


class CircuitBreakerOpenError(Exception):
    """Raised when the circuit breaker is open and requests are rejected."""

    def __init__(
        self, breaker_name: str, message: str = "Service temporarily unavailable"
    ):
        self.breaker_name = breaker_name
        self.message = message
        super().__init__(f"[{breaker_name}] {message}")


# Circuit breaker for AI service calls
# Configuration:
# - fail_max: Number of failures before opening the circuit (default: 5)
# - reset_timeout: Seconds to wait before attempting recovery (default: 60)
ai_service_breaker = pybreaker.CircuitBreaker(
    fail_max=getattr(settings, "CIRCUIT_BREAKER_FAIL_MAX", 5),
    reset_timeout=getattr(settings, "CIRCUIT_BREAKER_RESET_TIMEOUT", 60),
    listeners=[CircuitBreakerListener("ai_service")],
    name="ai_service",
)

# Circuit breaker for external webhook calls (if any)
webhook_service_breaker = pybreaker.CircuitBreaker(
    fail_max=getattr(settings, "CIRCUIT_BREAKER_FAIL_MAX", 5),
    reset_timeout=getattr(settings, "CIRCUIT_BREAKER_RESET_TIMEOUT", 60),
    listeners=[CircuitBreakerListener("webhook_service")],
    name="webhook_service",
)


def with_circuit_breaker(
    breaker: pybreaker.CircuitBreaker,
    fallback: Optional[Callable[..., Any]] = None,
) -> Callable:
    """
    Decorator to wrap a function with circuit breaker protection.

    Args:
        breaker: The circuit breaker to use
        fallback: Optional fallback function to call when circuit is open

    Usage:
        @with_circuit_breaker(ai_service_breaker)
        def call_ai():
            ...

        # With fallback
        @with_circuit_breaker(ai_service_breaker, fallback=lambda: "default")
        def call_ai():
            ...
    """

    def decorator(func: Callable) -> Callable:
        @wraps(func)
        def wrapper(*args, **kwargs):
            try:
                return breaker.call(func, *args, **kwargs)
            except pybreaker.CircuitBreakerError as e:
                CIRCUIT_BREAKER_REJECTED.labels(breaker_name=breaker.name).inc()
                logger.error(
                    f"[CircuitBreaker] {breaker.name} is OPEN, rejecting request"
                )
                if fallback:
                    return fallback(*args, **kwargs)
                raise CircuitBreakerOpenError(
                    breaker.name,
                    f"Service temporarily unavailable. Circuit will reset in {breaker.reset_timeout}s",
                ) from e

        return wrapper

    return decorator


def with_circuit_breaker_async(
    breaker: pybreaker.CircuitBreaker,
    fallback: Optional[Callable[..., Any]] = None,
) -> Callable:
    """
    Async version of circuit breaker decorator.

    This wrapper properly integrates with pybreaker by:
    - Using breaker.call_async() which handles state transitions automatically
    - Recording successes and failures to trigger state transitions
    - Supporting fallback when circuit is open

    Usage:
        @with_circuit_breaker_async(ai_service_breaker)
        async def call_ai():
            ...
    """

    def decorator(func: Callable) -> Callable:
        @wraps(func)
        async def wrapper(*args, **kwargs):
            try:
                # Use pybreaker's built-in async support
                return await breaker.call_async(func, *args, **kwargs)
            except pybreaker.CircuitBreakerError as e:
                CIRCUIT_BREAKER_REJECTED.labels(breaker_name=breaker.name).inc()
                logger.error(
                    f"[CircuitBreaker] {breaker.name} is OPEN, rejecting request"
                )
                if fallback:
                    return (
                        await fallback(*args, **kwargs)
                        if callable(fallback)
                        else fallback
                    )
                raise CircuitBreakerOpenError(
                    breaker.name,
                    f"Service temporarily unavailable. Circuit will reset in {breaker.reset_timeout}s",
                ) from e

        return wrapper

    return decorator


def get_circuit_breaker_status() -> dict:
    """
    Get the current status of all circuit breakers.

    Returns:
        dict: Status of all circuit breakers including state, failure count, etc.
    """
    breakers = [ai_service_breaker, webhook_service_breaker]
    status = {}

    for breaker in breakers:
        status[breaker.name] = {
            "state": str(breaker.current_state),
            "fail_counter": breaker.fail_counter,
            "fail_max": breaker.fail_max,
            "reset_timeout": breaker.reset_timeout,
        }

    return status
