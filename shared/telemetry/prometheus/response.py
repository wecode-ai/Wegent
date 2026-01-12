# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Prometheus metrics response utilities.

Provides functions to generate Prometheus-compatible metrics responses
for the /metrics endpoint.
"""

from typing import Optional

from prometheus_client import (CONTENT_TYPE_LATEST, REGISTRY,
                               CollectorRegistry, generate_latest)
from starlette.responses import Response


def get_metrics_response(registry: Optional[CollectorRegistry] = None) -> Response:
    """
    Generate a Starlette Response with Prometheus metrics.

    This function collects all registered metrics and formats them
    in the Prometheus text exposition format.

    Args:
        registry: Optional CollectorRegistry. If None, uses the default REGISTRY.

    Returns:
        Response: Starlette Response with metrics in Prometheus format

    Example:
        from fastapi import FastAPI
        from shared.telemetry.prometheus import get_metrics_response

        app = FastAPI()

        @app.get("/metrics")
        async def metrics():
            return get_metrics_response()
    """
    registry = registry or REGISTRY
    metrics_output = generate_latest(registry)

    return Response(
        content=metrics_output,
        media_type=CONTENT_TYPE_LATEST,
    )


def get_metrics_text(registry: Optional[CollectorRegistry] = None) -> str:
    """
    Generate Prometheus metrics as text.

    This function is useful when you need the metrics as a string
    rather than a Response object.

    Args:
        registry: Optional CollectorRegistry. If None, uses the default REGISTRY.

    Returns:
        str: Metrics in Prometheus text format

    Example:
        >>> text = get_metrics_text()
        >>> print(text[:100])
        # HELP wegent_http_requests_total Total number of HTTP requests
        # TYPE wegent_http_requests_total counter
    """
    registry = registry or REGISTRY
    return generate_latest(registry).decode("utf-8")
