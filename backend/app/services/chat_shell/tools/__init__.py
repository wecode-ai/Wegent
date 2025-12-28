# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat Shell Tools - Tool Execution Framework.

This module provides the tool execution framework for Chat Shell:
- Base tool classes and registry
- Tool event handling
- Built-in tools (knowledge base, file reader, web search, etc.)
- MCP protocol tools support
- Pending request registry for frontend interactions
"""

from .base import ToolRegistry, global_registry
from .builtin import (
    FileListSkill,
    FileReaderSkill,
    KnowledgeBaseTool,
    WebSearchTool,
)
from .pending_requests import (
    PendingRequest,
    PendingRequestRegistry,
    get_pending_request_registry,
    get_pending_request_registry_sync,
    shutdown_pending_request_registry,
)

__all__ = [
    "ToolRegistry",
    "global_registry",
    "WebSearchTool",
    "KnowledgeBaseTool",
    "FileReaderSkill",
    "FileListSkill",
    # Pending requests
    "PendingRequest",
    "PendingRequestRegistry",
    "get_pending_request_registry",
    "get_pending_request_registry_sync",
    "shutdown_pending_request_registry",
]
