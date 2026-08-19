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


def test_workflow_definition_validates_dependency_context() -> None:
    definition = ProjectWorkflowDefinition.model_validate(
        {
            "version": 1,
            "stage_mode": "dag",
            "nodes": [
                {"id": "develop", "name": "Develop", "depends_on": []},
                {
                    "id": "test",
                    "name": "Test",
                    "depends_on": ["develop"],
                    "dependency_context": {
                        "develop": ["final_result", "deliveries", "activity"]
                    },
                },
            ],
        }
    )

    assert definition.nodes[1].dependency_context["develop"] == [
        "final_result",
        "deliveries",
        "activity",
    ]

    with pytest.raises(ValidationError, match="non-dependencies"):
        ProjectWorkflowDefinition.model_validate(
            {
                "version": 1,
                "stage_mode": "dag",
                "nodes": [
                    {"id": "develop", "name": "Develop", "depends_on": []},
                    {
                        "id": "test",
                        "name": "Test",
                        "depends_on": ["develop"],
                        "dependency_context": {"missing": ["final_result"]},
                    },
                ],
            }
        )


@pytest.mark.parametrize("workspace_policy", ["none", "composer", "inherit"])
def test_workflow_definition_accepts_automatic_workspace_policies(
    workspace_policy: str,
) -> None:
    definition = ProjectWorkflowDefinition.model_validate(
        {
            "version": 1,
            "nodes": [
                {
                    "id": "automation",
                    "name": "自动化",
                    "depends_on": ["previous"] if workspace_policy == "inherit" else [],
                    "workspace_policy": workspace_policy,
                    "automation_rule_id": "rule-1",
                },
                *(
                    [
                        {
                            "id": "previous",
                            "name": "前序",
                            "workspace_policy": "composer",
                        }
                    ]
                    if workspace_policy == "inherit"
                    else []
                ),
            ],
        }
    )

    assert definition.nodes[0].automation_rule_id == "rule-1"
    assert definition.nodes[0].workspace_policy == workspace_policy


def test_workflow_definition_requires_a_rule_for_ai_advancement() -> None:
    with pytest.raises(ValidationError):
        ProjectWorkflowDefinition.model_validate(
            {"version": 1, "advancement_policy": "ai"}
        )
