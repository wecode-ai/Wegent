# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenAPI services package.

This package contains services for the OpenAPI v1/responses endpoint:
- helpers: Utility functions for status conversion, parsing, validation
- chat_session: Chat session setup and history building
- mcp: MCP (Model Context Protocol) tools loading
- streaming: SSE streaming service

Note: chat_response module is deprecated. OpenAPI responses now use the unified
trigger architecture via build_execution_request + dispatch_sse_stream.
"""

from app.services.openapi.chat_session import (
    ChatSessionSetup,
    build_chat_history,
    setup_chat_session,
)
from app.services.openapi.helpers import (
    extract_input_text,
    get_team_shell_type,
    parse_model_string,
    parse_wegent_tools,
    subtask_status_to_message_status,
    wegent_status_to_openai_status,
)
from app.services.openapi.mcp import load_bot_mcp_tools, load_server_mcp_tools

__all__ = [
    # chat_session
    "ChatSessionSetup",
    "build_chat_history",
    "setup_chat_session",
    # helpers
    "extract_input_text",
    "get_team_shell_type",
    "parse_model_string",
    "parse_wegent_tools",
    "subtask_status_to_message_status",
    "wegent_status_to_openai_status",
    # mcp
    "load_bot_mcp_tools",
    "load_server_mcp_tools",
]
