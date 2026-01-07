# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Configuration module for LangGraph Chat Service.

This module provides configuration builders for chat sessions and model resolution.
"""

# Re-export LangChainModelFactory from chat_shell for backward compatibility
from chat_shell.models import LangChainModelFactory

from .chat_config import ChatConfig, ChatConfigBuilder
from .model_resolver import (
    build_default_headers_with_placeholders,
    extract_and_process_model_config,
    get_bot_system_prompt,
    get_model_config_for_bot,
)
from .shell_checker import (
    DIRECT_CHAT_SHELL_TYPES,
    get_shell_type,
    get_team_first_bot_shell_type,
    is_direct_chat_shell,
    should_use_direct_chat,
)
from .stream_config import WebSocketStreamConfig

__all__ = [
    "ChatConfig",
    "ChatConfigBuilder",
    "WebSocketStreamConfig",
    "LangChainModelFactory",
    "get_model_config_for_bot",
    "get_bot_system_prompt",
    "extract_and_process_model_config",
    "build_default_headers_with_placeholders",
    # Shell checker
    "DIRECT_CHAT_SHELL_TYPES",
    "is_direct_chat_shell",
    "get_shell_type",
    "should_use_direct_chat",
    "get_team_first_bot_shell_type",
]
