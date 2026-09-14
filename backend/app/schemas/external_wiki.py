# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API schemas for external Wiki connections and synchronized imports."""

from typing import Annotated, Optional

from pydantic import BaseModel, Field


class WikiConnectorOption(BaseModel):
    type: str
    display_name: str


class WikiConnectionSummary(BaseModel):
    id: str
    display_name: str
    enabled: bool = False
    connector_type: Optional[str] = None
    site_url: str = ""
    default_locale: Optional[str] = None
    api_key_masked: str = ""
    available_connectors: list[WikiConnectorOption] = Field(default_factory=list)


class WikiConnectionsResponse(BaseModel):
    connections: list[WikiConnectionSummary] = Field(default_factory=list)
    available_connectors: list[WikiConnectorOption] = Field(default_factory=list)


class WikiConnectionUpdateRequest(BaseModel):
    connector_type: str = Field(..., min_length=1)
    site_url: str = Field(..., min_length=1)
    api_key: str = ""
    default_locale: Optional[str] = Field(None, max_length=10)
    enabled: bool = True


class WikiNamedConnectionUpdateRequest(WikiConnectionUpdateRequest):
    display_name: str = Field(..., min_length=1, max_length=100)


class WikiConnectionTestRequest(BaseModel):
    connection_id: Optional[str] = Field(None, min_length=1, max_length=100)
    connector_type: Optional[str] = None
    site_url: Optional[str] = None
    api_key: Optional[str] = None
    default_locale: Optional[str] = Field(None, max_length=10)


class WikiConnectionTestResponse(BaseModel):
    ok: bool
    message: str
    version: Optional[str] = None


class WikiBindingCreateRequest(BaseModel):
    """Import selected Wiki pages as synchronized knowledge documents."""

    paths: list[Annotated[str, Field(min_length=1, max_length=1024)]] = Field(
        ..., min_length=1, max_length=50
    )
    connection_id: Optional[str] = Field(None, max_length=100)
    folder_id: int = Field(0, ge=0)


class WikiBoundDocument(BaseModel):
    """A synchronized Wiki page as it appears in the KB document list."""

    id: int
    name: str
    path: str
    locale: str = ""
    page_updated_at: str = ""
    resource_url: str = ""
    status: str
    connection_id: Optional[str] = None


class WikiBindingCreateResponse(BaseModel):
    documents: list[WikiBoundDocument] = Field(default_factory=list)
    duplicate_documents: list[WikiBoundDocument] = Field(default_factory=list)
    created_count: int = 0
    updated_count: int = 0
    processing_count: int = 0


class WikiPageSummary(BaseModel):
    id: str
    path: str
    title: str
    description: str = ""
    updated_at: str = ""
    tags: list[str] = Field(default_factory=list)
    locale: str = ""
    is_published: bool = True
    page_url: str = ""


class WikiPagesResponse(BaseModel):
    pages: list[WikiPageSummary] = Field(default_factory=list)
    next_offset: Optional[int] = None
    warnings: list[str] = Field(default_factory=list)
