# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Subscription service package.

This package provides the SubscriptionService for managing Subscription
configurations and BackgroundExecution records.
"""

from app.services.subscription.execution import (
    BackgroundExecutionManager,
)
from app.services.subscription.service import (
    SubscriptionService,
    subscription_service,
)
from app.services.subscription.state_machine import (
    VALID_STATE_TRANSITIONS,
    InvalidStateTransitionError,
    OptimisticLockError,
    validate_state_transition,
)

__all__ = [
    # Main service
    "SubscriptionService",
    "subscription_service",
    # Execution manager
    "BackgroundExecutionManager",
    # State machine
    "InvalidStateTransitionError",
    "OptimisticLockError",
    "VALID_STATE_TRANSITIONS",
    "validate_state_transition",
]
