# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas returned by the external Sites service."""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import (
    AnyHttpUrl,
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

SitePublishStatus = Literal[
    "unpublished",
    "publishing",
    "published",
    "failed",
    "scanning",
]
SiteNetwork = Literal["inner", "outer"]
SiteAppType = Literal["web", "miniapp", "site", "mini_program"]
ApplicationCapability = Literal[
    "create",
    "publish",
    "edit",
    "delete",
    "open_experience",
    "configure_environment",
    "manage_access",
]
EnvironmentVariableType = Literal["plain", "secret"]
SiteAccessRole = Literal["owner", "collaborator"]
SiteAccessAudience = Literal["all", "login", "owner", "custom"]


class SiteResponse(BaseModel):
    """A generated site registered with the Sites service."""

    app_type: Literal["web"] = "web"
    siteid: str
    project_id: str
    taskid: str
    username: str
    owner_username: str
    access_role: SiteAccessRole
    name: str
    slug: str
    custom_domain_prefix: str | None = None
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
    project_id: str
    taskid: str
    username: str
    owner_username: str
    access_role: SiteAccessRole
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
    """A page of typed applications accessible to the authenticated user."""

    items: list[SiteListItem]
    total: int
    offset: int
    limit: int
    next_cursor: str | None = None


class SiteCollaborator(BaseModel):
    """One Project collaborator managed by the owner."""

    subject: str
    added_by: str
    created_at: datetime


class SiteCollaboratorListResponse(BaseModel):
    """All collaborators for one owned Project."""

    items: list[SiteCollaborator]


class SiteCollaboratorAddRequest(BaseModel):
    """Add one collaborator by trusted employee subject."""

    model_config = ConfigDict(extra="forbid")

    subject: str = Field(min_length=1, max_length=255)


class SiteAccessPolicy(BaseModel):
    """Latest immutable inner access policy for one Project."""

    model_config = ConfigDict(extra="forbid")

    id: str
    project_id: str
    target: Literal["inner"]
    audience: SiteAccessAudience
    subjects: list[str]
    revision_number: int = Field(ge=1)
    created_by: str
    created_at: datetime


class SiteAccessPolicyUpdateRequest(BaseModel):
    """Replace a Project's effective inner access policy."""

    model_config = ConfigDict(extra="forbid")

    audience: SiteAccessAudience
    subjects: list[str] = Field(default_factory=list, max_length=1000)

    @field_validator("subjects")
    @classmethod
    def normalize_subjects(cls, subjects: list[str]) -> list[str]:
        normalized = [subject.strip() for subject in subjects]
        if any(not subject or len(subject) > 255 for subject in normalized):
            raise ValueError(
                "subjects must contain non-empty values of at most 255 characters"
            )
        if len(set(normalized)) != len(normalized):
            raise ValueError("subjects must be unique")
        return sorted(normalized)

    @model_validator(mode="after")
    def validate_audience_subjects(self) -> "SiteAccessPolicyUpdateRequest":
        if self.audience == "custom" and not self.subjects:
            raise ValueError("subjects are required for custom access")
        if self.audience != "custom" and self.subjects:
            raise ValueError("subjects are accepted only for custom access")
        return self


class ApplicationCreatePluginResponse(BaseModel):
    """Plugin configuration used to create one application type."""

    plugin_name: str
    marketplace_name: str


class ApplicationTypeResponse(BaseModel):
    """One application type supported by the current Backend."""

    app_type: SiteAppType
    enabled: bool = True
    order: int
    capabilities: list[ApplicationCapability]
    create: ApplicationCreatePluginResponse | None = None


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


class SiteMetadataUpdateRequest(BaseModel):
    """Request to update editable site project metadata."""

    title: str | None = Field(default=None, min_length=1, max_length=255)
    name: str | None = Field(default=None, min_length=1, max_length=255)
    custom_domain_prefix: str | None = Field(default=None, min_length=4, max_length=63)


class PlainEnvironmentVariableMetadata(BaseModel):
    """Readable metadata for one non-secret Project variable."""

    model_config = ConfigDict(extra="forbid")

    key: str
    type: Literal["plain"]
    value: str
    updated_by: str
    updated_at: datetime


class SecretEnvironmentVariableMetadata(BaseModel):
    """Write-only Secret metadata; the value must never cross this boundary."""

    model_config = ConfigDict(extra="forbid")

    key: str
    type: Literal["secret"]
    configured: Literal[True]
    updated_by: str
    updated_at: datetime


EnvironmentVariableMetadata = Annotated[
    PlainEnvironmentVariableMetadata | SecretEnvironmentVariableMetadata,
    Field(discriminator="type"),
]


class EnvironmentSnapshot(BaseModel):
    """Latest saved Project environment configuration."""

    model_config = ConfigDict(extra="forbid")

    revision_id: str | None
    project_id: str
    revision_number: int
    items: list[EnvironmentVariableMetadata]


class EnvironmentRevision(BaseModel):
    """One immutable complete Project environment revision."""

    model_config = ConfigDict(extra="forbid")

    id: str
    project_id: str
    revision_number: int
    variables: list[EnvironmentVariableMetadata]
    created_by: str
    created_at: datetime


class EnvironmentVariablePutRequest(BaseModel):
    """Create or replace one Project environment variable."""

    model_config = ConfigDict(extra="forbid")

    type: EnvironmentVariableType
    value: str
    expected_revision_id: str | None = None


class EnvironmentVariableDeleteRequest(BaseModel):
    """Delete one variable with optional optimistic concurrency."""

    model_config = ConfigDict(extra="forbid")

    expected_revision_id: str | None = None


class EnvironmentVariableUpsertOperation(BaseModel):
    """One upsert in an atomic environment patch."""

    model_config = ConfigDict(extra="forbid")

    op: Literal["upsert"]
    key: str
    type: EnvironmentVariableType
    value: str


class EnvironmentVariableRemoveOperation(BaseModel):
    """One removal in an atomic environment patch."""

    model_config = ConfigDict(extra="forbid")

    op: Literal["remove"]
    key: str


EnvironmentPatchOperation = Annotated[
    EnvironmentVariableUpsertOperation | EnvironmentVariableRemoveOperation,
    Field(discriminator="op"),
]


class EnvironmentVariablesPatchRequest(BaseModel):
    """Atomically apply one or more Project environment operations."""

    model_config = ConfigDict(extra="forbid")

    expected_revision_id: str | None = None
    operations: list[EnvironmentPatchOperation] = Field(min_length=1, max_length=128)
