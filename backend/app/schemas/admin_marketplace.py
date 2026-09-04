# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for administrator marketplace curation."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.resource_library import MarketplaceExampleConversation

AdminMarketplaceResourceType = Literal["agent", "skill"]


class AdminMarketplaceResource(BaseModel):
    """One Agent or Skill visible in the marketplace."""

    id: int
    resource_type: AdminMarketplaceResourceType
    name: str
    display_name: str
    description: str | None = None
    publisher_user_name: str | None = None
    is_system: bool
    recommendation_score: int = Field(ge=0, le=100)
    example_conversations: list[MarketplaceExampleConversation] = Field(
        default_factory=list
    )


class AdminMarketplaceResourceList(BaseModel):
    """Paginated marketplace management response."""

    items: list[AdminMarketplaceResource]
    total: int
    page: int
    limit: int


class AdminMarketplaceResourceUpdate(BaseModel):
    """Editable marketplace curation fields."""

    recommendation_score: int | None = Field(default=None, ge=0, le=100)
    example_conversations: list[MarketplaceExampleConversation] | None = Field(
        default=None,
        max_length=10,
    )


class AdminMarketplacePlugin(BaseModel):
    """One official or enterprise plugin available for marketplace curation."""

    id: int
    catalog_namespace: Literal["wework-official", "enterprise"]
    name: str
    display_name: str
    description: str = ""
    version: str | None = None
    author: str | None = None
    featured_rank: int = Field(ge=0, le=100)
    is_listed: bool
    created_at: datetime
    updated_at: datetime


class AdminMarketplacePluginList(BaseModel):
    """Paginated official and enterprise plugin marketplace response."""

    items: list[AdminMarketplacePlugin]
    total: int
    page: int
    limit: int


class AdminMarketplacePluginUpdate(BaseModel):
    """Editable plugin marketplace presentation and listing fields."""

    description: str | None = Field(default=None, max_length=500)
    featured_rank: int | None = Field(default=None, ge=0, le=100)
    is_listed: bool | None = None


class AdminMarketplaceSmartApp(BaseModel):
    """One public Smart app available for marketplace curation."""

    id: int
    name: str
    display_name: str
    summary: str = ""
    description_md: str = ""
    tags: list[str] = Field(default_factory=list)
    icon_url: str = ""
    publisher_user_name: str | None = None
    is_system: bool
    featured_rank: int
    is_listed: bool
    needs_metadata: bool


class AdminMarketplaceSmartAppList(BaseModel):
    """Paginated public Smart app marketplace response."""

    items: list[AdminMarketplaceSmartApp]
    total: int
    page: int
    limit: int


class AdminMarketplaceSmartAppUpdate(BaseModel):
    """Editable Smart app marketplace curation fields."""

    featured_rank: int | None = Field(default=None, ge=0, le=100)
    is_listed: bool | None = None


class AdminMarketplaceSmartAppMetadataUpdate(BaseModel):
    """Editable marketplace presentation for an official Smart app."""

    summary: str = Field(min_length=1, max_length=500)
    description_md: str = Field(min_length=1, max_length=8192)
    tags: list[str] = Field(min_length=1, max_length=3)
