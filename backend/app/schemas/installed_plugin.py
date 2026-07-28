# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator

PluginInstallState = Literal[
    "not_installed",
    "installed",
    "update_available",
    "unavailable",
    "failed",
    "uninstalled",
]


class PluginSkillComponent(BaseModel):
    """Skill metadata discovered inside a Claude Code plugin."""

    name: str
    description: str = ""
    path: str


class PluginPathComponent(BaseModel):
    """Path-based plugin component such as command, agent, hook, or binary."""

    name: str
    path: str


class PluginMCPComponent(BaseModel):
    """MCP server entry discovered from a plugin .mcp.json file."""

    name: str
    server: Dict[str, Any] = Field(default_factory=dict)


class PluginConnectorComponent(BaseModel):
    """Cloud connector required by a plugin."""

    slug: str
    authPolicy: Literal["on_install", "optional"] = "optional"


class InstalledPluginComponents(BaseModel):
    """Claude Code plugin component inventory."""

    skills: List[PluginSkillComponent] = Field(default_factory=list)
    commands: List[PluginPathComponent] = Field(default_factory=list)
    agents: List[PluginPathComponent] = Field(default_factory=list)
    hooks: List[PluginPathComponent] = Field(default_factory=list)
    mcps: List[PluginMCPComponent] = Field(default_factory=list)
    connectors: List[PluginConnectorComponent] = Field(default_factory=list)
    lsps: List[PluginPathComponent] = Field(default_factory=list)
    monitors: List[PluginPathComponent] = Field(default_factory=list)
    bins: List[PluginPathComponent] = Field(default_factory=list)
    settings: Optional[Dict[str, Any]] = None


class PluginInterface(BaseModel):
    """Codex plugin UI-facing metadata from manifest.interface."""

    displayName: Optional[str] = None
    shortDescription: Optional[str] = None
    longDescription: Optional[str] = None
    developerName: Optional[str] = None
    category: Optional[str] = None
    capabilities: List[str] = Field(default_factory=list)
    websiteUrl: Optional[str] = None
    privacyPolicyUrl: Optional[str] = None
    termsOfServiceUrl: Optional[str] = None
    defaultPrompt: Optional[List[str]] = None
    brandColor: Optional[str] = None
    composerIcon: Optional[str] = None
    logo: Optional[str] = None
    logoDark: Optional[str] = None
    screenshots: List[str] = Field(default_factory=list)


class InstalledPluginSource(BaseModel):
    """Source identity for a user-installed Claude Code plugin."""

    type: Literal["upload", "marketplace", "local"] = "upload"
    providerKey: str = "claude-code"
    pluginKey: str
    catalogItemId: Optional[str] = None
    marketplace: Optional[str] = None


class InstalledPluginPackageRef(BaseModel):
    """Stored package reference for an installed plugin."""

    storageKey: str
    checksum: str
    sizeBytes: int


class InstalledPluginSpec(BaseModel):
    """User-scoped Claude Code plugin installation state."""

    source: InstalledPluginSource
    displayName: str
    description: str = ""
    version: Optional[str] = None
    author: Optional[str] = None
    installState: PluginInstallState = "installed"
    enabled: bool = True
    componentStates: Dict[str, bool] = Field(default_factory=dict)
    manifest: Dict[str, Any] = Field(default_factory=dict)
    components: InstalledPluginComponents = Field(
        default_factory=InstalledPluginComponents
    )
    interface: Optional[PluginInterface] = None
    packageRef: Optional[InstalledPluginPackageRef] = None
    sourcePayload: Optional[Dict[str, Any]] = None
    origin: Literal["created", "market"] = "market"
    pluginId: Optional[int] = None
    releaseId: Optional[int] = None
    desiredVersion: Optional[str] = None
    updatePolicy: Literal["manual"] = "manual"
    sourceProvider: Literal["wegent", "codex", "user"] = "wegent"
    sourceLabel: str = "Wegent 官方"


class InstalledPluginStatus(BaseModel):
    """Runtime status for an InstalledPlugin CRD."""

    state: str = "Available"
    devices: List["PluginDeviceInstallationItem"] = Field(default_factory=list)


class PluginDeviceInstallationItem(BaseModel):
    """Materialized installation state for one device."""

    deviceId: str
    desiredReleaseId: int
    actualReleaseId: Optional[int] = None
    state: Literal[
        "pending",
        "downloading",
        "installing",
        "installed",
        "failed",
        "uninstalling",
    ]
    errorCode: Optional[str] = None
    errorMessage: Optional[str] = None
    attemptCount: int = 0
    lastSyncAt: Optional[datetime] = None
    updatedAt: datetime


class InstalledPlugin(BaseModel):
    """InstalledPlugin CRD stored in the existing kinds table."""

    apiVersion: str = "agent.wecode.io/v1"
    kind: Literal["InstalledPlugin"] = "InstalledPlugin"
    metadata: Dict[str, Any]
    spec: InstalledPluginSpec
    status: InstalledPluginStatus = Field(default_factory=InstalledPluginStatus)


class InstalledPluginListResponse(BaseModel):
    """Response for listing user-installed Claude Code plugins."""

    items: List[InstalledPlugin]


