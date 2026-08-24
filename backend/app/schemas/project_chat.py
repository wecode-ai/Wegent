# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Wire schemas for shared Wework project chat."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


def _to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


BotVisibility = Literal["private", "creator_admin", "public"]
BotExecutionEnvironment = Literal["local", "cloud"]
BotExecutionMode = Literal["auto", "manual_approval"]
BotRuntime = Literal["codex", "wegent"]
BotWorkspacePolicy = Literal["project", "git_worktree"]
WorkspaceBindingType = Literal["backend_project", "device_project", "standalone"]


class ProjectChatSchema(BaseModel):
    model_config = ConfigDict(alias_generator=_to_camel, populate_by_name=True)


class ProjectChatWorkspaceBinding(ProjectChatSchema):
    """Stable robot workspace intent; device paths are resolved at dispatch."""

    type: WorkspaceBindingType
    project_id: int | None = Field(default=None, ge=1)
    device_workspace_id: int | None = Field(default=None, ge=1)
    device_id: str | None = Field(default=None, min_length=1, max_length=100)
    runtime_project_key: str | None = Field(
        default=None,
        min_length=1,
        max_length=255,
    )

    @model_validator(mode="after")
    def validate_identity(self) -> "ProjectChatWorkspaceBinding":
        if self.type == "backend_project":
            if self.project_id is None:
                raise ValueError("backend_project binding requires projectId")
            if self.runtime_project_key is not None:
                raise ValueError(
                    "backend_project binding cannot include runtimeProjectKey"
                )
        elif self.type == "device_project":
            if not self.device_id or not self.runtime_project_key:
                raise ValueError(
                    "device_project binding requires deviceId and runtimeProjectKey"
                )
            if self.project_id is not None or self.device_workspace_id is not None:
                raise ValueError(
                    "device_project binding cannot include Backend project identity"
                )
        elif any(
            value is not None
            for value in (
                self.project_id,
                self.device_workspace_id,
                self.device_id,
                self.runtime_project_key,
            )
        ):
            raise ValueError("standalone binding cannot include workspace identity")
        return self


class ProjectChatWorkspaceBindingView(ProjectChatSchema):
    type: Literal[
        "backend_project",
        "device_project",
        "standalone",
        "legacy_project",
    ]
    status: Literal["ready", "needs_rebind"]
    project_id: int | None = None
    device_workspace_id: int | None = None
    device_id: str | None = None
    runtime_project_key: str | None = None


class ProjectChatAgentPlugin(ProjectChatSchema):
    id: str = Field(min_length=1, max_length=255)
    plugin_name: str = Field(min_length=1, max_length=255)
    marketplace_id: str = Field(min_length=1, max_length=255)
    display_name: str = Field(min_length=1, max_length=255)


class ProjectChatAgentCreate(ProjectChatSchema):
    name: str = Field(min_length=1, max_length=100)
    runtime: BotRuntime = "codex"
    wegent_team_id: int | None = Field(default=None, ge=1)
    model: str | None = Field(default=None, max_length=255)
    model_type: Literal["public", "user", "group", "runtime"] | None = None
    model_options: dict[str, str] = Field(default_factory=dict)
    system_prompt: str = Field(default="", max_length=20_000)
    capability_description: str = Field(default="", max_length=2_000)
    visibility: BotVisibility = "creator_admin"
    execution_environment: BotExecutionEnvironment = "local"
    execution_mode: BotExecutionMode = "auto"
    execution_device_id: str | None = Field(default=None, max_length=100)
    workspace_binding: ProjectChatWorkspaceBinding | None = None
    # V1 compatibility only. New clients must send workspaceBinding.
    local_project_id: int | None = Field(default=None)
    max_concurrent_executions: int = Field(default=1, ge=1, le=20)
    workspace_policy: BotWorkspacePolicy = "project"
    default_runtime_profile_id: str | None = Field(default=None, max_length=64)
    plugins: list[ProjectChatAgentPlugin] = Field(default_factory=list, max_length=50)


class ProjectChatAgentUpdate(ProjectChatSchema):
    version: int = Field(ge=1)
    runtime: BotRuntime | None = None
    wegent_team_id: int | None = Field(default=None, ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=100)
    model: str | None = Field(default=None, max_length=255)
    model_type: Literal["public", "user", "group", "runtime"] | None = None
    model_options: dict[str, str] | None = None
    system_prompt: str | None = Field(default=None, max_length=20_000)
    capability_description: str | None = Field(default=None, max_length=2_000)
    status: Literal["active", "archived"] | None = None
    visibility: BotVisibility | None = None
    execution_environment: BotExecutionEnvironment | None = None
    execution_mode: BotExecutionMode | None = None
    execution_device_id: str | None = Field(default=None, max_length=100)
    workspace_binding: ProjectChatWorkspaceBinding | None = None
    # V1 compatibility only. New clients must send workspaceBinding.
    local_project_id: int | None = Field(default=None)
    max_concurrent_executions: int | None = Field(default=None, ge=1, le=20)
    workspace_policy: BotWorkspacePolicy | None = None
    default_runtime_profile_id: str | None = Field(default=None, max_length=64)
    plugins: list[ProjectChatAgentPlugin] | None = Field(default=None, max_length=50)


