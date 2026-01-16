# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat Shell tools module.

This module provides:
- ToolRegistry: Central registry for tool management
- Tool event handling for streaming
- Built-in tools (file reader, web search, knowledge base, load skill)
- Tool factories (knowledge base, skill)
- MCP integration
- Pending request registry for skill frontend interactions
"""

from .base import ToolRegistry
from .builtin import (
    FileListSkill,
    FileReaderSkill,
    KnowledgeBaseTool,
    LoadSkillTool,
    WebSearchTool,
)
from .events import create_tool_event_handler
from .pending_requests import (
    PendingRequest,
    PendingRequestRegistry,
    get_pending_request_registry,
    get_pending_request_registry_sync,
    shutdown_pending_request_registry,
)

__all__ = [
    # Base
    "ToolRegistry",
    # Events
    "create_tool_event_handler",
    # Built-in tools
    "WebSearchTool",
    "KnowledgeBaseTool",
    "FileReaderSkill",
    "FileListSkill",
    "LoadSkillTool",
    # Pending requests
    "PendingRequest",
    "PendingRequestRegistry",
    "get_pending_request_registry",
    "get_pending_request_registry_sync",
    "shutdown_pending_request_registry",
]
