# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Message utilities for Chat Service.

Provides:
- MessageConverter: Core message conversion logic
- message_builder: Legacy builder (deprecated, use MessageConverter)
"""

from langchain_core.messages.utils import convert_to_messages

from .builder import message_builder
from .converter import MessageConverter

__all__ = [
    "MessageConverter",
    "message_builder",
    "convert_to_messages",
]
