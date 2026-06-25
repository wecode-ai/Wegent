# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Schemas for runtime-native local work surfaced through Wework."""

from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

RuntimeName = Literal["codex", "claude_code"]
LocalTaskStatus = Literal["active", "archived"]
RuntimeWorkspaceKind = Literal["workspace", "worktree", "chat"]
RuntimeWorkspaceSource = Literal["local", "remote"]


class RuntimeTaskAddress(BaseModel):
    """Transient address for a device-local runtime task."""

    model_config = ConfigDict(populate_by_name=True)

    device_id: str = Field(..., alias="deviceId", min_length=1)
    workspace_path: Optional[str] = Field(default=None, alias="workspacePath")
    local_task_id: str = Field(..., alias="localTaskId", min_length=1)


class RuntimeTranscriptRequest(RuntimeTaskAddress):
    """Request a page of a device-local runtime transcript."""

    limit: Optional[int] = Field(default=None, ge=1, le=200)
    before_cursor: Optional[str] = Field(default=None, alias="beforeCursor")


class RuntimeMessageSource(BaseModel):
    """Optional source overlay for runtime transcript messages."""

    source: Literal["im"]
    external_id: str
    channel_type: str
    channel_id: int
    conversation_id: str
    sender_id: str
    message_id: Optional[str] = None


class NormalizedRuntimeMessage(BaseModel):
    """Normalized message rendered by Wework for native runtime transcripts."""

    model_config = ConfigDict(populate_by_name=True)

    id: str
    role: Literal["user", "assistant", "system", "tool"]
    content: str = ""
    subtask_id: Optional[int] = Field(default=None, alias="subtaskId")
    status: Optional[str] = None
    created_at: Optional[str] = Field(default=None, alias="createdAt")
    source: Optional[RuntimeMessageSource] = None
    attachments: list[dict[str, Any]] = Field(default_factory=list)
    blocks: list[dict[str, Any]] = Field(default_factory=list)


class RuntimeTaskAddressRef(RuntimeTaskAddress):
    """Parent/child task reference with the same transient address shape."""


class LocalTaskSummary(BaseModel):
    """Executor-local task metadata returned from an online device."""

    model_config = ConfigDict(populate_by_name=True)

    local_task_id: str = Field(..., alias="localTaskId")
    workspace_path: str = Field(..., alias="workspacePath")
    workspace_kind: RuntimeWorkspaceKind = Field(
        default="workspace",
        alias="workspaceKind",
    )
    worktree_id: Optional[str] = Field(default=None, alias="worktreeId")
    title: str
    runtime: RuntimeName
    runtime_handle: Optional[dict[str, Any]] = Field(
        default=None,
        alias="runtimeHandle",
        exclude=True,
    )
    git_info: Optional[dict[str, Any]] = Field(default=None, alias="gitInfo")
    parent: Optional[RuntimeTaskAddressRef] = None
    children: list[RuntimeTaskAddressRef] = Field(default_factory=list)
    created_at: Optional[str] = Field(default=None, alias="createdAt")
    updated_at: Optional[str] = Field(default=None, alias="updatedAt")
    running: bool = False
    status: Optional[LocalTaskStatus] = None


class DeviceWorkspaceUpsert(BaseModel):
    """Create or update a central device workspace mapping."""

    model_config = ConfigDict(populate_by_name=True)

    project_id: int = Field(..., alias="projectId", ge=1)
    device_id: str = Field(..., alias="deviceId", min_length=1)
    workspace_path: str = Field(..., alias="workspacePath", min_length=1)
    repo_url: Optional[str] = Field(default=None, alias="repoUrl")
    repo_root_fingerprint: Optional[str] = Field(
        default=None,
        alias="repoRootFingerprint",
    )
    label: Optional[str] = None


class DeviceWorkspacePrepareRequest(BaseModel):
    """Prepare one device folder and store it as a project child workspace."""

    model_config = ConfigDict(populate_by_name=True)

    project_id: int = Field(..., alias="projectId", ge=1)
    device_id: str = Field(..., alias="deviceId", min_length=1)
    workspace_path: str = Field(..., alias="workspacePath", min_length=1)
    action: Literal["create", "select"]
    label: Optional[str] = None


