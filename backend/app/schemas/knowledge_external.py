# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for external knowledge MCP integrations."""

from datetime import datetime
from enum import Enum
from typing import Dict, List, Optional

from pydantic import BaseModel, Field


class ExternalKnowledgeNodeType(str, Enum):
    """Node type returned by the external knowledge MCP."""

    FOLDER = "folder"
    DOCUMENT = "document"


class ExternalKnowledgeSpace(BaseModel):
    """Knowledge base summary returned by the external knowledge MCP."""

    knowledge_base_id: int
    knowledge_base_name: str
    description: Optional[str] = None
    namespace: str
    owner_user_id: int
    document_count: int = 0
    created_at: datetime
    updated_at: datetime


class ExternalKnowledgeSpaceListResponse(BaseModel):
    """List of knowledge bases visible to the external caller."""

    total: int
    total_returned: int
    has_more: bool = False
    limit: int
    offset: int
    items: List[ExternalKnowledgeSpace]


class ExternalKnowledgeNode(BaseModel):
    """Folder or document node returned by the external knowledge MCP."""

    node_id: str
    raw_id: int
    name: str
    node_type: ExternalKnowledgeNodeType
    parent_id: int = 0
    has_children: bool = False
    children: List["ExternalKnowledgeNode"] = Field(default_factory=list)
    source_type: Optional[str] = None
    index_status: Optional[str] = None
    file_extension: Optional[str] = None
    content_readable: bool = False
    downloadable: bool = False
    previewable: bool = False
    mime_type: Optional[str] = None
    file_size: Optional[int] = None
    created_at: datetime
    updated_at: datetime
    orphan: bool = False


class ExternalKnowledgeNodeListResponse(BaseModel):
    """Directory listing returned by the external knowledge MCP."""

    knowledge_base_id: int
    knowledge_base_name: str
    folder_id: int = 0
    recursive: bool = False
    total_returned: int
    total_available: int
    has_more: bool = False
    items: List[ExternalKnowledgeNode]
    warnings: List[str] = Field(default_factory=list)


class ExternalSearchContentRecord(BaseModel):
    """Single search hit returned by the external knowledge MCP."""

    content: str
    title: str
    score: Optional[float] = None
    knowledge_base_id: Optional[int] = None
    knowledge_base_name: Optional[str] = None
    document_id: Optional[int] = None


class ExternalSearchContentResponse(BaseModel):
    """Search result returned by the external knowledge MCP."""

    query: str
    total: int
    total_estimated_tokens: int
    searched_knowledge_base_ids: List[int] = Field(default_factory=list)
    ignored_knowledge_base_ids: List[int] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)
    records: List[ExternalSearchContentRecord]


class ExternalDocumentContentResponse(BaseModel):
    """Parsed document content returned by the external knowledge MCP."""

    document_id: int
    node_id: str
    knowledge_base_id: int
    name: str
    content: str
    content_format: str = "text"
    content_source: str = "parsed_attachment"
    content_available: bool
    offset: int
    returned_length: int
    total_length: int
    has_more: bool
    index_status: Optional[str] = None


class ExternalDocumentDownloadResponse(BaseModel):
    """Short-lived document file download credential for external MCP callers."""

    document_id: int
    node_id: str
    knowledge_base_id: int
    resource_url: str
    headers: Dict[str, str]
    expiration_seconds: int
    disposition: str
    mime_type: str
    file_name: str
    file_extension: Optional[str] = None
    file_size: Optional[int] = None
    downloadable: bool
    previewable: bool
