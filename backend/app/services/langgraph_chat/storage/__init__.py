# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Storage module for LangGraph Chat Service.

Provides unified access to db_handler and session_manager.

Usage:
    from .storage import storage_handler
    await storage_handler.update_subtask_status(subtask_id, "RUNNING")
    await storage_handler.get_chat_history(task_id)
"""

from .proxy import StorageProxy

# Global storage handler instance
storage_handler = StorageProxy()

__all__ = ["storage_handler", "StorageProxy"]
