# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Prometheus configuration management.

Environment variables:
    PROMETHEUS_ENABLED: Enable/disable prometheus metrics (default: false)
    PROMETHEUS_METRICS_PATH: Path for metrics endpoint (default: /metrics)
"""

import os
from dataclasses import dataclass
from functools import lru_cache
from typing import Optional


@dataclass(frozen=True)
class PrometheusConfig:
    """Prometheus configuration settings."""

    enabled: bool
    metrics_path: str

    @classmethod
    def from_env(cls) -> "PrometheusConfig":
        """Create config from environment variables."""
        enabled_str = os.getenv("PROMETHEUS_ENABLED", "false").lower()
        enabled = enabled_str in ("true", "1", "yes", "on")

        metrics_path = os.getenv("PROMETHEUS_METRICS_PATH", "/metrics")
        # Ensure path starts with /
        if not metrics_path.startswith("/"):
            metrics_path = f"/{metrics_path}"

        return cls(enabled=enabled, metrics_path=metrics_path)


# Cached config instance
_prometheus_config: Optional[PrometheusConfig] = None


def get_prometheus_config() -> PrometheusConfig:
    """Get the prometheus configuration singleton.

    Returns:
        PrometheusConfig instance loaded from environment variables.
    """
    global _prometheus_config
    if _prometheus_config is None:
        _prometheus_config = PrometheusConfig.from_env()
    return _prometheus_config


def reset_prometheus_config() -> None:
    """Reset the prometheus configuration (for testing)."""
    global _prometheus_config
    _prometheus_config = None
