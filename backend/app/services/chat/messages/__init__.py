# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Message converter module for LangGraph Chat Service.

For dict-to-LangChain conversion, use langchain_core.messages.utils.convert_to_messages.
"""

from langchain_core.messages.utils import convert_to_messages

from .converter import MessageConverter

__all__ = ["MessageConverter", "convert_to_messages"]