class DeviceWorkspaceResponse(BaseModel):
    """Kind-backed DeviceWorkspace mapping response."""

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: int
    user_id: int = Field(..., alias="userId")
    project_id: int = Field(..., alias="projectId")
    device_id: str = Field(..., alias="deviceId")
    workspace_path: str = Field(..., alias="workspacePath")
    repo_url: Optional[str] = Field(default=None, alias="repoUrl")
    repo_root_fingerprint: Optional[str] = Field(
        default=None,
        alias="repoRootFingerprint",
    )
    label: Optional[str] = None
    created_at: datetime = Field(..., alias="createdAt")
    updated_at: datetime = Field(..., alias="updatedAt")
    last_seen_at: Optional[datetime] = Field(default=None, alias="lastSeenAt")


class DeviceWorkspacePrepareResponse(BaseModel):
    """Prepared device workspace mapping plus the device-side action result."""

    model_config = ConfigDict(populate_by_name=True)

    mapping: DeviceWorkspaceResponse
    prepared_action: Literal["created", "selected", "cloned", "reused_git"] = Field(
        ...,
        alias="preparedAction",
    )


class RuntimeProjectRef(BaseModel):
    """Runtime workspace identity used by runtime work lists."""

    id: Optional[int] = None
    key: str
    name: str
    description: str = ""
    color: Optional[str] = None


class RuntimeDeviceWorkspace(BaseModel):
    """Device workspace with online LocalTasks attached."""

    model_config = ConfigDict(populate_by_name=True)

    id: Optional[int] = None
    project_id: Optional[int] = Field(default=None, alias="projectId")
    device_id: str = Field(..., alias="deviceId")
    device_name: str = Field(..., alias="deviceName")
    device_status: str = Field(..., alias="deviceStatus")
    workspace_path: str = Field(..., alias="workspacePath")
    workspace_kind: RuntimeWorkspaceKind = Field(
        default="workspace",
        alias="workspaceKind",
    )
    worktree_id: Optional[str] = Field(default=None, alias="worktreeId")
    repo_url: Optional[str] = Field(default=None, alias="repoUrl")
    repo_root_fingerprint: Optional[str] = Field(
        default=None,
        alias="repoRootFingerprint",
    )
    label: Optional[str] = None
    workspace_source: Optional[RuntimeWorkspaceSource] = Field(
        default=None,
        alias="workspaceSource",
    )
    remote_host_id: Optional[str] = Field(default=None, alias="remoteHostId")
    mapped: bool
    available: bool
    error: Optional[str] = None
    local_tasks: list[LocalTaskSummary] = Field(
        default_factory=list,
        alias="localTasks",
    )


class RuntimeProjectWork(BaseModel):
    """Runtime work grouped under one central Project."""

    model_config = ConfigDict(populate_by_name=True)

    project: RuntimeProjectRef
    device_workspaces: list[RuntimeDeviceWorkspace] = Field(
        default_factory=list,
        alias="deviceWorkspaces",
    )


class RuntimeWorkListResponse(BaseModel):
    """Project -> Device Workspace -> LocalTask workbench tree."""

    model_config = ConfigDict(populate_by_name=True)

    projects: list[RuntimeProjectWork] = Field(default_factory=list)
    chats: list[RuntimeDeviceWorkspace] = Field(
        default_factory=list,
        alias="chats",
    )
    total_local_tasks: int = Field(..., alias="totalLocalTasks")


class ArchivedConversationsListRequest(BaseModel):
    """Filter archived conversations stored on the user's devices."""

    model_config = ConfigDict(populate_by_name=True)

    device_id: Optional[str] = Field(default=None, alias="deviceId")
    workspace_path: Optional[str] = Field(default=None, alias="workspacePath")
    project_id: Optional[int] = Field(default=None, alias="projectId", ge=1)
    runtime_project_key: Optional[str] = Field(
        default=None,
        alias="runtimeProjectKey",
    )
    search: Optional[str] = None
    source: Literal["all", "local", "cloud"] = "all"
    sort: Literal["updated", "created", "alphabetical"] = "updated"


