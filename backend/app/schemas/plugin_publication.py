# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API contracts for enterprise plugin publication."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

PluginPublicationStage = Literal[
    "submit_request",
    "automated_checks",
    "administrator_review",
    "code_review",
    "release",
]
PluginPublicationStatus = Literal[
    "uploading",
    "submitted",
    "automatic_checking",
    "automatic_check_failed",
    "awaiting_admin",
    "admin_review",
    "changes_requested",
    "admin_accepted",
    "materializing",
    "draft_mr_open",
    "ci_running",
    "code_changes_requested",
    "merge_ready",
    "merged",
    "publishing",
    "published",
    "publish_failed",
    "withdrawn",
    "closed",
]
PluginPublicationRiskLevel = Literal["none", "low", "medium", "high", "critical"]
PluginPublicationCheckSeverity = Literal["info", "warning", "blocker"]
PluginPublicationCheckStatus = Literal[
    "pending",
    "running",
    "passed",
    "warning",
    "blocked",
    "failed",
    "not_run",
]


class PluginPublicationRiskDeclaration(BaseModel):
    """Submitter declaration captured with the immutable revision."""

    externalNetworkAccess: bool = False
    externalDomains: list[str] = Field(default_factory=list, max_length=100)
    executesCommands: bool = False
    commandExamples: list[str] = Field(default_factory=list, max_length=100)
    readsOrWritesLocalFiles: bool = False
    usesCredentials: bool = False
    applicationPermissions: list[str] = Field(default_factory=list, max_length=100)
    additionalNotes: str = Field(default="", max_length=2000)

    @field_validator("externalDomains", "commandExamples", "applicationPermissions")
    @classmethod
    def normalize_string_lists(cls, values: list[str]) -> list[str]:
        normalized: list[str] = []
        seen: set[str] = set()
        for value in values:
            cleaned = value.strip()
            if cleaned and cleaned not in seen:
                seen.add(cleaned)
                normalized.append(cleaned[:500])
        return normalized


