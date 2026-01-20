# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
State machine for BackgroundExecution status transitions.

This module defines the valid state transitions and provides validation
functions for ensuring execution status changes follow the defined rules.
"""

from typing import Dict, Set

from app.schemas.subscription import BackgroundExecutionStatus

# Valid state transitions for BackgroundExecution
# Key: current state, Value: set of valid next states
VALID_STATE_TRANSITIONS: Dict[
    BackgroundExecutionStatus, Set[BackgroundExecutionStatus]
] = {
    BackgroundExecutionStatus.PENDING: {
        BackgroundExecutionStatus.RUNNING,
        BackgroundExecutionStatus.CANCELLED,
        BackgroundExecutionStatus.FAILED,  # Can fail before starting (e.g., validation error)
    },
    BackgroundExecutionStatus.RUNNING: {
        BackgroundExecutionStatus.COMPLETED,
        BackgroundExecutionStatus.FAILED,
        BackgroundExecutionStatus.RETRYING,
        BackgroundExecutionStatus.CANCELLED,  # Allow cancellation of running executions
    },
    BackgroundExecutionStatus.RETRYING: {
        BackgroundExecutionStatus.RUNNING,
        BackgroundExecutionStatus.FAILED,
        BackgroundExecutionStatus.CANCELLED,
    },
    BackgroundExecutionStatus.COMPLETED: set(),  # Terminal state
    BackgroundExecutionStatus.FAILED: set(),  # Terminal state
    BackgroundExecutionStatus.CANCELLED: set(),  # Terminal state
}


class InvalidStateTransitionError(Exception):
    """Raised when an invalid state transition is attempted."""

    def __init__(self, current_state: str, new_state: str, execution_id: int):
        self.current_state = current_state
        self.new_state = new_state
        self.execution_id = execution_id
        super().__init__(
            f"Invalid state transition for execution {execution_id}: "
            f"{current_state} -> {new_state}"
        )


class OptimisticLockError(Exception):
    """Raised when optimistic lock conflict is detected."""

    def __init__(self, execution_id: int, expected_version: int, actual_version: int):
        self.execution_id = execution_id
        self.expected_version = expected_version
        self.actual_version = actual_version
        super().__init__(
            f"Optimistic lock conflict for execution {execution_id}: "
            f"expected version {expected_version}, got {actual_version}"
        )


def validate_state_transition(
    current_state: BackgroundExecutionStatus, new_state: BackgroundExecutionStatus
) -> bool:
    """
    Validate if a state transition is allowed.

    Args:
        current_state: Current execution status
        new_state: Desired new status

    Returns:
        True if transition is valid, False otherwise
    """
    if current_state == new_state:
        return True  # No-op transitions are always valid

    valid_next_states = VALID_STATE_TRANSITIONS.get(current_state, set())
    return new_state in valid_next_states


def is_terminal_state(status: BackgroundExecutionStatus) -> bool:
    """
    Check if a status is a terminal state.

    Terminal states are states from which no further transitions are allowed.

    Args:
        status: The status to check

    Returns:
        True if the status is terminal, False otherwise
    """
    return status in {
        BackgroundExecutionStatus.COMPLETED,
        BackgroundExecutionStatus.FAILED,
        BackgroundExecutionStatus.CANCELLED,
    }


def get_valid_next_states(
    current_state: BackgroundExecutionStatus,
) -> Set[BackgroundExecutionStatus]:
    """
    Get the set of valid next states from the current state.

    Args:
        current_state: Current execution status

    Returns:
        Set of valid next states
    """
    return VALID_STATE_TRANSITIONS.get(current_state, set())
