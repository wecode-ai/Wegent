import pytest
from pydantic import ValidationError

from app.schemas.issue_workflow import (
    ProjectWorkflowDefinition,
    WorkflowExecutionConfig,
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


def test_issue_snapshot_uses_shared_config_unless_node_overrides_it() -> None:
    shared = WorkflowExecutionConfig(
        agent_id="shared-agent",
        runtime_profile_id="shared-runtime",
        model="shared-model",
        workspace_binding={"type": "backend_project", "projectId": 1},
    )
    node = WorkflowExecutionConfig(
        agent_id="node-agent",
        runtime_profile_id="node-runtime",
        model="node-model",
        workspace_binding={"type": "backend_project", "projectId": 2},
    )
    workflow = instantiate_workflow(
        ProjectWorkflowDefinition(
            stage_mode="dag",
            execution_config=shared,
            nodes=[
                {
                    "id": "build",
                    "name": "Build",
                    "depends_on": [],
                    "automation_rule_id": "rule-1",
                    "execution_config": node,
                }
            ],
        )
    )

    assert workflow.execution_config_for(workflow.nodes[0]).agent_id == "shared-agent"
    workflow.nodes[0].execution_config_override = True
    assert workflow.execution_config_for(workflow.nodes[0]).agent_id == "node-agent"


def test_custom_robot_config_is_complete_without_runtime_profile() -> None:
    config = WorkflowExecutionConfig(
        execution_device_id="device-1",
        model="custom-model",
        workspace_binding={"type": "standalone"},
    )

    assert config.is_complete()


def test_node_execution_config_merges_with_shared_robot_config() -> None:
    workflow = instantiate_workflow(
        ProjectWorkflowDefinition(
            stage_mode="dag",
            execution_config=WorkflowExecutionConfig(
                agent_id="shared-agent",
                execution_device_id="device-1",
                model="shared-model",
                workspace_binding={
                    "type": "backend_project",
                    "projectId": 1,
                },
            ),
            nodes=[
                {
                    "id": "build",
                    "name": "Build",
                    "depends_on": [],
                    "automation_rule_id": "rule-1",
                    "execution_config_override": True,
                    "execution_config": {"model": "override-model"},
                }
            ],
        )
    )

    config = workflow.execution_config_for(workflow.nodes[0])

    assert config is not None
    assert config.agent_id == "shared-agent"
    assert config.runtime_profile_id is None
    assert config.execution_device_id == "device-1"
    assert config.model == "override-model"
    assert config.workspace_binding is not None
    assert config.workspace_binding.project_id == 1


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


def test_ai_stage_constraints_reject_execution_configuration() -> None:
    with pytest.raises(
        ValidationError,
        match="AI stage constraints cannot define execution configuration: develop",
    ):
        ProjectWorkflowDefinition.model_validate(
            {
                "version": 1,
                "stage_mode": "dag",
                "advancement_policy": "ai",
                "ai_automation_rule_id": "manager-rule",
                "nodes": [
                    {
                        "id": "develop",
                        "name": "开发",
                        "execution_mode": "robot",
                        "execution_config": {
                            "execution_device_id": "local-device",
                            "model": "gpt-5.6-codex",
                            "workspace_binding": {"type": "standalone"},
                        },
                    }
                ],
            }
        )


def test_workflow_node_preserves_unconfigured_robot_execution() -> None:
    definition = ProjectWorkflowDefinition.model_validate(
        {
            "version": 1,
            "stage_mode": "dag",
            "nodes": [
                {
                    "id": "develop",
                    "name": "开发",
                    "depends_on": [],
                    "execution_mode": "robot",
                    "automation_rule_id": None,
                }
            ],
        }
    )

    workflow = instantiate_workflow(definition)

    assert workflow.nodes[0].execution_mode == "robot"
    assert workflow.nodes[0].automation_rule_id is None
    assert workflow.node_needs_execution_config(workflow.nodes[0])


def test_workflow_node_infers_robot_execution_for_legacy_automation_rule() -> None:
    definition = ProjectWorkflowDefinition.model_validate(
        {
            "version": 1,
            "stage_mode": "dag",
            "nodes": [
                {
                    "id": "develop",
                    "name": "开发",
                    "depends_on": [],
                    "automation_rule_id": "rule-1",
                }
            ],
        }
    )

    assert definition.nodes[0].execution_mode == "robot"
