# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared result models.

This module contains small, reusable dataclasses that are shared across
backend and chat_shell packages.

All comments must be written in English.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Union


class KnowledgeBaseToolAccessMode:
    """Constants for knowledge base tool exposure modes."""

    FULL = "full"
    RESTRICTED_SEARCH_ONLY = "restricted_search_only"


@dataclass(frozen=True)
class KnowledgeBaseToolsResult:
    """Result container for knowledge base tool preparation."""

    extra_tools: list[Any]
    enhanced_system_prompt: str
    kb_meta_prompt: str
    # KB IDs resolved for this request (subtask-level takes priority over task-level).
    # Populated so callers can fill ExecutionRequest.knowledge_base_ids without a
    # second DB query.
    knowledge_base_ids: list[int] = None  # type: ignore[assignment]
    is_user_selected_kb: bool = False
    document_ids: list[int] = None  # type: ignore[assignment]
    kb_tool_access_mode: str = KnowledgeBaseToolAccessMode.FULL

    def __post_init__(self) -> None:
        # Use object.__setattr__ because the dataclass is frozen.
        if self.knowledge_base_ids is None:
            object.__setattr__(self, "knowledge_base_ids", [])
        if self.document_ids is None:
            object.__setattr__(self, "document_ids", [])


@dataclass(frozen=True)
class ChatContextsResult:
    """Result container for prepare_contexts_for_chat — backend-only.

    Groups the three orthogonal dimensions of context processing:
    - final_message: user message after attachment injection
    - has_table_context / table_contexts: parsed table info for chat_shell
    - kb: all knowledge-base related results (tools, prompts, IDs)

    ``kb`` nests ``KnowledgeBaseToolsResult`` to avoid duplicating its six
    fields here.  Callers access KB fields via ``result.kb.knowledge_base_ids``,
    ``result.kb.kb_meta_prompt``, etc.
    """

    # Processed user message (may be str or OpenAI Responses API vision list).
    final_message: Union[str, list[dict[str, Any]]]
    # Whether any table contexts were found for this subtask.
    has_table_context: bool
    # Parsed table descriptors forwarded to chat_shell for DataTableTool creation.
    table_contexts: list[dict[str, Any]]
    # All knowledge-base related results (tools, prompts, resolved IDs).
    kb: KnowledgeBaseToolsResult
