# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for system-configured marketplace tags."""

from pydantic import BaseModel, Field, field_validator


class MarketplaceTagItem(BaseModel):
    """One stable marketplace classification tag."""

    id: str = Field(min_length=1, max_length=50, pattern=r"^[a-z0-9_]+$")
    name_zh: str = Field(min_length=1, max_length=100)
    name_en: str = Field(min_length=1, max_length=100)
    sort: int = Field(ge=0, le=1_000_000)
    enabled: bool = True

    @field_validator("id", "name_zh", "name_en", mode="before")
    @classmethod
    def strip_text(cls, value: object) -> object:
        """Reject whitespace-only values and persist normalized text."""
        return value.strip() if isinstance(value, str) else value


class MarketplaceTagsUpdate(BaseModel):
    """Replace the marketplace tag catalog."""

    expected_version: int = Field(ge=0)
    items: list[MarketplaceTagItem] = Field(max_length=30)


class MarketplaceTagsResponse(BaseModel):
    """Versioned marketplace tag catalog."""

    version: int
    items: list[MarketplaceTagItem]
