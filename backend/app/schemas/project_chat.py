# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Wire schemas for shared Wework project chat."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


def _to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


BotVisibility = Literal["private", "creator_admin", "public"]
BotExecutionEnvironment = Literal["local", "cloud"]
BotExecutionMode = Literal["auto", "manual_approval"]


class ProjectChatSchema(BaseModel):
    model_config = ConfigDict(alias_generator=_to_camel, populate_by_name=True)


class ProjectChatAgentCreate(ProjectChatSchema):
    name: str = Field(min_length=1, max_length=100)
    runtime: Literal["codex"] = "codex"
    model: str | None = Field(default=None, max_length=255)
    system_prompt: str = Field(default="", max_length=20_000)
    visibility: BotVisibility = "creator_admin"
    execution_environment: BotExecutionEnvironment = "local"
    execution_mode: BotExecutionMode = "auto"
    execution_device_id: str | None = Field(default=None, max_length=100)


class ProjectChatAgentUpdate(ProjectChatSchema):
    version: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=100)
    model: str | None = Field(default=None, max_length=255)
    system_prompt: str | None = Field(default=None, max_length=20_000)
    status: Literal["active", "archived"] | None = None
    visibility: BotVisibility | None = None
    execution_environment: BotExecutionEnvironment | None = None
    execution_mode: BotExecutionMode | None = None
    execution_device_id: str | None = Field(default=None, max_length=100)


class ProjectChatAgentView(ProjectChatSchema):
    id: str
    project_id: str
    name: str
    runtime: Literal["codex"]
    model: str | None
    system_prompt: str
    status: Literal["active", "archived"]
    visibility: BotVisibility
    execution_environment: BotExecutionEnvironment
    execution_mode: BotExecutionMode
    execution_device_id: str | None
    created_by_user_id: int | None
    created_by_user_name: str | None = None
    version: int
    created_at: str
    updated_at: str


class LoopItemAssign(ProjectChatSchema):
    """Assign a loop item to a project member or to a project robot."""

    version: int = Field(ge=1)
    assignee_type: Literal["user", "agent"]
    assignee_id: str = Field(min_length=1, max_length=128)


class LoopItemApproval(ProjectChatSchema):
    """Approve or reject a robot run that is waiting for manual approval."""

    version: int = Field(ge=1)
    reason: str | None = Field(default=None, max_length=2_000)


class LoopItemExecutionClaim(ProjectChatSchema):
    """Claim the next queued run for one robot on one device."""

    agent_id: str = Field(min_length=1, max_length=128)
    execution_device_id: str = Field(min_length=1, max_length=100)
    execution_environment: Literal["local", "cloud"] = "local"
    device_capacity: int = Field(default=1, ge=1, le=20)
    lease_seconds: int = Field(default=300, ge=60, le=3600)
    assigner_user_id: int | None = Field(default=None)


class LoopItemExecutionDeviceClaim(ProjectChatSchema):
    """Claim the next queued local run for any robot bound to a device."""

    execution_device_id: str = Field(min_length=1, max_length=100)
    device_capacity: int = Field(default=1, ge=1, le=20)
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


class LoopItemExecutionComplete(ProjectChatSchema):
    """Report a successful robot run."""

    note: str | None = Field(default=None, max_length=2_000)


class LoopItemExecutionFail(ProjectChatSchema):
    """Report a failed robot run (optionally requeue when retries remain)."""

    error: str = Field(min_length=1, max_length=2_000)
    note: str | None = Field(default=None, max_length=2_000)
    requeue: bool = False


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
    agent_id: str
    assigner_user_id: int
    execution_environment: str
    execution_device_id: str | None
    status: str
    priority_weight: int
    queued_at: Any | None = None
    started_at: Any | None = None
    completed_at: Any | None = None
    lease_expires_at: Any | None = None
    heartbeat_at: Any | None = None
    retry_attempt: int = 0
    error_message: str = ""
    execution_note: str = ""
    approval_status: str | None = None
    approved_by_user_id: int | None = None
    rejected_reason: str | None = None
    runtime_device_id: str | None = None
    runtime_task_id: str | None = None
    execution_payload: Any | None = None
    version: int = 1
    created_at: Any
    updated_at: Any


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
