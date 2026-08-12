# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Wire contracts for project AI-development workflows."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


def _to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class ProjectWorkflowSchema(BaseModel):
    model_config = ConfigDict(alias_generator=_to_camel, populate_by_name=True)


ExecutionActorType = Literal[
    "project_agent",
    "project_squad",
    "wegent_team",
]
ExecutionTargetType = Literal["registered_device", "managed_container"]
WorkspaceMode = Literal["current_workspace", "git_worktree"]


class ExecutionActorRef(ProjectWorkflowSchema):
    type: ExecutionActorType
    id: str | None = Field(default=None, max_length=64)
    team_id: int | None = Field(default=None, ge=1)
    namespace: str | None = Field(default=None, min_length=1, max_length=255)
    name: str | None = Field(default=None, min_length=1, max_length=255)
    user_id: int | None = Field(default=None, ge=1)
    version: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def validate_actor_identity(self) -> "ExecutionActorRef":
        if self.type == "wegent_team":
            if not all(
                (
                    self.team_id,
                    self.namespace,
                    self.name,
                    self.user_id,
                )
            ):
                raise ValueError(
                    "wegent_team requires teamId, namespace, name, and userId"
                )
            if self.id:
                raise ValueError("wegent_team does not use id")
            return self
        if not self.id:
            raise ValueError(f"{self.type} requires id")
        if any((self.team_id, self.namespace, self.name, self.user_id)):
            raise ValueError(f"{self.type} cannot include Wegent Team fields")
        return self

    def stable_id(self) -> str:
        if self.type == "wegent_team":
            return str(self.team_id)
        return str(self.id)


class ExecutionTargetRef(ProjectWorkflowSchema):
    type: ExecutionTargetType
    id: str | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def validate_target(self) -> "ExecutionTargetRef":
        if self.type == "registered_device" and not self.id:
            raise ValueError("registered_device requires id")
        return self


class ProjectAgentSquadCreate(ProjectWorkflowSchema):
    name: str = Field(min_length=1, max_length=100)
    leader_agent_id: str = Field(min_length=1, max_length=64)
    member_agent_ids: list[str] = Field(min_length=1)
    routing_instructions: str = Field(default="", max_length=20_000)
    max_parallel_members: int = Field(default=1, ge=1, le=20)

    @model_validator(mode="after")
    def validate_members(self) -> "ProjectAgentSquadCreate":
        if len(set(self.member_agent_ids)) != len(self.member_agent_ids):
            raise ValueError("memberAgentIds must be unique")
        if self.leader_agent_id not in self.member_agent_ids:
            raise ValueError("leaderAgentId must be included in memberAgentIds")
        return self


class ProjectAgentSquadUpdate(ProjectWorkflowSchema):
    version: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=100)
    leader_agent_id: str | None = Field(default=None, min_length=1, max_length=64)
    member_agent_ids: list[str] | None = None
    routing_instructions: str | None = Field(default=None, max_length=20_000)
    max_parallel_members: int | None = Field(default=None, ge=1, le=20)
    status: Literal["active", "archived"] | None = None


class ProjectAgentSquadView(ProjectWorkflowSchema):
    id: str
    project_id: str
    name: str
    leader_agent_id: str
    member_agent_ids: list[str]
    routing_instructions: str
    max_parallel_members: int
    status: Literal["active", "archived"]
    created_by_user_id: int
    version: int
    created_at: str
    updated_at: str


class SquadRoutePreviewInput(ProjectWorkflowSchema):
    task: str = Field(min_length=1, max_length=20_000)


class SquadRoutePreviewMember(ProjectWorkflowSchema):
    agent_id: str
    instruction: str
    required_artifacts: list[str] = Field(default_factory=list)
    execution_mode: Literal["serial", "parallel"] = "parallel"


class SquadRoutePreviewView(ProjectWorkflowSchema):
    squad_id: str
    leader_agent_id: str
    selected_members: list[SquadRoutePreviewMember]
    explanation: str


