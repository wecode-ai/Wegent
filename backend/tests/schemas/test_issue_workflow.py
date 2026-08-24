import pytest
from pydantic import ValidationError

from app.schemas.issue_workflow import (
    IssueWorkflowInstance,
    ProjectWorkflowDefinition,
    instantiate_workflow,
    require_rerun_agent,
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


def test_workflow_definition_rejects_legacy_start_and_end_node_types() -> None:
    # The DAG is bounded by derivation (entry has no predecessors), so
    # structural start/end marker nodes are no longer part of the model.
    with pytest.raises(ValidationError):
        ProjectWorkflowDefinition.model_validate(
            {
                "version": 1,
                "stage_mode": "dag",
                "nodes": [
                    {
                        "id": "start",
                        "name": "开始",
                        "node_type": "start",
                        "depends_on": [],
                        "workspace_policy": "none",
                    },
                    {
                        "id": "develop",
                        "name": "开发",
                        "depends_on": ["start"],
                        "workspace_policy": "composer",
                    },
                    {
                        "id": "end",
                        "name": "结束",
                        "node_type": "end",
                        "depends_on": ["develop"],
                        "workspace_policy": "none",
                    },
                ],
            }
        )


def test_workflow_instantiation_activates_wait_node_before_upstream_completes() -> None:
    definition = ProjectWorkflowDefinition.model_validate(
        {
            "version": 1,
            "stage_mode": "dag",
            "advancement_policy": "manual",
            "nodes": [
                {
                    "id": "develop",
                    "name": "开发并提交 MR",
                    "depends_on": [],
                    "workspace_policy": "composer",
                },
                {
                    "id": "wait",
                    "name": "等待外部事件",
                    "node_type": "wait",
                    "depends_on": ["develop"],
                    "workspace_policy": "none",
                    "wait_config": {
                        "rules": [
                            {
                                "id": "rule-merged",
                                "event_type": "merged",
                                "action": "complete",
                            }
                        ]
                    },
                },
            ],
        }
    )

    workflow = instantiate_workflow(definition)

    # The wait node listens while its upstream stage is still running so the
    # robot can register the external reference during the stage execution.
    assert [node.status for node in workflow.nodes] == [
        "ready",
        "waiting",
    ]


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


def test_workflow_definition_accepts_wait_nodes_with_rules() -> None:
    definition = ProjectWorkflowDefinition.model_validate(
        {
            "version": 1,
            "stage_mode": "dag",
            "nodes": [
                {"id": "develop", "name": "Develop", "node_type": "stage"},
                {
                    "id": "wait",
                    "name": "Wait",
                    "node_type": "wait",
                    "depends_on": ["develop"],
                    "wait_config": {
                        "rules": [
                            {
                                "id": "merged",
                                "event_type": "merged",
                                "action": "complete",
                            },
                            {
                                "id": "ci",
                                "event_type": "ci_failed",
                                "action": "rerun",
                                "rerun_prompt": "Fix the pipeline",
                            },
                        ]
                    },
                },
            ],
        }
    )

    assert [node.node_type for node in definition.nodes] == [
        "stage",
        "wait",
    ]
    wait = definition.nodes[1]
    assert wait.wait_config is not None
    assert [rule.event_type for rule in wait.wait_config.rules] == [
        "merged",
        "ci_failed",
    ]


def test_wait_rule_provider_is_optional_and_normalized() -> None:
    definition = ProjectWorkflowDefinition.model_validate(
        {
            "version": 1,
            "stage_mode": "dag",
            "nodes": [
                {
                    "id": "wait",
                    "name": "Wait",
                    "node_type": "wait",
                    "depends_on": [],
                    "wait_config": {
                        "rules": [
                            {
                                "id": "merged",
                                "provider": " gitlab ",
                                "event_type": "merged",
                                "action": "complete",
                            },
                            {
                                "id": "custom",
                                "provider": "",
                                "event_type": "my_event",
                                "action": "rerun",
                                "rerun_prompt": "Retry the custom event",
                            },
                            {
                                "id": "legacy",
                                "event_type": "ci_failed",
                                "action": "rerun",
                                "rerun_prompt": "Fix the pipeline",
                            },
                        ]
                    },
                },
            ],
        }
    )
    rules = definition.nodes[0].wait_config.rules
    assert rules[0].provider == "gitlab"
    assert rules[1].provider is None
    assert rules[2].provider is None


def test_rerun_rule_requires_non_blank_prompt() -> None:
    with pytest.raises(ValidationError, match="non-empty repair prompt"):
        ProjectWorkflowDefinition.model_validate(
            {
                "version": 1,
                "stage_mode": "dag",
                "nodes": [
                    {
                        "id": "wait",
                        "name": "Wait",
                        "node_type": "wait",
                        "depends_on": [],
                        "wait_config": {
                            "rules": [
                                {
                                    "id": "ci",
                                    "event_type": "ci_failed",
                                    "action": "rerun",
                                    "rerun_prompt": "   ",
                                },
                            ]
                        },
                    },
                ],
            }
        )


def test_root_wait_node_instantiates_waiting() -> None:
    definition = ProjectWorkflowDefinition.model_validate(
        {
            "version": 1,
            "stage_mode": "dag",
            "nodes": [
                {
                    "id": "wait",
                    "name": "Wait",
                    "node_type": "wait",
                    "depends_on": [],
                    "wait_config": {
                        "rules": [
                            {
                                "id": "merged",
                                "event_type": "merged",
                                "action": "complete",
                            },
                        ]
                    },
                },
            ],
        }
    )

    workflow = instantiate_workflow(definition)

    assert [node.status for node in workflow.nodes] == ["waiting"]


def test_wait_rule_ignores_legacy_mode_keys() -> None:
    definition = ProjectWorkflowDefinition.model_validate(
        {
            "version": 1,
            "stage_mode": "dag",
            "nodes": [
                {
                    "id": "wait",
                    "name": "Wait",
                    "node_type": "wait",
                    "wait_config": {
                        "rules": [
                            {
                                "id": "merged",
                                "event_type": "merged",
                                "action": "complete",
                            },
                            {
                                "id": "ci",
                                "event_type": "ci_failed",
                                "mode": "debounce",
                                "action": "rerun",
                                "rerun_prompt": "Fix the pipeline",
                            },
                        ]
                    },
                },
            ],
        }
    )
    rules = definition.nodes[0].wait_config.rules
    assert [rule.event_type for rule in rules] == ["merged", "ci_failed"]
    # Delivery policy moved to the provider catalog: a persisted ``mode`` key
    # from older definitions is tolerated and dropped, never validated.
    assert "mode" not in rules[1].model_dump()


def test_workflow_definition_rejects_wait_node_without_config() -> None:
    with pytest.raises(ValidationError):
        ProjectWorkflowDefinition.model_validate(
            {
                "version": 1,
                "nodes": [
                    {"id": "wait", "name": "Wait", "node_type": "wait"},
                ],
            }
        )


def test_require_rerun_agent_accepts_complete_only_wait_node() -> None:
    definition = ProjectWorkflowDefinition.model_validate(
        {
            "version": 1,
            "stage_mode": "dag",
            "nodes": [
                {
                    "id": "wait",
                    "name": "Wait",
                    "node_type": "wait",
                    "wait_config": {
                        "rules": [
                            {
                                "id": "merged",
                                "event_type": "merged",
                                "action": "complete",
                            },
                        ]
                    },
                },
            ],
        }
    )
    require_rerun_agent(definition)


def test_require_rerun_agent_rejects_rerun_rule_without_robot() -> None:
    definition = ProjectWorkflowDefinition.model_validate(
        {
            "version": 1,
            "stage_mode": "dag",
            "nodes": [
                {
                    "id": "wait",
                    "name": "Wait",
                    "node_type": "wait",
                    "wait_config": {
                        "rules": [
                            {
                                "id": "ci",
                                "event_type": "ci_failed",
                                "action": "rerun",
                                "rerun_prompt": "Fix the pipeline",
                            },
                        ]
                    },
                },
            ],
        }
    )
    with pytest.raises(ValueError, match="requires an execution robot"):
        require_rerun_agent(definition)


def test_require_rerun_agent_accepts_rerun_rule_with_robot() -> None:
    definition = ProjectWorkflowDefinition.model_validate(
        {
            "version": 1,
            "stage_mode": "dag",
            "nodes": [
                {
                    "id": "wait",
                    "name": "Wait",
                    "node_type": "wait",
                    "wait_config": {
                        "agent_id": "robot-1",
                        "rules": [
                            {
                                "id": "ci",
                                "event_type": "ci_failed",
                                "action": "rerun",
                                "rerun_prompt": "Fix the pipeline",
                            },
                        ],
                    },
                },
            ],
        }
    )
    require_rerun_agent(definition)


def test_workflow_definition_rejects_config_on_stage_nodes() -> None:
    with pytest.raises(ValidationError):
        ProjectWorkflowDefinition.model_validate(
            {
                "version": 1,
                "nodes": [
                    {
                        "id": "stage",
                        "name": "Stage",
                        "wait_config": {
                            "rules": [
                                {
                                    "id": "r",
                                    "event_type": "merged",
                                    "action": "complete",
                                }
                            ]
                        },
                    },
                ],
            }
        )


def test_workflow_definition_rejects_multiple_legacy_start_nodes() -> None:
    with pytest.raises(ValidationError):
        ProjectWorkflowDefinition.model_validate(
            {
                "version": 1,
                "nodes": [
                    {"id": "s1", "name": "S1", "node_type": "start"},
                    {"id": "s2", "name": "S2", "node_type": "start"},
                    {"id": "stage", "name": "Stage", "depends_on": ["s1", "s2"]},
                ],
            }
        )


def test_workflow_snapshot_rejects_legacy_start_and_end_node_types() -> None:
    with pytest.raises(ValidationError):
        IssueWorkflowInstance.model_validate(
            {
                "version": 1,
                "definition_version": 1,
                "stage_mode": "dag",
                "advancement_policy": "manual",
                "nodes": [
                    {
                        "id": "start",
                        "name": "开始",
                        "node_type": "start",
                        "status": "completed",
                    },
                    {
                        "id": "develop",
                        "name": "开发",
                        "depends_on": ["start"],
                        "status": "ready",
                    },
                    {
                        "id": "end",
                        "name": "结束",
                        "node_type": "end",
                        "depends_on": ["develop"],
                        "status": "blocked",
                    },
                ],
            }
        )
