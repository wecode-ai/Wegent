# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Loop + branch event-wait state machine behavior."""

from datetime import datetime, timedelta, timezone

import pytest

from app.models.delivery import (
    CloudProject,
    LoopItem,
    LoopItemTaskBinding,
    ProjectAutomationRule,
    ProjectAutomationRun,
)
from app.schemas.issue_workflow import (
    ProjectWorkflowDefinition,
    WorkflowNodeDefinition,
    instantiate_workflow,
)
from app.services.project_automation_domain import ProjectAutomationEvent
from app.services.project_automation_execution import ProjectAutomationProcessor
from app.services.workflow_loop_runtime import (
    advance_loops,
    advance_root_branches,
    route_event_to_workflow_loop,
    scan_loop_timeouts,
)


def _nodes(
    *,
    max_attempts: int = 5,
    timeout_seconds: int | None = None,
) -> list[WorkflowNodeDefinition]:
    return [
        WorkflowNodeDefinition(
            id="start",
            name="触发",
            node_type="event",
            role="start",
        ),
        WorkflowNodeDefinition(
            id="loop1",
            name="修复循环",
            node_type="loop",
            depends_on=["start"],
            body_node_ids=["ls", "br", "fix1", "le"],
            loop_config={
                "max_attempts": max_attempts,
                "timeout_seconds": timeout_seconds,
            },
        ),
        WorkflowNodeDefinition(id="after", name="发布", depends_on=["loop1"]),
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
            event_wait={
                "collection_mode": "poll",
            },
            branch_conditions=[
                {
                    "event_type": "task.status_changed",
                    "handler_node_ids": ["fix1"],
                },
                {
                    "event_type": "change_request.merged",
                    "handler_node_ids": ["le"],
                },
            ],
        ),
        WorkflowNodeDefinition(
            id="fix1",
            name="修复",
            loop_id="loop1",
            depends_on=["br"],
            automation_rule_id="r1",
            execution_mode="robot",
        ),
        WorkflowNodeDefinition(
            id="le",
            name="循环结束",
            node_type="loop_end",
            loop_id="loop1",
            depends_on=["br"],
        ),
    ]


def _instance(max_attempts: int = 5, timeout_seconds: int | None = None):
    definition = ProjectWorkflowDefinition(
        stage_mode="dag",
        advancement_policy="manual",
        nodes=_nodes(max_attempts=max_attempts, timeout_seconds=timeout_seconds),
    )
    return instantiate_workflow(definition)


def _by_id(nodes):
    return {node["id"]: node for node in nodes}


def _root_branch_instance():
    definition = ProjectWorkflowDefinition(
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
                id="br1",
                name="分支",
                node_type="branch",
                depends_on=["start"],
                branch_conditions=[
                    {
                        "event_type": "task.status_changed",
                        "handler_node_ids": ["fix1"],
                    },
                ],
            ),
            WorkflowNodeDefinition(
                id="fix1",
                name="修复",
                depends_on=["br1"],
                automation_rule_id="r1",
                execution_mode="robot",
            ),
            WorkflowNodeDefinition(id="after", name="收尾", depends_on=["br1"]),
        ],
    )
    return instantiate_workflow(definition)


def test_instantiate_arms_root_branch_without_dispatching_it():
    nodes = [node.model_dump(mode="json") for node in _root_branch_instance().nodes]
    by_id = _by_id(nodes)
    assert by_id["br1"]["status"] == "waiting"
    assert by_id["fix1"]["status"] == "blocked"
    assert by_id["after"]["status"] == "blocked"


def test_root_branch_reacts_releases_handlers_and_completes():
    nodes = [node.model_dump(mode="json") for node in _root_branch_instance().nodes]
    by_id = _by_id(nodes)
    by_id["br1"]["status"] = "reacting"
    by_id["br1"]["active_condition"] = "wework:task.status_changed"
    advance_root_branches(nodes)
    assert by_id["fix1"]["status"] == "ready"
    assert by_id["br1"]["status"] == "reacting"
    by_id["fix1"]["status"] = "completed"
    advance_root_branches(nodes)
    assert by_id["br1"]["status"] == "completed"
    assert by_id["br1"]["active_condition"] is None