class RepositoryBindingCreate(ProjectWorkflowSchema):
    provider: Literal["github", "gitlab", "generic"] = "generic"
    repository_identity: str = Field(min_length=1, max_length=255)
    repository_url: str = Field(min_length=1, max_length=700)
    default_branch: str = Field(default="main", min_length=1, max_length=255)
    local_project_id: int | None = Field(default=None, ge=1)
    default_execution_target: ExecutionTargetRef | None = None
    credential_ref: str | None = Field(default=None, max_length=255)
    workspace_policy: dict[str, Any] = Field(default_factory=dict)
    git_policy: dict[str, Any] = Field(default_factory=dict)
    provider_settings: dict[str, Any] = Field(default_factory=dict)


class RepositoryBindingUpdate(ProjectWorkflowSchema):
    version: int = Field(ge=1)
    repository_url: str | None = Field(default=None, min_length=1, max_length=700)
    default_branch: str | None = Field(default=None, min_length=1, max_length=255)
    local_project_id: int | None = Field(default=None, ge=1)
    default_execution_target: ExecutionTargetRef | None = None
    credential_ref: str | None = Field(default=None, max_length=255)
    workspace_policy: dict[str, Any] | None = None
    git_policy: dict[str, Any] | None = None
    provider_settings: dict[str, Any] | None = None
    status: Literal["active", "archived"] | None = None


class RepositoryBindingView(ProjectWorkflowSchema):
    id: str
    project_id: str
    provider: Literal["github", "gitlab", "generic"]
    repository_identity: str
    repository_url: str
    default_branch: str
    local_project_id: int | None
    default_execution_target: ExecutionTargetRef | None
    has_credential: bool
    webhook_configured: bool
    workspace_policy: dict[str, Any]
    git_policy: dict[str, Any]
    provider_settings: dict[str, Any]
    status: Literal["active", "archived"]
    created_by_user_id: int
    version: int
    created_at: str
    updated_at: str


class RepositoryWebhookSecretView(ProjectWorkflowSchema):
    binding_id: str
    secret: str
    rotated_at: str


class ConfigurationValidationView(ProjectWorkflowSchema):
    valid: bool
    issues: list[str] = Field(default_factory=list)


WorkflowNodeType = Literal["agent", "human_gate", "ci_gate", "merge", "complete"]


class WorkflowNode(ProjectWorkflowSchema):
    key: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=100)
    type: WorkflowNodeType
    actor: ExecutionActorRef | None = None
    prompt_template: str = Field(default="", max_length=100_000)
    input_artifacts: list[str] = Field(default_factory=list)
    required_outputs: list[str] = Field(default_factory=list)
    workspace_mode: WorkspaceMode | None = None
    max_retries: int = Field(default=1, ge=0, le=10)
    timeout_seconds: int = Field(default=3600, ge=60, le=86_400)
    condition: (
        Literal[
            "all_required_tests_passed",
            "pr_exists",
            "ci_passed",
            "review_approved",
            "no_merge_conflict",
            "human_approved",
            "pr_merged",
        ]
        | None
    ) = None

    @model_validator(mode="after")
    def validate_node(self) -> "WorkflowNode":
        if self.type == "agent" and not self.actor:
            raise ValueError("agent node requires actor")
        if self.type != "agent" and self.actor:
            raise ValueError(f"{self.type} node cannot include actor")
        return self


class WorkflowStageGroup(ProjectWorkflowSchema):
    key: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=100)
    execution: Literal["serial", "parallel"] = "serial"
    completion: Literal["all", "any"] = "all"
    nodes: list[WorkflowNode] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_nodes(self) -> "WorkflowStageGroup":
        keys = [node.key for node in self.nodes]
        if len(keys) != len(set(keys)):
            raise ValueError("node keys must be unique within a stage group")
        return self


class WorkflowDefinitionCreate(ProjectWorkflowSchema):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=20_000)
    trigger_mode: Literal["manual", "automatic"] = "manual"
    repository_binding_id: str | None = Field(default=None, max_length=64)
    stages: list[WorkflowStageGroup] = Field(min_length=1)
    failure_policy: Literal["pause", "stop", "return_to_stage"] = "pause"
    is_default: bool = False

    @model_validator(mode="after")
    def validate_groups(self) -> "WorkflowDefinitionCreate":
        keys = [group.key for group in self.stages]
        if len(keys) != len(set(keys)):
            raise ValueError("stage group keys must be unique")
        return self