class ArchivedConversationItem(BaseModel):
    """Archived conversation metadata normalized by Backend."""

    model_config = ConfigDict(populate_by_name=True)

    id: str
    local_task_id: str = Field(..., alias="localTaskId")
    title: str
    project_id: Optional[int] = Field(default=None, alias="projectId")
    project_key: Optional[str] = Field(default=None, alias="projectKey")
    project_name: Optional[str] = Field(default=None, alias="projectName")
    workspace_path: str = Field(..., alias="workspacePath")
    workspace_kind: RuntimeWorkspaceKind = Field(
        default="workspace",
        alias="workspaceKind",
    )
    device_id: str = Field(..., alias="deviceId")
    device_name: Optional[str] = Field(default=None, alias="deviceName")
    device_address: Optional[str] = Field(default=None, alias="deviceAddress")
    source: Literal["local", "cloud"] = "local"
    runtime: Optional[RuntimeName] = None
    created_at: Optional[str] = Field(default=None, alias="createdAt")
    updated_at: Optional[str] = Field(default=None, alias="updatedAt")


class ArchivedConversationProjectGroup(BaseModel):
    """Archived conversation counts grouped by project/workspace."""

    model_config = ConfigDict(populate_by_name=True)

    project_id: Optional[int] = Field(default=None, alias="projectId")
    project_key: Optional[str] = Field(default=None, alias="projectKey")
    project_name: str = Field(..., alias="projectName")
    count: int


class ArchivedConversationsListResponse(BaseModel):
    """Archived conversations plus project-group counts."""

    model_config = ConfigDict(populate_by_name=True)

    items: list[ArchivedConversationItem] = Field(default_factory=list)
    project_groups: list[ArchivedConversationProjectGroup] = Field(
        default_factory=list,
        alias="projectGroups",
    )
    total: int


class RuntimeArchiveProjectConversationsRequest(BaseModel):
    """Archive all active conversations under one runtime project."""

    model_config = ConfigDict(populate_by_name=True)

    project_id: Optional[int] = Field(default=None, alias="projectId", ge=1)
    runtime_project_key: Optional[str] = Field(
        default=None,
        alias="runtimeProjectKey",
    )


class RuntimeArchivedConversationBulkRequest(BaseModel):
    """Bulk operation over device-local runtime task addresses."""

    model_config = ConfigDict(populate_by_name=True)

    items: list[RuntimeTaskAddress] = Field(default_factory=list)


class RuntimeArchivedConversationBulkResponse(BaseModel):
    """Bulk archive/delete acknowledgement."""

    model_config = ConfigDict(populate_by_name=True)

    accepted: bool
    requested_count: int = Field(..., alias="requestedCount")
    accepted_count: int = Field(..., alias="acceptedCount")
    deleted_count: Optional[int] = Field(default=None, alias="deletedCount")
    results: list[dict[str, Any]] = Field(default_factory=list)
    error: Optional[str] = None


class RuntimeTranscriptResponse(BaseModel):
    """Transcript returned by the owning local executor."""

    model_config = ConfigDict(populate_by_name=True)

    local_task_id: str = Field(..., alias="localTaskId")
    workspace_path: str = Field(..., alias="workspacePath")
    runtime: RuntimeName
    title: Optional[str] = None
    messages: list[NormalizedRuntimeMessage] = Field(default_factory=list)
    has_more_before: bool = Field(default=False, alias="hasMoreBefore")
    before_cursor: Optional[str] = Field(default=None, alias="beforeCursor")
    parse_error: Optional[str] = Field(default=None, alias="parseError")


class RuntimeSendRequest(BaseModel):
    """Request to continue a native runtime task."""

    model_config = ConfigDict(populate_by_name=True)

    address: RuntimeTaskAddress
    message: str = Field(..., min_length=1)
    source: Optional[RuntimeMessageSource] = None


