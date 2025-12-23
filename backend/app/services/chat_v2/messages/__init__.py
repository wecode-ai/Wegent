# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Message utilities for Chat Service.

Provides:
- MessageConverter: Core message conversion logic
"""

from langchain_core.messages.utils import convert_to_messages

from .converter import MessageConverter

__all__ = [
    "MessageConverter",
    "convert_to_messages",
]
