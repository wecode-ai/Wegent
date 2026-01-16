# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenTelemetry provider initialization module.

Provides functions to initialize TracerProvider and MeterProvider
with OTLP exporters for distributed tracing and metrics.

Includes BusinessContextSpanProcessor for automatic propagation of
business context (task_id, subtask_id, user_id, user_name) to all spans.
"""

import logging
from typing import Optional, Sequence

from opentelemetry import metrics, trace
from opentelemetry.context import Context
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import \
    OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import \
    OTLPSpanExporter
from opentelemetry.propagate import set_global_textmap
from opentelemetry.propagators.composite import CompositePropagator
from opentelemetry.sdk.metrics import MeterProvider as SDKMeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan, Span, SpanProcessor
from opentelemetry.sdk.trace import TracerProvider as SDKTracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.trace.sampling import (Decision,
                                              ParentBasedTraceIdRatio, Sampler,
                                              SamplingResult)
from opentelemetry.trace import Link, SpanKind
from opentelemetry.trace.propagation.tracecontext import \
    TraceContextTextMapPropagator
from opentelemetry.util.types import Attributes

logger = logging.getLogger(__name__)


class BusinessContextSpanProcessor(SpanProcessor):
    """
    A SpanProcessor that automatically adds business context attributes
    (task_id, subtask_id, user_id, user_name) to every span.

    This processor reads from ContextVars set by set_task_context() and
    set_user_context() and adds those attributes to each span when it starts.

    This ensures that all spans within a request automatically inherit
    the business context, making it easy to filter and correlate traces
    by task_id, subtask_id, or user.
    """

    def on_start(
        self,
        span: Span,
        parent_context: Optional[Context] = None,
    ) -> None:
        """
        Called when a span is started. Adds business context attributes.
        """
        try:
            # Import here to avoid circular imports
            from shared.telemetry.context.span import get_business_context

            # Get current business context from ContextVars
            context = get_business_context()

            # Add each attribute to the span
            for key, value in context.items():
                if value is not None:
                    span.set_attribute(key, value)

        except Exception as e:
            # Don't let context propagation errors affect the application
            logger.debug(f"Failed to add business context to span: {e}")

    def on_end(self, span: ReadableSpan) -> None:
        """Called when a span is ended. No action needed."""
        pass

    def shutdown(self) -> None:
        """Called when the processor is shut down. No action needed."""
        pass

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        """Force flush any pending spans. No action needed."""
        return True


class FilteringParentBasedSampler(Sampler):
    """
    A custom sampler that filters out internal ASGI spans and Redis spans in WebSocket context.

    This sampler wraps a parent-based sampler and adds filtering logic to:
    1. Drop spans with names like "http send" or "http receive" which are
       created by the ASGI middleware for each SSE chunk in streaming responses.
    2. Drop Redis command spans when in WebSocket context to reduce noise.

    This significantly reduces trace noise for streaming endpoints like
    /api/chat/stream where each chunk would otherwise create a separate span.
    """

    # Span names to filter out (internal ASGI spans)
    FILTERED_SPAN_NAMES = frozenset(
        [
            "http send",
            "http receive",
            "HTTP send",
            "HTTP receive",
            "asgi.send",
            "asgi.receive",
        ]
    )

    # Redis command span names (uppercase command names)
    REDIS_COMMANDS = frozenset(
        [
            "GET",
            "SET",
            "DEL",
            "MGET",
            "MSET",
            "HGET",
            "HSET",
            "HDEL",
            "HGETALL",
            "LPUSH",
            "RPUSH",
            "LPOP",
            "RPOP",
            "LRANGE",
            "SADD",
            "SREM",
            "SMEMBERS",
            "ZADD",
            "ZREM",
            "ZRANGE",
            "PUBLISH",
            "SUBSCRIBE",
            "PSUBSCRIBE",
            "UNSUBSCRIBE",
            "PUNSUBSCRIBE",
            "PING",
            "EXISTS",
            "EXPIRE",
            "TTL",
            "KEYS",
            "SCAN",
            "DBSIZE",
            "SETNX",
            "SETEX",
        ]
    )

    def __init__(
        self,
        root_sampler: Sampler,
        filter_internal_spans: bool = True,
    ):
        """
        Initialize the filtering sampler.

        Args:
            root_sampler: The underlying sampler to use for non-filtered spans
            filter_internal_spans: Whether to filter out internal ASGI spans
        """
        self._root_sampler = root_sampler
        self._filter_internal_spans = filter_internal_spans

    def should_sample(
        self,
        parent_context: Optional[Context],
        trace_id: int,
        name: str,
        kind: Optional[SpanKind] = None,
        attributes: Attributes = None,
        links: Optional[Sequence[Link]] = None,
        trace_state: Optional["TraceState"] = None,
    ) -> SamplingResult:
        """
        Determine if a span should be sampled.

        Filters out:
        1. Internal ASGI spans (http send/receive) to reduce noise from streaming endpoints
        2. Redis command spans when in WebSocket context
        """
        # Filter out internal ASGI spans if enabled
        if self._filter_internal_spans and name in self.FILTERED_SPAN_NAMES:
            return SamplingResult(
                decision=Decision.DROP,
                attributes=None,
                trace_state=trace_state,
            )

        # Filter out Redis spans in WebSocket context
        if name in self.REDIS_COMMANDS:
            try:
                from shared.telemetry.context.span import is_websocket_context

                if is_websocket_context():
                    return SamplingResult(
                        decision=Decision.DROP,
                        attributes=None,
                        trace_state=trace_state,
                    )
            except Exception:
                pass  # If check fails, don't filter

        # Delegate to the root sampler for all other spans
        return self._root_sampler.should_sample(
            parent_context=parent_context,
            trace_id=trace_id,
            name=name,
            kind=kind,
            attributes=attributes,
            links=links,
            trace_state=trace_state,
        )

    def get_description(self) -> str:
        """Return a description of this sampler."""
        return f"FilteringParentBasedSampler(root={self._root_sampler.get_description()}, filter_internal={self._filter_internal_spans})"


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
    # Configure global propagator for W3C Trace Context
    # This is CRITICAL for distributed tracing - FastAPIInstrumentor uses this
    # to extract trace context (traceparent header) from incoming HTTP requests
    # Without this, each service starts a new trace instead of continuing the parent trace
    propagator = CompositePropagator([TraceContextTextMapPropagator()])
    set_global_textmap(propagator)
    logger.debug("Global propagator configured for W3C Trace Context")

    # Create sampler with filtering for internal spans and WebSocket Redis
    base_sampler = ParentBasedTraceIdRatio(sampler_ratio)
    sampler = FilteringParentBasedSampler(base_sampler, filter_internal_spans=True)

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
        max_queue_size=2048,  # Max spans in queue (default: 2048)
        schedule_delay_millis=5000,  # Export every 5 seconds (default: 5000)
        max_export_batch_size=512,  # Max spans per batch (default: 512)
        export_timeout_millis=10000,  # 10 second export timeout (default: 30000)
    )
    tracer_provider.add_span_processor(span_processor)

    # Add BusinessContextSpanProcessor to automatically propagate
    # task_id, subtask_id, user_id, user_name to all spans
    business_context_processor = BusinessContextSpanProcessor()
    tracer_provider.add_span_processor(business_context_processor)

    # Set as global TracerProvider
    trace.set_tracer_provider(tracer_provider)

    logger.debug(
        f"TracerProvider initialized with endpoint: {otlp_endpoint}, "
        f"sampler_ratio: {sampler_ratio}, fail-safe mode enabled, "
        f"business context propagation enabled"
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
        export_interval_millis=60000,  # Export every 60 seconds
        export_timeout_millis=10000,  # 10 second export timeout
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
