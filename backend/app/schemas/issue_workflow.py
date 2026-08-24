# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Validated project orchestration definitions and per-Issue snapshots."""

from datetime import datetime
from typing import Any, Literal, Mapping

from pydantic import BaseModel, Field, model_validator

from app.schemas.project_chat import ProjectChatWorkspaceBinding
from app.schemas.runtime_work import (
    RuntimeGoalCreateInput,
    RuntimeSupervisorCreateInput,
)

WorkflowContextSource = Literal["final_result", "deliveries", "activity"]
WorkflowOrchestrationStatus = Literal[
    "idle",
    "planning",
    "awaiting_approval",
    "dispatching",
    "running",
    "awaiting_review",
    "paused",
    "completed",
    "failed",
]
WorkflowPlanItemAssigneeType = Literal["user", "agent", "team"]
ISSUE_WORKFLOW_SCOPE_ID = "__issue__"
DeliverableValueType = Literal[
    "text",
    "file",
    "code_snapshot",
    "git_branch",
    "pull_request",
    "url",
]
WorkflowNodeStatus = Literal[
    "blocked",
    "ready",
    "queued",
    "running",
    "awaiting_approval",
    "awaiting_deliverables",
    "changes_requested",
    "completed",
    "forced_completed",
    "failed",
]


def workflow_node_execution_mode(
    node: Mapping[str, Any],
) -> Literal["human", "robot"]:
    mode = node.get("execution_mode")
    if mode in {"human", "robot"}:
        return mode
    return "robot" if node.get("automation_rule_id") else "human"


class WorkflowExecutionConfig(BaseModel):
    """Execution choices snapshotted with a workflow or one Issue."""

    agent_id: str | None = Field(default=None, max_length=64)
    runtime_profile_id: str | None = Field(default=None, max_length=64)
    execution_device_id: str | None = Field(default=None, max_length=100)
    model: str | None = Field(default=None, max_length=255)
    model_type: Literal["public", "user", "group", "runtime"] | None = None
    model_options: dict[str, str] = Field(default_factory=dict)
    workspace_binding: ProjectChatWorkspaceBinding | None = None
    runtime_permission_mode: (
        Literal[
            "default",
            "acceptEdits",
            "plan",
            "auto",
            "bypassPermissions",
        ]
        | None
    ) = None
    execution: dict[str, Any] | None = None
    initial_goal: RuntimeGoalCreateInput | None = None
    initial_supervisor: RuntimeSupervisorCreateInput | None = None
    additional_skills: list[Any] | None = None
    attachment_ids: list[int] | None = None
    attachments: list[dict[str, Any]] | None = None
    project_plugins: list[dict[str, Any]] | None = None
    additional_context: dict[str, dict[str, Any]] | None = None
    ephemeral: bool | None = None

    @model_validator(mode="after")
    def normalize_values(self) -> "WorkflowExecutionConfig":
        self.agent_id = self.agent_id.strip() if self.agent_id else None
        self.runtime_profile_id = (
            self.runtime_profile_id.strip() if self.runtime_profile_id else None
        )
        self.execution_device_id = (
            self.execution_device_id.strip() if self.execution_device_id else None
        )
        self.model = self.model.strip() if self.model else None
        return self

    def is_complete(self) -> bool:
        return bool(
            (self.agent_id or self.execution_device_id)
            and self.model
            and self.workspace_binding
        )

    def merged_with(
        self, override: "WorkflowExecutionConfig"
    ) -> "WorkflowExecutionConfig":
        model_overridden = bool(override.model)
        return WorkflowExecutionConfig(
            agent_id=override.agent_id or self.agent_id,
            runtime_profile_id=(override.runtime_profile_id or self.runtime_profile_id),
            execution_device_id=(
                override.execution_device_id or self.execution_device_id
            ),
            model=override.model or self.model,
            model_type=(override.model_type if model_overridden else self.model_type),
            model_options=(
                override.model_options if model_overridden else self.model_options
            ),
            workspace_binding=override.workspace_binding or self.workspace_binding,
            runtime_permission_mode=(
                override.runtime_permission_mode or self.runtime_permission_mode
            ),
            execution=override.execution or self.execution,
            initial_goal=override.initial_goal or self.initial_goal,
            initial_supervisor=override.initial_supervisor or self.initial_supervisor,
            additional_skills=(
                override.additional_skills
                if override.additional_skills is not None
                else self.additional_skills
            ),
            attachment_ids=(
                override.attachment_ids
                if override.attachment_ids is not None
                else self.attachment_ids
            ),
            attachments=(
                override.attachments
                if override.attachments is not None
                else self.attachments
            ),
            project_plugins=(
                override.project_plugins
                if override.project_plugins is not None
                else self.project_plugins
            ),
            additional_context=(
                override.additional_context
                if override.additional_context is not None
                else self.additional_context
            ),
            ephemeral=(
                override.ephemeral if override.ephemeral is not None else self.ephemeral
            ),
        )

    def runtime_request_options(self) -> dict[str, Any]:
        """Return only producer-facing RuntimeTaskCreateRequest capabilities."""

        return {
            "runtime_permission_mode": self.runtime_permission_mode,
            "execution": self.execution,
            "initial_goal": (
                self.initial_goal.model_dump(by_alias=True)
                if self.initial_goal is not None
                else None
            ),
            "initial_supervisor": (
                self.initial_supervisor.model_dump(by_alias=True)
                if self.initial_supervisor is not None
                else None
            ),
            "additional_skills": self.additional_skills,
            "attachment_ids": self.attachment_ids,
            "attachments": self.attachments,
            "project_plugins": self.project_plugins,
            "additional_context": self.additional_context,
            "ephemeral": self.ephemeral,
        }


