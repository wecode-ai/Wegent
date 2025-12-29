# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""RAG (Retrieval-Augmented Generation) module for Chat Service.

This module provides utilities for processing RAG contexts and
knowledge base retrieval.
"""

from .processor import (
    extract_knowledge_base_ids,
    process_context_and_rag,
    process_rag_if_needed,
)

__all__ = [
    "process_rag_if_needed",
    "extract_knowledge_base_ids",
    "process_context_and_rag",
]
