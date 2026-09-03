# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from app.schemas.device import DeviceCapabilitySyncResponse

PluginInstallState = Literal[
    "not_installed",
    "installed",
    "update_available",
    "unavailable",
    "failed",
    "uninstalled",
]


class PluginSkillComponent(BaseModel):
    """Skill metadata discovered inside a plugin."""

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


class PluginLocalAuthArtifactDefinition(BaseModel):
    """Immutable platform artifact used by a managed local auth tool."""

    url: str
    sha256: str
    archive: Literal["tar_gz", "zip"]
    binaryPath: str


class PluginLocalAuthToolDefinition(BaseModel):
    """Bundled or host-managed CLI used by local connector authentication."""

    id: str
    source: Literal["bundled", "managed"]
    version: Optional[str] = None
    artifacts: Dict[str, PluginLocalAuthArtifactDefinition] = Field(
        default_factory=dict
    )


class PluginLocalAuthDefinition(BaseModel):
    """Device-side authentication commands for a plugin connector."""

    kind: Literal["local_qr", "browser_oauth"] = "local_qr"
    health: List[str] = Field(default_factory=list)
    start: List[str] = Field(default_factory=list)
    poll: List[str] = Field(default_factory=list)
    logout: List[str] = Field(default_factory=list)
    tool: Optional[PluginLocalAuthToolDefinition] = None
    qrField: str = "qr_path"
    statusField: str = "status"
    okValues: List[str] = Field(default_factory=lambda: ["ok"])
    pollIntervalSeconds: int = 2
    timeoutSeconds: int = 45
    logoutOnUninstall: bool = True


class PluginConnectorComponent(BaseModel):
    """Cloud or device connector required by a plugin."""

    slug: str
    authPolicy: Literal["on_install", "on_use", "optional"] = "optional"
    localAuth: Optional[PluginLocalAuthDefinition] = Field(
        default=None,
        exclude_if=lambda value: value is None,
    )


class WorkbenchFrontendModule(BaseModel):
    """Same-realm frontend entry exported by a Wework plugin package."""

    entry: str
    export: str = "default"
    sha256: str


class WorkbenchDesktopSidecar(BaseModel):
    """Desktop JSON-RPC sidecar declared by a Wework plugin package."""

    command: str
    args: List[str] = Field(default_factory=list)
    sha256: str
    capabilities: List[str] = Field(default_factory=list)


class WorkbenchPluginComponent(BaseModel):
    """Optional Wework workbench runtime contribution."""

    apiVersion: Literal["1"] = "1"
    required: bool = False
    pinnedToClientVersion: bool = False
    clientVersion: Optional[str] = None
    frontend: Optional[WorkbenchFrontendModule] = None
    desktop: Optional[WorkbenchDesktopSidecar] = None


class InstalledPluginComponents(BaseModel):
    """Cross-runtime plugin component inventory."""

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
    workbench: Optional[WorkbenchPluginComponent] = None


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
    """Source identity for a user-installed plugin."""

    type: Literal["upload", "marketplace", "local"] = "upload"
    providerKey: str = "codex-local"
    pluginKey: str
    catalogItemId: Optional[str] = None
    marketplace: Optional[str] = None


class InstalledPluginPackageRef(BaseModel):
    """Stored package reference for an installed plugin."""

    storageKey: str
    checksum: str
    sizeBytes: int


class InstalledPluginSpec(BaseModel):
    """User-scoped plugin installation state."""

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
    updatePolicy: Literal["manual", "auto"] = "manual"
    sourceProvider: Literal["wegent", "codex", "user"] = "wegent"
    sourceLabel: str = "Wegent 官方"
    visibility: Literal["personal", "workspace", "public"] = "workspace"


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
    """Response for listing user-installed plugins."""

    items: List[InstalledPlugin]


class InstalledPluginUpdateRequest(BaseModel):
    """Request to update installed plugin runtime state."""

    enabled: Optional[bool] = None
    componentStates: Optional[Dict[str, bool]] = None
    displayName: Optional[str] = None
    description: Optional[str] = None
    releaseId: Optional[int] = None
    updatePolicy: Optional[Literal["manual", "auto"]] = None


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


class PluginMarketplaceItem(BaseModel):
    """Plugin entry exposed by the Wegent cloud marketplace."""

    id: int
    catalogNamespace: str = "enterprise"
    originPersonalPluginId: Optional[int] = None
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
    ownerDisplayName: str = ""
    accessRole: Literal["catalog", "owner", "recipient"] = "catalog"
    allowCopy: bool = False
    grantUserCount: int = 0
    grantNamespaceCount: int = 0
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


