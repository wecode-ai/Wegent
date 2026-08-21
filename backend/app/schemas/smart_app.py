# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API contracts for the Smart app cloud catalog."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


class SmartAppAccessTarget(BaseModel):
    entityType: Literal["user", "namespace"]
    entityId: str = Field(min_length=1, max_length=100)
    displayName: str = ""


class SmartAppAccessUpdateRequest(BaseModel):
    scope: Literal["private", "restricted"]
    targets: list[SmartAppAccessTarget] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_targets(self) -> "SmartAppAccessUpdateRequest":
        if self.scope == "restricted" and not self.targets:
            raise ValueError("Restricted sharing requires at least one target")
        return self


class SmartAppAccessResponse(BaseModel):
    smartAppId: int
    scope: Literal["private", "restricted"]
    targets: list[SmartAppAccessTarget] = Field(default_factory=list)


class SmartAppReleaseItem(BaseModel):
    id: int
    version: str
    releaseNotes: str = ""
    sizeBytes: int
    sha256: str
    scanStatus: Literal["passed", "failed"] = "passed"
    extensions: dict[str, Any] = Field(default_factory=dict)
    publishedAt: datetime


class SmartAppMarketplaceItem(BaseModel):
    id: int
    name: str
    displayName: str
    summary: str = ""
    descriptionMd: str = ""
    sourceType: Literal["official", "user"]
    ownerUserId: int
    ownerDisplayName: str = ""
    accessRole: Literal["official", "owner", "recipient"]
    tags: list[str] = Field(default_factory=list)
    iconUrl: str = ""
    screenshotUrls: list[str] = Field(default_factory=list)
    featured: bool = False
    latestReleaseId: int
    version: str
    releaseNotes: str = ""
    sizeBytes: int
    requirements: dict[str, Any] = Field(default_factory=dict)
    extensions: dict[str, Any] = Field(default_factory=dict)
    releaseExtensions: dict[str, Any] = Field(default_factory=dict)
    scanStatus: Literal["passed", "failed"] = "passed"
    updatedAt: datetime
    publishedAt: datetime


class SmartAppMarketplaceListResponse(BaseModel):
    items: list[SmartAppMarketplaceItem]


class SmartAppOwnedListResponse(BaseModel):
    items: list[SmartAppMarketplaceItem]


class SmartAppDownloadDescriptor(BaseModel):
    smartAppId: int
    releaseId: int
    version: str
    filename: str
    downloadUrl: str
    sha256: str
    sizeBytes: int
    expiresAt: datetime


class SmartAppSubmissionInitRequest(BaseModel):
    smartAppId: int | None = None
    name: str = Field(min_length=1, max_length=100)
    displayName: str = Field(min_length=1, max_length=200)
    version: str = Field(min_length=1, max_length=50)
    filename: str = Field(min_length=1, max_length=255)
    sha256: str = Field(min_length=64, max_length=64)
    sizeBytes: int = Field(gt=0, le=50 * 1024 * 1024)
    summary: str = Field(min_length=1, max_length=500)
    descriptionMd: str = Field(default="", max_length=8192)
    tags: list[str] = Field(min_length=1, max_length=3)
    iconDataUrl: str = Field(min_length=1)
    screenshotDataUrls: list[str] = Field(default_factory=list, max_length=5)
    releaseNotes: str = Field(default="", max_length=4096)
    extensions: dict[str, Any] = Field(default_factory=dict)
    releaseExtensions: dict[str, Any] = Field(default_factory=dict)
    targets: list[SmartAppAccessTarget] = Field(default_factory=list)


class SmartAppSubmissionInitResponse(BaseModel):
    submissionId: int
    smartAppId: int
    uploadUrl: str
    expiresAt: datetime


class SmartAppSubmissionItem(BaseModel):
    id: int
    smartAppId: int
    version: str
    status: Literal["uploading", "scanning", "published", "rejected", "cancelled"]
    error: str = ""
    createdAt: datetime


class SmartAppSubmissionCompleteResponse(BaseModel):
    submission: SmartAppSubmissionItem
    item: SmartAppMarketplaceItem | None = None