class ProjectChatAgentView(ProjectChatSchema):
    id: str
    project_id: str
    name: str
    runtime: BotRuntime
    wegent_team_id: int | None
    model: str | None
    model_type: Literal["public", "user", "group", "runtime"] | None
    model_options: dict[str, str]
    system_prompt: str
    capability_description: str
    status: Literal["active", "archived"]
    visibility: BotVisibility
    execution_environment: BotExecutionEnvironment
    execution_mode: BotExecutionMode
    execution_device_id: str | None
    workspace_binding: ProjectChatWorkspaceBindingView
    local_project_id: int | None
    max_concurrent_executions: int
    workspace_policy: BotWorkspacePolicy
    default_runtime_profile_id: str | None
    plugins: list[ProjectChatAgentPlugin]
    created_by_user_id: int | None
    created_by_user_name: str | None = None
    version: int
    created_at: str
    updated_at: str


class LoopItemAssign(ProjectChatSchema):
    """Assign a loop item to a project member or board robot."""

    version: int = Field(ge=1)
    assignee_type: Literal["user", "agent"]
    assignee_id: str = Field(min_length=1, max_length=128)


class LoopItemApproval(ProjectChatSchema):
    """Approve or reject a robot run that is waiting for manual approval."""

    version: int = Field(ge=1)
    reason: str | None = Field(default=None, max_length=2_000)


class LoopItemExecutionClaim(ProjectChatSchema):
    """Claim the next queued run for one robot on one device."""

    model_config = ConfigDict(
        alias_generator=_to_camel, populate_by_name=True, extra="forbid"
    )

    agent_id: str = Field(min_length=1, max_length=128)
    execution_device_id: str = Field(min_length=1, max_length=100)
    execution_environment: Literal["local", "cloud"] = "local"
    lease_seconds: int = Field(default=300, ge=60, le=3600)
    assigner_user_id: int | None = Field(default=None)


class LoopItemExecutionDeviceClaim(ProjectChatSchema):
    """Claim the next queued local run for any robot bound to a device."""

    model_config = ConfigDict(
        alias_generator=_to_camel, populate_by_name=True, extra="forbid"
    )

    execution_device_id: str = Field(min_length=1, max_length=100)
    lease_seconds: int = Field(default=300, ge=60, le=3600)


class LoopItemExecutionHeartbeat(ProjectChatSchema):
    """Extend the lease of a running robot run."""

    runtime_device_id: str | None = Field(default=None, max_length=255)
    runtime_task_id: str | None = Field(default=None, max_length=255)
    lease_seconds: int = Field(default=300, ge=60, le=3600)


class LoopItemExecutionRuntimeStart(ProjectChatSchema):
    """Record a freshly created runtime task and open the agent message."""

    runtime_device_id: str = Field(min_length=1, max_length=255)
    runtime_task_id: str = Field(min_length=1, max_length=255)
    prompt: str | None = Field(default=None, max_length=100_000)
    model: str | None = Field(default=None, max_length=255)


class LoopItemExecutionDispatchIntent(ProjectChatSchema):
    """Fence a Runtime create request before it can leave the App."""

    runtime_device_id: str = Field(min_length=1, max_length=255)
    runtime_task_id: str = Field(min_length=1, max_length=255)


class LoopItemExecutionDispatchUnknown(LoopItemExecutionDispatchIntent):
    """Report an ambiguous result after a fenced Runtime create request."""

    error: str = Field(min_length=1, max_length=2_000)


class LoopItemExecutionDispatchFailed(ProjectChatSchema):
    """Report a local preflight failure before Runtime delivery was fenced."""

    error: str = Field(min_length=1, max_length=2_000)
    note: str | None = Field(default=None, max_length=2_000)


class LoopItemExecutionCancel(ProjectChatSchema):
    """Cancel a queued or running robot run."""

    note: str | None = Field(default=None, max_length=2_000)


