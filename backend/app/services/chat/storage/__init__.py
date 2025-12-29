# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Storage module for Chat Service.

Provides unified access to database and session storage.
"""

from .db import db_handler
from .proxy import StorageProxy
from .session import session_manager
from .task_manager import (
    TaskCreationParams,
    TaskCreationResult,
    check_task_status,
    create_assistant_subtask,
    create_new_task,
    create_task_and_subtasks,
    create_user_subtask,
    get_bot_ids_from_team,
    get_existing_subtasks,
    get_next_message_id,
    get_task_with_access_check,
    initialize_redis_chat_history,
    update_task_timestamp,
)

# Global storage handler instance
storage_handler = StorageProxy()

__all__ = [
    "storage_handler",
    "StorageProxy",
    "db_handler",
    "session_manager",
    # Task manager
    "TaskCreationParams",
    "TaskCreationResult",
    "get_bot_ids_from_team",
    "get_task_with_access_check",
    "check_task_status",
    "create_new_task",
    "create_user_subtask",
    "create_assistant_subtask",
    "get_next_message_id",
    "get_existing_subtasks",
    "update_task_timestamp",
    "initialize_redis_chat_history",
    "create_task_and_subtasks",
]
