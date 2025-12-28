# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Model factory and resolver module for Chat Service.

Provides:
- LangChainModelFactory: Create LangChain chat models from config (re-exported from chat_shell)
- get_model_config_for_bot: Resolve model configuration
- get_bot_system_prompt: Resolve system prompt
- extract_and_process_model_config: Extract and process model config with placeholders
- build_default_headers_with_placeholders: Build headers with placeholder replacement
"""

# Re-export LangChainModelFactory from chat_shell for backward compatibility
from app.services.chat_shell.models import LangChainModelFactory

from .resolver import (
    build_default_headers_with_placeholders,
    extract_and_process_model_config,
    get_bot_system_prompt,
    get_model_config_for_bot,
)

__all__ = [
    "LangChainModelFactory",
    "get_model_config_for_bot",
    "get_bot_system_prompt",
    "extract_and_process_model_config",
    "build_default_headers_with_placeholders",
]