class WorkflowDefinitionUpdate(ProjectWorkflowSchema):
    version: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=20_000)
    trigger_mode: Literal["manual", "automatic"] | None = None
    repository_binding_id: str | None = Field(default=None, max_length=64)
    stages: list[WorkflowStageGroup] | None = None
    failure_policy: Literal["pause", "stop", "return_to_stage"] | None = None
    is_default: bool | None = None
    status: Literal["active", "archived"] | None = None


class WorkflowDefinitionView(ProjectWorkflowSchema):
    id: str
    project_id: str
    name: str
    description: str
    trigger_mode: Literal["manual", "automatic"]
    repository_binding_id: str | None
    stages: list[WorkflowStageGroup]
    failure_policy: Literal["pause", "stop", "return_to_stage"]
    is_default: bool
    status: Literal["active", "archived"]
    created_by_user_id: int
    version: int
    created_at: str
    updated_at: str


class ProjectWorkflowAutomationCreate(ProjectWorkflowSchema):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=20_000)
    trigger_type: Literal["manual", "cron", "interval", "one_time", "webhook"]
    trigger_config: dict[str, Any] = Field(default_factory=dict)
    workflow_id: str = Field(min_length=1, max_length=64)
    repository_binding_id: str | None = Field(default=None, max_length=64)
    execution_target: ExecutionTargetRef
    workspace_mode: WorkspaceMode = "git_worktree"
    task_template: dict[str, Any] = Field(default_factory=dict)
    payload_mapping: dict[str, str] = Field(default_factory=dict)
    enabled: bool = True


class ProjectWorkflowAutomationUpdate(ProjectWorkflowSchema):
    version: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=20_000)
    trigger_type: (
        Literal["manual", "cron", "interval", "one_time", "webhook"] | None
    ) = None
    trigger_config: dict[str, Any] | None = None
    workflow_id: str | None = Field(default=None, min_length=1, max_length=64)
    repository_binding_id: str | None = Field(default=None, max_length=64)
    execution_target: ExecutionTargetRef | None = None
    workspace_mode: WorkspaceMode | None = None
    task_template: dict[str, Any] | None = None
    payload_mapping: dict[str, str] | None = None
    enabled: bool | None = None


class ProjectWorkflowAutomationView(ProjectWorkflowSchema):
    id: str
    project_id: str
    name: str
    description: str
    trigger_type: Literal["manual", "cron", "interval", "one_time", "webhook"]
    trigger_config: dict[str, Any]
    workflow_id: str
    repository_binding_id: str | None
    execution_target: ExecutionTargetRef
    workspace_mode: WorkspaceMode
    task_template: dict[str, Any]
    payload_mapping: dict[str, str]
    webhook_configured: bool
    enabled: bool
    next_run_at: str | None
    last_run_at: str | None
    created_by_user_id: int
    version: int
    created_at: str
    updated_at: str


class ProjectWorkflowAutomationSecretView(ProjectWorkflowSchema):
    automation_id: str
    webhook_token: str
    webhook_secret: str


class ProjectWorkflowAutomationRunView(ProjectWorkflowSchema):
    id: str
    automation_id: str
    trigger_type: str
    status: Literal["pending", "running", "succeeded", "failed", "cancelled"]
    loop_item_id: str | None
    workflow_run_id: str | None
    scheduled_for: str | None
    started_at: str | None
    completed_at: str | None
    error_message: str | None
    created_at: str
    updated_at: str


class ProjectWorkflowAutomationRunRequest(ProjectWorkflowSchema):
    idempotency_key: str | None = Field(default=None, max_length=255)
    payload: dict[str, Any] = Field(default_factory=dict)


class TaskExecutionBindingUpsert(ProjectWorkflowSchema):
    version: int | None = Field(default=None, ge=1)
    actor: ExecutionActorRef | None = None
    workflow_id: str | None = Field(default=None, max_length=64)
    repository_binding_id: str | None = Field(default=None, max_length=64)
    execution_target: ExecutionTargetRef
    workspace_mode: WorkspaceMode = "git_worktree"
    start_after_save: bool = False

    @model_validator(mode="after")
    def validate_binding(self) -> "TaskExecutionBindingUpsert":
        if bool(self.actor) == bool(self.workflow_id):
            raise ValueError("exactly one of actor or workflowId is required")
        return self


