# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Prometheus registry management.

Provides a centralized registry for all Prometheus metrics.
Uses the default REGISTRY from prometheus_client for simplicity,
which is the standard approach for single-process applications.
"""

import os
from typing import Optional

from prometheus_client import REGISTRY, CollectorRegistry, multiprocess

# Global registry instance
_registry: Optional[CollectorRegistry] = None


def get_registry() -> CollectorRegistry:
    """Get the global Prometheus registry.

    In multi-process mode (when prometheus_multiproc_dir is set),
    uses a custom registry with multiprocess collector.
    Otherwise, uses the default REGISTRY from prometheus_client.

    Returns:
        CollectorRegistry instance for metrics collection.
    """
    global _registry
    if _registry is None:
        # Check for multi-process mode
        prometheus_multiproc_dir = os.getenv("prometheus_multiproc_dir")
        if prometheus_multiproc_dir:
            # Multi-process mode: use custom registry with multiprocess collector
            _registry = CollectorRegistry()
            multiprocess.MultiProcessCollector(_registry)
        else:
            # Single-process mode: use the default REGISTRY
            # This is the standard approach and ensures all default collectors
            # (process, platform, gc) are included automatically
            _registry = REGISTRY

    return _registry


def reset_registry() -> None:
    """Reset the global registry (for testing)."""
    global _registry
    _registry = None
