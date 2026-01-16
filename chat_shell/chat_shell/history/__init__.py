# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat history module for Chat Service.

This module provides functions to load and process chat history.

Supports two modes:
- Package mode: Direct database access via Backend's ORM
- HTTP mode: Remote API call via /internal/chat/history (session_id: "task-{task_id}")
"""

from .loader import (
    close_remote_history_store,
    get_chat_history,
    get_knowledge_base_meta_prompt,
)

__all__ = [
    "get_chat_history",
    "get_knowledge_base_meta_prompt",
    "close_remote_history_store",
]
