# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Summary schemas for document and knowledge base summaries.

Defines Pydantic models for document-level and knowledge-base-level summary data.
"""

from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class DocumentSummaryMetaInfo(BaseModel):
    """Meta information extracted from document."""

    author: Optional[str] = None
    source: Optional[str] = None
    type: Optional[str] = None

    model_config = ConfigDict(extra="allow")


class DocumentSummary(BaseModel):
    """Document summary data structure."""

    short_summary: Optional[str] = Field(
        default=None, description="Short summary (50-100 characters)"
    )
    long_summary: Optional[str] = Field(
        default=None, description="Long summary (up to 500 characters)"
    )
    topics: Optional[List[str]] = Field(
        default=None, description="List of topic tags (3-5 topics)"
    )
    meta_info: Optional[DocumentSummaryMetaInfo] = Field(
        default=None, description="Extracted meta information"
    )
    status: Literal["pending", "generating", "completed", "failed"] = Field(
        default="pending", description="Summary generation status"
    )
    error: Optional[str] = Field(
        default=None, description="Error message if generation failed"
    )
    task_id: Optional[int] = Field(
        default=None, description="Associated background task ID for tracking"
    )
    updated_at: Optional[datetime] = Field(
        default=None, description="Last update timestamp"
    )

    model_config = ConfigDict(extra="allow")


class KnowledgeBaseSummaryMetaInfo(BaseModel):
    """Meta information for knowledge base summary."""

    document_count: Optional[int] = Field(
        default=None, description="Number of documents included in summary"
    )
    last_updated: Optional[datetime] = Field(
        default=None, description="Last update timestamp"
    )

    model_config = ConfigDict(extra="allow")


class KnowledgeBaseSummary(BaseModel):
    """Knowledge base summary data structure."""

    short_summary: Optional[str] = Field(
        default=None, description="Short summary (50-100 characters)"
    )
    long_summary: Optional[str] = Field(
        default=None, description="Long summary (up to 500 characters)"
    )
    topics: Optional[List[str]] = Field(
        default=None, description="List of core topic tags (5 topics)"
    )
    meta_info: Optional[KnowledgeBaseSummaryMetaInfo] = Field(
        default=None, description="Summary meta information"
    )
    status: Literal["pending", "generating", "completed", "failed"] = Field(
        default="pending", description="Summary generation status"
    )
    error: Optional[str] = Field(
        default=None, description="Error message if generation failed"
    )
    task_id: Optional[int] = Field(
        default=None, description="Associated background task ID"
    )
    updated_at: Optional[datetime] = Field(
        default=None, description="Last update timestamp"
    )
    last_summary_doc_count: Optional[int] = Field(
        default=None,
        description="Document count when summary was last generated (for change detection)",
    )

    model_config = ConfigDict(extra="allow")


# API Response schemas


class SummaryRefreshResponse(BaseModel):
    """Response for summary refresh requests."""

    task_id: Optional[int] = Field(
        default=None, description="Background task ID if refresh started"
    )
    message: str = Field(description="Status message")
    status: Literal["generating", "completed", "failed", "skipped"] = Field(
        description="Refresh operation status"
    )


class DocumentSummaryResponse(BaseModel):
    """Response for document summary retrieval."""

    document_id: int = Field(description="Document ID")
    summary: Optional[DocumentSummary] = Field(
        default=None, description="Document summary data"
    )


class KnowledgeBaseSummaryResponse(BaseModel):
    """Response for knowledge base summary retrieval."""

    kb_id: int = Field(description="Knowledge base ID")
    summary: Optional[KnowledgeBaseSummary] = Field(
        default=None, description="Knowledge base summary data"
    )
