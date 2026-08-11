# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for the internal IP-to-user lookup API."""

from typing import List, Literal, Optional

from pydantic import BaseModel, Field

IpUserSource = Literal["cloud_device", "k8s_pod"]


class IpUserMatch(BaseModel):
    """One resource that associates an IP address with a user."""

    source: IpUserSource
    user_id: Optional[int] = None
    user_name: str
    resource_name: str
    resource_namespace: Optional[str] = None
    status: Optional[str] = None
    task_id: Optional[str] = None


class IpLookupError(BaseModel):
    """One unavailable lookup source."""

    source: IpUserSource
    message: str


class IpUserLookupResponse(BaseModel):
    """Users and resources associated with an IP address."""

    ip: str
    user_names: List[str] = Field(default_factory=list)
    matches: List[IpUserMatch] = Field(default_factory=list)
    lookup_errors: List[IpLookupError] = Field(default_factory=list)