class PluginPublicationSnapshotRequest(BaseModel):
    requestedVersion: str = Field(min_length=1, max_length=50)
    filename: str = Field(default="plugin.zip", min_length=1, max_length=255)
    snapshotSha256: str = Field(min_length=64, max_length=64)
    sizeBytes: int = Field(gt=0, le=50 * 1024 * 1024)
    sourceReleaseId: int | None = Field(default=None, gt=0)
    releaseNotes: str = Field(min_length=1, max_length=2000)
    testNotes: str = Field(min_length=1, max_length=1000)
    sourceUpdatedAt: datetime | None = None
    riskDeclaration: PluginPublicationRiskDeclaration = Field(
        default_factory=PluginPublicationRiskDeclaration
    )

    @field_validator("snapshotSha256")
    @classmethod
    def validate_sha256(cls, value: str) -> str:
        normalized = value.lower()
        if any(character not in "0123456789abcdef" for character in normalized):
            raise ValueError("snapshotSha256 must be hexadecimal")
        return normalized

    @field_validator("releaseNotes", "testNotes")
    @classmethod
    def validate_required_notes(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("value must not be blank")
        return normalized


class PluginPublicationCreateRequest(PluginPublicationSnapshotRequest):
    sourcePluginId: int | None = Field(default=None, gt=0)
    slug: str | None = Field(default=None, min_length=1, max_length=100)
    displayName: str | None = Field(default=None, max_length=200)
    listingType: Literal["plugin", "skill"] = "plugin"

    @model_validator(mode="after")
    def require_source_or_slug(self) -> "PluginPublicationCreateRequest":
        if self.sourcePluginId is None and not (self.slug or "").strip():
            raise ValueError("sourcePluginId or slug is required")
        return self


class PluginPublicationRevisionCreateRequest(PluginPublicationSnapshotRequest):
    pass


class PluginPublicationSubmitter(BaseModel):
    id: int
    userName: str
    email: str | None = None


class PluginPublicationDeclaration(BaseModel):
    key: str
    label: str
    declared: bool
    detected: bool | None = None
    confirmed: bool | None = None
    details: list[str] = Field(default_factory=list)


class PluginPublicationRevisionItem(BaseModel):
    id: int
    number: int
    requestedVersion: str
    snapshotSha256: str
    sourceTreeSha256: str | None = None
    status: PluginPublicationStatus
    releaseNotes: str | None = None
    testNotes: str | None = None
    sourceUpdatedAt: datetime | None = None
    createdAt: datetime
    declarations: list[PluginPublicationDeclaration] = Field(default_factory=list)
    manifest: dict[str, Any] = Field(default_factory=dict)
    packageEntries: list[str] = Field(default_factory=list)
    packageEntryCount: int = 0
    packageEntriesTruncated: bool = False
    capabilities: list[str] = Field(default_factory=list)


class PluginPublicationUploadResponse(BaseModel):
    requestId: int
    sourcePluginId: int
    revision: PluginPublicationRevisionItem
    uploadUrl: str
    expiresAt: datetime


class PluginPublicationRequestSummary(BaseModel):
    id: int
    pluginId: int
    pluginName: str
    pluginSlug: str
    requestedVersion: str
    submitter: PluginPublicationSubmitter
    currentRevision: int
    stage: PluginPublicationStage
    status: PluginPublicationStatus
    riskLevel: PluginPublicationRiskLevel
    blockerCount: int
    warningCount: int
    gitlabStatus: str | None = None
    waitingDurationSeconds: int
    submittedAt: datetime
    updatedAt: datetime


class PluginPublicationRequestListResponse(BaseModel):
    items: list[PluginPublicationRequestSummary]
    total: int
    page: int
    limit: int


class PluginPublicationCheckItem(BaseModel):
    id: int
    checkCode: str
    title: str
    severity: PluginPublicationCheckSeverity
    status: PluginPublicationCheckStatus
    summary: str | None = None
    evidence: list[str] = Field(default_factory=list)
    jobUrl: str | None = None
    acknowledgementRequired: bool
    acknowledged: bool


class PluginPublicationFailureDetail(BaseModel):
    jobName: str
    stage: str | None = None
    status: str
    reason: str | None = None
    jobUrl: str | None = None


class PluginPublicationEventItem(BaseModel):
    id: int
    eventType: str
    actorType: Literal[
        "user", "admin", "gitlab", "pipeline", "release_service", "system"
    ]
    actorName: str | None = None
    message: str
    requiredChanges: list[str] = Field(default_factory=list)
    failureDetails: list[PluginPublicationFailureDetail] = Field(default_factory=list)
    createdAt: datetime


class PluginPublicationGitLabState(BaseModel):
    projectUrl: str | None = None
    sourceBranch: str | None = None
    mergeRequestIid: int | None = None
    mergeRequestUrl: str | None = None
    mergeRequestStatus: str | None = None
    pipelineId: int | None = None
    pipelineUrl: str | None = None
    pipelineStatus: str | None = None
    commitSha: str | None = None


class PluginPublicationActionEligibility(BaseModel):
    canWithdraw: bool = False
    canCreateRevision: bool = False
    canViewEnterprisePlugin: bool = False
    canReturn: bool = False
    canAccept: bool = False
    canReconcile: bool = False
    blockedReasons: list[str] = Field(default_factory=list)


class PluginPublicationRequestDetail(PluginPublicationRequestSummary):
    enterprisePluginId: int | None = None
    revision: PluginPublicationRevisionItem
    revisions: list[PluginPublicationRevisionItem] = Field(default_factory=list)
    checks: list[PluginPublicationCheckItem] = Field(default_factory=list)
    events: list[PluginPublicationEventItem] = Field(default_factory=list)
    gitlab: PluginPublicationGitLabState | None = None
    actionEligibility: PluginPublicationActionEligibility


class ReturnPluginPublicationRequest(BaseModel):
    currentRevision: int = Field(gt=0)
    reason: str = Field(min_length=1, max_length=2000)
    requiredChanges: list[str] = Field(min_length=1, max_length=100)

    @field_validator("requiredChanges")
    @classmethod
    def validate_required_changes(cls, values: list[str]) -> list[str]:
        normalized = [value.strip()[:500] for value in values if value.strip()]
        if not normalized:
            raise ValueError("requiredChanges must contain at least one item")
        return normalized


class AcceptPluginPublicationRequest(BaseModel):
    currentRevision: int = Field(gt=0)
    acknowledgedWarningCodes: list[str] = Field(default_factory=list, max_length=100)


class ReconcilePluginPublicationRequest(BaseModel):
    currentRevision: int = Field(gt=0)


class PluginReleasePublishResponse(BaseModel):
    pluginId: int
    releaseId: int
    created: bool
    catalogNamespace: Literal["enterprise"] = "enterprise"
    slug: str
    version: str
    sha256: str


class PluginGitLabWebhookResponse(BaseModel):
    accepted: bool = True
    requestId: int | None = None
    status: str | None = None


class PluginReleaseSourceMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")

    projectPath: str = Field(min_length=1, max_length=500)


class PluginReleaseProvenance(BaseModel):
    model_config = ConfigDict(extra="forbid")

    projectId: str = Field(min_length=1, max_length=100)
    ref: str = Field(min_length=1, max_length=255)
    sourceCommitSha: str = Field(min_length=40, max_length=64)
    pipelineId: int = Field(gt=0)
    pipelineUrl: str = Field(min_length=1, max_length=500)
    metadata: PluginReleaseSourceMetadata

    @field_validator("sourceCommitSha")
    @classmethod
    def validate_source_commit_sha(cls, value: str) -> str:
        normalized = value.lower()
        if any(character not in "0123456789abcdef" for character in normalized):
            raise ValueError("sourceCommitSha must be hexadecimal")
        return normalized


class PluginReleaseIdentity(BaseModel):
    model_config = ConfigDict(extra="forbid")

    slug: str = Field(min_length=1, max_length=100)
    version: str = Field(min_length=1, max_length=50)
    listingType: Literal["plugin", "skill"] = "plugin"


class PluginReleaseArtifact(BaseModel):
    model_config = ConfigDict(extra="forbid")

    file: str = Field(min_length=1, max_length=255)
    sha256: str = Field(min_length=64, max_length=64)
    sizeBytes: int = Field(gt=0, le=50 * 1024 * 1024)

    @field_validator("sha256")
    @classmethod
    def validate_sha256(cls, value: str) -> str:
        normalized = value.lower()
        if any(character not in "0123456789abcdef" for character in normalized):
            raise ValueError("artifact sha256 must be hexadecimal")
        return normalized


class PluginReleaseMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal[1]
    changed: Literal[True]
    plugin: PluginReleaseIdentity
    artifact: PluginReleaseArtifact
    source: PluginReleaseProvenance
    requestId: int | None = Field(default=None, gt=0)
    revision: int | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def require_complete_publication_identity(self) -> "PluginReleaseMetadata":
        if (self.requestId is None) != (self.revision is None):
            raise ValueError("requestId and revision must be provided together")
        return self