def test_root_branch_skips_sibling_handlers_that_did_not_match():
    definition = ProjectWorkflowDefinition(
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
                id="br1",
                name="分支",
                node_type="branch",
                depends_on=["start"],
                branch_conditions=[
                    {
                        "event_type": "change_request.comment_created",
                        "handler_node_ids": ["fix1"],
                    },
                    {
                        "event_type": "change_request.merged",
                        "handler_node_ids": ["merge1"],
                    },
                ],
            ),
            WorkflowNodeDefinition(
                id="fix1",
                name="按评论修复",
                depends_on=["br1"],
                automation_rule_id="r1",
                execution_mode="robot",
            ),
            WorkflowNodeDefinition(
                id="merge1",
                name="合并后收尾",
                depends_on=["br1"],
                automation_rule_id="r2",
                execution_mode="robot",
            ),
        ],
    )
    nodes = [
        node.model_dump(mode="json") for node in instantiate_workflow(definition).nodes
    ]
    by_id = _by_id(nodes)
    by_id["br1"]["status"] = "reacting"
    by_id["br1"]["active_condition"] = "github:change_request.comment_created"
    advance_root_branches(nodes)
    assert by_id["fix1"]["status"] == "ready"
    assert by_id["merge1"]["status"] == "blocked"
    by_id["fix1"]["status"] = "completed"
    advance_root_branches(nodes)
    assert by_id["br1"]["status"] == "completed"
    assert by_id["merge1"]["status"] == "completed"
    assert by_id["merge1"].get("automation_run_id") is None


def test_root_branch_ignores_unmatched_condition():
    nodes = [node.model_dump(mode="json") for node in _root_branch_instance().nodes]
    by_id = _by_id(nodes)
    by_id["br1"]["status"] = "reacting"
    by_id["br1"]["active_condition"] = "github:change_request.merged"
    advance_root_branches(nodes)
    assert by_id["br1"]["status"] == "waiting"
    assert by_id["br1"]["active_condition"] is None
    assert by_id["fix1"]["status"] == "blocked"


def test_root_branch_condition_validation():
    with pytest.raises(ValueError, match="at least one condition"):
        ProjectWorkflowDefinition(
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
                    id="br1",
                    name="分支",
                    node_type="branch",
                    depends_on=["start"],
                    branch_conditions=[],
                ),
            ],
        )
    with pytest.raises(ValueError, match="branch handler outside top-level"):
        ProjectWorkflowDefinition(
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
                    id="br1",
                    name="分支",
                    node_type="branch",
                    depends_on=["start"],
                    branch_conditions=[
                        {
                            "event_type": "task.status_changed",
                            "handler_node_ids": ["ghost"],
                        },
                    ],
                ),
            ],
        )


def test_instantiate_arms_branch_after_loop_activation():
    instance = _instance()
    nodes = [node.model_dump(mode="json") for node in instance.nodes]
    by_id = _by_id(nodes)
    assert by_id["start"]["status"] == "completed"
    assert by_id["loop1"]["loop_state"] == "active"
    assert by_id["br"]["status"] == "waiting"
    assert by_id["fix1"]["status"] == "blocked"
    assert by_id["after"]["status"] == "blocked"


def test_reaction_releases_handlers_and_reams_branch():
    nodes = [node.model_dump(mode="json") for node in _instance().nodes]
    by_id = _by_id(nodes)
    by_id["br"]["status"] = "reacting"
    by_id["br"]["active_condition"] = "wework:task.status_changed"
    advance_loops(nodes)
    assert by_id["fix1"]["status"] == "ready"
    by_id["fix1"]["status"] = "completed"
    advance_loops(nodes)
    assert by_id["br"]["status"] == "waiting"
    assert by_id["loop1"]["attempts"] == 1
    assert by_id["loop1"]["loop_state"] == "active"


def test_loop_end_completes_loop():
    nodes = [node.model_dump(mode="json") for node in _instance().nodes]
    by_id = _by_id(nodes)
    by_id["br"]["status"] = "reacting"
    by_id["br"]["active_condition"] = "github:change_request.merged"
    advance_loops(nodes)
    # A loop_end reached by an event ends the loop in the same advance pass.
    assert by_id["le"]["status"] == "completed"
    assert by_id["loop1"]["loop_state"] == "completed"
    assert by_id["loop1"]["exit_reason"] == "loop_end"


def test_max_attempts_completes_loop():
    nodes = [node.model_dump(mode="json") for node in _instance(max_attempts=1).nodes]
    by_id = _by_id(nodes)
    by_id["br"]["status"] = "reacting"
    by_id["br"]["active_condition"] = "wework:task.status_changed"
    advance_loops(nodes)
    by_id["fix1"]["status"] = "completed"
    advance_loops(nodes)
    assert by_id["loop1"]["loop_state"] == "completed"
    assert by_id["loop1"]["exit_reason"] == "max_attempts"


