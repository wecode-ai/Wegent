# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat Trigger - AI Response Triggering.

This module is responsible for triggering AI responses:
- Extract data from ORM objects
- Start background streaming tasks
- Prepare ChatEvent and send to Chat Shell

This is Backend's responsibility, not Chat Shell's.

Note: Tool preparation functions have been moved to their appropriate locations:
- Knowledge base tools: app.chat_shell.tools.knowledge_factory
- Skill tools: app.chat_shell.tools.skill_factory
- Attachment processing: app.services.chat.preprocessing
"""

from .core import StreamTaskData, trigger_ai_response
from .group_chat import (
    is_task_group_chat,
    notify_group_members_task_updated,
    should_trigger_ai_response,
)

__all__ = [
    # Core
    "trigger_ai_response",
    "StreamTaskData",
    # Group chat
    "should_trigger_ai_response",
    "notify_group_members_task_updated",
    "is_task_group_chat",
]
