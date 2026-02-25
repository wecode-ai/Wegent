# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Configuration module for LangGraph Chat Service.

This module provides model resolution and shell type checking utilities.

Note: ChatConfig and ChatConfigBuilder have been removed and consolidated into
TaskRequestBuilder in app.services.execution.request_builder.

Note: should_use_direct_chat and is_direct_chat_shell have been removed.
All teams now use ExecutionDispatcher for unified task routing.
"""

# Re-export LangChainModelFactory from chat_shell for backward compatibility
from chat_shell.models import LangChainModelFactory

from .model_resolver import (
    build_default_headers_with_placeholders,
    extract_and_process_model_config,
    get_bot_system_prompt,
    get_model_config_for_bot,
)
from .shell_checker import (
    get_shell_type,
    get_team_first_bot_shell_type,
    is_deep_research_protocol,
)
from .stream_config import WebSocketStreamConfig

__all__ = [
    "WebSocketStreamConfig",
    "LangChainModelFactory",
    "get_model_config_for_bot",
    "get_bot_system_prompt",
    "extract_and_process_model_config",
    "build_default_headers_with_placeholders",
    # Shell checker
    "get_shell_type",
    "get_team_first_bot_shell_type",
    "is_deep_research_protocol",
]
