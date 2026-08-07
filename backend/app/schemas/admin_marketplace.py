# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for administrator marketplace curation."""

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
