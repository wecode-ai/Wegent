# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for synchronizing user Git credentials to managed devices."""

from typing import Literal, Optional

from pydantic import BaseModel, Field

GitProvider = Literal["github", "gitlab", "gitee", "gitea", "gerrit"]


class GitAccountSyncSummaryItem(BaseModel):
    """Non-sensitive Git account metadata safe for desktop clients."""

    id: Optional[str] = None
    domain: str
    provider: GitProvider
    login: Optional[str] = None
    email: Optional[str] = None
    effective: bool = True
    duplicate_of: Optional[str] = None


class GitAccountSyncSummary(BaseModel):
    """Current Git accounts and their effective per-domain priority."""

    accounts: list[GitAccountSyncSummaryItem] = Field(default_factory=list)
    effective_count: int = 0
    duplicate_count: int = 0


class DeviceGitAccountSyncRequest(BaseModel):
    """Options for reconciling one device with the user's Git accounts."""

    allow_empty: bool = False


class GitCliSyncResult(BaseModel):
    """Result of configuring a provider CLI on the selected device."""

    provider: Literal["gh", "glab"]
    domain: str
    status: Literal["configured", "not_installed", "failed"]
    reason_code: Optional[str] = None


class DeviceGitAccountSyncResponse(BaseModel):
    """Sanitized result of a device Git credential reconciliation."""

    device_id: str
    status: Literal["synced", "synced_with_warnings"]
    synced_domains: list[str] = Field(default_factory=list)
    removed_domains: list[str] = Field(default_factory=list)
    duplicate_domains: list[str] = Field(default_factory=list)
    identity_warning_domains: list[str] = Field(default_factory=list)
    cli: list[GitCliSyncResult] = Field(default_factory=list)
    warning_codes: list[str] = Field(default_factory=list)
