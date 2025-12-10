# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenTelemetry integration module for Wegent services.

This module provides a unified interface for distributed tracing, metrics,
and context propagation across all Wegent services.

Directory Structure:
    telemetry/
    ├── __init__.py          # Public API exports (this file)
    ├── core.py              # Core initialization and lifecycle
    ├── config.py            # Configuration from environment
    ├── providers.py         # TracerProvider and MeterProvider setup
    ├── instrumentation.py   # Auto-instrumentation for frameworks
    ├── context/
    │   ├── __init__.py      # Context utilities exports
    │   ├── attributes.py    # Standard span attribute keys
    │   ├── span.py          # Span manipulation utilities
    │   └── propagation.py   # Trace context propagation
    └── metrics/
        ├── __init__.py      # Metrics exports
        ├── business.py      # Business metrics (WegentMetrics)
        └── decorators.py    # Metric tracking decorators
    ├── decorators.py        # Tracing decorators for functions/methods

Usage:
    from shared.telemetry import init_telemetry, shutdown_telemetry, is_telemetry_enabled
    from shared.telemetry import get_tracer, get_meter
    from shared.telemetry import trace_async, trace_sync, add_span_event, set_span_attribute
    from shared.telemetry.instrumentation import setup_opentelemetry_instrumentation
    from shared.telemetry.context import set_user_context, set_task_context
    from shared.telemetry.metrics import record_task_completed, record_model_call
"""

# Configuration
from shared.telemetry.config import get_http_capture_settings, get_otel_config_from_env

# Core initialization and lifecycle
from shared.telemetry.core import (
    get_meter,
    get_tracer,
    init_telemetry,
    is_telemetry_enabled,
    shutdown_telemetry,
)

# Instrumentation
from shared.telemetry.instrumentation import setup_opentelemetry_instrumentation

# Decorators for tracing
from shared.telemetry.decorators import (
    add_span_event,
    set_span_attribute,
    trace_async,
    trace_sync,
)

__all__ = [
    # Core
    "init_telemetry",
    "shutdown_telemetry",
    "is_telemetry_enabled",
    "get_tracer",
    "get_meter",
    # Config
    "get_otel_config_from_env",
    "get_http_capture_settings",
    # Instrumentation
    "setup_opentelemetry_instrumentation",
    # Decorators
    "trace_async",
    "trace_sync",
    "add_span_event",
    "set_span_attribute",
]
