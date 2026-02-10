# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""FastAPI Prometheus middleware.

Provides automatic metrics collection for FastAPI applications.
Supports service-specific metrics with different bucket configurations:
- Backend: Optimized for standard REST API response times
- Chat Shell: Extended buckets for long-running LLM interactions
"""

import time
from enum import Enum
from typing import Callable, Optional, Set, Union

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response, StreamingResponse

from shared.prometheus.config import get_prometheus_config
from shared.prometheus.utils import get_route_template, normalize_route

# Default paths to exclude from metrics
DEFAULT_EXCLUDED_PATHS: Set[str] = {
    "/",
    "/health",
    "/healthz",
    "/ready",
    "/readiness",
    "/live",
    "/liveness",
}


class ServiceType(str, Enum):
    """Service type for selecting appropriate metrics configuration."""

    BACKEND = "backend"
    CHAT_SHELL = "chat_shell"


def _get_metrics_for_service(service_type: ServiceType):
    """Get the appropriate metrics instance for the service type.

    Args:
        service_type: The service type (backend or chat_shell)

    Returns:
        The metrics instance for the specified service type
    """
    if service_type == ServiceType.BACKEND:
        from shared.prometheus.metrics.backend_http import get_backend_http_metrics

        return get_backend_http_metrics()
    elif service_type == ServiceType.CHAT_SHELL:
        from shared.prometheus.metrics.chat_shell_http import (
            get_chat_shell_http_metrics,
        )

        return get_chat_shell_http_metrics()
    else:
        raise ValueError(f"Unknown service type: {service_type}")


class PrometheusMiddleware(BaseHTTPMiddleware):
    """FastAPI middleware for Prometheus metrics collection.

    Automatically collects HTTP request metrics:
    - Request counts by method, endpoint, and status
    - Request latency distribution
    - Concurrent request tracking

    Supports service-specific metrics:
    - Backend: backend_http_* metrics with REST API optimized buckets
    - Chat Shell: chat_shell_http_* metrics with LLM optimized buckets

    Usage:
        from shared.prometheus.middleware import PrometheusMiddleware, ServiceType

        # For Backend
        app.add_middleware(PrometheusMiddleware, service_type=ServiceType.BACKEND)

        # For Chat Shell
        app.add_middleware(PrometheusMiddleware, service_type=ServiceType.CHAT_SHELL)
    """

    def __init__(
        self,
        app,
        service_type: Union[ServiceType, str] = ServiceType.BACKEND,
        excluded_paths: Optional[Set[str]] = None,
    ):
        """Initialize the middleware.

        Args:
            app: The ASGI application
            service_type: The service type for metrics selection.
                         Use ServiceType.BACKEND for backend service or
                         ServiceType.CHAT_SHELL for chat shell service.
                         Defaults to ServiceType.BACKEND.
            excluded_paths: Set of paths to exclude from metrics collection.
                           Defaults to health check endpoints.
        """
        super().__init__(app)

        # Convert string to ServiceType if needed
        if isinstance(service_type, str):
            service_type = ServiceType(service_type)

        self._service_type = service_type
        self._metrics = _get_metrics_for_service(service_type)
        self._config = get_prometheus_config()

        # Merge default excluded paths with custom ones
        self._excluded_paths = DEFAULT_EXCLUDED_PATHS.copy()
        if excluded_paths:
            self._excluded_paths.update(excluded_paths)

        # Always exclude the metrics endpoint itself
        self._excluded_paths.add(self._config.metrics_path)

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        """Process the request and collect metrics.

        Args:
            request: The incoming request
            call_next: The next middleware/handler in the chain

        Returns:
            The response from the handler
        """
        path = request.url.path

        # Skip excluded paths
        if path in self._excluded_paths:
            return await call_next(request)

        # Get normalized endpoint for metrics labels
        route_template = get_route_template(request)
        endpoint = normalize_route(route_template, path)
        method = request.method

        # Track in-progress requests
        self._metrics.inc_in_progress(method, endpoint)
        start_time = time.time()

        try:
            response = await call_next(request)

            # Handle streaming responses
            if isinstance(response, StreamingResponse):
                # Wrap the body iterator to measure total time
                original_body_iterator = response.body_iterator

                async def timed_body_iterator():
                    try:
                        async for chunk in original_body_iterator:
                            yield chunk
                    finally:
                        # Record metrics after streaming completes
                        duration = time.time() - start_time
                        self._metrics.observe_request(
                            method=method,
                            endpoint=endpoint,
                            status_code=response.status_code,
                            duration_seconds=duration,
                        )
                        self._metrics.dec_in_progress(method, endpoint)

                response.body_iterator = timed_body_iterator()
                return response

            # Record metrics for non-streaming responses
            duration = time.time() - start_time
            self._metrics.observe_request(
                method=method,
                endpoint=endpoint,
                status_code=response.status_code,
                duration_seconds=duration,
            )
            self._metrics.dec_in_progress(method, endpoint)

            return response

        except Exception:
            # Record error metrics on exception
            duration = time.time() - start_time
            self._metrics.observe_request(
                method=method,
                endpoint=endpoint,
                status_code=500,
                duration_seconds=duration,
            )
            self._metrics.dec_in_progress(method, endpoint)
            raise


def setup_prometheus_endpoint(app, path: str = None):
    """Add the Prometheus metrics endpoint to a FastAPI app.

    Args:
        app: FastAPI application instance
        path: Path for the metrics endpoint. If None, uses config value.
    """
    from fastapi import APIRouter, Response
    from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

    from shared.prometheus.registry import get_registry

    config = get_prometheus_config()
    metrics_path = path or config.metrics_path

    # Create a dedicated router for metrics endpoint
    metrics_router = APIRouter()

    @metrics_router.get(metrics_path, include_in_schema=False)
    async def metrics():
        """Prometheus metrics endpoint."""
        registry = get_registry()
        return Response(
            content=generate_latest(registry),
            media_type=CONTENT_TYPE_LATEST,
        )

    # Include the router in the app
    app.include_router(metrics_router)
