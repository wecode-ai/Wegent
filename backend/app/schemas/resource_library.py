# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for the capability center resource library."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

ResourceLibraryResourceType = Literal["agent", "skill", "model", "shell", "retriever"]
ResourceLibraryListingStatus = Literal["published", "archived"]


class ResourceLibraryVersion(BaseModel):
    """Current published version projected from a source Kind."""

    id: int
    listing_id: int
    version: str
    changelog: str | None = None
    package_url: str | None = None
    created_at: datetime
    updated_at: datetime | None = None


class ResourceLibraryListing(BaseModel):
    """A public Team or Skill normalized for marketplace display."""

    id: int
    resource_type: ResourceLibraryResourceType
    name: str
    display_name: str
    description: str | None = None
    icon: str | None = None
    tags: list[str] = Field(default_factory=list)
    publisher_user_id: int
    publisher_user_name: str | None = None
    publisher_namespace: str = "default"
    status: ResourceLibraryListingStatus
    current_version_id: int
    current_version: ResourceLibraryVersion
    install_count: int = 0
    is_installed: bool = False
    bind_modes: list[str] = Field(default_factory=list)
    allow_personal_install: bool = True
    allow_group_install: bool = True
    target_groups: list[str] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class ResourceLibraryListingList(BaseModel):
    """Paginated marketplace listing response."""

    items: list[ResourceLibraryListing]
    total: int
    page: int
    limit: int


class ResourceLibraryDiscoveryList(BaseModel):
    """Cursor-paginated marketplace discovery response."""

    items: list[ResourceLibraryListing]
    has_more: bool
    next_cursor: str | None = None
    limit: int


class ResourceLibraryCreateListingRequest(BaseModel):
    """Set the sharing scope for an existing capability Kind."""

    resource_type: ResourceLibraryResourceType
    source_id: int | None = None
    source_name: str | None = Field(default=None, min_length=1, max_length=100)
    source_namespace: str = Field(default="default", min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=100)
    display_name: str = Field(min_length=1, max_length=100)
    description: str | None = None
    icon: str | None = None
    tags: list[str] = Field(default_factory=list, max_length=20)
    version: str = Field(default="1.0.0", min_length=1, max_length=50)
    status: ResourceLibraryListingStatus = "published"
    target_groups: list[str] = Field(default_factory=list, max_length=100)
    allow_personal_install: bool | None = None
    allow_group_install: bool | None = None
    manifest_options: dict[str, Any] = Field(default_factory=dict)


class ResourceLibraryPublicationUpdateRequest(BaseModel):
    """Editable publication metadata and installation rules."""

    display_name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = None
    icon: str | None = None
    tags: list[str] | None = Field(default=None, max_length=20)
    version: str | None = Field(default=None, min_length=1, max_length=50)
    status: ResourceLibraryListingStatus | None = None
    allow_personal_install: bool | None = None
    allow_group_install: bool | None = None
    target_groups: list[str] | None = Field(default=None, max_length=100)


class ResourceLibraryInstallRequest(BaseModel):
    """Install a public capability into a personal or group namespace."""

    target_namespace: str = Field(default="default", min_length=1, max_length=100)
    version_id: int | None = None
    install_options: dict[str, Any] = Field(default_factory=dict)


class ResourceLibraryAgentBindingsUpdateRequest(BaseModel):
    """Replace the extra group bindings for an Agent."""

    group_names: list[str] = Field(default_factory=list, max_length=100)


class ResourceLibraryAgentBindings(BaseModel):
    """Effective personal and group scopes referencing one canonical Agent."""

    agent_id: int
    personal: bool = False
    group_names: list[str] = Field(default_factory=list)


class ResourceLibraryInstall(BaseModel):
    """Normalized installed or group-owned capability state."""

    id: int
    listing_id: int
    version_id: int
    user_id: int
    resource_type: ResourceLibraryResourceType
    listing: ResourceLibraryListing | None = None
    installed_kind_id: int | None = None
    installed_reference: dict[str, Any] = Field(default_factory=dict)
    install_status: Literal["installed", "removed", "failed"] = "installed"
    error_message: str | None = None
    installed_at: datetime
    updated_at: datetime


class ResourceLibraryInstallList(BaseModel):
    """Paginated current-user installation response."""

    items: list[ResourceLibraryInstall]
    total: int
    page: int
    limit: int


class ResourceLibraryReferenceConsumer(BaseModel):
    """Resource that currently depends on an installed capability reference."""

    id: int
    name: str
    namespace: str


class ResourceLibraryReferenceUsage(BaseModel):
    """Consumers that prevent a capability reference from being unbound."""

    referenced_bots: list[ResourceLibraryReferenceConsumer] = Field(
        default_factory=list
    )
    referenced_knowledge_bases: list[ResourceLibraryReferenceConsumer] = Field(
        default_factory=list
    )
