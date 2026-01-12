# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Prometheus configuration module.

Provides centralized configuration loading from environment variables
for Prometheus metrics collection across all Wegent services.

Environment Variables:
    PROMETHEUS_ENABLED: Enable/disable Prometheus metrics (default: false)
    PROMETHEUS_METRICS_PATH: Metrics endpoint path (default: /metrics)
    PROMETHEUS_METRICS_PREFIX: Prefix for all metric names (default: wegent_)
    PROMETHEUS_EXCLUDE_PATHS: Comma-separated list of paths to exclude from metrics
"""

import os
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class PrometheusConfig:
    """
    Prometheus configuration dataclass.

    This class holds all Prometheus configuration values loaded from environment
    variables. Use get_prometheus_config() to get a singleton instance.

    Attributes:
        enabled: Whether Prometheus metrics collection is enabled
        metrics_path: The path where metrics will be exposed (default: /metrics)
        metrics_prefix: Prefix for all metric names (default: wegent_)
        exclude_paths: List of URL paths to exclude from metrics collection
        service_name: Name of the service for metric labels
    """

    enabled: bool = False
    metrics_path: str = "/metrics"
    metrics_prefix: str = "wegent_"
    exclude_paths: List[str] = field(default_factory=list)
    service_name: str = "wegent-service"


# Default paths to exclude from metrics (health checks, static assets, etc.)
DEFAULT_EXCLUDE_PATHS = [
    "/",
    "/health",
    "/healthz",
    "/ready",
    "/readyz",
    "/livez",
    "/metrics",
    "/favicon.ico",
]

# Cached configuration instance
_prometheus_config: Optional[PrometheusConfig] = None


def get_prometheus_config(
    service_name_override: Optional[str] = None,
) -> PrometheusConfig:
    """
    Get Prometheus configuration from environment variables.

    This function returns a cached PrometheusConfig instance. The configuration
    is loaded once from environment variables and reused for subsequent calls.

    Args:
        service_name_override: Optional service name to override the default.
                              Only used on first call when config is created.

    Returns:
        PrometheusConfig: Configuration dataclass with all Prometheus settings

    Example:
        >>> config = get_prometheus_config("wegent-backend")
        >>> if config.enabled:
        ...     setup_prometheus_middleware(app)
    """
    global _prometheus_config

    if _prometheus_config is None:
        # Parse exclude paths from environment variable
        exclude_paths_env = os.getenv("PROMETHEUS_EXCLUDE_PATHS", "")
        if exclude_paths_env:
            exclude_paths = [
                path.strip() for path in exclude_paths_env.split(",") if path.strip()
            ]
        else:
            # Use default excluded paths if not specified
            exclude_paths = DEFAULT_EXCLUDE_PATHS.copy()

        # Determine service name
        service_name = service_name_override or os.getenv(
            "PROMETHEUS_SERVICE_NAME",
            os.getenv("OTEL_SERVICE_NAME", "wegent-service"),
        )

        _prometheus_config = PrometheusConfig(
            enabled=os.getenv("PROMETHEUS_ENABLED", "false").lower() == "true",
            metrics_path=os.getenv("PROMETHEUS_METRICS_PATH", "/metrics"),
            metrics_prefix=os.getenv("PROMETHEUS_METRICS_PREFIX", "wegent_"),
            exclude_paths=exclude_paths,
            service_name=service_name,
        )

    return _prometheus_config


def reset_prometheus_config() -> None:
    """
    Reset the cached Prometheus configuration.

    This is primarily useful for testing purposes where you need to
    reload configuration with different environment variables.
    """
    global _prometheus_config
    _prometheus_config = None


def should_track_path(path: str, config: Optional[PrometheusConfig] = None) -> bool:
    """
    Check if a URL path should be tracked for metrics.

    Args:
        path: The URL path to check (e.g., "/api/users/123")
        config: Optional PrometheusConfig instance. If not provided, uses get_prometheus_config()

    Returns:
        bool: True if the path should be tracked, False if it should be excluded

    Example:
        >>> should_track_path("/api/users")  # True
        >>> should_track_path("/health")     # False
        >>> should_track_path("/metrics")    # False
    """
    if config is None:
        config = get_prometheus_config()

    # Check exact match first
    if path in config.exclude_paths:
        return False

    # Check prefix match for paths ending with *
    for exclude_path in config.exclude_paths:
        if exclude_path.endswith("*"):
            prefix = exclude_path[:-1]
            if path.startswith(prefix):
                return False

    return True
