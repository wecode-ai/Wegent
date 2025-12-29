# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat history module for Chat Service.

This module provides functions to load and process chat history.
"""

from .loader import get_chat_history

__all__ = ["get_chat_history"]
