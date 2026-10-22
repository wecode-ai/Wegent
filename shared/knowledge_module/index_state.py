# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Pure generation and state rules; callers apply decisions under their lock."""

from dataclasses import dataclass
from typing import Literal, Mapping

ACTIVE_INDEX_STATUSES = frozenset(
    {"queued", "pending_conversion", "converting", "indexing"}
)


@dataclass(frozen=True)
class IndexStateSnapshot:
    status: str
    generation: int


@dataclass(frozen=True)
class IndexStateDecision:
    accepted: bool
    reason: str
    generation: int | None = None
    next_status: str | None = None


def active_index_stale_reason(
    status: str, *, age_seconds: float | None, thresholds: Mapping[str, float]
) -> str | None:
    """Decide expiration from caller-provided elapsed time and policy values."""
    threshold = thresholds.get(status)
    if age_seconds is not None and threshold is not None and age_seconds >= threshold:
        return f"stale_{status}"
    return None


def decide_index_transition(
    snapshot: IndexStateSnapshot | None,
    *,
    event: Literal["enqueue", "start", "success", "failure"],
    generation: int | None = None,
    expected_generation: int | None = None,
    allow_if_success: bool = False,
    replace_active: bool = False,
    stale: bool = False,
) -> IndexStateDecision:
    """Accept only events that still own the attempt and its allowed state."""
    if event not in {"enqueue", "start", "success", "failure"}:
        raise ValueError(f"Unsupported index event: {event}")
    if snapshot is None:
        return IndexStateDecision(False, "document_not_found", generation)
    if event == "enqueue":
        return _decide_enqueue(
            snapshot, expected_generation, allow_if_success, replace_active, stale
        )
    if snapshot.generation != generation:
        return IndexStateDecision(False, "stale_generation", generation)
    if event == "start":
        reason = {
            "success": "already_completed",
            "not_indexed": "not_scheduled",
            "failed": "already_failed",
        }.get(snapshot.status)
        if reason:
            return IndexStateDecision(False, reason, generation)
        return IndexStateDecision(True, "started", generation, "indexing")
    allowed = {"queued", "indexing"} if event == "success" else ACTIVE_INDEX_STATUSES
    if snapshot.status not in allowed:
        return IndexStateDecision(False, "stale_or_already_finalized", generation)
    return IndexStateDecision(
        True, "finalized", generation, "success" if event == "success" else "failed"
    )


def _decide_enqueue(
    snapshot: IndexStateSnapshot,
    expected: int | None,
    allow_success: bool,
    replace_active: bool,
    stale: bool,
) -> IndexStateDecision:
    if expected is not None and snapshot.generation != expected:
        return IndexStateDecision(False, "stale_generation", expected)
    active = snapshot.status in ACTIVE_INDEX_STATUSES and not replace_active
    if active and not stale:
        return IndexStateDecision(False, "already_in_progress", snapshot.generation)
    if snapshot.status == "success" and not allow_success:
        return IndexStateDecision(False, "already_indexed", snapshot.generation)
    reason = "scheduled_after_stale_recovery" if active else "scheduled"
    return IndexStateDecision(True, reason, snapshot.generation + 1, "queued")