class DeliverableFileConstraints(BaseModel):
    accepted_types: list[str] = Field(default_factory=list, max_length=20)
    min_files: int = Field(default=1, ge=1, le=100)
    max_files: int = Field(default=1, ge=1, le=100)

    @model_validator(mode="after")
    def validate_file_count(self) -> "DeliverableFileConstraints":
        self.accepted_types = [
            value.strip() for value in self.accepted_types if value.strip()
        ]
        if self.max_files < self.min_files:
            raise ValueError("max_files cannot be smaller than min_files")
        return self


class DeliverableRequirement(BaseModel):
    id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=2000)
    value_type: DeliverableValueType
    file_constraints: DeliverableFileConstraints | None = None

    @model_validator(mode="after")
    def validate_requirement(self) -> "DeliverableRequirement":
        self.name = self.name.strip()
        self.description = self.description.strip()
        if not self.name:
            raise ValueError("workflow deliverable requirement name cannot be empty")
        if self.value_type == "file":
            self.file_constraints = (
                self.file_constraints or DeliverableFileConstraints()
            )
        elif self.file_constraints is not None:
            raise ValueError("file_constraints are only valid for file requirements")
        return self


class WorkflowNodeDefinition(BaseModel):
    id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    name: str = Field(min_length=1, max_length=100)
    prompt: str = Field(default="", max_length=100_000)
    # Kept only to read workflow definitions written by older clients. Stage
    # nodes are task categories, not executor kinds.
    kind: Literal["my_task", "automation", "ai"] | None = None
    execution_mode: Literal["human", "robot"] = "human"
    depends_on: list[str] = Field(default_factory=list, max_length=50)
    dependency_context: dict[str, list[WorkflowContextSource]] = Field(
        default_factory=dict
    )
    required: bool = True
    required_deliverables: list[DeliverableRequirement] = Field(
        default_factory=list, max_length=20
    )
    workspace_policy: Literal["none", "composer", "inherit"] = "composer"
    automation_rule_id: str | None = Field(default=None, max_length=64)
    execution_config: WorkflowExecutionConfig | None = None
    execution_config_override: bool = False

    @model_validator(mode="before")
    @classmethod
    def infer_legacy_execution_mode(cls, value: object) -> object:
        if (
            isinstance(value, dict)
            and "execution_mode" not in value
            and value.get("automation_rule_id")
        ):
            return {**value, "execution_mode": "robot"}
        return value

    @model_validator(mode="after")
    def validate_execution_configuration(self) -> "WorkflowNodeDefinition":
        if self.automation_rule_id and self.execution_mode != "robot":
            raise ValueError("workflow automation rule requires robot execution")
        if unknown := set(self.dependency_context) - set(self.depends_on):
            raise ValueError(
                "workflow dependency context references non-dependencies: "
                + ", ".join(sorted(unknown))
            )
        for dependency, sources in self.dependency_context.items():
            if len(sources) != len(set(sources)):
                raise ValueError(
                    f"workflow dependency context contains duplicates: {dependency}"
                )
        deliverable_ids = [requirement.id for requirement in self.required_deliverables]
        if len(deliverable_ids) != len(set(deliverable_ids)):
            raise ValueError("workflow deliverable requirement IDs must be unique")
        return self


