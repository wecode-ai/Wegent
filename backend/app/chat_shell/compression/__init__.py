# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Message compression module for handling context window limits.

This module provides utilities to compress chat history when it exceeds
the model's context window limit, enabling continuous conversation without
interruption.
"""

from .compressor import MessageCompressor
from .config import (
    CompressionConfig,
    ModelContextConfig,
    get_model_context_config,
)
from .strategies import (
    AttachmentTruncationStrategy,
    CompressionResult,
    CompressionStrategy,
    HistoryTruncationStrategy,
)
from .token_counter import TokenCounter

__all__ = [
    "MessageCompressor",
    "TokenCounter",
    "CompressionConfig",
    "ModelContextConfig",
    "get_model_context_config",
    "CompressionResult",
    "CompressionStrategy",
    "AttachmentTruncationStrategy",
    "HistoryTruncationStrategy",
]