class BuiltinPluginInstallRequest(BaseModel):
    """Optional target device that must acknowledge the built-in plugin."""

    device_id: Optional[str] = Field(default=None, min_length=1)


class PluginMarketplaceInstallResponse(BaseModel):
    """Response for installing a marketplace plugin."""

    plugin: InstalledPlugin
    sync: Optional[DeviceCapabilitySyncResponse] = None


class PluginDeviceSyncResponse(BaseModel):
    """Result of syncing account-installed plugins onto one device."""

    deviceId: str
    pendingCount: int = 0
    sync: DeviceCapabilitySyncResponse


class PluginDeviceReportItem(BaseModel):
    """One package version observed on the reporting device."""

    installedPluginId: int = Field(gt=0)
    releaseId: int = Field(gt=0)
    version: str = Field(min_length=1)


class PluginDeviceReportRequest(BaseModel):
    """Local packages already present on a device; do not push installs."""

    plugins: List[PluginDeviceReportItem] = Field(default_factory=list)


class PluginDeviceReportResponse(BaseModel):
    """Result of acknowledging local plugin presence on one device."""

    deviceId: str
    acknowledgedCount: int = 0
    acknowledgedInstalledPluginIds: List[int] = Field(default_factory=list)


class PluginAutoUpdateItem(BaseModel):
    """One account installation advanced to a newer marketplace release."""

    installedPluginId: int
    pluginId: int
    fromReleaseId: int
    toReleaseId: int
    version: str


class PluginAutoUpdateBatchResponse(BaseModel):
    """One bounded batch of automatic marketplace plugin updates."""

    updated: List[PluginAutoUpdateItem] = Field(default_factory=list)
    updatedCount: int = 0
    remainingCount: int = 0


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
    purpose: Literal["marketplace_publish", "restricted_share"] = "restricted_share"
    # Legacy submissions are retained only for personal ACL sharing. Enterprise
    # publication uses the independent publication-request workflow.
    visibility: Optional[Literal["personal", "workspace", "public"]] = None
    targets: List["PluginAccessTarget"] = Field(default_factory=list)
    allowCopy: bool = False

    @model_validator(mode="after")
    def resolve_purpose_from_visibility(self) -> "PluginSubmissionInitRequest":
        if self.visibility is None:
            return self
        if self.visibility == "personal":
            self.purpose = "restricted_share"
            return self
        self.purpose = "marketplace_publish"
        if self.targets:
            raise ValueError("targets are only allowed when visibility is personal")
        if self.allowCopy:
            raise ValueError("allowCopy is only allowed when visibility is personal")
        return self


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
    purpose: Literal["marketplace_publish", "restricted_share"] = "marketplace_publish"
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
    plugin: Optional[PluginMarketplaceItem] = None


class PluginAccessTarget(BaseModel):
    entityType: Literal["user", "namespace"]
    entityId: str = Field(..., min_length=1, max_length=100)
    displayName: str = ""


class PluginAccessUpdateRequest(BaseModel):
    scope: Literal["private", "restricted"]
    targets: List[PluginAccessTarget] = Field(default_factory=list)
    allowCopy: bool = False


class PluginAccessResponse(BaseModel):
    pluginId: int
    scope: Literal["private", "restricted"]
    targets: List[PluginAccessTarget] = Field(default_factory=list)
    allowCopy: bool = False
    revocationPendingCount: int = 0


class PluginDeleteImpactResponse(BaseModel):
    pluginId: int
    affectedUserCount: int = 0
    installedDeviceCount: int = 0
    sharedTargetCount: int = 0
    impactRevision: str


class PluginDeleteRequest(BaseModel):
    impactRevision: str = Field(..., min_length=1)
    revokeAndDelete: bool = False


class PluginDeleteResponse(BaseModel):
    pendingDeviceCount: int = 0


class PluginCopyResponse(BaseModel):
    sourcePluginId: int
    sourceReleaseId: int
    sourcePluginName: str
    sourceDisplayName: str
    version: str
    sha256: str
    downloadUrl: str
    expiresAt: datetime


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
    syncPolicy: Literal["auto_after_scan", "review_required"] = "auto_after_scan"


class PluginUpstreamUpdateRequest(BaseModel):
    syncPolicy: Literal["auto_after_scan", "review_required"]


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
