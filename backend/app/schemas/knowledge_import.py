# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Schemas for external knowledge import endpoints.
"""

from typing import Optional

from pydantic import BaseModel, Field

from app.schemas.knowledge import KnowledgeDocumentResponse
from app.schemas.rag import SplitterConfig
from app.schemas.subtask_context import TruncationInfo


class ExternalKnowledgeImportRequest(BaseModel):
    """Request payload for importing external text into a knowledge base."""

    title: Optional[str] = Field(
        default=None, max_length=255, description="Title for the imported document"
    )
    content: str = Field(
        ..., min_length=1, description="Document content in plain text"
    )
    source: Optional[str] = Field(
        default=None, max_length=100, description="Source system name (e.g., weibo)"
    )
    source_url: Optional[str] = Field(
        default=None,
        max_length=2048,
        description="Original URL for the imported content",
    )
    external_id: Optional[str] = Field(
        default=None,
        max_length=255,
        description="External system identifier for the content",
    )
    author: Optional[str] = Field(
        default=None,
        max_length=255,
        description="Author or creator of the content",
    )
    tags: Optional[list[str]] = Field(
        default=None, description="Optional tags for the document"
    )
    metadata: Optional[dict] = Field(
        default=None, description="Additional metadata for the source"
    )
    splitter_config: Optional[SplitterConfig] = Field(
        default=None, description="Optional splitter configuration for indexing"
    )


class ExternalKnowledgeImportResponse(BaseModel):
    """Response for external knowledge import."""

    knowledge_base_id: int
    attachment_id: int
    index_scheduled: bool
    truncation_info: Optional[TruncationInfo] = None
    document: KnowledgeDocumentResponse