class RuntimeSendResponse(BaseModel):
    """Acknowledgement from the runtime send RPC."""

    accepted: bool
    local_task_id: str = Field(..., alias="localTaskId")
    error: Optional[str] = None


class RuntimeWorkspaceOpenRequest(BaseModel):
    """Request to register/open a device-local runtime workspace."""

    model_config = ConfigDict(populate_by_name=True)

    device_id: str = Field(..., alias="deviceId", min_length=1)
    workspace_path: str = Field(..., alias="workspacePath", min_length=1)
    runtime: RuntimeName = "codex"
    label: Optional[str] = None
    action: Optional[Literal["create", "select"]] = None


class RuntimeWorkspaceRenameRequest(BaseModel):
    """Request to rename a device-local runtime workspace project."""

    model_config = ConfigDict(populate_by_name=True)

    device_id: str = Field(..., alias="deviceId", min_length=1)
    workspace_path: str = Field(..., alias="workspacePath", min_length=1)
    runtime: RuntimeName = "codex"
    name: str = Field(..., min_length=1)


class RuntimeWorkspaceRemoveRequest(BaseModel):
    """Request to remove a device-local runtime workspace project."""

    model_config = ConfigDict(populate_by_name=True)

    device_id: str = Field(..., alias="deviceId", min_length=1)
    workspace_path: str = Field(..., alias="workspacePath", min_length=1)
    runtime: RuntimeName = "codex"


class RuntimeWorkspaceOpenResponse(BaseModel):
    """Acknowledgement from opening a runtime workspace without a turn."""

    model_config = ConfigDict(populate_by_name=True)

    accepted: bool
    device_id: str = Field(..., alias="deviceId")
    workspace_path: str = Field(..., alias="workspacePath")
    runtime: RuntimeName
    thread_id: Optional[str] = Field(default=None, alias="threadId")
    error: Optional[str] = None


class BindRuntimeTaskIMSessionsRequest(BaseModel):
    """Bind private IM sessions to a device-local runtime task."""

    model_config = ConfigDict(populate_by_name=True)

    address: RuntimeTaskAddress
    session_keys: list[str] = Field(..., alias="sessionKeys", min_length=1)


class BindRuntimeTaskIMSessionsResponse(BaseModel):
    """Acknowledgement for binding private IM sessions to a runtime task."""

    model_config = ConfigDict(populate_by_name=True)

    address: RuntimeTaskAddress
    bound_session_keys: list[str] = Field(..., alias="boundSessionKeys")
    notified_count: int = Field(..., alias="notifiedCount")


class RuntimeIMNotificationSession(BaseModel):
    """Private IM session metadata used for notification target selection."""

    model_config = ConfigDict(populate_by_name=True)

    session_key: str = Field(..., alias="sessionKey")
    channel_type: str = Field(..., alias="channelType")
    channel_label: str = Field(..., alias="channelLabel")
    channel_id: int = Field(..., alias="channelId")
    conversation_id: str = Field(..., alias="conversationId")
    sender_id: str = Field(..., alias="senderId")
    display_name: str = Field("", alias="displayName")


class RuntimeGlobalIMNotificationSettings(BaseModel):
    """User-level IM notification switch and default session."""

    model_config = ConfigDict(populate_by_name=True)

    enabled: bool = False
    session_key: Optional[str] = Field(default=None, alias="sessionKey")
    session: Optional[RuntimeIMNotificationSession] = None


class RuntimeTaskIMNotificationSubscription(BaseModel):
    """Task-level IM notification subscription state."""

    model_config = ConfigDict(populate_by_name=True)

    address: RuntimeTaskAddress
    session_keys: list[str] = Field(default_factory=list, alias="sessionKeys")
    sessions: list[RuntimeIMNotificationSession] = Field(default_factory=list)


class RuntimeIMNotificationSettingsResponse(BaseModel):
    """All runtime IM notification settings needed by Wework."""

    model_config = ConfigDict(populate_by_name=True)

    global_settings: RuntimeGlobalIMNotificationSettings = Field(..., alias="global")
    runtime_task_subscriptions: list[RuntimeTaskIMNotificationSubscription] = Field(
        default_factory=list,
        alias="runtimeTaskSubscriptions",
    )


