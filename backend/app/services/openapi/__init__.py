# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenAPI services package.

This package contains services for the OpenAPI v1/responses endpoint:
- helpers: Utility functions for status conversion, parsing, validation
- chat_session: Chat session setup and history building
- mcp: MCP (Model Context Protocol) tools loading
- chat_response: Streaming and synchronous response handlers
- streaming: SSE streaming service
"""

from app.services.openapi.chat_response import (
    create_streaming_response,
    create_sync_response,
)
from app.services.openapi.chat_session import (
    ChatSessionSetup,
    build_chat_history,
    setup_chat_session,
)
from app.services.openapi.helpers import (
    check_team_supports_direct_chat,
    extract_input_text,
    parse_model_string,
    parse_wegent_tools,
    subtask_status_to_message_status,
    wegent_status_to_openai_status,
)
from app.services.openapi.mcp import load_bot_mcp_tools, load_server_mcp_tools

__all__ = [
    # chat_response
    "create_streaming_response",
    "create_sync_response",
    # chat_session
    "ChatSessionSetup",
    "build_chat_history",
    "setup_chat_session",
    # helpers
    "check_team_supports_direct_chat",
    "extract_input_text",
    "parse_model_string",
    "parse_wegent_tools",
    "subtask_status_to_message_status",
    "wegent_status_to_openai_status",
    # mcp
    "load_bot_mcp_tools",
    "load_server_mcp_tools",
]
