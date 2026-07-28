# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas returned by the external Sites service."""

from datetime import datetime
from typing import Literal

from pydantic import AnyHttpUrl, BaseModel, Field

SitePublishStatus = Literal["unpublished", "publishing", "published", "failed"]
SiteNetwork = Literal["inner", "outer"]


class SiteResponse(BaseModel):
    """A generated site registered with the Sites service."""

    siteid: str
    taskid: str
    username: str
    name: str
    slug: str
    internal_url: AnyHttpUrl
    external_url: AnyHttpUrl | None = None
    publish_status: SitePublishStatus
    last_publish_error: str | None = None
    thumbnail_url: AnyHttpUrl | None = None
    created_at: datetime
    updated_at: datetime
    published_at: datetime | None = None


class SiteListResponse(BaseModel):
    """A page of sites owned by the authenticated user."""

    items: list[SiteResponse]
    total: int
    offset: int
    limit: int
    next_cursor: str | None = None


class SiteNetworkUpdateRequest(BaseModel):
    """Request to update one site network scope."""

    network: SiteNetwork


class SiteUpdateRequest(BaseModel):
    """Request to update one site display name."""

    sitename: str | None = Field(default=None, min_length=1, max_length=255)
    name: str | None = Field(default=None, min_length=1, max_length=255)