class RuntimeGlobalIMNotificationUpdateRequest(BaseModel):
    """Update the global IM notification switch."""

    model_config = ConfigDict(populate_by_name=True)

    enabled: bool
    session_key: Optional[str] = Field(default=None, alias="sessionKey")


class RuntimeTaskIMNotificationSubscriptionRequest(BaseModel):
    """Subscribe a runtime task to one or more private IM sessions."""

    model_config = ConfigDict(populate_by_name=True)

    address: RuntimeTaskAddress
    session_keys: list[str] = Field(..., alias="sessionKeys", min_length=1)


class RuntimeTaskIMNotificationSubscriptionResponse(BaseModel):
    """Acknowledgement for task-level IM notification subscription changes."""

    model_config = ConfigDict(populate_by_name=True)

    address: RuntimeTaskAddress
    subscribed: bool
    session_keys: list[str] = Field(default_factory=list, alias="sessionKeys")


class RuntimeTaskArchiveResponse(BaseModel):
    """Acknowledgement from the runtime archive RPC."""

    model_config = ConfigDict(populate_by_name=True)

    accepted: bool
    local_task_id: str = Field(..., alias="localTaskId")
    workspace_path: Optional[str] = Field(default=None, alias="workspacePath")
    error: Optional[str] = None


class RuntimeTaskRenameRequest(BaseModel):
    """Request to rename one device-local runtime task."""

    model_config = ConfigDict(populate_by_name=True)

    address: RuntimeTaskAddress
    title: str = Field(..., min_length=1, max_length=120)


class RuntimeTaskCreateRequest(BaseModel):
    """Request to create a device-local runtime task without DB Task rows."""

    model_config = ConfigDict(populate_by_name=True)

    project_id: Optional[int] = Field(default=None, alias="projectId", ge=1)
    device_workspace_id: Optional[int] = Field(
        default=None,
        alias="deviceWorkspaceId",
        ge=1,
    )
    device_id: Optional[str] = Field(default=None, alias="deviceId")
    workspace_path: Optional[str] = Field(default=None, alias="workspacePath")
    team_id: int = Field(..., alias="teamId", ge=1)
    runtime: RuntimeName
    message: str = Field(..., min_length=1)
    title: Optional[str] = None
    model_id: Optional[str] = Field(default=None, alias="modelId")
    model_type: Optional[str] = Field(default=None, alias="modelType")
    model_options: dict[str, Any] = Field(
        default_factory=dict,
        alias="modelOptions",
    )
    additional_skills: list[Any] = Field(
        default_factory=list,
        alias="additionalSkills",
    )
    attachment_ids: list[int] = Field(default_factory=list, alias="attachmentIds")
    execution: Optional[dict[str, Any]] = None


class RuntimeTaskCreateResponse(BaseModel):
    """Acknowledgement from device-local runtime task creation."""

    model_config = ConfigDict(populate_by_name=True)

    accepted: bool
    device_id: str = Field(..., alias="deviceId")
    local_task_id: str = Field(..., alias="localTaskId")
    workspace_path: str = Field(..., alias="workspacePath")
    runtime: RuntimeName
    error: Optional[str] = None


class RuntimeTaskForkTarget(BaseModel):
    """Target device workspace for a runtime-native task fork."""

    model_config = ConfigDict(populate_by_name=True)

    device_id: str = Field(..., alias="deviceId", min_length=1)
    workspace_path: str = Field(..., alias="workspacePath", min_length=1)


class RuntimeTaskForkRequest(BaseModel):
    """Fork a device-local runtime task to another device workspace."""

    model_config = ConfigDict(populate_by_name=True)

    source: RuntimeTaskAddress
    target: RuntimeTaskForkTarget


class RuntimeTaskForkResponse(BaseModel):
    """Acknowledgement for a runtime-native task fork."""

    model_config = ConfigDict(populate_by_name=True)

    accepted: bool
    source: RuntimeTaskAddress
    target: RuntimeTaskAddress
    runtime: RuntimeName
    error: Optional[str] = None
