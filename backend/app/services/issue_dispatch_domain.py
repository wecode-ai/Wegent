# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Pure state transitions for Issue dispatch orchestration."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Sequence

DispatchTargetType = Literal["human", "agent", "group"]
DispatchStatus = Literal["active", "completed", "cancelled"]
RoundStatus = Literal["planning", "executing", "evaluating", "closed", "cancelled"]
TaskStatus = Literal[
    "assigned",
    "queued",
    "running",
    "submitted",
    "failed",
    "needs_rework",
    "cancelled",
]

TERMINAL_TASK_STATUSES: frozenset[str] = frozenset(
    {"submitted", "failed", "needs_rework", "cancelled"}
)


class DispatchConflict(ValueError):
    """Raised when a command violates the dispatch state machine."""


@dataclass(frozen=True)
class RoundBarrier:
    round_status: RoundStatus
    request_leader_turn: bool


@dataclass(frozen=True)
class DirectOutcome:
    dispatch_status: DispatchStatus
    issue_status: str | None


def prepare_next_round(active_round_status: str | None) -> bool:
    """Return whether the previous evaluating round must be closed.

    A manager may create the next round only after the current concurrent round
    reached its barrier. Creating the next round closes that evaluated round.
    """

    if active_round_status is None:
        return False
    if active_round_status == "evaluating":
        return True
    raise DispatchConflict("The current dispatch round has not reached its barrier")


def evaluate_round_barrier(task_statuses: Sequence[str]) -> RoundBarrier:
    """Evaluate the all-terminal barrier for one concurrent round."""

    if not task_statuses:
        raise DispatchConflict("A dispatch round must contain at least one task")
    if all(status in TERMINAL_TASK_STATUSES for status in task_statuses):
        return RoundBarrier(round_status="evaluating", request_leader_turn=True)
    return RoundBarrier(round_status="executing", request_leader_turn=False)


def direct_outcome(status: str) -> DirectOutcome:
    """Map a direct assignment outcome without affecting group semantics."""

    if status == "submitted":
        return DirectOutcome(dispatch_status="completed", issue_status="in_review")
    if status in {"failed", "needs_rework", "cancelled"}:
        return DirectOutcome(dispatch_status="active", issue_status=None)
    raise DispatchConflict(f"Unsupported direct dispatch outcome: {status}")


def require_stage_for_group_task(
    configured_stage_ids: set[str], stage_id: str | None
) -> None:
    """Validate an optional project workflow stage on a group assignment."""

    if configured_stage_ids and not stage_id:
        raise DispatchConflict(
            "A workflow stage is required when the project configures stages"
        )
    if stage_id and stage_id not in configured_stage_ids:
        raise DispatchConflict("The dispatch task workflow stage is invalid")