class TaskExecutionBindingView(ProjectWorkflowSchema):
    id: int
    item_id: str
    target_type: Literal[
        "project_agent",
        "project_squad",
        "wegent_team",
        "workflow",
    ]
    target_id: str
    target_snapshot: dict[str, Any]
    repository_binding_id: str | None
    execution_target: ExecutionTargetRef
    workspace_mode: WorkspaceMode
    created_by_user_id: int
    version: int
    created_at: str
    updated_at: str


class WorkflowRunStart(ProjectWorkflowSchema):
    idempotency_key: str = Field(min_length=1, max_length=128)
    trigger_message_id: str | None = Field(default=None, min_length=1, max_length=64)


class WorkflowAction(ProjectWorkflowSchema):
    version: int = Field(ge=1)
    reason: str | None = Field(default=None, max_length=2_000)


class WorkflowRunView(ProjectWorkflowSchema):
    id: str
    item_id: str
    workflow_definition_id: str | None
    status: Literal[
        "pending",
        "waiting_approval",
        "queued",
        "running",
        "blocked",
        "failed",
        "cancelled",
        "completed",
    ]
    current_group_key: str | None
    trigger_message_id: str | None
    repository_binding_id: str | None
    execution_target: ExecutionTargetRef
    execution_target_snapshot: dict[str, Any]
    failure_code: str | None
    failure_message: str | None
    version: int
    created_at: str
    updated_at: str


WorkflowArtifactType = Literal[
    "requirements_analysis",
    "implementation_plan",
    "code_change_summary",
    "test_report",
    "review_report",
    "pull_request",
    "ci_summary",
    "approval_decision",
    "delivery_summary",
    "execution_result",
]


class WorkflowArtifactCreate(ProjectWorkflowSchema):
    artifact_type: WorkflowArtifactType
    schema_version: int = Field(default=1, ge=1)
    content: dict[str, Any] = Field(default_factory=dict)
    object_key: str | None = Field(default=None, max_length=1_400)
    sha256: str | None = Field(
        default=None,
        min_length=64,
        max_length=64,
        pattern=r"^[0-9a-fA-F]{64}$",
    )

    @model_validator(mode="after")
    def validate_content_location(self) -> "WorkflowArtifactCreate":
        if not self.content and not self.object_key:
            raise ValueError("artifact requires content or objectKey")
        return self


class WorkflowArtifactView(ProjectWorkflowSchema):
    id: str
    workflow_run_id: str
    stage_run_id: str
    artifact_type: WorkflowArtifactType
    schema_version: int
    content: dict[str, Any]
    object_key: str | None
    sha256: str | None
    created_at: str


class StageRunView(ProjectWorkflowSchema):
    id: str
    workflow_run_id: str
    group_key: str
    node_key: str
    node_type: WorkflowNodeType
    target_type: str | None
    target_id: str | None
    target_snapshot: dict[str, Any]
    execution_target: ExecutionTargetRef
    status: Literal[
        "pending",
        "waiting_approval",
        "queued",
        "claimed",
        "running",
        "passed",
        "failed",
        "rejected",
        "cancelled",
        "skipped",
    ]
    attempt: int
    loop_item_execution_id: int | None
    runtime_instance_id: str | None
    runtime_task_id: str | None
    workspace_id: str | None
    input_snapshot: dict[str, Any]
    output: dict[str, Any]
    failure_code: str | None
    failure_message: str | None
    version: int
    created_at: str
    updated_at: str


class WorkflowRunDetailView(WorkflowRunView):
    stages: list[StageRunView]
    artifacts: list[WorkflowArtifactView]


class TaskWorkspaceView(ProjectWorkflowSchema):
    id: str
    item_id: str
    repository_binding_id: str
    execution_target: ExecutionTargetRef
    source_workspace_path: str | None
    workspace_path: str | None
    workspace_kind: str
    branch_name: str
    base_branch: str
    head_commit: str | None
    status: str
    cleanup_policy: str
    version: int
    created_at: str
    updated_at: str


