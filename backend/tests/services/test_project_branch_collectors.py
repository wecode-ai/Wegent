# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Branch event collectors: auto-create, reuse and terminal release."""

import os
import pathlib

import pytest

from app.models.delivery import (
    CloudProject,
    LoopItem,
    LoopItemTaskBinding,
    ProjectIncomingHook,
    loop_datetime_is_unset,
    loop_datetime_value_is_unset,
)
from app.schemas.issue_workflow import (
    ProjectWorkflowDefinition,
    WorkflowNodeDefinition,
    instantiate_workflow,
)
from app.schemas.project_incoming_hook import ChangeRequestBindingInput
from app.services.machine_cli_credentials import machine_cli_token
from app.services.project_branch_collectors import (
    ensure_branch_collectors,
    release_item_collectors,
)
from app.services.project_change_request_bindings import (
    project_change_request_binding_service,
)
from app.services.project_incoming_hooks import project_incoming_hook_service


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
                id="loop1",
                name="修复循环",
                node_type="loop",
                depends_on=["start"],
                body_node_ids=["ls", "br", "fix1", "le"],
                loop_config={"max_attempts": 5},
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
                    "source_type": "gitlab",
                    "collection_mode": "poll",
                    "poll_interval_seconds": 120,
                },
                branch_conditions=[
                    {
                        "event_type": "change_request.comment_created",
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


def _project(test_db) -> CloudProject:
    project = CloudProject(
        project_key="TESTBRANCH",
        name="Branch collector",
        status="active",
        created_by_user_id=1,
        storage_prefix="projects/testbranch",
    )
    test_db.add(project)
    test_db.flush()
    return project


def _item(
    test_db,
    project: CloudProject,
    *,
    armed: bool = True,
    mr_number: int = 7,
) -> LoopItem:
    instance = instantiate_workflow(_definition())
    by_id = {node.id: node for node in instance.nodes}
    if armed:
        by_id["start"].status = "completed"
        by_id["loop1"].loop_state = "active"
        by_id["loop1"].status = "running"
        by_id["ls"].status = "completed"
        by_id["br"].status = "waiting"
    item = LoopItem(
        cloud_project_id=str(project.id),
        title="Branch collector issue",
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
        task_id="runtime-task-1",
        task_title="Branch collector issue",
        linked_by_user_id=1,
        metadata_json={},
    )
    test_db.add(binding)
    test_db.flush()
    project_change_request_binding_service.upsert(
        test_db,
        binding=binding,
        values=ChangeRequestBindingInput(
            provider="gitlab",
            url=f"https://gitlab.example/acme/app/-/merge_requests/{mr_number}",
            number=mr_number,
            head_branch="fix/comment",
            base_branch="main",
            head_commit="abc1234",
            source="delivery",
        ),
    )
    return item


def _nodes(item: LoopItem) -> list[dict]:
    return [
        dict(node)
        for node in item.metadata_json["workflow"]["nodes"]
        if isinstance(node, dict)
    ]


def _hook_count(test_db, project: CloudProject, mode: str) -> int:
    return (
        test_db.query(ProjectIncomingHook)
        .filter(
            ProjectIncomingHook.cloud_project_id == str(project.id),
            ProjectIncomingHook.status == "active",
            loop_datetime_is_unset(ProjectIncomingHook.deleted_at),
        )
        .count()
    )


def test_ensure_creates_poll_collector_and_records_node_state(test_db):
    project = _project(test_db)
    item = _item(test_db, project)
    nodes = _nodes(item)

    created = ensure_branch_collectors(test_db, item, nodes=nodes)

    assert created == 1
    assert _hook_count(test_db, project, "poll") == 1
    hook = (
        test_db.query(ProjectIncomingHook)
        .filter(ProjectIncomingHook.cloud_project_id == str(project.id))
        .one()
    )
    metadata = project_incoming_hook_service.metadata(hook)
    assert metadata["source_type"] == "gitlab"
    assert metadata["collection_mode"] == "poll"
    assert metadata["credential_ref"] == "machine-cli"
    assert metadata["scope"] == {"source": "branch_wait"}
    assert metadata["resource"]["path"] == "acme/app"
    branch = next(node for node in nodes if node["id"] == "br")
    assert branch["collector_id"] == str(hook.id)
    assert branch["collector_state"]["mode"] == "poll"
    assert branch["collector_state"]["status"] == "active"


def test_ensure_is_idempotent(test_db):
    project = _project(test_db)
    item = _item(test_db, project)
    nodes = _nodes(item)

    assert ensure_branch_collectors(test_db, item, nodes=nodes) == 1
    test_db.flush()
    created = ensure_branch_collectors(test_db, item, nodes=nodes)

    assert created == 0
    assert _hook_count(test_db, project, "poll") == 1


def test_release_disables_collector_when_workflow_terminal(test_db):
    project = _project(test_db)
    item = _item(test_db, project)
    nodes = _nodes(item)
    ensure_branch_collectors(test_db, item, nodes=nodes)
    hook_id = next(node for node in nodes if node["id"] == "br")["collector_id"]

    for node in nodes:
        node["status"] = "completed"
    released = release_item_collectors(test_db, item, nodes=nodes)

    assert released == 1
    hook = test_db.get(ProjectIncomingHook, hook_id)
    assert hook.status == "disabled"
    assert not loop_datetime_value_is_unset(hook.deleted_at)


def test_release_keeps_shared_collector_for_other_item(test_db):
    project = _project(test_db)
    first = _item(test_db, project)
    second = _item(test_db, project, armed=True, mr_number=8)
    first_nodes = _nodes(first)
    second_nodes = _nodes(second)
    ensure_branch_collectors(test_db, first, nodes=first_nodes)
    ensure_branch_collectors(test_db, second, nodes=second_nodes)
    assert _hook_count(test_db, project, "poll") == 1
    hook_id = next(node for node in first_nodes if node["id"] == "br")["collector_id"]

    for node in first_nodes:
        node["status"] = "completed"
    released = release_item_collectors(test_db, first, nodes=first_nodes)

    assert released == 0
    hook = test_db.get(ProjectIncomingHook, hook_id)
    assert hook.status == "active"
    assert hook.metadata_json["branch_wait_refs"] == {str(second.id): ["br"]}


def test_machine_cli_token_reads_glab_config(tmp_path, monkeypatch):
    config = tmp_path / "glab.yml"
    config.write_text(
        "hosts:\n"
        "  gitlab.example:\n"
        "    token: glpat-test\n"
        "    api_host: gitlab.example\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("GLAB_CONFIG", str(config))

    token = machine_cli_token(
        source_type="gitlab",
        instance_url="https://gitlab.example",
    )

    assert token == "glpat-test"


def test_machine_cli_token_missing_raises(tmp_path, monkeypatch):
    monkeypatch.setenv("GLAB_CONFIG", str(tmp_path / "missing.yml"))

    with pytest.raises(ValueError, match="glab is not logged in"):
        machine_cli_token(source_type="gitlab", instance_url="https://gitlab.example")


def test_machine_cli_github_falls_back_to_hosts_file(tmp_path, monkeypatch):
    monkeypatch.delenv("GLAB_CONFIG", raising=False)
    home = tmp_path / "home"
    hosts = home / ".config" / "gh" / "hosts.yml"
    hosts.parent.mkdir(parents=True)
    hosts.write_text(
        "github.example:\n" "  oauth_token: gho-test\n" "  user: dev\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HOME", str(home))

    token = machine_cli_token(source_type="github", instance_url="github.example")

    assert token == "gho-test"
