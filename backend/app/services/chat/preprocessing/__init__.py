# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat preprocessing module.

This module handles message preprocessing before sending to AI:
- Context processing (attachments, knowledge bases)
- Message transformation

The contexts module provides unified processing for all context types,
replacing the original attachments-only approach.
"""

from .contexts import (
    extract_knowledge_base_ids,
    process_attachments,
    process_contexts,
)

__all__ = [
    "process_attachments",
    "process_contexts",
    "extract_knowledge_base_ids",
]
