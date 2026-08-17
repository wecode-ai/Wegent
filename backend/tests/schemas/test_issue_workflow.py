import pytest
from pydantic import ValidationError

from app.schemas.issue_workflow import (
    ProjectWorkflowDefinition,
    instantiate_workflow,
)


def test_workflow_definition_instantiates_ready_roots() -> None:
    definition = ProjectWorkflowDefinition.model_validate(
        {
            "version": 3,
            "nodes": [
                {
                    "id": "develop",
                    "name": "开发",
                    "kind": "my_task",
                    "depends_on": [],
                    "workspace_policy": "composer",
                },
                {
                    "id": "test",
                    "name": "测试",
                    "kind": "my_task",
                    "depends_on": ["develop"],
                    "workspace_policy": "inherit",
                },
            ],
        }
    )

    workflow = instantiate_workflow(definition)

    assert workflow.definition_version == 3
    assert [node.status for node in workflow.nodes] == ["ready", "blocked"]


@pytest.mark.parametrize(
    "nodes",
    [
        [
            {"id": "same", "name": "A", "depends_on": []},
            {"id": "same", "name": "B", "depends_on": []},
        ],
        [{"id": "self", "name": "Self", "depends_on": ["self"]}],
        [
            {"id": "a", "name": "A", "depends_on": ["b"]},
            {"id": "b", "name": "B", "depends_on": ["a"]},
        ],
        [{"id": "a", "name": "A", "depends_on": ["missing"]}],
    ],
)
def test_workflow_definition_rejects_invalid_dag(nodes: list[dict]) -> None:
    with pytest.raises(ValidationError):
        ProjectWorkflowDefinition.model_validate({"version": 1, "nodes": nodes})


@pytest.mark.parametrize(
    "node",
    [
        {
            "id": "automation",
            "name": "自动化",
            "kind": "automation",
            "workspace_policy": "none",
        },
        {
            "id": "ai",
            "name": "AI 分配",
            "kind": "ai",
            "workspace_policy": "composer",
            "automation_rule_id": "rule-1",
        },
        {
            "id": "task",
            "name": "我的任务",
            "kind": "my_task",
            "automation_rule_id": "rule-1",
        },
    ],
)
def test_workflow_definition_rejects_invalid_execution_configuration(
    node: dict,
) -> None:
    with pytest.raises(ValidationError):
        ProjectWorkflowDefinition.model_validate({"version": 1, "nodes": [node]})


def test_workflow_definition_accepts_configured_automatic_nodes() -> None:
    definition = ProjectWorkflowDefinition.model_validate(
        {
            "version": 1,
            "nodes": [
                {
                    "id": "automation",
                    "name": "自动化",
                    "kind": "automation",
                    "workspace_policy": "none",
                    "automation_rule_id": "rule-1",
                }
            ],
        }
    )

    assert definition.nodes[0].automation_rule_id == "rule-1"
