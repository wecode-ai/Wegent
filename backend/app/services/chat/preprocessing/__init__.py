# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat preprocessing module.

This module handles message preprocessing before sending to AI:
- Context processing (attachments, knowledge bases)
- Message transformation

The contexts module provides unified processing for all context types,
replacing the original attachments-only approach.

Key functions:
- prepare_contexts_for_chat: Unified context processing based on user_subtask_id
- link_contexts_to_subtask: Link attachments and create KB contexts for a subtask
- process_attachments: Legacy function for backward compatibility
"""

from .contexts import (
    extract_knowledge_base_ids,
    get_attachment_context_ids_from_subtask,
    get_knowledge_base_ids_from_subtask,
    link_contexts_to_subtask,
    prepare_contexts_for_chat,
    process_attachments,
    process_contexts,
)

__all__ = [
    "process_attachments",
    "process_contexts",
    "extract_knowledge_base_ids",
    "link_contexts_to_subtask",
    "prepare_contexts_for_chat",
    "get_knowledge_base_ids_from_subtask",
    "get_attachment_context_ids_from_subtask",
]
