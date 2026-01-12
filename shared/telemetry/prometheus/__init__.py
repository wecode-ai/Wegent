# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Prometheus metrics module for Wegent services.

This module provides a unified interface for Prometheus metrics collection
across all Wegent services (Backend, Chat Shell, Executor Manager, Executor).

Features:
- Standard HTTP request metrics (counter, histogram, gauge)
- Configurable via environment variables
- Easy integration with FastAPI applications
- Extensible for custom business metrics

Usage:
    from shared.telemetry.prometheus import (
        get_prometheus_config,
        setup_prometheus_middleware,
        get_metrics_response,
    )

    # In FastAPI app setup
    if get_prometheus_config().enabled:
        setup_prometheus_middleware(app, service_name="wegent-backend")

    # Add metrics endpoint
    @app.get("/metrics")
    async def metrics():
        return get_metrics_response()
"""

from shared.telemetry.prometheus.config import (PrometheusConfig,
                                                get_prometheus_config,
                                                reset_prometheus_config)
from shared.telemetry.prometheus.metrics import (PrometheusMetrics,
                                                 get_prometheus_metrics)
from shared.telemetry.prometheus.middleware import (
    PrometheusMiddleware, setup_prometheus_middleware)
from shared.telemetry.prometheus.response import get_metrics_response

__all__ = [
    # Config
    "PrometheusConfig",
    "get_prometheus_config",
    "reset_prometheus_config",
    # Metrics
    "PrometheusMetrics",
    "get_prometheus_metrics",
    # Middleware
    "PrometheusMiddleware",
    "setup_prometheus_middleware",
    # Response
    "get_metrics_response",
]
