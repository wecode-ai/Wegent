# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Validated project workflow definitions and per-Issue snapshots."""

from typing import Literal

from pydantic import BaseModel, Field, model_validator


class WorkflowNodeDefinition(BaseModel):
    id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    name: str = Field(min_length=1, max_length=100)
    kind: Literal["my_task", "automation", "ai"] = "my_task"
    depends_on: list[str] = Field(default_factory=list, max_length=50)
    required: bool = True
    workspace_policy: Literal["none", "composer", "inherit"] = "composer"
    automation_rule_id: str | None = Field(default=None, max_length=64)

    @model_validator(mode="after")
    def validate_execution_configuration(self) -> "WorkflowNodeDefinition":
        if self.kind in {"automation", "ai"} and not self.automation_rule_id:
            raise ValueError("automatic workflow nodes require an automation rule")
        if self.kind != "my_task" and self.workspace_policy != "none":
            raise ValueError("automatic workflow nodes cannot use a local workspace")
        if self.kind == "my_task" and self.automation_rule_id:
            raise ValueError("task workflow nodes cannot reference an automation rule")
        return self


class ProjectWorkflowDefinition(BaseModel):
    version: int = Field(default=1, ge=1)
    nodes: list[WorkflowNodeDefinition] = Field(default_factory=list, max_length=50)

    @model_validator(mode="after")
    def validate_dag(self) -> "ProjectWorkflowDefinition":
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
    status: Literal["blocked", "ready", "queued", "running", "completed", "failed"] = (
        "blocked"
    )
    task_binding_id: str | None = Field(default=None, max_length=64)
    execution_id: int | None = Field(default=None, ge=1)
    automation_run_id: str | None = Field(default=None, max_length=64)


class IssueWorkflowInstance(BaseModel):
    version: int = Field(default=1, ge=1)
    definition_version: int = Field(default=1, ge=1)
    nodes: list[WorkflowNodeInstance] = Field(default_factory=list, max_length=50)

    @model_validator(mode="after")
    def validate_snapshot(self) -> "IssueWorkflowInstance":
        ProjectWorkflowDefinition(
            version=self.definition_version,
            nodes=[
                WorkflowNodeDefinition(
                    id=node.id,
                    name=node.name,
                    kind=node.kind,
                    depends_on=node.depends_on,
                    required=node.required,
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
        nodes=[
            WorkflowNodeInstance(
                **node.model_dump(),
                status="ready" if node.id in roots else "blocked",
            )
            for node in definition.nodes
        ],
    )