class DevelopmentCheckView(ProjectWorkflowSchema):
    id: str
    provider_check_id: str
    name: str
    status: str
    conclusion: str | None
    details_url: str | None
    started_at: str | None
    completed_at: str | None
    updated_at: str


class DevelopmentReviewThreadView(ProjectWorkflowSchema):
    id: str
    provider_thread_id: str
    provider_comment_id: str | None
    path: str | None
    line: int | None
    side: str | None
    author: str | None
    body: str
    url: str | None
    status: str
    review_state: str | None
    created_at: str
    updated_at: str


class TaskDevelopmentView(ProjectWorkflowSchema):
    id: str
    item_id: str
    repository_binding_id: str
    workspace: TaskWorkspaceView | None
    branch_name: str
    base_branch: str
    head_commit: str | None
    provider: str
    pull_request_id: str | None
    pull_request_number: int | None
    pull_request_url: str | None
    pull_request_state: str | None
    draft: bool
    mergeable_state: str | None
    review_decision: str | None
    ci_state: str | None
    merged_commit: str | None
    checks: list[DevelopmentCheckView]
    review_threads: list[DevelopmentReviewThreadView]
    version: int
    created_at: str
    updated_at: str


class PullRequestCreate(ProjectWorkflowSchema):
    title: str = Field(min_length=1, max_length=255)
    body: str = Field(default="", max_length=100_000)
    draft: bool = True


class PullRequestMerge(ProjectWorkflowSchema):
    method: Literal["merge", "squash", "rebase"] = "squash"
    version: int = Field(ge=1)


class ProviderCheckUpdate(ProjectWorkflowSchema):
    id: str = Field(min_length=1, max_length=255)
    name: str = Field(min_length=1, max_length=255)
    status: str = Field(min_length=1, max_length=24)
    conclusion: str | None = Field(default=None, max_length=32)
    details_url: str | None = Field(default=None, max_length=1_400)
    started_at: datetime | None = None
    completed_at: datetime | None = None


class ProviderReviewThreadUpdate(ProjectWorkflowSchema):
    id: str = Field(min_length=1, max_length=255)
    comment_id: str | None = Field(default=None, max_length=255)
    path: str | None = Field(default=None, max_length=700)
    line: int | None = Field(default=None, ge=1)
    side: str | None = Field(default=None, max_length=16)
    author: str | None = Field(default=None, max_length=255)
    body: str = Field(default="", max_length=100_000)
    url: str | None = Field(default=None, max_length=1_400)
    status: Literal["open", "resolved", "outdated"] = "open"
    review_state: str | None = Field(default=None, max_length=32)


class RepositoryProviderEventInput(ProjectWorkflowSchema):
    provider_event_id: str = Field(min_length=1, max_length=255)
    delivery_id: str = Field(min_length=1, max_length=255)
    event_type: str = Field(min_length=1, max_length=100)
    occurred_at: datetime | None = None
    branch_name: str | None = Field(default=None, max_length=255)
    base_branch: str | None = Field(default=None, max_length=255)
    head_commit: str | None = Field(default=None, max_length=64)
    pull_request_id: str | None = Field(default=None, max_length=100)
    pull_request_number: int | None = Field(default=None, ge=1)
    pull_request_url: str | None = Field(default=None, max_length=1_400)
    pull_request_state: str | None = Field(default=None, max_length=24)
    draft: bool | None = None
    mergeable_state: str | None = Field(default=None, max_length=32)
    review_decision: str | None = Field(default=None, max_length=32)
    ci_state: str | None = Field(default=None, max_length=24)
    merged_commit: str | None = Field(default=None, max_length=64)
    checks: list[ProviderCheckUpdate] = Field(default_factory=list)
    review_threads: list[ProviderReviewThreadUpdate] = Field(default_factory=list)


class RepositoryProviderEventView(ProjectWorkflowSchema):
    id: int
    repository_binding_id: str
    provider_event_id: str
    event_type: str
    delivery_id: str
    processing_status: str
    duplicate: bool = False
