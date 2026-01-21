# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Application-wide constants.

This module defines constants used across the application to avoid magic strings
and ensure consistency.
"""

# ========== WebSocket Room Prefixes ==========

# Room prefix for task-specific WebSocket rooms
# Used to broadcast task events (messages, status updates) to connected clients
# Format: "task:{task_id}"
TASK_ROOM_PREFIX = "task:"


def get_task_room(task_id: int) -> str:
    """
    Get the WebSocket room name for a task.

    Args:
        task_id: The task ID

    Returns:
        Room name in format "task:{task_id}"
    """
    return f"{TASK_ROOM_PREFIX}{task_id}"


# ========== Kind Names ==========

KIND_TEAM = "Team"
KIND_SUBSCRIPTION = "Subscription"
KIND_WORKSPACE = "Workspace"
KIND_TASK = "Task"


# ========== Background Execution Labels ==========

LABEL_SUBSCRIPTION_ID = "subscriptionId"
LABEL_EXECUTION_ID = "executionId"
LABEL_BACKGROUND_EXECUTION_ID = "backgroundExecutionId"
LABEL_SOURCE = "source"


# ========== Trigger Types (string values for database storage) ==========
# These match SubscriptionTriggerType enum values but are plain strings for use
# where enum comparison is not appropriate

TRIGGER_TYPE_CRON = "cron"
TRIGGER_TYPE_INTERVAL = "interval"
TRIGGER_TYPE_ONE_TIME = "one_time"
TRIGGER_TYPE_EVENT = "event"