class InstalledPluginUpdateRequest(BaseModel):
    """Request to update installed plugin runtime state."""

    enabled: Optional[bool] = None
    componentStates: Optional[Dict[str, bool]] = None
    displayName: Optional[str] = None
    description: Optional[str] = None
    releaseId: Optional[int] = None


class PluginUploadInfo(BaseModel):
    """Normalized plugin metadata parsed from an uploaded package."""

    name: str
    displayName: str
    description: str = ""
    version: Optional[str] = None
    author: Optional[str] = None
    manifest: Dict[str, Any] = Field(default_factory=dict)
    components: InstalledPluginComponents
    interface: Optional[PluginInterface] = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("name is required")
        return cleaned[:100]


class PluginMarketplacePublishRequest(BaseModel):
    """Metadata for publishing an uploaded plugin package to Wegent marketplace."""

    visibility: Literal["personal", "workspace", "public"] = "workspace"
    featured: bool = False


class PluginMarketplacePublishResponse(BaseModel):
    """Response after publishing a plugin package to the marketplace."""

    item: "PluginMarketplaceItem"


class PluginMarketplaceItem(BaseModel):
    """Plugin entry exposed by the Wegent cloud marketplace."""

    id: int
    remotePluginId: str
    name: str
    displayName: str
    description: str = ""
    version: Optional[str] = None
    author: Optional[str] = None
    visibility: Literal["personal", "workspace", "public"] = "workspace"
    featured: bool = False
    installed: bool = False
    installedPluginId: Optional[int] = None
    enabled: bool = False
    sourceType: Literal["marketplace"] = "marketplace"
    interface: Optional[PluginInterface] = None
    components: InstalledPluginComponents = Field(
        default_factory=InstalledPluginComponents
    )
    manifest: Dict[str, Any] = Field(default_factory=dict)
    ownerUserId: int
    latestReleaseId: Optional[int] = None
    listingType: Literal["plugin", "skill"] = "plugin"
    origin: Literal["market"] = "market"
    sourceProvider: Literal["wegent", "codex", "user"] = "wegent"
    sourceLabel: str = "Wegent 官方"
    updateAvailable: bool = False
    currentDeviceInstallation: Optional["PluginDeviceInstallationItem"] = None


class PluginMarketplaceListResponse(BaseModel):
    """Response for listing marketplace plugins."""

    items: List[PluginMarketplaceItem]


class PluginMarketplaceInstallResponse(BaseModel):
    """Response for installing a marketplace plugin."""

    plugin: InstalledPlugin


class PluginMarketplaceCapabilities(BaseModel):
    """User-specific marketplace operations enabled by server policy."""

    canPublish: bool = False


class PluginReleaseItem(BaseModel):
    """Published immutable release exposed by the marketplace API."""

    id: int
    pluginId: int
    version: str
    releaseNotes: str = ""
    checksum: str
    sizeBytes: int
    publishedAt: Optional[datetime] = None


class PluginReleaseListResponse(BaseModel):
    items: List[PluginReleaseItem]


class PluginSubmissionInitRequest(BaseModel):
    slug: str
    displayName: str
    version: str
    filename: str
    sha256: str = Field(min_length=64, max_length=64)
    sizeBytes: int = Field(gt=0, le=50 * 1024 * 1024)
    listingType: Literal["plugin", "skill"] = "plugin"


class PluginSubmissionInitResponse(BaseModel):
    submissionId: int
    pluginId: int
    releaseId: int
    uploadUrl: str
    expiresAt: datetime


class PluginSubmissionItem(BaseModel):
    id: int
    pluginId: int
    releaseId: int
    status: Literal[
        "uploading",
        "scanning",
        "pending",
        "approved",
        "rejected",
        "cancelled",
    ]
    reviewNote: str = ""
    submittedAt: datetime
    reviewedAt: Optional[datetime] = None


class PluginSubmissionCompleteResponse(BaseModel):
    submission: PluginSubmissionItem


class PluginSubmissionListResponse(BaseModel):
    items: List[PluginSubmissionItem]


class PluginSubmissionReviewRequest(BaseModel):
    approved: bool
    note: str = Field(default="", max_length=5000)


class PluginVisibilityGrantRequest(BaseModel):
    entityType: Literal["user", "namespace"]
    entityId: str = Field(..., min_length=1, max_length=100)


class PluginUpstreamCreateRequest(BaseModel):
    slug: str
    displayName: str
    marketplaceName: str
    remotePluginId: str
    upstreamUrl: str
    licenseInfo: str = ""
    listingType: Literal["plugin", "skill"] = "plugin"


class PluginUpstreamItem(BaseModel):
    id: int
    pluginId: int
    provider: str
    marketplaceName: str
    remotePluginId: str
    upstreamUrl: str
    licenseInfo: str
    syncEnabled: bool
    syncPolicy: Literal["auto_after_scan", "review_required"]
    lastSeenVersion: Optional[str] = None
    lastCheckedAt: Optional[datetime] = None
    lastSyncedAt: Optional[datetime] = None
    lastError: Optional[str] = None


class PluginUpstreamListResponse(BaseModel):
    items: List[PluginUpstreamItem]


PluginMarketplacePublishResponse.model_rebuild()
