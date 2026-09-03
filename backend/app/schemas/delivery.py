# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API schemas for project TODO delivery snapshots."""

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    computed_field,
    field_validator,
    model_validator,
)

from app.schemas.cloud_project import CloudProjectResponse, SnowflakeId
from app.schemas.issue_workflow import IssueWorkflowInstance, WorkflowExecutionConfig
from app.schemas.tagging import MAX_TAGS_PER_ITEM
from app.schemas.tagging import normalize_tags as _normalize_tags


class LoopItemCreate(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    description: str = ""
    status: str | None = Field(default=None, max_length=32)
    assignee_user_id: int | None = None
    assignee_agent_id: str | None = Field(default=None, max_length=64)
    assignee_team_id: int | None = Field(default=None, ge=1)
    priority: Literal["none", "low", "medium", "high", "urgent"] = "none"
    due_at: datetime | None = None
    parent_id: str | None = Field(default=None, max_length=64)
    tags: list[str] = Field(default_factory=list, max_length=MAX_TAGS_PER_ITEM)
    workflow: IssueWorkflowInstance | None = None
    execution_config: WorkflowExecutionConfig | None = None
    automation_rule_id: str | None = Field(default=None, max_length=64)

    _normalize = field_validator("tags", mode="before")(_normalize_tags)

    @model_validator(mode="after")
    def validate_assignee(self) -> "LoopItemCreate":
        selected = sum(
            value is not None
            for value in (
                self.assignee_user_id,
                self.assignee_agent_id,
                self.assignee_team_id,
            )
        )
        if selected > 1:
            raise ValueError("Only one assignee may be selected")
        return self


class LoopItemUpdate(BaseModel):
    version: int = Field(ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    status: str | None = Field(default=None, max_length=32)
    assignee_user_id: int | None = None
    assignee_agent_id: str | None = Field(default=None, max_length=64)
    assignee_team_id: int | None = Field(default=None, ge=1)
    priority: Literal["none", "low", "medium", "high", "urgent"] | None = None
    due_at: datetime | None = None
    parent_id: str | None = Field(default=None, max_length=64)
    tags: list[str] | None = Field(default=None, max_length=MAX_TAGS_PER_ITEM)
    workflow: IssueWorkflowInstance | None = None
    execution_config: WorkflowExecutionConfig | None = None
    automation_rule_id: str | None = Field(default=None, max_length=64)

    _normalize = field_validator("tags", mode="before")(
        lambda value: None if value is None else _normalize_tags(value)
    )

    @model_validator(mode="after")
    def validate_assignee(self) -> "LoopItemUpdate":
        values = [
            value
            for field, value in (
                ("assignee_user_id", self.assignee_user_id),
                ("assignee_agent_id", self.assignee_agent_id),
                ("assignee_team_id", self.assignee_team_id),
            )
            if field in self.model_fields_set and value is not None
        ]
        if len(values) > 1:
            raise ValueError("Only one assignee may be selected")
        return self


class LoopItemReorder(BaseModel):
    """Manual order of the TODOs inside one board lane (parent + status)."""

    parent_id: str | None = Field(default=None, max_length=64)
    status: str = Field(max_length=32)
    item_ids: list[str] = Field(min_length=1, max_length=1000)


class LoopItemResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    cloud_project_id: SnowflakeId
    sequence_number: int
    parent_id: str | None
    title: str
    description: str
    status: str
    assignee_user_id: int | None
    assignee_name: str | None = None
    assignee_agent_id: str | None = None
    assignee_agent_name: str | None = None
    assignee_team_id: int | None = None
    assignee_team_name: str | None = None
    ai_state: dict[str, Any] | None = None
    execution_id: int | None = None
    execution_state: str | None = None
    execution_control_state: str | None = None
    execution_observed_state: str | None = None
    execution_sync_state: str | None = None
    execution_attempt_no: int | None = None
    execution_last_event_seq: int | None = None
    can_approve: bool = False
    assignment_history: list[dict[str, Any]] = Field(default_factory=list)
    status_history: list[dict[str, Any]] = Field(default_factory=list)
    approval: dict[str, Any] | None = None
    queued_at: str | None = None
    execution_note: str | None = None
    execution_error: str | None = None
    automation: dict[str, Any] | None = None
    workflow: IssueWorkflowInstance | None = None
    execution_config: WorkflowExecutionConfig | None = None
    priority: str
    due_at: datetime | None
    sort_order: int
    tags: list[str] = []
    created_by_user_id: int
    created_by_user_name: str | None = None
    can_view_detail: bool = True
    can_edit: bool = True
    detail_loaded: bool = True
    content_revision: int = 1
    is_unread: bool = False
    current_delivery_id: str | None
    version: int
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None

    @model_validator(mode="before")
    @classmethod
    def populate_tags(cls, value: object) -> object:
        """Fill tags and metadata-derived fields when the input has no tags key."""
        if isinstance(value, dict) and "tags" not in value:
            metadata = value.get("metadata_json")
            metadata = metadata if isinstance(metadata, dict) else {}
            ai_state = (
                value.get("ai_state")
                if value.get("ai_state") is not None
                else (
                    metadata.get("ai_state")
                    if isinstance(metadata.get("ai_state"), dict)
                    else None
                )
            )
            assignment_history = (
                value.get("assignment_history")
                if value.get("assignment_history") is not None
                else (
                    metadata.get("assignment_history")
                    if isinstance(metadata.get("assignment_history"), list)
                    else []
                )
            )
            status_history = (
                value.get("status_history")
                if value.get("status_history") is not None
                else (
                    metadata.get("status_history")
                    if isinstance(metadata.get("status_history"), list)
                    else []
                )
            )
            approval = (
                value.get("approval")
                if value.get("approval") is not None
                else (
                    metadata.get("approval")
                    if isinstance(metadata.get("approval"), dict)
                    else None
                )
            )
            workflow = (
                value.get("workflow")
                if value.get("workflow") is not None
                else (
                    metadata.get("workflow")
                    if isinstance(metadata.get("workflow"), dict)
                    else None
                )
            )
            execution_config = (
                value.get("execution_config")
                if value.get("execution_config") is not None
                else (
                    metadata.get("execution_config")
                    if isinstance(metadata.get("execution_config"), dict)
                    else None
                )
            )
            queued_at_value = value.get("queued_at")
            if isinstance(queued_at_value, datetime):
                queued_at = queued_at_value.isoformat()
            elif isinstance(queued_at_value, str):
                queued_at = queued_at_value
            else:
                queued_at = metadata.get("queued_at")
            return {
                **value,
                "tags": _normalize_tags(metadata.get("tags")),
                "ai_state": ai_state,
                "execution_state": (
                    value.get("execution_state")
                    if value.get("execution_state") is not None
                    else metadata.get("execution_state")
                ),
                "assignment_history": assignment_history,
                "status_history": status_history,
                "approval": approval,
                "workflow": workflow,
                "execution_config": execution_config,
                "queued_at": queued_at,
                "execution_note": (
                    value.get("execution_note")
                    if value.get("execution_note") is not None
                    else metadata.get("execution_note")
                ),
                "execution_error": (
                    value.get("execution_error")
                    if value.get("execution_error") is not None
                    else metadata.get("execution_error")
                ),
                "automation": (
                    value.get("automation")
                    if value.get("automation") is not None
                    else metadata.get("automation")
                ),
            }
        return value

    @field_validator(
        "parent_id", "current_delivery_id", "assignee_agent_id", mode="before"
    )
    @classmethod
    def normalize_empty_id(cls, value: object) -> object:
        return None if value == "" else value

    @field_validator("assignee_user_id", "assignee_team_id", mode="before")
    @classmethod
    def normalize_empty_numeric_assignee_id(cls, value: object) -> object:
        return None if value == 0 else value

    @field_validator("due_at", "completed_at", mode="before")
    @classmethod
    def normalize_unset_datetime(cls, value: object) -> object:
        if isinstance(value, datetime) and value == datetime(1970, 1, 1, 0, 0, 1):
            return None
        if isinstance(value, str) and value.startswith("1970-01-01 00:00:01"):
            return None
        return value


class LoopItemListResponse(BaseModel):
    items: list[LoopItemResponse]


class LoopItemCommentCreate(BaseModel):
    body: str = Field(min_length=1)


class LoopItemCommentResponse(BaseModel):
    id: str
    body: str
    author: str
    web_url: str | None = None
    created_at: datetime
    updated_at: datetime


class LoopItemAttachmentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    loop_item_id: str
    display_name: str
    content_type: str | None
    size_bytes: int
    sha256: str
    created_by_user_id: int
    created_at: datetime
    markdown: str | None = None

    @computed_field
    @property
    def markdown_url(self) -> str:
        return f"wegent://attachments/{self.id}"

    @model_validator(mode="after")
    def populate_markdown(self) -> "LoopItemAttachmentResponse":
        if self.markdown is None:
            self.markdown = (
                f"[{self.display_name}]({self.markdown_url})\n"
                f"<!-- wegent-attachment:{self.id} -->"
            )
        return self

    @field_validator("content_type", mode="before")
    @classmethod
    def normalize_empty_content_type(cls, value: object) -> object:
        return None if value == "" else value


class LoopItemAttachmentAccessResponse(BaseModel):
    url: str
    expires_in_seconds: int


class MyWorkItemResponse(LoopItemResponse):
    project_key: str
    project_name: str
    has_active_task: bool


class MyWorkListResponse(BaseModel):
    items: list[MyWorkItemResponse]


class LoopItemCollaboratorCreate(BaseModel):
    user_id: int = Field(ge=1)


class LoopItemCollaboratorResponse(BaseModel):
    id: SnowflakeId
    loop_item_id: str
    user_id: int
    user_name: str
    email: str | None
    source: str
    added_by_user_id: int
    created_at: datetime


class LoopItemTaskBind(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    device_id: str = Field(alias="deviceId", min_length=1, max_length=100)
    task_id: str = Field(alias="taskId", min_length=1, max_length=255)
    task_title: str | None = Field(default=None, alias="taskTitle", max_length=255)
    backend_task_id: int | None = Field(default=None, alias="backendTaskId")
    workflow_node_id: str | None = Field(
        default=None,
        alias="workflowNodeId",
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9_-]+$",
    )


class LoopItemTaskBindingResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: SnowflakeId
    cloud_project_id: SnowflakeId
    loop_item_id: str | None
    task_user_id: int
    device_id: str
    task_id: str
    task_title: str | None
    backend_task_id: int | None
    workflow_node_id: str | None = None
    linked_by_user_id: int
    linked_at: datetime
    unlinked_at: datetime | None

    @field_validator("loop_item_id", "task_title", mode="before")
    @classmethod
    def normalize_empty_text(cls, value: object) -> object:
        return None if value == "" else value

    @field_validator("backend_task_id", mode="before")
    @classmethod
    def normalize_empty_task_id(cls, value: object) -> object:
        return None if value == 0 else value

    @field_validator("unlinked_at", mode="before")
    @classmethod
    def normalize_unlinked_at(cls, value: object) -> object:
        return LoopItemResponse.normalize_unset_datetime(value)


class LoopItemPageResponse(BaseModel):
    items: list[LoopItemResponse]
    task_bindings: list[LoopItemTaskBindingResponse]
    next_cursor: str | None = None


class CloudTaskContextResponse(LoopItemTaskBindingResponse):
    project: CloudProjectResponse
    loop_item: LoopItemResponse | None = None


class DeliveryChatSelection(BaseModel):
    mode: Literal["all", "latest", "message_ids"]
    count: int | None = Field(default=None, ge=1, le=500)
    message_ids: list[str] = Field(default_factory=list, max_length=500)

    @model_validator(mode="after")
    def validate_selection(self) -> "DeliveryChatSelection":
        if self.mode == "latest" and self.count is None:
            raise ValueError("count is required when mode is latest")
        if self.mode == "message_ids" and not self.message_ids:
            raise ValueError("message_ids is required when mode is message_ids")
        if self.mode != "message_ids" and self.message_ids:
            raise ValueError("message_ids is only valid when mode is message_ids")
        if self.mode != "latest" and self.count is not None:
            raise ValueError("count is only valid when mode is latest")
        return self


class DeliveryCreate(BaseModel):
    markdown: str = ""
    chat: dict[str, Any] | None = None
    chat_selection: DeliveryChatSelection | None = None
    source_task: LoopItemTaskBind | None = None

    @model_validator(mode="after")
    def validate_chat_source(self) -> "DeliveryCreate":
        if self.chat is not None and self.chat_selection is not None:
            raise ValueError("chat and chat_selection are mutually exclusive")
        return self


class DeliveryTextFulfillment(BaseModel):
    requirement_id: str = Field(min_length=1, max_length=64)
    kind: Literal["text"]
    text: str = Field(min_length=1, max_length=100_000)


class DeliveryFileFulfillment(BaseModel):
    requirement_id: str = Field(min_length=1, max_length=64)
    kind: Literal["file"]
    asset_ids: list[str] = Field(min_length=1, max_length=100)


class DeliveryCodeSnapshotFulfillment(BaseModel):
    requirement_id: str = Field(min_length=1, max_length=64)
    kind: Literal["code_snapshot"]
    asset_id: str = Field(min_length=1, max_length=64)
    changed_files: list[str] = Field(default_factory=list, max_length=5000)
    base_revision: str | None = Field(default=None, max_length=255)
    head_revision: str | None = Field(default=None, max_length=255)
    sha256: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")


class DeliveryGitBranchFulfillment(BaseModel):
    requirement_id: str = Field(min_length=1, max_length=64)
    kind: Literal["git_branch"]
    remote_url: str = Field(min_length=1, max_length=2000)
    branch: str = Field(min_length=1, max_length=255)
    commit_sha: str = Field(min_length=7, max_length=64)

    @field_validator("remote_url")
    @classmethod
    def validate_remote_url(cls, value: str) -> str:
        normalized = value.strip()
        if not (
            normalized.startswith(("https://", "ssh://", "git@"))
            or normalized.endswith(".git")
        ):
            raise ValueError("remote_url must identify a Git remote")
        return normalized


class DeliveryPullRequestFulfillment(BaseModel):
    requirement_id: str = Field(min_length=1, max_length=64)
    kind: Literal["pull_request"]
    provider: Literal["github", "gitlab"]
    url: str = Field(min_length=1, max_length=2000)
    number: int = Field(ge=1)
    state: Literal["draft"] = "draft"
    head_branch: str = Field(min_length=1, max_length=255)
    base_branch: str = Field(min_length=1, max_length=255)
    head_commit: str = Field(min_length=7, max_length=64)

    @field_validator("url")
    @classmethod
    def validate_pull_request_url(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized.startswith(("http://", "https://")):
            raise ValueError("pull request URL must use HTTP or HTTPS")
        return normalized


class DeliveryUrlFulfillment(BaseModel):
    requirement_id: str = Field(min_length=1, max_length=64)
    kind: Literal["url"]
    url: str = Field(min_length=1, max_length=2000)
    title: str = Field(default="", max_length=255)

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized.startswith(("http://", "https://")):
            raise ValueError("URL fulfillment must use HTTP or HTTPS")
        return normalized


DeliveryFulfillment = Annotated[
    DeliveryTextFulfillment
    | DeliveryFileFulfillment
    | DeliveryCodeSnapshotFulfillment
    | DeliveryGitBranchFulfillment
    | DeliveryPullRequestFulfillment
    | DeliveryUrlFulfillment,
    Field(discriminator="kind"),
]


class DeliveryFinalize(BaseModel):
    fulfillments: list[DeliveryFulfillment] = Field(
        default_factory=list, max_length=100
    )

    @model_validator(mode="after")
    def validate_unique_requirements(self) -> "DeliveryFinalize":
        requirement_ids = [
            fulfillment.requirement_id for fulfillment in self.fulfillments
        ]
        if len(requirement_ids) != len(set(requirement_ids)):
            raise ValueError("a Delivery can fulfill each requirement only once")
        return self


class DeliveryAssetResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    kind: str
    display_name: str
    relative_path: str = Field(max_length=700)
    content_type: str | None
    size_bytes: int
    sha256: str

    @field_validator("content_type", mode="before")
    @classmethod
    def normalize_empty_content_type(cls, value: object) -> object:
        return None if value == "" else value


class DeliveryAssetAccessResponse(BaseModel):
    url: str
    expires_in_seconds: int = 900


class DeliveryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    loop_item_id: str
    created_by_user_id: int
    source_task_binding_id: int | None
    source_task_snapshot: dict[str, Any] | None
    status: Literal["draft", "delivered"]
    created_at: datetime
    delivered_at: datetime | None
    assets: list[DeliveryAssetResponse] = Field(default_factory=list)
    fulfillments: list[DeliveryFulfillment] = Field(default_factory=list)

    @field_validator("source_task_binding_id", mode="before")
    @classmethod
    def normalize_empty_binding_id(cls, value: object) -> object:
        return None if value in ("", 0) else value

    @field_validator("source_task_snapshot", mode="before")
    @classmethod
    def normalize_empty_snapshot(cls, value: object) -> object:
        return None if value == {} else value

    @field_validator("delivered_at", mode="before")
    @classmethod
    def normalize_delivered_at(cls, value: object) -> object:
        return LoopItemResponse.normalize_unset_datetime(value)


class DeliveryDetailResponse(DeliveryResponse):
    markdown: str
    chat: dict[str, Any] | None = None


class DeliveryListResponse(BaseModel):
    items: list[DeliveryResponse]
