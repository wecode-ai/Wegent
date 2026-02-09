# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Prometheus monitoring module for Wegent services.

This module provides Prometheus metrics collection and exposure for Backend and Chat Shell.
It's designed to work independently from OpenTelemetry.

Usage:
    from shared.prometheus import get_prometheus_config, setup_prometheus_app

    # Check if prometheus is enabled
    config = get_prometheus_config()
    if config.enabled:
        setup_prometheus_app(app)
"""

from shared.prometheus.config import PrometheusConfig, get_prometheus_config
from shared.prometheus.registry import get_registry

__all__ = [
    "PrometheusConfig",
    "get_prometheus_config",
    "get_registry",
]
