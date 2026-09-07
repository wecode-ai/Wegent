# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""End-to-end loop routing over webhook and polling delivery, plus catch-up."""

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest

from app.models.delivery import (
    CloudProject,
    LoopItem,
    LoopItemTaskBinding,
    ProjectIncomingEvent,
    ProjectIncomingHook,
)
from app.schemas.issue_workflow import (
    ProjectWorkflowDefinition,
    WorkflowExecutionConfig,
    WorkflowNodeDefinition,
    instantiate_workflow,
)
from app.schemas.project_incoming_hook import ChangeRequestBindingInput
from app.services.connector_connections import connector_connection_service
from app.services.project_automation_domain import utcnow
from app.services.project_change_request_bindings import (
    project_change_request_binding_service,
)
from app.services.project_event_polling import PolledInput, PollPage
from app.services.project_event_polling_service import (
    project_event_polling_service,
)
from app.services.project_incoming_hooks import project_incoming_hook_service


def _definition() -> ProjectWorkflowDefinition:
    return ProjectWorkflowDefinition(
        version=1,
        stage_mode="dag",
        advancement_policy="manual",
        execution_config=WorkflowExecutionConfig(
            agent_id="agent-1",
            model="model-1",
            workspace_binding={"type": "standalone"},
        ),
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
                    "source_type": "github",
                    "collection_mode": "webhook",
                },
                branch_conditions=[
                    {
                        "event_type": "change_request.checks_failed",
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


def _project(test_db, key: str) -> CloudProject:
    project = CloudProject(
        project_key=key,
        name=f"Loop {key}",
        status="active",
        created_by_user_id=1,
        storage_prefix=f"projects/{key.lower()}",
    )
    test_db.add(project)
    test_db.flush()
    return project


def _item(test_db, project: CloudProject, *, armed: bool = True) -> LoopItem:
    instance = instantiate_workflow(_definition())
    if not armed:
        for node in instance.nodes:
            if node.node_type == "branch":
                node.status = "blocked"
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
    binding = LoopItemTaskBinding(
        cloud_project_id=str(project.id),
        loop_item_id=str(item.id),
        task_user_id=1,
        device_id="desktop-1",
        task_id="runtime-task-1",
        task_title="Loop issue",
        linked_by_user_id=1,
        metadata_json={},
    )
    test_db.add(binding)
    test_db.flush()
    project_change_request_binding_service.upsert(
        test_db,
        binding=binding,
        values=ChangeRequestBindingInput(
            provider="github",
            url="https://github.example/acme/app/pull/7",
            number=7,
            head_branch="fix/checks",
            base_branch="main",
            head_commit="abc1234",
            source="runtime",
        ),
    )
    return item


def _github_subscription(test_db, project: CloudProject) -> ProjectIncomingHook:
    hook = ProjectIncomingHook(
        public_id="loop-webhook-subscription",
        cloud_project_id=str(project.id),
        name="GitHub",
        source="github",
        status="active",
        created_by_user_id=1,
        metadata_json={
            "schema_version": 1,
            "source_type": "github",
            "collection_mode": "webhook",
            "resource": {
                "resource_type": "repository",
                "instance_url": "https://github.example",
                "external_id": "acme/app",
                "path": "acme/app",
                "url": "https://github.example/acme/app",
                "display_name": "acme/app",
            },
        },
    )
    test_db.add(hook)
    test_db.flush()
    return hook


def _connect_github(test_db) -> None:
    connector_connection_service.save_oauth_connection(
        test_db,
        slug="github",
        user_id=1,
        access_token="github-token",
        refresh_token=None,
        token_type="bearer",
        granted_scopes=["repo"],
        external_account_name="octocat",
        expires_at=None,
    )


def _check_failure_payload() -> dict:
    return {
        "action": "completed",
        "check_run": {
            "id": 100,
            "status": "completed",
            "conclusion": "failure",
            "head_sha": "abc1234",
            "pull_requests": [
                {
                    "number": 7,
                    "html_url": "https://github.example/acme/app/pull/7",
                    "head": {"ref": "fix/checks", "sha": "abc1234"},
                    "base": {"ref": "main"},
                }
            ],
        },
        "repository": {
            "id": 42,
            "full_name": "acme/app",
            "html_url": "https://github.example/acme/app",
        },
    }


@pytest.mark.asyncio
async def test_webhook_event_routes_to_armed_loop(test_db, monkeypatch):
    project = _project(test_db, "WLOOP")
    subscription = _github_subscription(test_db, project)
    item = _item(test_db, project)
    run_for_workflow_node = AsyncMock(return_value={"id": "run-fix"})
    monkeypatch.setattr(
        "app.services.project_automations.project_automation_service.run_for_workflow_node",
        run_for_workflow_node,
    )
    event = ProjectIncomingEvent(
        public_id="loop-webhook-event",
        cloud_project_id=str(project.id),
        parent_id=str(subscription.id),
        title="github: check_run",
        source="github",
        status="received",
        created_by_user_id=1,
        metadata_json={
            "schema_version": 1,
            "collection_mode": "webhook",
            "attempt_count": 0,
            "payload": _check_failure_payload(),
            "headers": {"x-github-event": "check_run"},
        },
    )
    test_db.add(event)
    test_db.commit()

    await project_incoming_hook_service.process_event(test_db, str(event.id))

    test_db.refresh(item)
    by_id = {node["id"]: node for node in item.metadata_json["workflow"]["nodes"]}
    assert by_id["br"]["status"] == "reacting"
    assert by_id["br"]["active_condition"] == "github:change_request.checks_failed"
    assert by_id["fix1"]["status"] == "ready"
    run_for_workflow_node.assert_awaited_once()
    assert run_for_workflow_node.await_args.args[4] == "fix1"


@pytest.mark.asyncio
async def test_polled_event_routes_to_armed_loop(test_db, test_user, monkeypatch):
    project = _project(test_db, "PLOOP")
    hook = ProjectIncomingHook(
        public_id="loop-poll-subscription",
        cloud_project_id=str(project.id),
        name="GitHub polling",
        source="github",
        status="active",
        due_at=datetime(2020, 1, 1),
        created_by_user_id=1,
        metadata_json={
            "schema_version": 1,
            "source_type": "github",
            "collection_mode": "poll",
            "credential_ref": "github",
            "resource": {
                "resource_type": "repository",
                "instance_url": "https://github.example",
                "external_id": "acme/app",
                "path": "acme/app",
                "url": "https://github.example/acme/app",
                "display_name": "acme/app",
            },
            "poll": {
                "interval_seconds": 300,
                "cursor": None,
                "failure_count": 0,
            },
            "health": {"status": "pending"},
        },
    )
    test_db.add(hook)
    test_db.flush()
    item = _item(test_db, project)
    _connect_github(test_db)
    run_for_workflow_node = AsyncMock(return_value={"id": "run-fix"})
    monkeypatch.setattr(
        "app.services.project_automations.project_automation_service.run_for_workflow_node",
        run_for_workflow_node,
    )

    class FakePoller:
        async def fetch_page(self, *, resource, credential, cursor):
            return PollPage(
                inputs=(
                    PolledInput(
                        identity="check_run:1",
                        title="github: check_run 1",
                        payload=_check_failure_payload(),
                        headers={"x-github-event": "check_run"},
                    ),
                ),
                next_cursor={"watermark": "2026-08-27T00:00:00Z", "page": 1},
                complete=True,
            )

    monkeypatch.setattr(
        "app.services.project_event_polling_service.poller_for",
        lambda _source_type: FakePoller(),
    )

    discovered = await project_event_polling_service.poll_subscription(
        test_db,
        str(hook.id),
    )
    assert discovered == 1
    persisted = (
        test_db.query(ProjectIncomingEvent)
        .filter(ProjectIncomingEvent.parent_id == str(hook.id))
        .all()
    )
    assert persisted and persisted[0].status == "processed"
    await project_incoming_hook_service.process_event(test_db, str(persisted[0].id))

    test_db.refresh(item)
    by_id = {node["id"]: node for node in item.metadata_json["workflow"]["nodes"]}
    assert by_id["br"]["status"] == "reacting"
    assert by_id["fix1"]["status"] == "ready"
    run_for_workflow_node.assert_awaited_once()
    assert run_for_workflow_node.await_args.args[4] == "fix1"


def _persisted_event(
    test_db,
    project: CloudProject,
    subscription: ProjectIncomingHook,
    *,
    public_id: str,
    created_at: datetime,
) -> ProjectIncomingEvent:
    event = ProjectIncomingEvent(
        public_id=public_id,
        cloud_project_id=str(project.id),
        parent_id=str(subscription.id),
        title="github: check_run",
        source="github",
        status="processed",
        created_by_user_id=1,
        created_at=created_at,
        metadata_json={
            "schema_version": 1,
            "collection_mode": subscription.metadata_json["collection_mode"],
            "attempt_count": 1,
            "payload": _check_failure_payload(),
            "normalized_events": [
                {
                    "event_type": "change_request.checks_failed",
                    "resource": {},
                    "subject": {
                        "type": "change_request",
                        "id": "7",
                        "provider": "github",
                        "instance_url": "https://github.example",
                        "repository": "acme/app",
                        "number": 7,
                        "head_commit": "abc1234",
                    },
                }
            ],
        },
    )
    test_db.add(event)
    test_db.flush()
    return event


@pytest.mark.parametrize(
    "collection_mode",
    ["webhook", "poll"],
)
def test_loop_catches_up_events_received_before_arming(test_db, collection_mode):
    project = _project(test_db, f"CAT{collection_mode.upper()}")
    subscription = ProjectIncomingHook(
        public_id=f"loop-catchup-{collection_mode}",
        cloud_project_id=str(project.id),
        name="GitHub",
        source="github",
        status="active",
        created_by_user_id=1,
        metadata_json={
            "schema_version": 1,
            "source_type": "github",
            "collection_mode": collection_mode,
            "resource": {},
        },
    )
    test_db.add(subscription)
    test_db.flush()
    item = _item(test_db, project, armed=False)
    _persisted_event(
        test_db,
        project,
        subscription,
        public_id=f"loop-catchup-event-{collection_mode}",
        created_at=utcnow() - timedelta(minutes=5),
    )
    workflow = dict(item.metadata_json["workflow"])
    nodes = [dict(node) for node in workflow["nodes"]]
    loop = next(node for node in nodes if node["node_type"] == "loop")
    loop["activated_at"] = (utcnow() - timedelta(minutes=10)).isoformat()
    loop["catch_up_done"] = False
    workflow["nodes"] = nodes
    item.metadata_json = {**item.metadata_json, "workflow": workflow}
    test_db.commit()

    from app.services.project_workflow_projection import apply_workflow_nodes

    apply_workflow_nodes(test_db, item, workflow=workflow, nodes=nodes)

    test_db.commit()
    test_db.refresh(item)
    by_id = {node["id"]: node for node in item.metadata_json["workflow"]["nodes"]}
    assert by_id["br"]["status"] == "reacting"
    assert by_id["br"]["active_condition"] == "github:change_request.checks_failed"
    assert by_id["fix1"]["status"] == "ready"
