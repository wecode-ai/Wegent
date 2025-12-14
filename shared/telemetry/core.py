# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenTelemetry core initialization module.

Provides the main entry point for initializing and managing
OpenTelemetry tracing and metrics.
"""

import logging
import os
from typing import Optional

from opentelemetry import metrics, trace
from opentelemetry.metrics import Meter
from opentelemetry.sdk.resources import Resource
from opentelemetry.trace import Tracer

from shared.telemetry.config import set_http_capture_settings
from shared.telemetry.providers import (
    init_meter_provider,
    init_tracer_provider,
    shutdown_providers,
)

logger = logging.getLogger(__name__)

# Global state for telemetry
_telemetry_initialized = False
_telemetry_enabled = False


def init_telemetry(
    service_name: str,
    enabled: bool = True,
    otlp_endpoint: str = "http://otel-collector:4317",
    sampler_ratio: float = 1.0,
    service_version: str = "1.0.0",
    deployment_environment: Optional[str] = None,
    metrics_enabled: bool = False,
    capture_request_headers: bool = False,
    capture_request_body: bool = False,
    capture_response_headers: bool = False,
    capture_response_body: bool = False,
    max_body_size: int = 4096,
) -> bool:
    """
    Initialize OpenTelemetry with tracing and optional metrics support.

    Args:
        service_name: Name of the service (e.g., "wegent-backend")
        enabled: Whether to enable telemetry (default: True)
        otlp_endpoint: OTLP gRPC endpoint URL (default: "http://otel-collector:4317")
        sampler_ratio: Trace sampling ratio from 0.0 to 1.0 (default: 1.0)
        service_version: Version of the service (default: "1.0.0")
        deployment_environment: Deployment environment (e.g., "production", "development")
        metrics_enabled: Whether to enable metrics export (default: False)
        capture_request_headers: Whether to capture HTTP request headers (default: False)
        capture_request_body: Whether to capture HTTP request body (default: False)
        capture_response_headers: Whether to capture HTTP response headers (default: False)
        capture_response_body: Whether to capture HTTP response body (default: False)
        max_body_size: Maximum body size to capture in bytes (default: 4096)

    Returns:
        bool: True if initialization was successful, False otherwise
    """
    global _telemetry_initialized, _telemetry_enabled

    if _telemetry_initialized:
        logger.warning("Telemetry already initialized, skipping re-initialization")
        return _telemetry_enabled

    # Store HTTP capture settings globally
    set_http_capture_settings(
        capture_request_headers=capture_request_headers,
        capture_request_body=capture_request_body,
        capture_response_headers=capture_response_headers,
        capture_response_body=capture_response_body,
        max_body_size=max_body_size,
    )

    if not enabled:
        logger.info("OpenTelemetry is disabled, skipping initialization")
        _telemetry_initialized = True
        _telemetry_enabled = False
        return False

    try:
        # Create resource attributes
        resource_attributes = {
            "service.name": service_name,
            "service.version": service_version,
        }

        if deployment_environment:
            resource_attributes["deployment.environment"] = deployment_environment
        else:
            # Try to get from environment
            env = os.getenv("ENVIRONMENT", os.getenv("ENV", "development"))
            resource_attributes["deployment.environment"] = env

        resource = Resource.create(resource_attributes)

        # Initialize TracerProvider (always enabled when telemetry is enabled)
        init_tracer_provider(resource, otlp_endpoint, sampler_ratio)

        # Initialize MeterProvider only if metrics are enabled
        if metrics_enabled:
            init_meter_provider(resource, otlp_endpoint)
            logger.info("OpenTelemetry metrics export enabled")
        else:
            logger.info("OpenTelemetry metrics export disabled")

        _telemetry_initialized = True
        _telemetry_enabled = True

        # Log HTTP capture settings
        http_capture_info = []
        if capture_request_headers:
            http_capture_info.append("request_headers")
        if capture_request_body:
            http_capture_info.append("request_body")
        if capture_response_headers:
            http_capture_info.append("response_headers")
        if capture_response_body:
            http_capture_info.append("response_body")

        capture_str = ", ".join(http_capture_info) if http_capture_info else "none"
        logger.info(
            f"OpenTelemetry initialized successfully for service '{service_name}' "
            f"with endpoint '{otlp_endpoint}', sampler ratio {sampler_ratio}, "
            f"HTTP capture: [{capture_str}], max_body_size: {max_body_size} bytes"
        )

        return True

    except Exception as e:
        logger.error(f"Failed to initialize OpenTelemetry: {e}")
        _telemetry_initialized = True
        _telemetry_enabled = False
        return False


def shutdown_telemetry() -> None:
    """
    Gracefully shutdown telemetry providers.
    Should be called during application shutdown.
    """
    global _telemetry_initialized, _telemetry_enabled

    if not _telemetry_enabled:
        return

    try:
        shutdown_providers()
        logger.info("OpenTelemetry shutdown completed")
    except Exception as e:
        logger.error(f"Error during OpenTelemetry shutdown: {e}")
    finally:
        _telemetry_initialized = False
        _telemetry_enabled = False


def is_telemetry_enabled() -> bool:
    """
    Check if telemetry is enabled and initialized.

    Returns:
        bool: True if telemetry is enabled, False otherwise
    """
    return _telemetry_enabled


def get_tracer(name: str) -> Tracer:
    """
    Get a Tracer instance for creating spans.

    Args:
        name: Name of the tracer (typically module name)

    Returns:
        Tracer: OpenTelemetry Tracer instance
    """
    return trace.get_tracer(name)


def get_meter(name: str) -> Meter:
    """
    Get a Meter instance for creating metrics.

    Args:
        name: Name of the meter (typically module name)

    Returns:
        Meter: OpenTelemetry Meter instance
    """
    return metrics.get_meter(name)
