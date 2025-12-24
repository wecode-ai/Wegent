# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Model factory and resolver module for Chat Service.

Provides:
- LangChainModelFactory: Create LangChain chat models from config
- get_model_config_for_bot: Resolve model configuration
- get_bot_system_prompt: Resolve system prompt
"""

from .factory import LangChainModelFactory
from .resolver import get_bot_system_prompt, get_model_config_for_bot

__all__ = [
    "LangChainModelFactory",
    "get_model_config_for_bot",
    "get_bot_system_prompt",
]