class ProjectWorkflowDefinition(BaseModel):
    version: int = Field(default=1, ge=1)
    stage_mode: Literal["none", "dag"] = "none"
    advancement_policy: Literal["manual", "ai"] = "manual"
    coordinator_prompt: str = Field(default="", max_length=4000)
    approval_policy: Literal["required", "automatic"] = "required"
    ai_automation_rule_id: str | None = Field(default=None, max_length=64)
    execution_config: WorkflowExecutionConfig | None = None
    nodes: list[WorkflowNodeDefinition] = Field(default_factory=list, max_length=50)

    @model_validator(mode="before")
    @classmethod
    def infer_legacy_stage_mode(cls, value: object) -> object:
        if isinstance(value, dict) and "stage_mode" not in value and value.get("nodes"):
            return {**value, "stage_mode": "dag"}
        return value

    @model_validator(mode="after")
    def validate_dag(self) -> "ProjectWorkflowDefinition":
        if self.advancement_policy == "ai" and not self.ai_automation_rule_id:
            raise ValueError("AI advancement requires an AI automation rule")
        node_ids = [node.id for node in self.nodes]
        if len(node_ids) != len(set(node_ids)):
            raise ValueError("workflow node ids must be unique")
        known = set(node_ids)
        dependencies = {node.id: set(node.depends_on) for node in self.nodes}
        for node_id, node_dependencies in dependencies.items():
            if node_id in node_dependencies:
                raise ValueError("workflow node cannot depend on itself")
            if unknown := node_dependencies - known:
                raise ValueError(
                    f"workflow node dependencies do not exist: {', '.join(sorted(unknown))}"
                )
        visiting: set[str] = set()
        visited: set[str] = set()

        def visit(node_id: str) -> None:
            if node_id in visiting:
                raise ValueError("workflow dependencies must be acyclic")
            if node_id in visited:
                return
            visiting.add(node_id)
            for dependency in dependencies[node_id]:
                visit(dependency)
            visiting.remove(node_id)
            visited.add(node_id)

        for node_id in node_ids:
            visit(node_id)
        return self


class WorkflowNodeInstance(WorkflowNodeDefinition):
    status: WorkflowNodeStatus = "blocked"
    task_binding_id: str | None = Field(default=None, max_length=64)
    task_ids: list[str] = Field(default_factory=list, max_length=100)
    task_statuses: dict[str, str] = Field(default_factory=dict)
    delivery_ids: list[str] = Field(default_factory=list, max_length=100)
    decision_history: list["WorkflowNodeDecision"] = Field(
        default_factory=list, max_length=100
    )
    execution_id: int | None = Field(default=None, ge=1)
    automation_run_id: str | None = Field(default=None, max_length=64)
    execution_error: str | None = Field(default=None, max_length=2000)


class WorkflowNodeDecision(BaseModel):
    action: Literal["approve", "reject", "force_advance"]
    actor_user_id: int = Field(ge=1)
    reason: str = Field(default="", max_length=2000)
    decided_at: datetime


class WorkflowNodeDecisionRequest(BaseModel):
    action: Literal["approve", "reject", "force_advance"]
    reason: str = Field(default="", max_length=2000)

    @model_validator(mode="after")
    def validate_reason(self) -> "WorkflowNodeDecisionRequest":
        self.reason = self.reason.strip()
        if self.action in {"reject", "force_advance"} and not self.reason:
            raise ValueError(f"{self.action} requires a reason")
        return self


