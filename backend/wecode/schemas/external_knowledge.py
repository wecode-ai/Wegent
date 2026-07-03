# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for read-only external knowledge browse APIs."""

from typing import Literal

from pydantic import BaseModel, Field


class ExternalKnowledgeBase(BaseModel):
    """External knowledge base metadata."""

    provider: str
    knowledge_base_id: str
    knowledge_base_name: str
    description: str | None = None
    scope: str
    owner_id: str | None = None
    employee_id: str | None = None
    document_count: int = 0
    created_at: str | None = None
    updated_at: str | None = None


class ExternalKnowledgeBaseListResponse(BaseModel):
    """Paginated external knowledge base list response."""

    provider: str
    total: int = 0
    total_returned: int = 0
    has_more: bool = False
    limit: int
    offset: int
    items: list[ExternalKnowledgeBase] = Field(default_factory=list)


class ExternalPreviewResponse(BaseModel):
    """Authorized preview URL response."""

    url: str
    preview_mode: Literal["iframe", "new_tab"]


class ExternalKbNode(BaseModel):
    """External knowledge base node returned by external browse APIs."""

    node_id: str
    raw_id: str
    name: str
    node_type: Literal["folder", "document"] | str
    parent_id: str | None = None
    has_children: bool = False
    children: list["ExternalKbNode"] = Field(default_factory=list)
    owner_id: str | None = None
    employee_id: str | None = None
    owner_name: str | None = None
    previewable: bool = False
    content_readable: bool = False
    downloadable: bool = False
    mime_type: str | None = None
    source_type: str | None = None
    index_status: str | None = None
    file_extension: str | None = None
    file_size: int | None = None
    browser_open_url: str | None = None
    preview: ExternalPreviewResponse | None = None


class ExternalKbNodesResponse(BaseModel):
    """External knowledge base nodes response."""

    provider: str
    knowledge_base_id: str
    knowledge_base_name: str | None = None
    owner_id: str | None = None
    employee_id: str | None = None
    folder_id: str | None = None
    recursive: bool = False
    total_returned: int = 0
    total_available: int = 0
    has_more: bool = False
    warnings: list[str] = Field(default_factory=list)
    items: list[ExternalKbNode] = Field(default_factory=list)


class ExternalSearchRequest(BaseModel):
    """External knowledge search request body."""

    query: str = Field(..., min_length=1, max_length=2000)
    knowledge_base_ids: list[str] = Field(..., min_length=1, max_length=100)
    max_results: int = Field(default=10, ge=1, le=50)


class ExternalSearchRecord(BaseModel):
    """External search hit without raw preview URLs."""

    content: str
    title: str
    score: float | None = None
    knowledge_base_id: str
    knowledge_base_name: str | None = None
    document_id: str
    owner_id: str | None = None
    employee_id: str | None = None
    source_uri: str


class ExternalSearchResult(BaseModel):
    """External knowledge search response."""

    provider: str
    query: str
    total: int = 0
    records: list[ExternalSearchRecord] = Field(default_factory=list)
    searched_knowledge_base_ids: list[str] = Field(default_factory=list)
    ignored_knowledge_base_ids: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class ExternalKnowledgeHealthResponse(BaseModel):
    """External provider health response."""

    provider: str
    enabled: bool
    configured: bool
    ok: bool
    status: Literal["ok", "unavailable"] = "unavailable"
    message: str | None = None


ExternalKbNode.model_rebuild()
