# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat Trigger - AI Response Triggering.

This module is responsible for triggering AI responses:
- Extract data from ORM objects
- Start background streaming tasks
- Coordinate sub-modules (attachments, knowledge base, skills)
- Prepare ChatEvent and send to Chat Shell

This is Backend's responsibility, not Chat Shell's.
"""

from .attachments import process_attachments
from .core import StreamTaskData, trigger_ai_response
from .knowledge import prepare_knowledge_base_tools
from .skills import prepare_load_skill_tool, prepare_skill_tools

__all__ = [
    # Core
    "trigger_ai_response",
    "StreamTaskData",
    # Attachments
    "process_attachments",
    # Knowledge base
    "prepare_knowledge_base_tools",
    # Skills
    "prepare_load_skill_tool",
    "prepare_skill_tools",
]
