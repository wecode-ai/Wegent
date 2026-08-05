# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas returned by the external Sites service."""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import AnyHttpUrl, BaseModel, Field

SitePublishStatus = Literal[
    "unpublished",
    "publishing",
    "published",
    "failed",
    "scanning",
]
SiteNetwork = Literal["inner", "outer"]
SiteAppType = Literal["web", "miniapp", "site", "mini_program"]
ApplicationCapability = Literal["create", "publish", "delete", "open_experience"]


class SiteResponse(BaseModel):
    """A generated site registered with the Sites service."""

    app_type: Literal["web"] = "web"
    siteid: str
    taskid: str
    username: str
    name: str
    slug: str
    network: SiteNetwork
    internal_url: AnyHttpUrl
    external_url: AnyHttpUrl | None = None
    publish_status: SitePublishStatus
    last_publish_error: str | None = None
    thumbnail_url: AnyHttpUrl | None = None
    created_at: datetime
    updated_at: datetime
    published_at: datetime | None = None


class MiniProgramResponse(BaseModel):
    """A mini program registered with the Sites service."""

    app_type: Literal["miniapp"] = "miniapp"
    siteid: str
    taskid: str
    username: str
    name: str
    slug: str
    app_id: str | None = None
    status: str
    version: str | None = None
    experience_url: AnyHttpUrl | None = None
    thumbnail_url: AnyHttpUrl | None = None
    created_at: datetime
    updated_at: datetime


SiteListItem = Annotated[
    SiteResponse | MiniProgramResponse,
    Field(discriminator="app_type"),
]


class SiteListResponse(BaseModel):
    """A page of typed applications owned by the authenticated user."""

    items: list[SiteListItem]
    total: int
    offset: int
    limit: int
    next_cursor: str | None = None


class ApplicationTypeResponse(BaseModel):
    """One application type supported by the current Backend."""

    app_type: SiteAppType
    enabled: bool = True
    order: int
    capabilities: list[ApplicationCapability]


class ApplicationTypeListResponse(BaseModel):
    """Application types and capabilities exposed to clients."""

    items: list[ApplicationTypeResponse]


class SiteNetworkUpdateRequest(BaseModel):
    """Request to update one site network scope."""

    network: SiteNetwork


class SiteUpdateRequest(BaseModel):
    """Request to update one site display name."""

    sitename: str | None = Field(default=None, min_length=1, max_length=255)
    name: str | None = Field(default=None, min_length=1, max_length=255)
