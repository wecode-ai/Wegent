# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared result models.

This module contains small, reusable dataclasses that are shared across
backend and chat_shell packages.

All comments must be written in English.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Union


class KnowledgeBaseToolAccessMode:
    """Constants for knowledge base tool exposure modes."""

    FULL = "full"
    RESTRICTED_SEARCH_ONLY = "restricted_search_only"


class KnowledgeScopeType:
    """Canonical selection scope types shared by all knowledge providers."""

    KNOWLEDGE_BASE = "knowledge_base"
    FOLDER = "folder"
    DOCUMENT = "document"


@dataclass(frozen=True)
class SelectedKnowledgeResource:
    """One selected folder or document inside a knowledge base."""

    scope_type: str
    resource_id: str | None = None
    resource_name: str | None = None
    resource_path: str | None = None
    resource_url: str | None = None


@dataclass(frozen=True)
class SelectedKnowledgeRef:
    """One provider knowledge base and its selected runtime resources."""

    provider: str
    knowledge_base_id: str
    knowledge_base_name: str
    resources: tuple[SelectedKnowledgeResource, ...] = field(default_factory=tuple)
    routing_summary: str | None = None
    routing_topics: tuple[str, ...] = field(default_factory=tuple)
    retrieval_capabilities: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class SelectedKnowledgeContext:
    """Effective provider-native knowledge routing for one request."""

    refs: tuple[SelectedKnowledgeRef, ...] = field(default_factory=tuple)
    evidence_required: bool = False


@dataclass(frozen=True)
class KnowledgeBaseScope:
    """Per-knowledge-base access scope for knowledge tools."""

    knowledge_base_id: int
    scope_restricted: bool = False
    document_ids: list[int] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.document_ids is None:
            object.__setattr__(self, "document_ids", [])


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
    knowledge_base_scopes: list[KnowledgeBaseScope] = None  # type: ignore[assignment]
    kb_tool_access_mode: str = KnowledgeBaseToolAccessMode.FULL

    def __post_init__(self) -> None:
        # Use object.__setattr__ because the dataclass is frozen.
        if self.knowledge_base_ids is None:
            object.__setattr__(self, "knowledge_base_ids", [])
        if self.document_ids is None:
            object.__setattr__(self, "document_ids", [])
        if self.knowledge_base_scopes is None:
            object.__setattr__(self, "knowledge_base_scopes", [])


@dataclass(frozen=True)
class ChatContextsResult:
    """Result container for prepare_contexts_for_chat — backend-only.

    Groups the two orthogonal dimensions of context processing:
    - final_message: user message after attachment injection
    - kb: all knowledge-base related results (tools, prompts, IDs)

    ``kb`` nests ``KnowledgeBaseToolsResult`` to avoid duplicating its six
    fields here.  Callers access KB fields via ``result.kb.knowledge_base_ids``,
    ``result.kb.kb_meta_prompt``, etc.
    """

    # Processed user message (may be str or OpenAI Responses API vision list).
    final_message: Union[str, list[dict[str, Any]]]
    # All knowledge-base related results (tools, prompts, resolved IDs).
    kb: KnowledgeBaseToolsResult