class IssueWorkflowInstance(BaseModel):
    version: int = Field(default=1, ge=1)
    definition_version: int = Field(default=1, ge=1)
    stage_mode: Literal["none", "dag"] = "none"
    advancement_policy: Literal["manual", "ai"] = "manual"
    coordinator_prompt: str = Field(default="", max_length=4000)
    approval_policy: Literal["required", "automatic"] = "required"
    ai_automation_rule_id: str | None = Field(default=None, max_length=64)
    execution_config: WorkflowExecutionConfig | None = None
    orchestration_status: WorkflowOrchestrationStatus = "idle"
    active_run_id: str | None = Field(default=None, max_length=64)
    active_plan_version: int | None = Field(default=None, ge=1)
    current_stage_id: str | None = Field(default=None, max_length=64)
    nodes: list[WorkflowNodeInstance] = Field(default_factory=list, max_length=50)

    @model_validator(mode="after")
    def validate_snapshot(self) -> "IssueWorkflowInstance":
        ProjectWorkflowDefinition(
            version=self.definition_version,
            stage_mode=self.stage_mode,
            advancement_policy=self.advancement_policy,
            coordinator_prompt=self.coordinator_prompt,
            approval_policy=self.approval_policy,
            ai_automation_rule_id=self.ai_automation_rule_id,
            nodes=[
                WorkflowNodeDefinition(
                    id=node.id,
                    name=node.name,
                    prompt=node.prompt,
                    kind=node.kind,
                    execution_mode=node.execution_mode,
                    depends_on=node.depends_on,
                    dependency_context=node.dependency_context,
                    required=node.required,
                    required_deliverables=node.required_deliverables,
                    workspace_policy=node.workspace_policy,
                    automation_rule_id=node.automation_rule_id,
                    execution_config=node.execution_config,
                    execution_config_override=node.execution_config_override,
                )
                for node in self.nodes
            ],
            execution_config=self.execution_config,
        )
        return self

    def execution_config_for(
        self, node: WorkflowNodeDefinition
    ) -> WorkflowExecutionConfig | None:
        if node.execution_config_override:
            if node.execution_config is None:
                return None
            if self.execution_config is None:
                return node.execution_config
            return self.execution_config.merged_with(node.execution_config)
        return self.execution_config or node.execution_config

    def node_needs_execution_config(self, node: WorkflowNodeDefinition) -> bool:
        if node.execution_mode != "robot":
            return False
        return bool(
            not (
                self.execution_config_for(node)
                and self.execution_config_for(node).is_complete()
            )
        )


def instantiate_workflow(
    definition: ProjectWorkflowDefinition,
) -> IssueWorkflowInstance:
    roots = {node.id for node in definition.nodes if not node.depends_on}
    return IssueWorkflowInstance(
        definition_version=definition.version,
        stage_mode=definition.stage_mode,
        advancement_policy=definition.advancement_policy,
        coordinator_prompt=definition.coordinator_prompt,
        approval_policy=definition.approval_policy,
        ai_automation_rule_id=definition.ai_automation_rule_id,
        execution_config=definition.execution_config,
        nodes=[
            WorkflowNodeInstance(
                **node.model_dump(),
                status="ready" if node.id in roots else "blocked",
            )
            for node in (definition.nodes if definition.stage_mode == "dag" else [])
        ],
    )


class WorkflowPlanItemCreate(BaseModel):
    client_key: str = Field(
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9_-]+$",
    )
    stage_id: str = Field(default="", max_length=64)
    title: str = Field(min_length=1, max_length=255)
    description: str = Field(default="", max_length=100_000)
    assignee_type: WorkflowPlanItemAssigneeType
    assignee_id: str = Field(min_length=1, max_length=128)
    assignee_name: str = Field(default="", max_length=255)
    rationale: str = Field(default="", max_length=4000)


class WorkflowPlanSubmit(BaseModel):
    summary: str = Field(default="", max_length=10_000)
    items: list[WorkflowPlanItemCreate] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def validate_keys(self) -> "WorkflowPlanSubmit":
        keys = [item.client_key for item in self.items]
        if len(keys) != len(set(keys)):
            raise ValueError("workflow plan item keys must be unique")
        return self


class WorkflowPlanItemView(WorkflowPlanItemCreate):
    id: str
    stage_id: str = Field(min_length=1, max_length=64)
    task_id: str | None = None
    task_status: str | None = None
    outcome_verdict: Literal["passed", "needs_rework"] | None = None
    outcome_summary: str = ""
    status: Literal["proposed", "materialized", "superseded"]


class WorkflowManagerRunView(BaseModel):
    id: str
    status: str
    model: str | None = None
    execution_environment: str | None = None
    device_id: str | None = None
    recent_activity: str = ""
    error: str | None = None
    updated_at: datetime


class WorkflowPlanView(BaseModel):
    run_id: str
    issue_id: str
    stage_id: str
    plan_version: int
    approval_policy: Literal["required", "automatic"]
    status: WorkflowOrchestrationStatus
    summary: str
    items: list[WorkflowPlanItemView]
    manager_run: WorkflowManagerRunView | None = None


class WorkflowTaskOutcomeSubmit(BaseModel):
    verdict: Literal["passed", "needs_rework"]
    summary: str = Field(min_length=1, max_length=10_000)
    findings: list[str] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def normalize_text(self) -> "WorkflowTaskOutcomeSubmit":
        self.summary = self.summary.strip()
        self.findings = [value.strip() for value in self.findings if value.strip()]
        if not self.summary:
            raise ValueError("workflow outcome summary cannot be empty")
        return self
