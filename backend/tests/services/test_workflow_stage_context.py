# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Inherited workspace predecessor resolution for workflow stages."""

from app.models.delivery import CloudProject, LoopItem, LoopItemTaskBinding
from app.schemas.issue_workflow import (
    ProjectWorkflowDefinition,
    WorkflowNodeDefinition,
    instantiate_workflow,
)
from app.services.workflow_stage_context import WorkflowStageContextResolver


def _definition() -> ProjectWorkflowDefinition:
    return ProjectWorkflowDefinition(
        version=1,
        stage_mode="dag",
        advancement_policy="manual",
        nodes=[
            WorkflowNodeDefinition(
                id="start",
                name="触发",
                node_type="event",
                role="start",
            ),
            WorkflowNodeDefinition(
                id="stepA",
                name="3",
                depends_on=["start"],
                automation_rule_id="rule-3",
                execution_mode="robot",
                workspace_policy="composer",
            ),
            WorkflowNodeDefinition(
                id="loop1",
                name="修复循环",
                node_type="loop",
                depends_on=["stepA"],
                body_node_ids=["ls", "br", "fix", "le"],
                loop_config={"max_attempts": 5},
            ),
            WorkflowNodeDefinition(
                id="ls",
                name="循环开始",
                node_type="loop_start",
                loop_id="loop1",
            ),
            WorkflowNodeDefinition(
                id="br",
                name="分支",
                node_type="branch",
                loop_id="loop1",
                depends_on=["ls"],
                event_wait={"collection_mode": "poll"},
                branch_conditions=[
                    {
                        "source_type": "gitlab",
                        "event_type": "change_request.comment_created",
                        "handler_node_ids": ["fix"],
                    },
                    {
                        "event_type": "change_request.merged",
                        "handler_node_ids": ["le"],
                    },
                ],
            ),
            WorkflowNodeDefinition(
                id="fix",
                name="2",
                node_type="task",
                loop_id="loop1",
                depends_on=["br"],
                execution_mode="robot",
                workspace_policy="inherit",
            ),
            WorkflowNodeDefinition(
                id="le",
                name="循环结束",
                node_type="loop_end",
                loop_id="loop1",
                depends_on=["br"],
            ),
        ],
    )


def _item(test_db) -> LoopItem:
    project = CloudProject(
        project_key="TESTINHERIT",
        name="Inherit context",
        status="active",
        created_by_user_id=1,
        storage_prefix="projects/testinherit",
    )
    test_db.add(project)
    test_db.flush()
    instance = instantiate_workflow(_definition())
    by_id = {node.id: node for node in instance.nodes}
    by_id["stepA"].status = "completed"
    item = LoopItem(
        cloud_project_id=str(project.id),
        title="Inherit issue",
        resource_type="task",
        status="in_progress",
        created_by_user_id=1,
        metadata_json={
            "workflow_automation": {"rule_id": "rule-1", "run_id": "run-1"},
            "workflow": instance.model_dump(mode="json"),
        },
    )
    test_db.add(item)
    test_db.flush()
    binding = LoopItemTaskBinding(
        cloud_project_id=str(project.id),
        loop_item_id=str(item.id),
        task_user_id=1,
        device_id="desktop-1",
        task_id="runtime-task-A",
        task_title="3",
        linked_by_user_id=1,
        metadata_json={
            "workflow_node_id": "stepA",
            # A stale logical queue device must not shadow the real runtime
            # device that owns the predecessor Runtime task.
            "workspace_device_id": "local-device",
        },
    )
    test_db.add(binding)
    test_db.flush()
    return item


def test_inherit_resolves_predecessor_outside_loop(test_db):
    item = _item(test_db)

    snapshot = WorkflowStageContextResolver().resolve(
        test_db,
        item=item,
        target_node_id="fix",
    )

    with_runtime = [
        dependency
        for dependency in snapshot["dependencies"]
        if dependency.get("runtime_tasks")
    ]
    assert with_runtime
    assert with_runtime[-1]["stage_id"] == "stepA"
    assert with_runtime[-1]["runtime_tasks"][0]["task_id"] == "runtime-task-A"
    assert with_runtime[-1]["runtime_tasks"][0]["device_id"] == "desktop-1"


def test_trigger_event_is_compiled_into_stage_instruction(test_db):
    item = _item(test_db)
    workflow = dict(item.metadata_json["workflow"])
    nodes = [dict(node) for node in workflow["nodes"]]
    fix = next(node for node in nodes if node["id"] == "fix")
    fix["trigger_event"] = {
        "source": "gitlab",
        "event_type": "change_request.comment_created",
        "event_id": "event-1",
        "subject_id": str(item.id),
        "payload": {
            "subject": {
                "provider": "gitlab",
                "url": "https://gitlab.example/acme/app/-/merge_requests/7",
                "repository": "acme/app",
                "number": 7,
            }
        },
    }
    workflow["nodes"] = nodes
    item.metadata_json = {**item.metadata_json, "workflow": workflow}
    test_db.commit()
    item = test_db.get(LoopItem, item.id)

    snapshot = WorkflowStageContextResolver().resolve(
        test_db,
        item=item,
        target_node_id="fix",
    )

    assert snapshot["trigger_event"]["payload"]["subject"]["number"] == 7
    instruction = snapshot["compiled_task_instruction"]
    assert "Provider：gitlab" in instruction
    assert "MR/PR：7" in instruction
    assert "https://gitlab.example/acme/app/-/merge_requests/7" in instruction
    assert "glab" in instruction
