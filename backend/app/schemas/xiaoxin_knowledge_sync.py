# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for Xiaoxin knowledge-sync notifications."""

from typing import Annotated

from pydantic import BaseModel, Field, StringConstraints

NotificationDomain = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)
]


class XiaoxinKnowledgeSyncNotification(BaseModel):
    """Current Xiaoxin notification envelope; pull_api is compatibility-only."""

    domains: list[NotificationDomain] = Field(min_length=1, max_length=50)
    sync_time: str | None = Field(default=None, max_length=64)
    operator: str | None = Field(default=None, max_length=128)
    pull_api: str | None = Field(default=None, max_length=2048)


class XiaoxinKnowledgeSyncResponse(BaseModel):
    """Accepted and ignored domains for one notification."""

    accepted_domains: list[str]
    ignored_domains: list[str]
    status: str = "accepted"
