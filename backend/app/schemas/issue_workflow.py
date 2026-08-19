# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Validated project orchestration definitions and per-Issue snapshots."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

WorkflowContextSource = Literal["final_result", "deliveries", "activity"]
DeliverableValueType = Literal[
    "text",
    "file",
    "code_snapshot",
    "git_branch",
    "pull_request",
    "url",
]
WorkflowNodeType = Literal["stage", "wait", "start", "end"]
WaitEventMode = Literal["trigger", "debounce"]
WaitEventAction = Literal["rerun", "complete"]
WorkflowNodeStatus = Literal[
    "blocked",
    "ready",
    "queued",
    "running",
    "waiting",
    "awaiting_approval",
    "awaiting_deliverables",
    "changes_requested",
    "completed",
    "forced_completed",
    "failed",
]


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


class WaitEventRule(BaseModel):
    id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    event_type: str = Field(min_length=1, max_length=128)
    mode: WaitEventMode = "trigger"
    action: WaitEventAction = "complete"
    rerun_prompt: str = Field(default="", max_length=20_000)


class WaitNodeConfig(BaseModel):
    rules: list[WaitEventRule] = Field(default_factory=list, min_length=1, max_length=20)


class WorkflowNodeDefinition(BaseModel):
    id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    name: str = Field(min_length=1, max_length=100)
    prompt: str = Field(default="", max_length=100_000)
    node_type: WorkflowNodeType = "stage"
    wait_config: WaitNodeConfig | None = None
    # Kept only to read workflow definitions written by older clients. Stage
    # nodes are task categories, not executor kinds.
    kind: Literal["my_task", "automation", "ai"] | None = None
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

    @model_validator(mode="after")
    def validate_execution_configuration(self) -> "WorkflowNodeDefinition":
        if self.node_type == "wait":
            if self.wait_config is None:
                raise ValueError("wait nodes require wait_config")
            if self.automation_rule_id:
                raise ValueError("wait nodes cannot run an automation stage")
        elif self.wait_config is not None:
            raise ValueError("only wait nodes may define wait_config")
        if self.node_type == "start" and self.depends_on:
            raise ValueError("start node cannot depend on other nodes")
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
    ai_automation_rule_id: str | None = Field(default=None, max_length=64)
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
        start_nodes = [node for node in self.nodes if node.node_type == "start"]
        if len(start_nodes) > 1:
            raise ValueError("workflow must have at most one start node")
        end_node_ids = {node.id for node in self.nodes if node.node_type == "end"}
        if end_node_ids:
            dependents = {
                dependency
                for node in self.nodes
                for dependency in node.depends_on
                if dependency in end_node_ids
            }
            if dependents:
                raise ValueError("end node cannot be a dependency of other nodes")
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
    wait_round: int = Field(default=0, ge=0)
    decision_history: list["WorkflowNodeDecision"] = Field(
        default_factory=list, max_length=100
    )
    execution_id: int | None = Field(default=None, ge=1)
    automation_run_id: str | None = Field(default=None, max_length=64)


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
    ai_automation_rule_id: str | None = Field(default=None, max_length=64)
    nodes: list[WorkflowNodeInstance] = Field(default_factory=list, max_length=50)

    @model_validator(mode="after")
    def validate_snapshot(self) -> "IssueWorkflowInstance":
        ProjectWorkflowDefinition(
            version=self.definition_version,
            stage_mode=self.stage_mode,
            advancement_policy=self.advancement_policy,
            coordinator_prompt=self.coordinator_prompt,
            ai_automation_rule_id=self.ai_automation_rule_id,
            nodes=[
                WorkflowNodeDefinition(
                    id=node.id,
                    name=node.name,
                    prompt=node.prompt,
                    node_type=node.node_type,
                    wait_config=node.wait_config,
                    kind=node.kind,
                    depends_on=node.depends_on,
                    dependency_context=node.dependency_context,
                    required=node.required,
                    required_deliverables=node.required_deliverables,
                    workspace_policy=node.workspace_policy,
                    automation_rule_id=node.automation_rule_id,
                )
                for node in self.nodes
            ],
        )
        return self


def instantiate_workflow(
    definition: ProjectWorkflowDefinition,
) -> IssueWorkflowInstance:
    roots = {node.id for node in definition.nodes if not node.depends_on}
    return IssueWorkflowInstance(
        definition_version=definition.version,
        stage_mode=definition.stage_mode,
        advancement_policy=definition.advancement_policy,
        coordinator_prompt=definition.coordinator_prompt,
        ai_automation_rule_id=definition.ai_automation_rule_id,
        nodes=[
            WorkflowNodeInstance(
                **node.model_dump(),
                status="ready" if node.id in roots else "blocked",
            )
            for node in (definition.nodes if definition.stage_mode == "dag" else [])
        ],
    )
