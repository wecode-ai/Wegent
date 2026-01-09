# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat preprocessing module.

This module handles message preprocessing before sending to AI:
- Context processing (attachments, knowledge bases, tables)
- Message transformation

The contexts module provides unified processing for all context types,
replacing the original attachments-only approach.

Key functions:
- prepare_contexts_for_chat: Unified context processing based on user_subtask_id
- link_contexts_to_subtask: Link attachments and create KB contexts for a subtask
- process_attachments: Legacy function for backward compatibility

Table functions (multi-provider support):
- parse_table_url: Extract baseId and sheetId from any supported table URL
- get_table_context_for_document: Get table context for a document
- detect_provider_from_url: Detect provider type (dingtalk, feishu) from URL
"""

from .contexts import (
    extract_knowledge_base_ids,
    get_attachment_context_ids_from_subtask,
    get_knowledge_base_ids_from_subtask,
    get_table_context_ids_from_subtask,
    link_contexts_to_subtask,
    prepare_contexts_for_chat,
    process_attachments,
    process_contexts,
)
from .tables import (
    detect_provider_from_url,
    get_table_context_for_document,
    parse_table_url,
)

__all__ = [
    "process_attachments",
    "process_contexts",
    "extract_knowledge_base_ids",
    "link_contexts_to_subtask",
    "prepare_contexts_for_chat",
    "get_knowledge_base_ids_from_subtask",
    "get_attachment_context_ids_from_subtask",
    "get_table_context_ids_from_subtask",
    # Table functions (multi-provider support)
    "parse_table_url",
    "detect_provider_from_url",
    "get_table_context_for_document",
]
