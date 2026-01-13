# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Prometheus middleware for FastAPI applications.

Provides automatic HTTP request metrics collection through
FastAPI/Starlette middleware.
"""

import logging
import re
import time
from typing import Callable, List, Optional, Pattern

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp

from shared.telemetry.prometheus.config import (PrometheusConfig,
                                                get_prometheus_config,
                                                should_track_path)
from shared.telemetry.prometheus.metrics import (PrometheusMetrics,
                                                 get_prometheus_metrics)

logger = logging.getLogger(__name__)


# Common URL patterns that should be normalized
# e.g., /api/users/123 -> /api/users/{id}
# This helps reduce cardinality of path labels
DEFAULT_PATH_NORMALIZATION_PATTERNS = [
    # UUIDs
    (
        re.compile(r"/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"),
        "/{uuid}",
    ),
    # Numeric IDs
    (re.compile(r"/\d+(?=/|$)"), "/{id}"),
]


def normalize_path(
    path: str,
    patterns: Optional[List[tuple]] = None,
) -> str:
    """
    Normalize a URL path to reduce cardinality.

    This function replaces dynamic segments (like IDs and UUIDs) with
    placeholder labels to prevent metric explosion.

    Args:
        path: The URL path to normalize
        patterns: Optional list of (regex, replacement) tuples

    Returns:
        str: The normalized path

    Example:
        >>> normalize_path("/api/users/123")
        '/api/users/{id}'
        >>> normalize_path("/api/tasks/550e8400-e29b-41d4-a716-446655440000")
        '/api/tasks/{uuid}'
    """
    if patterns is None:
        patterns = DEFAULT_PATH_NORMALIZATION_PATTERNS

    normalized = path
    for pattern, replacement in patterns:
        normalized = pattern.sub(replacement, normalized)

    return normalized


class PrometheusMiddleware(BaseHTTPMiddleware):
    """
    Starlette middleware for Prometheus metrics collection.

    This middleware automatically tracks:
    - Total HTTP requests (by method, path, status code)
    - Request duration (histogram, standard and high-resolution)
    - Request/response body sizes (summary)
    - In-progress requests (gauge)

    Usage:
        app = FastAPI()
        app.add_middleware(PrometheusMiddleware, service_name="my-service")
    """

    def __init__(
        self,
        app: ASGIApp,
        service_name: Optional[str] = None,
        config: Optional[PrometheusConfig] = None,
        metrics: Optional[PrometheusMetrics] = None,
        normalize_paths: bool = True,
        path_patterns: Optional[List[tuple]] = None,
    ):
        """
        Initialize the Prometheus middleware.

        Args:
            app: The ASGI application
            service_name: Optional service name override
            config: Optional PrometheusConfig instance
            metrics: Optional PrometheusMetrics instance
            normalize_paths: Whether to normalize paths (default: True)
            path_patterns: Optional custom path normalization patterns
        """
        super().__init__(app)

        self.config = config or get_prometheus_config(service_name)
        self.metrics = metrics or get_prometheus_metrics(self.config)
        self.normalize_paths = normalize_paths
        self.path_patterns = path_patterns

    def _get_request_size(self, request: Request) -> int:
        """
        Get the size of the request body from Content-Length header.

        Args:
            request: The incoming request

        Returns:
            int: Request body size in bytes, or 0 if not available
        """
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                return int(content_length)
            except (ValueError, TypeError):
                return 0
        return 0

    def _get_response_size(self, response: Response) -> int:
        """
        Get the size of the response body from Content-Length header.

        Args:
            response: The response object

        Returns:
            int: Response body size in bytes, or 0 if not available
        """
        content_length = response.headers.get("content-length")
        if content_length:
            try:
                return int(content_length)
            except (ValueError, TypeError):
                return 0
        return 0

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        """
        Process the request and record metrics.

        Args:
            request: The incoming request
            call_next: The next middleware/handler in the chain

        Returns:
            Response: The response from the handler
        """
        path = request.url.path
        method = request.method

        # Skip metrics for excluded paths
        if not should_track_path(path, self.config):
            return await call_next(request)

        # Normalize path to reduce cardinality
        if self.normalize_paths:
            normalized_path = normalize_path(path, self.path_patterns)
        else:
            normalized_path = path

        # Get request size
        request_size = self._get_request_size(request)

        # Record request start
        start_time = time.perf_counter()
        self.metrics.record_request_start(method, normalized_path)

        try:
            # Process the request
            response = await call_next(request)
            status_code = response.status_code
            response_size = self._get_response_size(response)
        except Exception:
            # Record as 500 on unhandled exception
            status_code = 500
            duration = time.perf_counter() - start_time
            self.metrics.record_request_end(
                method=method,
                path=normalized_path,
                status_code=status_code,
                duration=duration,
                request_size=request_size,
                response_size=0,
            )
            raise

        # Record request end
        duration = time.perf_counter() - start_time
        self.metrics.record_request_end(
            method=method,
            path=normalized_path,
            status_code=status_code,
            duration=duration,
            request_size=request_size,
            response_size=response_size,
        )

        return response


def setup_prometheus_middleware(
    app,
    service_name: Optional[str] = None,
    config: Optional[PrometheusConfig] = None,
    normalize_paths: bool = True,
) -> None:
    """
    Setup Prometheus middleware for a FastAPI application.

    This is a convenience function that adds the PrometheusMiddleware
    to a FastAPI application with proper configuration.

    Args:
        app: FastAPI application instance
        service_name: Optional service name override
        config: Optional PrometheusConfig instance
        normalize_paths: Whether to normalize paths (default: True)

    Example:
        from fastapi import FastAPI
        from shared.telemetry.prometheus import setup_prometheus_middleware

        app = FastAPI()
        setup_prometheus_middleware(app, service_name="wegent-backend")
    """
    config = config or get_prometheus_config(service_name)

    if not config.enabled:
        logger.debug("Prometheus metrics disabled, skipping middleware setup")
        return

    # Determine effective service name for logging
    effective_service_name = service_name or config.service_name

    app.add_middleware(
        PrometheusMiddleware,
        service_name=service_name,
        config=config,
        normalize_paths=normalize_paths,
    )

    logger.info(
        f"Prometheus middleware enabled for service '{effective_service_name}' "
        f"at path '{config.metrics_path}'"
    )
