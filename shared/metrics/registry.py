# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Process-wide metric registry.

One table keyed by metric name, shared by every thread of the process. The
first registration starts the profile logger, mirroring ``brz-metrics``.
"""

from __future__ import annotations

import threading
from typing import Iterator, Optional

from shared.metrics.metric import Metric, MetricType, Slot


class Registry:
    """Thread-safe table of metric slots."""

    def __init__(self) -> None:
        self._slots: dict[tuple[str, MetricType], Slot] = {}
        self._lock = threading.Lock()

    def register(
        self,
        name: str,
        metric_type: MetricType,
        slow_threshold_ms: Optional[int] = None,
    ) -> Metric:
        """Return the metric for ``name``, registering it on first use."""
        key = (name, metric_type)
        slot = self._slots.get(key)
        if slot is None:
            with self._lock:
                slot = self._slots.setdefault(key, Slot())
        if slow_threshold_ms is not None:
            slot.slow_threshold_ms = slow_threshold_ms
        start_logger_once()
        return Metric(name, metric_type, slot, slow_threshold_ms)

    def items(self) -> Iterator[tuple[str, MetricType, Slot, Optional[int]]]:
        """Iterate over every registered metric; order is stable by name."""
        ordered = sorted(
            self._slots.items(), key=lambda kv: (kv[0][0], kv[0][1].profile_type)
        )
        for (name, metric_type), slot in ordered:
            yield name, metric_type, slot, slot.slow_threshold_ms


def start_logger_once() -> None:
    from shared.metrics.profile import start_profile_logger

    start_profile_logger()


_REGISTRY = Registry()


def get_registry() -> Registry:
    """Return the process-wide registry."""
    return _REGISTRY