def _sequential_instance(max_attempts: int = 2):
    definition = ProjectWorkflowDefinition(
        stage_mode="dag",
        advancement_policy="manual",
        nodes=[
            WorkflowNodeDefinition(
                id="start", name="触发", node_type="event", role="start"
            ),
            WorkflowNodeDefinition(
                id="loop1",
                name="顺序循环",
                node_type="loop",
                depends_on=["start"],
                body_node_ids=["ls", "t1", "t2"],
                loop_config={"max_attempts": max_attempts},
            ),
            WorkflowNodeDefinition(id="after", name="发布", depends_on=["loop1"]),
            WorkflowNodeDefinition(
                id="ls", name="循环开始", node_type="loop_start", loop_id="loop1"
            ),
            WorkflowNodeDefinition(
                id="t1",
                name="步骤一",
                loop_id="loop1",
                depends_on=["ls"],
                automation_rule_id="r1",
                execution_mode="robot",
            ),
            WorkflowNodeDefinition(
                id="t2",
                name="步骤二",
                loop_id="loop1",
                depends_on=["t1"],
                automation_rule_id="r2",
                execution_mode="robot",
            ),
        ],
    )
    return instantiate_workflow(definition)


def test_sequential_loop_without_branch_runs_body_and_repeats():
    nodes = [node.model_dump(mode="json") for node in _sequential_instance().nodes]
    by_id = _by_id(nodes)
    # Activation arms the first body step without dispatching it.
    assert by_id["start"]["status"] == "completed"
    assert by_id["loop1"]["loop_state"] == "active"
    assert by_id["ls"]["status"] == "completed"
    assert by_id["t1"]["status"] == "ready"
    assert by_id["t2"]["status"] == "blocked"

    # First pass: t1 then t2 run to completion.
    by_id["t1"]["status"] = "completed"
    advance_loops(nodes)
    assert by_id["t2"]["status"] == "ready"
    by_id["t2"]["status"] = "completed"
    advance_loops(nodes)
    assert by_id["loop1"]["attempts"] == 1
    assert by_id["loop1"]["loop_state"] == "active"
    # Loop resets the body for the next pass; t1 is armed again.
    assert by_id["t1"]["status"] == "ready"
    assert by_id["t2"]["status"] == "blocked"

    # Second pass completes the loop at the attempt cap.
    by_id["t1"]["status"] = "completed"
    advance_loops(nodes)
    by_id["t2"]["status"] = "completed"
    advance_loops(nodes)
    assert by_id["loop1"]["loop_state"] == "completed"
    assert by_id["loop1"]["exit_reason"] == "max_attempts"
    assert by_id["loop1"]["attempts"] == 2


def test_pending_events_are_consumed_serially():
    nodes = [node.model_dump(mode="json") for node in _instance().nodes]
    by_id = _by_id(nodes)
    by_id["br"]["status"] = "reacting"
    by_id["br"]["active_condition"] = "wework:task.status_changed"
    by_id["br"]["pending_events"] = [
        {
            "source": "wework",
            "event_type": "task.status_changed",
            "event_id": "evt-2",
            "subject_id": "s",
        }
    ]
    advance_loops(nodes)
    by_id["fix1"]["status"] = "completed"
    advance_loops(nodes)
    assert by_id["br"]["status"] == "reacting"
    assert by_id["br"]["active_condition"] == "wework:task.status_changed"
    assert by_id["fix1"]["status"] == "ready"
    assert by_id["loop1"]["attempts"] == 1


def test_timeout_completes_loop():
    nodes = [
        node.model_dump(mode="json") for node in _instance(timeout_seconds=60).nodes
    ]
    by_id = _by_id(nodes)
    by_id["loop1"]["loop_deadline"] = (
        datetime.now(timezone.utc) - timedelta(seconds=1)
    ).isoformat()
    advance_loops(nodes)
    assert by_id["loop1"]["loop_state"] == "completed"
    assert by_id["loop1"]["exit_reason"] == "timeout"


