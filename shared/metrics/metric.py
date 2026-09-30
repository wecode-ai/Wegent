# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Metric slot, recording policies, and the public metric handle.

Aligned with ``brz-metrics``: one slot carries failure, total latency, slow
count, and five latency-interval buckets. The metric type selects the policy
(slow threshold and bucket boundaries); the profile writer drains the slot
every interval, so each log line reports one interval window.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from enum import Enum
from typing import Optional

_NS_PER_MS = 1_000_000


class MetricPolicy(Enum):
    """Latency policy: slow threshold and interval bucket boundaries, in ms."""

    # ProfileUtil resource buckets: <10, <50, <100, <200, >=200 ms; slow at 50.
    RESOURCE = (50, (10, 50, 100, 200))
    # Whole-request/API buckets with the 200 ms slow threshold.
    SERVICE = (200, (10, 50, 100, 200))

    @property
    def slow_threshold_ms(self) -> int:
        return self.value[0]

    @property
    def intervals_ms(self) -> tuple[int, ...]:
        return self.value[1]


class MetricType(Enum):
    """ProfileUtil ``type`` label of one metric line."""

    # Count-only counters such as job outcomes; recorded via ``increment``.
    LOG = ("LOG", MetricPolicy.RESOURCE)
    # One inbound API route and HTTP status class.
    API = ("API", MetricPolicy.SERVICE)
    # Service operation with the 200 ms slow threshold.
    SERVICE = ("SERVICE", MetricPolicy.SERVICE)

    @property
    def profile_type(self) -> str:
        return self.value[0]

    @property
    def policy(self) -> MetricPolicy:
        return self.value[1]


class Slot:
    """Mutable counters behind one registered metric."""

    __slots__ = (
        "failure",
        "elapsed_ns",
        "slow",
        "intervals",
        "lock",
        "slow_threshold_ms",
    )

    def __init__(self) -> None:
        self.failure = 0
        self.elapsed_ns = 0
        self.slow = 0
        self.intervals = [0, 0, 0, 0, 0]
        self.lock = threading.Lock()
        # Per-metric slow threshold in ms; defaults to the metric type's policy.
        self.slow_threshold_ms: Optional[int] = None


@dataclass(frozen=True)
class MetricSnapshot:
    """Point-in-time view of one slot."""

    total: int
    success: int
    failure: int
    elapsed_ns: int
    slow: int
    intervals: tuple[int, int, int, int, int]


class Metric:
    """Handle to one registered metric slot.

    Handles are cheap to keep at module scope and updates are thread-safe.
    """

    __slots__ = ("_name", "_type", "_slot", "_slow_threshold_ms")

    def __init__(
        self,
        name: str,
        metric_type: MetricType,
        slot: Slot,
        slow_threshold_ms: Optional[int] = None,
    ) -> None:
        self._name = name
        self._type = metric_type
        self._slot = slot
        self._slow_threshold_ms = slow_threshold_ms

    @classmethod
    def api(cls, name: str, slow_threshold_ms: Optional[int] = None) -> "Metric":
        """Register one inbound API metric with the service latency policy."""
        return _register(name, MetricType.API, slow_threshold_ms)

    @classmethod
    def service(cls, name: str, slow_threshold_ms: Optional[int] = None) -> "Metric":
        """Register one service-operation metric (200 ms slow threshold)."""
        return _register(name, MetricType.SERVICE, slow_threshold_ms)

    @classmethod
    def log(cls, name: str, slow_threshold_ms: Optional[int] = None) -> "Metric":
        """Register one count-only counter."""
        return _register(name, MetricType.LOG, slow_threshold_ms)

    @property
    def name(self) -> str:
        return self._name

    @property
    def type(self) -> MetricType:
        return self._type

    @property
    def slow_threshold_ms(self) -> int:
        """Effective slow threshold: per-metric override, else policy default."""
        if self._slow_threshold_ms is not None:
            return self._slow_threshold_ms
        return self._type.policy.slow_threshold_ms

    def record(
        self,
        elapsed_seconds: float,
        success: bool = True,
        slow_threshold_ms: Optional[int] = None,
    ) -> None:
        """Record one completed operation with its latency in seconds."""
        if isinstance(elapsed_seconds, bool) or not isinstance(
            elapsed_seconds, (int, float)
        ):
            raise TypeError(
                f"elapsed_seconds must be a number, got {elapsed_seconds!r}"
            )
        if elapsed_seconds < 0:
            raise ValueError(
                f"elapsed_seconds must be non-negative, got {elapsed_seconds}"
            )
        policy = self._type.policy
        elapsed_ns = int(elapsed_seconds * 1_000_000_000)
        interval_ms = elapsed_ns // _NS_PER_MS
        bucket = 4
        for index, boundary in enumerate(policy.intervals_ms):
            if interval_ms < boundary:
                bucket = index
                break
        slow_threshold = (
            slow_threshold_ms
            if slow_threshold_ms is not None
            else self.slow_threshold_ms
        )
        with self._slot.lock:
            if not success:
                self._slot.failure += 1
            self._slot.elapsed_ns += elapsed_ns
            if interval_ms >= slow_threshold:
                self._slot.slow += 1
            self._slot.intervals[bucket] += 1

    def increment(self, count: int = 1) -> None:
        """Record ``count`` occurrences without timing or failure data."""
        if isinstance(count, bool) or not isinstance(count, int):
            raise TypeError(f"count must be an int, got {count!r}")
        with self._slot.lock:
            self._slot.intervals[0] += count

    def snapshot(self) -> MetricSnapshot:
        """Return a consistent point-in-time view without draining the slot."""
        with self._slot.lock:
            return _snapshot(self._slot)

    def __repr__(self) -> str:
        return f"Metric(name={self._name!r}, type={self._type.profile_type})"


def _snapshot(slot: Slot) -> MetricSnapshot:
    total = sum(slot.intervals)
    return MetricSnapshot(
        total=total,
        success=total - slot.failure,
        failure=slot.failure,
        elapsed_ns=slot.elapsed_ns,
        slow=slot.slow,
        intervals=tuple(slot.intervals),
    )


def _drain(slot: Slot) -> MetricSnapshot:
    """Read and reset one slot; callers treat the result as one interval."""
    with slot.lock:
        view = _snapshot(slot)
        slot.failure = 0
        slot.elapsed_ns = 0
        slot.slow = 0
        slot.intervals = [0, 0, 0, 0, 0]
    return view


def _register(
    name: str,
    metric_type: MetricType,
    slow_threshold_ms: Optional[int] = None,
) -> Metric:
    from shared.metrics.registry import get_registry

    return get_registry().register(name, metric_type, slow_threshold_ms)
