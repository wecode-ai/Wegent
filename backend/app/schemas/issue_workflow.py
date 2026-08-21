# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Validated project orchestration definitions and per-Issue snapshots."""

from datetime import datetime
from typing import Literal, Sequence

from pydantic import AliasChoices, BaseModel, Field, field_validator, model_validator

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
WorkflowNodeType = Literal["stage", "wait"]
WaitEventAction = Literal["rerun", "complete", "continue"]
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
    # The provider that emits the event. Rules picked from the provider catalog
    # always carry it; custom rules may leave it empty to match any provider.
    provider: str | None = Field(default=None, max_length=64)
    event_type: str = Field(min_length=1, max_length=128)
    # Delivery policy (window / busy-period merge) is declared by the event
    # type in the provider catalog and is never stored on the rule.
    action: WaitEventAction = "complete"
    # Prompt used by every prompt-driven action (rerun / continue). Accepts the
    # legacy ``rerun_prompt`` key so definitions written before the rename stay
    # readable without a migration.
    prompt: str = Field(
        default="",
        max_length=20_000,
        validation_alias=AliasChoices("prompt", "rerun_prompt"),
    )

    @field_validator("provider")
    @classmethod
    def _normalize_provider(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None

    @model_validator(mode="after")
    def validate_prompt_driven_rule(self) -> "WaitEventRule":
        if self.action in {"rerun", "continue"} and not self.prompt.strip():
            raise ValueError(f"{self.action} rules require a non-empty repair prompt")
        return self


class WaitNodeConfig(BaseModel):
    rules: list[WaitEventRule] = Field(
        default_factory=list, min_length=1, max_length=20
    )
    # Robot that executes a rerun round when a matching event fires. Wait nodes
    # are robot-only: the rerun is an autonomous reaction to an external event,
    # so the human path is expressed by ``complete`` + a downstream human stage.
    agent_id: str | None = Field(default=None, max_length=64)


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


def strip_structural_nodes(
    nodes: Sequence[dict[str, object] | WorkflowNodeDefinition],
) -> list[dict[str, object]]:
    """Drop legacy start/end sentinels so stored data matches the current model.

    Old definitions and snapshots may still carry ``start``/``end`` marker
    nodes. They carry no semantics: the entry is any node without predecessors
    and the end is derived from nodes without successors. Stripping also
    rewires ``depends_on`` and the per-edge context so no dangling reference
    survives. Returns plain dicts whenever anything was stripped so the parent
    model re-validates the cleaned shape.
    """

    def node_type(node: object) -> object:
        if isinstance(node, dict):
            return node.get("node_type")
        return getattr(node, "node_type", None)

    def node_id(node: object) -> object:
        if isinstance(node, dict):
            return node.get("id")
        return getattr(node, "id", None)

    structural = {
        node_id(node)
        for node in nodes
        if node_type(node) in {"start", "end"} and node_id(node)
    }
    if not structural:
        return [node if isinstance(node, dict) else node.model_dump() for node in nodes]
    cleaned = [
        node if isinstance(node, dict) else node.model_dump()
        for node in nodes
        if node_type(node) not in {"start", "end"}
    ]
    for node in cleaned:
        depends_on = [
            dependency
            for dependency in (node.get("depends_on") or [])
            if dependency not in structural
        ]
        node["depends_on"] = depends_on
        context = node.get("dependency_context")
        if isinstance(context, dict):
            node["dependency_context"] = {
                dependency: sources
                for dependency, sources in context.items()
                if dependency not in structural
            }
    return cleaned


def require_rerun_agent(definition: "ProjectWorkflowDefinition") -> None:
    """Reject definitions whose rerun wait rules have no execution robot.

    Kept outside the schema so legacy stored definitions and Issue snapshots
    stay readable: the invariant is enforced where definitions are written
    (project save) and at rerun time, never on read.
    """

    for node in definition.nodes:
        if node.node_type != "wait" or node.wait_config is None:
            continue
        if not any(rule.action == "rerun" for rule in node.wait_config.rules):
            continue
        if not node.wait_config.agent_id:
            label = node.name or node.id
            raise ValueError(
                f"wait node {label!r} with rerun rules requires an execution robot"
            )


class ProjectWorkflowDefinition(BaseModel):
    version: int = Field(default=1, ge=1)
    stage_mode: Literal["none", "dag"] = "none"
    advancement_policy: Literal["manual", "ai"] = "manual"
    coordinator_prompt: str = Field(default="", max_length=4000)
    approval_policy: Literal["required", "automatic"] = "required"
    ai_automation_rule_id: str | None = Field(default=None, max_length=64)
    nodes: list[WorkflowNodeDefinition] = Field(default_factory=list, max_length=50)

    @model_validator(mode="before")
    @classmethod
    def normalize_legacy_definition(cls, value: object) -> object:
        if not isinstance(value, dict):
            return value
        if "stage_mode" not in value and value.get("nodes"):
            value = {**value, "stage_mode": "dag"}
        if isinstance(value.get("nodes"), list):
            value = {**value, "nodes": strip_structural_nodes(value["nodes"])}
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
    wait_round: int = Field(default=0, ge=0)
    repair_status: str | None = Field(default=None, max_length=32)
    # Set when a delivered reference for this wait node failed to register, so
    # the card can show why the listener is not receiving events.
    registration_error: str | None = Field(default=None, max_length=500)
    # Set when a continue round could not be dispatched into the current task,
    # so the card can show why a repair prompt never landed.
    continue_error: str | None = Field(default=None, max_length=500)
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
    approval_policy: Literal["required", "automatic"] = "required"
    ai_automation_rule_id: str | None = Field(default=None, max_length=64)
    orchestration_status: WorkflowOrchestrationStatus = "idle"
    active_run_id: str | None = Field(default=None, max_length=64)
    active_plan_version: int | None = Field(default=None, ge=1)
    current_stage_id: str | None = Field(default=None, max_length=64)
    nodes: list[WorkflowNodeInstance] = Field(default_factory=list, max_length=50)

    @model_validator(mode="before")
    @classmethod
    def normalize_legacy_snapshot(cls, value: object) -> object:
        if isinstance(value, dict) and isinstance(value.get("nodes"), list):
            return {**value, "nodes": strip_structural_nodes(value["nodes"])}
        return value

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


def release_blocked_nodes(
    nodes: list[WorkflowNodeInstance],
) -> list[WorkflowNodeInstance]:
    """Advance blocked nodes whose dependencies are already completed.

    Mirrors the projection pass used on persisted snapshots: a wait node enters
    ``waiting`` once its upstream work has begun, and everything else becomes
    ``ready`` once its dependencies are done.
    """

    completed = {
        node.id for node in nodes if node.status in {"completed", "forced_completed"}
    }
    statuses = {node.id: node.status for node in nodes}
    for node in nodes:
        if node.status != "blocked":
            continue
        if node.node_type == "wait":
            if not any(
                statuses.get(dependency) == "blocked" for dependency in node.depends_on
            ):
                node.status = "waiting"
                statuses[node.id] = "waiting"
            continue
        if not all(dependency in completed for dependency in node.depends_on):
            continue
        node.status = "ready"
        statuses[node.id] = node.status
    return nodes


def instantiate_workflow(
    definition: ProjectWorkflowDefinition,
) -> IssueWorkflowInstance:
    roots = {node.id for node in definition.nodes if not node.depends_on}
    nodes = [
        WorkflowNodeInstance(
            **node.model_dump(),
            status=(
                "waiting"
                if node.id in roots and node.node_type == "wait"
                else ("ready" if node.id in roots else "blocked")
            ),
        )
        for node in (definition.nodes if definition.stage_mode == "dag" else [])
    ]
    return IssueWorkflowInstance(
        definition_version=definition.version,
        stage_mode=definition.stage_mode,
        advancement_policy=definition.advancement_policy,
        coordinator_prompt=definition.coordinator_prompt,
        approval_policy=definition.approval_policy,
        ai_automation_rule_id=definition.ai_automation_rule_id,
        # Release nodes whose dependencies are already satisfied (roots are
        # ready at instantiation), mirroring the projection pass.
        nodes=release_blocked_nodes(nodes),
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