def _workflow_item(test_db, *, max_attempts: int = 5) -> tuple[CloudProject, LoopItem]:
    project = CloudProject(
        project_key="LOOP",
        name="Loop project",
        created_by_user_id=1,
        storage_prefix="projects/loop",
    )
    test_db.add(project)
    test_db.flush()
    instance = _instance(max_attempts=max_attempts)
    item = LoopItem(
        cloud_project_id=str(project.id),
        title="Loop issue",
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
    return project, item


def test_route_event_reacts_to_armed_branch(test_db):
    _, item = _workflow_item(test_db)
    routed = route_event_to_workflow_loop(
        test_db,
        ProjectAutomationEvent(
            event_type="task.status_changed",
            project_id=str(item.cloud_project_id),
            subject_id=str(item.id),
            source="wework",
            actor_user_id=1,
            payload={"title": "processing"},
            event_id="evt-1",
            subscription_id="subscription-1",
        ),
    )
    assert routed is not None
    workflow = routed.metadata_json["workflow"]
    by_id = {node["id"]: node for node in workflow["nodes"]}
    assert by_id["br"]["status"] == "reacting"
    assert by_id["fix1"]["status"] == "ready"


def test_route_event_queues_while_reacting(test_db):
    _, item = _workflow_item(test_db)
    route_event_to_workflow_loop(
        test_db,
        ProjectAutomationEvent(
            event_type="task.status_changed",
            project_id=str(item.cloud_project_id),
            subject_id=str(item.id),
            source="wework",
            actor_user_id=1,
            payload={"title": "processing"},
            event_id="evt-1",
            subscription_id="subscription-1",
        ),
    )
    routed = route_event_to_workflow_loop(
        test_db,
        ProjectAutomationEvent(
            event_type="task.status_changed",
            project_id=str(item.cloud_project_id),
            subject_id=str(item.id),
            source="wework",
            actor_user_id=1,
            payload={"title": "processing again"},
            event_id="evt-2",
            subscription_id="subscription-1",
        ),
    )
    by_id = {node["id"]: node for node in routed.metadata_json["workflow"]["nodes"]}
    assert by_id["br"]["status"] == "reacting"
    assert [entry["event_id"] for entry in by_id["br"]["pending_events"]] == ["evt-2"]


def test_route_event_ignores_unmatched_event(test_db):
    _, item = _workflow_item(test_db)
    routed = route_event_to_workflow_loop(
        test_db,
        ProjectAutomationEvent(
            event_type="change_request.comment_created",
            project_id=str(item.cloud_project_id),
            subject_id=str(item.id),
            source="wework",
            actor_user_id=1,
            payload={"title": "comment"},
            event_id="evt-3",
            subscription_id="subscription-1",
        ),
    )
    assert routed is None


def test_route_event_uses_subject_binding_instead_of_transport_subscription(test_db):
    _, item = _workflow_item(test_db)
    routed = route_event_to_workflow_loop(
        test_db,
        ProjectAutomationEvent(
            event_type="task.status_changed",
            project_id=str(item.cloud_project_id),
            subject_id=str(item.id),
            source="wework",
            actor_user_id=1,
            payload={"title": "processing"},
            event_id="evt-other-subscription",
            subscription_id="subscription-2",
        ),
    )
    assert routed is item


def test_route_event_matches_platform_specific_condition(test_db):
    project, item = _workflow_item(test_db)
    binding = LoopItemTaskBinding(
        cloud_project_id=str(project.id),
        loop_item_id=str(item.id),
        task_user_id=1,
        device_id="desktop-1",
        task_id="runtime-task-1",
        task_title="Loop issue",
        linked_by_user_id=1,
        metadata_json={
            "change_requests": [
                {
                    "provider": "gitlab",
                    "instance_url": "https://gitlab.example",
                    "repository": "acme/app",
                    "number": 7,
                }
            ]
        },
    )
    test_db.add(binding)
    test_db.flush()
    workflow = dict(item.metadata_json["workflow"])
    nodes = [dict(node) for node in workflow["nodes"]]
    branch = next(node for node in nodes if node["id"] == "br")
    branch["branch_conditions"] = [
        {
            "source_type": "github",
            "event_type": "change_request.merged",
            "handler_node_ids": ["fix1"],
            "collection_mode": None,
        },
        {
            "source_type": "gitlab",
            "event_type": "change_request.merged",
            "handler_node_ids": ["le"],
            "collection_mode": None,
        },
    ]
    workflow["nodes"] = nodes
    item.metadata_json = {**item.metadata_json, "workflow": workflow}
    test_db.commit()
    item = test_db.get(LoopItem, item.id)
    branch = next(
        node for node in item.metadata_json["workflow"]["nodes"] if node["id"] == "br"
    )
    assert branch["branch_conditions"] == [
        {
            "source_type": "github",
            "event_type": "change_request.merged",
            "handler_node_ids": ["fix1"],
            "collection_mode": None,
        },
        {
            "source_type": "gitlab",
            "event_type": "change_request.merged",
            "handler_node_ids": ["le"],
            "collection_mode": None,
        },
    ]

    routed = route_event_to_workflow_loop(
        test_db,
        ProjectAutomationEvent(
            event_type="change_request.merged",
            project_id=str(project.id),
            subject_id=str(item.id),
            source="gitlab",
            actor_user_id=1,
            payload={
                "title": "merged",
                "subject": {
                    "provider": "gitlab",
                    "instance_url": "https://gitlab.example",
                    "repository": "acme/app",
                    "number": 7,
                },
            },
            event_id="evt-gitlab-merged",
            subscription_id="subscription-1",
        ),
    )

    assert routed is item
    by_id = {node["id"]: node for node in routed.metadata_json["workflow"]["nodes"]}
    assert by_id["br"]["active_condition"] == "gitlab:change_request.merged"
    assert by_id["le"]["status"] == "completed"
    assert by_id["fix1"].get("automation_run_id") is None


def test_scan_loop_timeouts_completes_expired_loop(test_db):
    _, item = _workflow_item(test_db, max_attempts=5)
    workflow = dict(item.metadata_json["workflow"])
    nodes = [dict(node) for node in workflow["nodes"]]
    loop = next(node for node in nodes if node["node_type"] == "loop")
    loop["loop_deadline"] = (
        datetime.now(timezone.utc) - timedelta(seconds=1)
    ).isoformat()
    workflow["nodes"] = nodes
    item.metadata_json = {**item.metadata_json, "workflow": workflow}
    test_db.commit()

    assert scan_loop_timeouts(test_db) == 1
    test_db.refresh(item)
    loop = next(
        node
        for node in item.metadata_json["workflow"]["nodes"]
        if node["node_type"] == "loop"
    )
    assert loop["loop_state"] == "completed"
    assert loop["exit_reason"] == "timeout"


@pytest.mark.asyncio
async def test_process_with_runs_routes_event_to_loop_without_new_run(test_db):
    project, item = _workflow_item(test_db)
    rule = ProjectAutomationRule(
        cloud_project_id=str(project.id),
        title="Loop rule",
        status="enabled",
        created_by_user_id=1,
        metadata_json={
            "trigger_type": "event",
            "event_type": "task.status_changed",
            "event_config": {"transition": "entered_processing"},
        },
    )
    test_db.add(rule)
    test_db.flush()

    processor = ProjectAutomationProcessor()
    runs = await processor.process_with_runs(
        test_db,
        ProjectAutomationEvent(
            event_type="task.status_changed",
            project_id=str(project.id),
            subject_id=str(item.id),
            source="wework",
            actor_user_id=1,
            payload={"title": "processing", "status": "in_progress"},
            event_id="loop-event-1",
            subscription_id="subscription-1",
        ),
    )

    assert runs == []
    assert test_db.query(ProjectAutomationRun).count() == 0
    test_db.refresh(item)
    by_id = {node["id"]: node for node in item.metadata_json["workflow"]["nodes"]}
    assert by_id["br"]["status"] == "reacting"
    assert by_id["fix1"]["status"] == "ready"


def _terminal_loop_item(test_db) -> LoopItem:
    project = CloudProject(
        project_key="LOOPEND",
        name="Loop end project",
        created_by_user_id=1,
        storage_prefix="projects/loopend",
    )
    test_db.add(project)
    test_db.flush()
    definition = ProjectWorkflowDefinition(
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
                id="loop1",
                name="修复循环",
                node_type="loop",
                depends_on=["start"],
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
                branch_conditions=[
                    {
                        "source_type": "wework",
                        "event_type": "change_request.merged",
                        "handler_node_ids": ["le"],
                    },
                ],
            ),
            WorkflowNodeDefinition(
                id="fix",
                name="修复",
                node_type="task",
                loop_id="loop1",
                depends_on=["br"],
                automation_rule_id="fix-rule",
                execution_mode="robot",
                workspace_policy="none",
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
    instance = instantiate_workflow(definition)
    item = LoopItem(
        cloud_project_id=str(project.id),
        title="Loop end issue",
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
    return item


def test_route_event_projects_terminal_loop_to_review(test_db):
    item = _terminal_loop_item(test_db)

    routed = route_event_to_workflow_loop(
        test_db,
        ProjectAutomationEvent(
            event_type="change_request.merged",
            project_id=str(item.cloud_project_id),
            subject_id=str(item.id),
            source="wework",
            actor_user_id=1,
            payload={"title": "merged"},
            event_id="evt-merged",
            subscription_id="subscription-1",
        ),
    )

    assert routed is not None
    workflow = routed.metadata_json["workflow"]
    by_id = {node["id"]: node for node in workflow["nodes"]}
    assert by_id["loop1"]["exit_reason"] == "loop_end"
    assert by_id["le"]["status"] == "completed"
    assert routed.status == "in_review"
