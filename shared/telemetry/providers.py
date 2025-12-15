# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenTelemetry provider initialization module.

Provides functions to initialize TracerProvider and MeterProvider
with OTLP exporters for distributed tracing and metrics.
"""

import logging

from opentelemetry import metrics, trace
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.metrics import MeterProvider as SDKMeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider as SDKTracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.trace.sampling import ParentBasedTraceIdRatio

logger = logging.getLogger(__name__)


def init_tracer_provider(
    resource: Resource, otlp_endpoint: str, sampler_ratio: float
) -> None:
    """
    Initialize and configure the TracerProvider.

    The BatchSpanProcessor is configured with fail-safe settings to ensure
    that if the OTLP Collector is unavailable, the main service will not
    be affected. Spans will be dropped rather than blocking the application.

    Args:
        resource: OpenTelemetry resource with service attributes
        otlp_endpoint: OTLP gRPC endpoint URL
        sampler_ratio: Trace sampling ratio (0.0 to 1.0)
    """
    # Create sampler
    sampler = ParentBasedTraceIdRatio(sampler_ratio)

    # Create TracerProvider
    tracer_provider = SDKTracerProvider(resource=resource, sampler=sampler)

    # Create OTLP exporter with timeout settings
    # Short timeout ensures we don't block if collector is down
    otlp_exporter = OTLPSpanExporter(
        endpoint=otlp_endpoint,
        insecure=True,
        timeout=5,  # 5 second timeout for export operations
    )

    # Configure BatchSpanProcessor with fail-safe settings:
    # - max_queue_size: Maximum spans to queue (drop oldest if exceeded)
    # - schedule_delay_millis: How often to export batches
    # - max_export_batch_size: Maximum spans per export batch
    # - export_timeout_millis: Timeout for each export attempt
    #
    # These settings ensure that if the collector is down:
    # 1. Spans are dropped (not blocking the app) when queue is full
    # 2. Export attempts timeout quickly
    # 3. The application continues to function normally
    span_processor = BatchSpanProcessor(
        otlp_exporter,
        max_queue_size=2048,           # Max spans in queue (default: 2048)
        schedule_delay_millis=5000,    # Export every 5 seconds (default: 5000)
        max_export_batch_size=512,     # Max spans per batch (default: 512)
        export_timeout_millis=10000,   # 10 second export timeout (default: 30000)
    )
    tracer_provider.add_span_processor(span_processor)

    # Set as global TracerProvider
    trace.set_tracer_provider(tracer_provider)

    logger.debug(
        f"TracerProvider initialized with endpoint: {otlp_endpoint}, "
        f"sampler_ratio: {sampler_ratio}, fail-safe mode enabled"
    )


def init_meter_provider(resource: Resource, otlp_endpoint: str) -> None:
    """
    Initialize and configure the MeterProvider.

    The MeterProvider is configured with fail-safe settings to ensure
    that if the OTLP Collector is unavailable, the main service will not
    be affected. Metrics will be dropped rather than blocking the application.

    Args:
        resource: OpenTelemetry resource with service attributes
        otlp_endpoint: OTLP gRPC endpoint URL
    """
    # Create OTLP metric exporter with timeout settings
    # Short timeout ensures we don't block if collector is down
    metric_exporter = OTLPMetricExporter(
        endpoint=otlp_endpoint,
        insecure=True,
        timeout=5,  # 5 second timeout for export operations
    )

    # Create metric reader with periodic export
    # - export_interval_millis: How often to export metrics
    # - export_timeout_millis: Timeout for each export attempt
    #
    # These settings ensure that if the collector is down:
    # 1. Export attempts timeout quickly
    # 2. The application continues to function normally
    metric_reader = PeriodicExportingMetricReader(
        metric_exporter,
        export_interval_millis=60000,   # Export every 60 seconds
        export_timeout_millis=10000,    # 10 second export timeout
    )

    # Create MeterProvider
    meter_provider = SDKMeterProvider(resource=resource, metric_readers=[metric_reader])

    # Set as global MeterProvider
    metrics.set_meter_provider(meter_provider)

    logger.debug(
        f"MeterProvider initialized with endpoint: {otlp_endpoint}, "
        f"fail-safe mode enabled"
    )


def shutdown_providers() -> None:
    """
    Gracefully shutdown telemetry providers.
    Should be called during application shutdown.
    """
    try:
        # Shutdown TracerProvider
        tracer_provider = trace.get_tracer_provider()
        if hasattr(tracer_provider, "shutdown"):
            tracer_provider.shutdown()
            logger.debug("TracerProvider shutdown completed")

        # Shutdown MeterProvider
        meter_provider = metrics.get_meter_provider()
        if hasattr(meter_provider, "shutdown"):
            meter_provider.shutdown()
            logger.debug("MeterProvider shutdown completed")

    except Exception as e:
        logger.error(f"Error during provider shutdown: {e}")
