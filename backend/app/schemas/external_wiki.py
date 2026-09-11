# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API schemas for the external wiki feature (bridge + KB mounting)."""

from typing import Annotated, Optional

from pydantic import BaseModel, Field


class WikiConnectorOption(BaseModel):
    type: str
    display_name: str


class WikiConnectionResponse(BaseModel):
    enabled: bool = False
    connector_type: Optional[str] = None
    site_url: str = ""
    default_locale: Optional[str] = None
    api_key_masked: str = ""
    available_connectors: list[WikiConnectorOption] = Field(default_factory=list)


class WikiConnectionSummary(BaseModel):
    id: str
    display_name: str
    enabled: bool = False
    connector_type: Optional[str] = None
    site_url: str = ""
    default_locale: Optional[str] = None
    api_key_masked: str = ""
    legacy: bool = False
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
    connection_id: Optional[str] = Field(None, max_length=100)
    connector_type: Optional[str] = None
    site_url: Optional[str] = None
    api_key: Optional[str] = None
    default_locale: Optional[str] = Field(None, max_length=10)


class WikiConnectionTestResponse(BaseModel):
    ok: bool
    message: str
    version: Optional[str] = None


class WikiBindingCreateRequest(BaseModel):
    """Multi-select page binding: documents only (no site/folder scopes)."""

    paths: list[Annotated[str, Field(min_length=1, max_length=1024)]] = Field(
        ..., min_length=1, max_length=50
    )
    connection_id: Optional[str] = Field(None, max_length=100)
    sync: bool = False
    folder_id: int = Field(0, ge=0)


class WikiBoundDocument(BaseModel):
    """A live-bound wiki page as it appears in the KB document list."""

    id: int
    name: str
    path: str
    locale: str = ""
    page_updated_at: str = ""
    resource_url: str = ""
    bound_by: Optional[str] = None
    bound_at: Optional[str] = None
    status: str = "live"
    connection_id: Optional[str] = None
    sync: bool = False


class WikiBindingCreateResponse(BaseModel):
    documents: list[WikiBoundDocument] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


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


class WikiOutlineItem(BaseModel):
    level: int
    title: str


class WikiPageDetail(BaseModel):
    id: str
    path: str
    title: str
    locale: str = ""
    updated_at: str = ""
    tags: list[str] = Field(default_factory=list)
    is_published: bool = True
    page_url: str = ""
    content: str
    content_total_chars: int
    truncated: bool
    outline: list[WikiOutlineItem] = Field(default_factory=list)