class LoopItemExecutionView(ProjectChatSchema):
    id: int
    loop_item_id: str
    cloud_project_id: str
    task_title: str
    task_status: str | None
    task_priority: str | None
    executor_type: str = "project_robot"
    agent_id: str | None = None
    team_id: int | None = None
    backend_task_id: int | None = None
    automation_run_id: str = ""
    executor_owner_user_id: int | None = None
    assigner_user_id: int
    execution_environment: str
    execution_device_id: str | None
    runtime_instance_id: str | None = None
    status: str
    display_state: str
    observed_state: str = "unconfirmed"
    sync_state: str = "pending"
    priority_weight: int
    queued_at: Any | None = None
    started_at: Any | None = None
    completed_at: Any | None = None
    lease_expires_at: Any | None = None
    heartbeat_at: Any | None = None
    claimed_at: Any | None = None
    start_requested_at: Any | None = None
    observed_at: Any | None = None
    cancel_requested_at: Any | None = None
    attempt_no: int = 1
    previous_execution_id: int | None = None
    execution_scope: str = ""
    last_event_seq: int = 0
    termination_reason: str = ""
    retry_attempt: int = 0
    error_message: str = ""
    execution_note: str = ""
    approval_status: str | None = None
    approved_by_user_id: int | None = None
    rejected_reason: str | None = None
    runtime_device_id: str | None = None
    runtime_task_id: str | None = None
    agent_max_concurrent_executions: int = 1
    runtime_profile_id: str | None = None
    runtime_source: str | None = None
    can_select_runtime: bool = False
    waiting_runtime_reason: str | None = None
    # Materialized only for an authenticated device claim. It is never stored
    # on the execution row because model credentials are resolved just in time.
    runtime_payload: Any | None = None
    version: int = 1
    created_at: Any
    updated_at: Any

    @field_validator("team_id", "backend_task_id", mode="before")
    @classmethod
    def normalize_optional_execution_id(cls, value: object) -> object:
        return None if value == 0 else value


class LoopItemExecutionListResponse(ProjectChatSchema):
    items: list[LoopItemExecutionView]
    total: int


class ProjectChatMention(ProjectChatSchema):
    type: Literal["user", "agent"]
    id: str = Field(min_length=1, max_length=128)
    label: str = Field(min_length=1, max_length=255)


class ProjectChatSend(ProjectChatSchema):
    client_message_id: str = Field(min_length=1, max_length=64)
    project_id: str = Field(min_length=1, max_length=64)
    task_id: str | None = Field(default=None, max_length=64)
    content: str = Field(min_length=1, max_length=100_000)
    mentions: list[ProjectChatMention] = Field(default_factory=list, max_length=64)
    reply_to_message_id: str | None = Field(default=None, max_length=64)
    model: str | None = Field(default=None, max_length=255)


class ProjectChatSubscribe(ProjectChatSchema):
    project_id: str = Field(min_length=1, max_length=64)
    task_id: str | None = Field(default=None, max_length=64)
    after_sequence: int = Field(default=0, ge=0)
    limit: int = Field(default=200, ge=1, le=500)


class ProjectChatAgentStart(ProjectChatSchema):
    project_id: str = Field(min_length=1, max_length=64)
    task_id: str | None = Field(default=None, max_length=64)
    trigger_message_id: str | None = Field(default=None, min_length=1, max_length=64)
    agent_id: str = Field(min_length=1, max_length=128)
    runtime_device_id: str = Field(min_length=1, max_length=255)
    runtime_task_id: str = Field(min_length=1, max_length=255)
    prompt: str | None = Field(default=None, max_length=100_000)
    auto_retry: bool = False
    model: str | None = Field(default=None, max_length=255)


class ProjectChatAgentFailure(ProjectChatSchema):
    project_id: str = Field(min_length=1, max_length=64)
    task_id: str | None = Field(default=None, max_length=64)
    message_id: str = Field(min_length=1, max_length=64)
    error: str | None = Field(default=None, max_length=2_000)


class ProjectChatAutomationManagerContinuation(ProjectChatSchema):
    """Open one reply in a custom automation manager's Runtime session."""

    project_id: str = Field(min_length=1, max_length=64)
    task_id: str = Field(min_length=1, max_length=64)
    trigger_message_id: str = Field(min_length=1, max_length=64)
    manager_message_id: str = Field(min_length=1, max_length=64)


class ProjectChatWegentContinuation(ProjectChatSchema):
    """Continue the native Wegent Task behind one board comment thread."""

    project_id: str = Field(min_length=1, max_length=64)
    task_id: str = Field(min_length=1, max_length=64)
    trigger_message_id: str = Field(min_length=1, max_length=64)
    agent_id: str = Field(min_length=1, max_length=128)
    attachment_ids: list[int] = Field(default_factory=list, max_length=64)


class ProjectChatMessageView(ProjectChatSchema):
    sequence_number: int
    message_id: str
    client_message_id: str | None
    project_id: str
    task_id: str | None
    sender: dict[str, str]
    type: str
    content: str
    metadata: dict[str, Any]
    trigger_message_id: str | None
    reply_to_message_id: str | None
    root_message_id: str | None
    agent_id: str | None
    runtime_address: dict[str, str] | None
    status: str
    created_at: str
    updated_at: str
