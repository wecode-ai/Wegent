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

    Args:
        resource: OpenTelemetry resource with service attributes
        otlp_endpoint: OTLP gRPC endpoint URL
        sampler_ratio: Trace sampling ratio (0.0 to 1.0)
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

    logger.debug(f"TracerProvider initialized with endpoint: {otlp_endpoint}")


def init_meter_provider(resource: Resource, otlp_endpoint: str) -> None:
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

    logger.debug(f"MeterProvider initialized with endpoint: {otlp_endpoint}")


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
