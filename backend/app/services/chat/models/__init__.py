# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Model factory and resolver module for LangGraph Chat Service.

Provides:
- LangChainModelFactory: Create LangChain chat models from config
- ModelResolver: Proxy class for model resolution (delegates to chat service)
- find_model, get_bot_system_prompt: Direct function access
"""

from .factory import LangChainModelFactory
from .resolver import ModelResolver, find_model, get_bot_system_prompt

__all__ = [
    "LangChainModelFactory",
    "ModelResolver",
    "find_model",
    "get_bot_system_prompt",
]
