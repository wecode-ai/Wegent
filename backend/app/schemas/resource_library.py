# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

ResourceLibraryResourceType = Literal["agent", "skill", "mcp"]
ResourceLibraryListingStatus = Literal["published", "archived"]
ResourceLibraryInstallStatus = Literal["installed", "removed", "failed"]


class ResourceLibraryListingCreate(BaseModel):
    resource_type: ResourceLibraryResourceType
    source_id: int = Field(..., ge=1)
    name: str = Field(..., min_length=1, max_length=100)
    display_name: Optional[str] = Field(None, max_length=200)
    description: Optional[str] = None
    icon: Optional[str] = Field(None, max_length=100)
    tags: List[str] = Field(default_factory=list)
    version: str = Field(..., min_length=1, max_length=50)
    manifest_options: Dict[str, Any] = Field(default_factory=dict)


class ResourceLibraryVersionCreate(BaseModel):
    source_id: int = Field(..., ge=1)
    version: str = Field(..., min_length=1, max_length=50)
    manifest_options: Dict[str, Any] = Field(default_factory=dict)


class ResourceLibraryInstallCreate(BaseModel):
    version_id: Optional[int] = None
    target_namespace: Optional[str] = Field(default="default", max_length=100)
    install_options: Dict[str, Any] = Field(default_factory=dict)


class ResourceLibraryVersionResponse(BaseModel):
    id: int
    listing_id: int
    version: str
    manifest: Dict[str, Any]
    is_current: bool
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ResourceLibraryListingResponse(BaseModel):
    id: int
    resource_type: ResourceLibraryResourceType
    name: str
    display_name: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    tags: List[str]
    publisher_user_id: int
    status: ResourceLibraryListingStatus
    current_version_id: Optional[int] = None
    install_count: int
    is_installed: bool = False
    current_version: Optional[ResourceLibraryVersionResponse] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ResourceLibraryInstallResponse(BaseModel):
    id: int
    listing_id: int
    version_id: int
    user_id: int
    resource_type: ResourceLibraryResourceType
    installed_kind_id: Optional[int] = None
    installed_reference: Dict[str, Any]
    install_status: ResourceLibraryInstallStatus
    error_message: Optional[str] = None
    listing: Optional[ResourceLibraryListingResponse] = None
    requires_configuration: bool = False
    installed_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ResourceLibraryListResponse(BaseModel):
    total: int
    items: List[ResourceLibraryListingResponse]


class ResourceLibraryInstallListResponse(BaseModel):
    total: int
    items: List[ResourceLibraryInstallResponse]


__all__ = [
    "ResourceLibraryInstallCreate",
    "ResourceLibraryInstallListResponse",
    "ResourceLibraryInstallResponse",
    "ResourceLibraryInstallStatus",
    "ResourceLibraryListResponse",
    "ResourceLibraryListingCreate",
    "ResourceLibraryListingResponse",
    "ResourceLibraryListingStatus",
    "ResourceLibraryResourceType",
    "ResourceLibraryVersionCreate",
    "ResourceLibraryVersionResponse",
]
