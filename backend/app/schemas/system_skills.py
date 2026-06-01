# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

InstallState = Literal[
    "not_installed",
    "installed",
    "update_available",
    "unavailable",
    "failed",
]

ProviderErrorCode = Literal[
    "token_required",
    "unauthorized",
    "timeout",
    "connect_error",
    "provider_error",
    "mapping_error",
]


class SystemSkillProviderInfo(BaseModel):
    """Provider metadata exposed to the system skill catalog API."""

    key: str
    name: str
    description: str
    requiresToken: bool = False
    hasToken: bool = False
    priority: int = 100


class SystemSkillProviderListResponse(BaseModel):
    """Response for listing system skill providers."""

    providers: List[SystemSkillProviderInfo]


class SystemSkillCatalogItem(BaseModel):
    """Provider-normalized system skill catalog item."""

    id: str
    providerKey: str
    providerName: str
    name: str
    displayName: str
    description: str
    iconUrl: Optional[str] = None
    tags: List[str] = Field(default_factory=list)
    version: Optional[str] = None
    author: Optional[str] = None
    category: str = "system"
    capabilities: List[str] = Field(default_factory=list)
    detailUrl: Optional[str] = None
    installState: InstallState = "not_installed"
    installedSkillId: Optional[int] = None
    enabled: bool = False
    requiresPermission: bool = False
    permissionUrl: Optional[str] = None
    updatedAt: Optional[datetime] = None

    @field_validator("version", mode="before")
    @classmethod
    def validate_version(cls, value: Any) -> Optional[str]:
        if value is None:
            return None
        return str(value)


class SystemSkillProviderError(BaseModel):
    """Provider-level error returned alongside partial catalog results."""

    providerKey: str
    code: ProviderErrorCode
    message: str


class SystemSkillListResponse(BaseModel):
    """Response for listing or searching system skills."""

    total: int
    page: int
    pageSize: int
    items: List[SystemSkillCatalogItem]
    providerErrors: List[SystemSkillProviderError] = Field(default_factory=list)


class SystemSkillInstallRequest(BaseModel):
    """Request to install a catalog skill for the current user."""

    providerKey: str
    skillKey: str
    catalogItemId: Optional[str] = None
    displayName: str
    description: str = ""
    version: Optional[str] = None
    author: Optional[str] = None
    tags: List[str] = Field(default_factory=list)


class SystemSkillUpdateInstalledRequest(BaseModel):
    """Request to update installed skill runtime state."""

    enabled: bool


class InstalledSkillSource(BaseModel):
    """Source identity for a user-installed skill."""

    type: Literal["system", "personal", "git", "market"] = "system"
    providerKey: Optional[str] = None
    skillKey: str
    catalogItemId: Optional[str] = None


class InstalledSkillRef(BaseModel):
    """Reference to the executable Skill definition, when available."""

    kind: str = "Skill"
    name: str
    namespace: str = "default"
    user_id: Optional[int] = None


class InstalledSkillSpec(BaseModel):
    """User-scoped install and enablement state for a skill."""

    source: InstalledSkillSource
    skillRef: Optional[InstalledSkillRef] = None
    displayName: str
    description: str
    version: Optional[str] = None
    installState: InstallState = "installed"
    enabled: bool = True
    sourcePayload: Optional[Dict[str, Any]] = None

    @field_validator("version", mode="before")
    @classmethod
    def validate_version(cls, value: Any) -> Optional[str]:
        if value is None:
            return None
        return str(value)


class InstalledSkillStatus(BaseModel):
    """Runtime status for an InstalledSkill CRD."""

    state: str = "Available"


class InstalledSkill(BaseModel):
    """InstalledSkill CRD stored in the existing kinds table."""

    model_config = ConfigDict(populate_by_name=True)

    apiVersion: str = "agent.wecode.io/v1"
    kind: Literal["InstalledSkill"] = "InstalledSkill"
    metadata: Dict[str, Any]
    spec: InstalledSkillSpec
    status: InstalledSkillStatus = Field(default_factory=InstalledSkillStatus)


class InstalledSkillListResponse(BaseModel):
    """Response for listing user-installed skills."""

    items: List[InstalledSkill]
