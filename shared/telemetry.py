#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
OpenTelemetry core initialization module.
Provides unified initialization and utility functions for distributed tracing and metrics.
"""

import logging
import os
from typing import Optional

from opentelemetry import metrics, trace
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.metrics import Meter, MeterProvider
from opentelemetry.sdk.metrics import MeterProvider as SDKMeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider as SDKTracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.trace.sampling import ParentBasedTraceIdRatio
from opentelemetry.trace import Tracer, TracerProvider

logger = logging.getLogger(__name__)

# Global flag to track if telemetry is initialized
_telemetry_initialized = False
_telemetry_enabled = False


def get_otel_config_from_env() -> dict:
    """
    Get OpenTelemetry configuration from environment variables.

    Returns:
        dict: Configuration dictionary with keys:
            - enabled: bool
            - service_name: str
            - otlp_endpoint: str
            - sampler_ratio: float
            - metrics_enabled: bool
    """
    return {
        "enabled": os.getenv("OTEL_ENABLED", "false").lower() == "true",
        "service_name": os.getenv("OTEL_SERVICE_NAME", "wegent-service"),
        "otlp_endpoint": os.getenv(
            "OTEL_EXPORTER_OTLP_ENDPOINT", "http://otel-collector:4317"
        ),
        "sampler_ratio": float(os.getenv("OTEL_TRACES_SAMPLER_ARG", "1.0")),
        "metrics_enabled": os.getenv("OTEL_METRICS_ENABLED", "false").lower() == "true",
    }


# Global HTTP capture settings
_http_capture_settings = {
    "capture_request_headers": False,
    "capture_request_body": False,
    "capture_response_headers": False,
    "capture_response_body": False,
}


def get_http_capture_settings() -> dict:
    """
    Get the current HTTP capture settings.

    Returns:
        dict: HTTP capture settings dictionary
    """
    return _http_capture_settings.copy()


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

    Returns:
        bool: True if initialization was successful, False otherwise
    """
    global _telemetry_initialized, _telemetry_enabled, _http_capture_settings

    if _telemetry_initialized:
        logger.warning("Telemetry already initialized, skipping re-initialization")
        return _telemetry_enabled

    # Store HTTP capture settings globally
    _http_capture_settings["capture_request_headers"] = capture_request_headers
    _http_capture_settings["capture_request_body"] = capture_request_body
    _http_capture_settings["capture_response_headers"] = capture_response_headers
    _http_capture_settings["capture_response_body"] = capture_response_body

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
        _init_tracer_provider(resource, otlp_endpoint, sampler_ratio)

        # Initialize MeterProvider only if metrics are enabled
        if metrics_enabled:
            _init_meter_provider(resource, otlp_endpoint)
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
            f"HTTP capture: [{capture_str}]"
        )

        return True

    except Exception as e:
        logger.error(f"Failed to initialize OpenTelemetry: {e}")
        _telemetry_initialized = True
        _telemetry_enabled = False
        return False


def _init_tracer_provider(
    resource: Resource, otlp_endpoint: str, sampler_ratio: float
) -> None:
    """
    Initialize and configure the TracerProvider.

    Args:
        resource: OpenTelemetry resource with service attributes
        otlp_endpoint: OTLP gRPC endpoint URL
        sampler_ratio: Trace sampling ratio
    """
    # Create sampler
    sampler = ParentBasedTraceIdRatio(sampler_ratio)

    # Create TracerProvider
    tracer_provider = SDKTracerProvider(resource=resource, sampler=sampler)

    # Create OTLP exporter and span processor
    otlp_exporter = OTLPSpanExporter(endpoint=otlp_endpoint, insecure=True)
    span_processor = BatchSpanProcessor(otlp_exporter)
    tracer_provider.add_span_processor(span_processor)

    # Set as global TracerProvider
    trace.set_tracer_provider(tracer_provider)


def _init_meter_provider(resource: Resource, otlp_endpoint: str) -> None:
    """
    Initialize and configure the MeterProvider.

    Args:
        resource: OpenTelemetry resource with service attributes
        otlp_endpoint: OTLP gRPC endpoint URL
    """
    # Create OTLP metric exporter
    metric_exporter = OTLPMetricExporter(endpoint=otlp_endpoint, insecure=True)

    # Create metric reader with periodic export
    metric_reader = PeriodicExportingMetricReader(
        metric_exporter,
        export_interval_millis=60000,  # Export every 60 seconds
    )

    # Create MeterProvider
    meter_provider = SDKMeterProvider(resource=resource, metric_readers=[metric_reader])

    # Set as global MeterProvider
    metrics.set_meter_provider(meter_provider)


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


def is_telemetry_enabled() -> bool:
    """
    Check if telemetry is enabled and initialized.

    Returns:
        bool: True if telemetry is enabled, False otherwise
    """
    return _telemetry_enabled


def shutdown_telemetry() -> None:
    """
    Gracefully shutdown telemetry providers.
    Should be called during application shutdown.
    """
    global _telemetry_initialized, _telemetry_enabled

    if not _telemetry_enabled:
        return

    try:
        # Shutdown TracerProvider
        tracer_provider = trace.get_tracer_provider()
        if hasattr(tracer_provider, "shutdown"):
            tracer_provider.shutdown()

        # Shutdown MeterProvider
        meter_provider = metrics.get_meter_provider()
        if hasattr(meter_provider, "shutdown"):
            meter_provider.shutdown()

        logger.info("OpenTelemetry shutdown completed")

    except Exception as e:
        logger.error(f"Error during OpenTelemetry shutdown: {e}")

    finally:
        _telemetry_initialized = False
        _telemetry_enabled = False
