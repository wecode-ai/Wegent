# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas exchanged with the external Sites project API."""

from datetime import datetime
from typing import Literal

from pydantic import AnyHttpUrl, BaseModel, Field, field_validator

SiteNetwork = Literal["inner", "outer"]


class SiteResponse(BaseModel):
    """A project returned by the Sites service."""

    id: str
    network: SiteNetwork
    title: str
    url: AnyHttpUrl
    snapshot: AnyHttpUrl
    created_at: datetime


class SiteListResponse(BaseModel):
    """A cursor page of projects owned by the authenticated user."""

    items: list[SiteResponse]
    next_cursor: str | None = None


class SiteDeleteResponse(BaseModel):
    """Result returned after deleting a Sites project."""

    deleted: bool


class SiteRenameRequest(BaseModel):
    """Validated project title for a rename request."""

    title: str = Field(min_length=1, max_length=255)

    @field_validator("title", mode="before")
    @classmethod
    def strip_title(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        title = value.strip()
        if not title:
            raise ValueError("title must not be blank")
        return title
