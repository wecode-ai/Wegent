# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Chat Shell direct chat service module.

This module provides direct LLM API calling capabilities for Chat Shell type,
bypassing the Docker Executor container for lightweight chat scenarios.
"""

from app.services.chat.chat_service import chat_service
from app.services.chat.model_resolver import get_model_config_for_bot
from app.services.chat.session_manager import session_manager

__all__ = [
    "chat_service",
    "session_manager",
    "get_model_config_for_bot",
]
