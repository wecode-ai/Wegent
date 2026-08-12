# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Authoritative workflow and stage lifecycle contracts."""

from enum import StrEnum


class WorkflowStatus(StrEnum):
    PENDING = "pending"
    WAITING_APPROVAL = "waiting_approval"
    QUEUED = "queued"
    RUNNING = "running"
    BLOCKED = "blocked"
    FAILED = "failed"
    CANCELLED = "cancelled"
    COMPLETED = "completed"


class StageStatus(StrEnum):
    PENDING = "pending"
    WAITING_APPROVAL = "waiting_approval"
    QUEUED = "queued"
    CLAIMED = "claimed"
    RUNNING = "running"
    PASSED = "passed"
    FAILED = "failed"
    REJECTED = "rejected"
    CANCELLED = "cancelled"
    SKIPPED = "skipped"


WORKFLOW_TERMINAL_STATUSES = frozenset(
    {
        WorkflowStatus.FAILED,
        WorkflowStatus.CANCELLED,
        WorkflowStatus.COMPLETED,
    }
)
STAGE_TERMINAL_STATUSES = frozenset(
    {
        StageStatus.PASSED,
        StageStatus.FAILED,
        StageStatus.REJECTED,
        StageStatus.CANCELLED,
        StageStatus.SKIPPED,
    }
)

WORKFLOW_TRANSITIONS: dict[WorkflowStatus, frozenset[WorkflowStatus]] = {
    WorkflowStatus.PENDING: frozenset(
        {
            WorkflowStatus.WAITING_APPROVAL,
            WorkflowStatus.QUEUED,
            WorkflowStatus.CANCELLED,
        }
    ),
    WorkflowStatus.WAITING_APPROVAL: frozenset(
        {
            WorkflowStatus.QUEUED,
            WorkflowStatus.CANCELLED,
            WorkflowStatus.FAILED,
        }
    ),
    WorkflowStatus.QUEUED: frozenset(
        {
            WorkflowStatus.RUNNING,
            WorkflowStatus.BLOCKED,
            WorkflowStatus.FAILED,
            WorkflowStatus.CANCELLED,
        }
    ),
    WorkflowStatus.RUNNING: frozenset(
        {
            WorkflowStatus.WAITING_APPROVAL,
            WorkflowStatus.QUEUED,
            WorkflowStatus.BLOCKED,
            WorkflowStatus.FAILED,
            WorkflowStatus.CANCELLED,
            WorkflowStatus.COMPLETED,
        }
    ),
    WorkflowStatus.BLOCKED: frozenset(
        {
            WorkflowStatus.QUEUED,
            WorkflowStatus.RUNNING,
            WorkflowStatus.FAILED,
            WorkflowStatus.CANCELLED,
        }
    ),
    WorkflowStatus.FAILED: frozenset({WorkflowStatus.QUEUED}),
    WorkflowStatus.CANCELLED: frozenset(),
    WorkflowStatus.COMPLETED: frozenset(),
}

STAGE_TRANSITIONS: dict[StageStatus, frozenset[StageStatus]] = {
    StageStatus.PENDING: frozenset(
        {
            StageStatus.WAITING_APPROVAL,
            StageStatus.QUEUED,
            StageStatus.CANCELLED,
            StageStatus.SKIPPED,
        }
    ),
    StageStatus.WAITING_APPROVAL: frozenset(
        {
            StageStatus.QUEUED,
            StageStatus.REJECTED,
            StageStatus.CANCELLED,
        }
    ),
    StageStatus.QUEUED: frozenset(
        {
            StageStatus.CLAIMED,
            StageStatus.RUNNING,
            StageStatus.FAILED,
            StageStatus.CANCELLED,
        }
    ),
    StageStatus.CLAIMED: frozenset(
        {
            StageStatus.RUNNING,
            StageStatus.FAILED,
            StageStatus.CANCELLED,
        }
    ),
    StageStatus.RUNNING: frozenset(
        {
            StageStatus.PASSED,
            StageStatus.FAILED,
            StageStatus.CANCELLED,
        }
    ),
    StageStatus.PASSED: frozenset(),
    StageStatus.FAILED: frozenset({StageStatus.QUEUED}),
    StageStatus.REJECTED: frozenset(),
    StageStatus.CANCELLED: frozenset(),
    StageStatus.SKIPPED: frozenset(),
}


def can_transition_workflow(
    current: WorkflowStatus | str,
    target: WorkflowStatus | str,
) -> bool:
    current_status = WorkflowStatus(current)
    target_status = WorkflowStatus(target)
    return target_status in WORKFLOW_TRANSITIONS[current_status]


def can_transition_stage(
    current: StageStatus | str,
    target: StageStatus | str,
) -> bool:
    current_status = StageStatus(current)
    target_status = StageStatus(target)
    return target_status in STAGE_TRANSITIONS[current_status]
