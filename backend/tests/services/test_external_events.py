# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Tests for the external event subscription service."""

import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.models.delivery import (
    ExternalEventBinding,
    LoopItem,
    ProjectAutomationRun,
    ProjectChatAgent,
    loop_datetime_is_unset,
)
from app.models.loop_item_execution import LoopItemExecution
from app.models.user import User
from app.schemas.issue_workflow import instantiate_workflow
from app.services.external_events.adapters import NormalizedExternalEvent
from app.services.external_events.binding import external_event_binding_service
from app.services.external_events.buffer import ExternalEventBuffer
from app.services.external_events.evaluate import external_event_evaluation_service
from app.services.loop_items.service import loop_item_service


class FakeRedis:
    """Minimal in-memory Redis stand-in for buffer tests."""

    def __init__(self) -> None:
        self.store: dict[bytes, bytes] = {}

    def get(self, key: bytes | str) -> bytes | None:
        return self.store.get(key if isinstance(key, bytes) else key.encode())

    def set(self, key: bytes | str, value: bytes | str, ex: int | None = None) -> bool:
        self.store[key if isinstance(key, bytes) else key.encode()] = (
            value if isinstance(value, bytes) else value.encode()
        )
        return True

    def delete(self, *keys: bytes | str) -> int:
        count = 0
        for key in keys:
            encoded = key if isinstance(key, bytes) else key.encode()
            if encoded in self.store:
                del self.store[encoded]
                count += 1
        return count

    def scan_iter(self, pattern: str = "*", count: int = 100):
        del count
        prefix = pattern.split("*")[0].encode()
        return (key for key in self.store if key.startswith(prefix))

    def pipeline(self):
        return FakePipeline(self)


class FakePipeline:
    def __init__(self, redis: FakeRedis) -> None:
        self.redis = redis
        self.commands: list[tuple] = []

    def set(self, key: bytes | str, value: bytes | str, ex: int | None = None):
        self.commands.append(("set", key, value, ex))
        return self

    def execute(self) -> list[object]:
        results = []
        for command in self.commands:
            if command[0] == "set":
                results.append(self.redis.set(command[1], command[2], command[3]))
        return results


@pytest.fixture(autouse=True)
def fake_event_buffer() -> FakeRedis:
    fake = FakeRedis()
    from app.services.external_events.buffer import external_event_buffer

    original = external_event_buffer._client
    external_event_buffer._client = fake
    yield fake
    external_event_buffer._client = original


@pytest.fixture
def workflow_project(test_db: Session, test_user: User) -> CloudProject:
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key="EXT",
        name="External events project",
        description="",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{public_id}",
    )
    test_db.add(project)
    test_db.commit()
    test_db.refresh(project)
    return project


def _workflow_definition() -> dict:
    return {
        "version": 1,
        "stage_mode": "dag",
        "advancement_policy": "manual",
        "nodes": [
            {
                "id": "start-1",
                "name": "Start",
                "node_type": "start",
                "depends_on": [],
                "required": False,
                "workspace_policy": "none",
                "status": "completed",
            },
            {
                "id": "stage-1",
                "name": "Develop MR",
                "node_type": "stage",
                "depends_on": ["start-1"],
                "required": True,
                "workspace_policy": "composer",
                "status": "completed",
            },
            {
                "id": "wait-1",
                "name": "Wait external",
                "node_type": "wait",
                "depends_on": ["stage-1"],
                "required": True,
                "workspace_policy": "none",
                "status": "waiting",
                "wait_config": {
                    "rules": [
                        {
                            "id": "rule-merged",
                            "event_type": "merged",
                            "mode": "trigger",
                            "action": "complete",
                            "rerun_prompt": "",
                        },
                        {
                            "id": "rule-ci",
                            "event_type": "ci_failed",
                            "mode": "trigger",
                            "action": "rerun",
                            "rerun_prompt": "CI failed, please fix it",
                        },
                    ]
                },
            },
            {
                "id": "end-1",
                "name": "End",
                "node_type": "end",
                "depends_on": ["wait-1"],
                "required": True,
                "workspace_policy": "none",
                "status": "blocked",
            },
        ],
    }


def _issue(test_db: Session, project: CloudProject, user_id: int) -> LoopItem:
    item = LoopItem(
        id="ext-issue-1",
        cloud_project_id=project.id,
        sequence_number=1,
        created_by_user_id=user_id,
        title="External issue",
        description="",
        status="in_progress",
        priority="none",
        sort_order=0,
        metadata_json={"workflow": _workflow_definition()},
    )
    test_db.add(item)
    test_db.commit()
    test_db.refresh(item)
    return item


def _binding(
    test_db: Session,
    *,
    project: CloudProject,
    issue: LoopItem,
    user_id: int,
    opaque_ref: str = "acme/app!7",
    provider: str = "gitlab",
) -> ExternalEventBinding:
    return external_event_binding_service.create(
        test_db,
        provider=provider,
        opaque_ref=opaque_ref,
        cloud_project_id=str(project.id),
        loop_item_id=issue.id,
        issue_item_id=issue.id,
        workflow_node_id="wait-1",
        automation_run_id="run-1",
        created_by_user_id=user_id,
    )


def _merged_event() -> NormalizedExternalEvent:
    return NormalizedExternalEvent(
        provider="gitlab",
        opaque_ref="acme/app!7",
        event_type="merged",
        event_id="mr-7",
        summary="MR !7 merged",
        source_url="https://gitlab.example/acme/app/-/merge_requests/7",
        occurred_at=datetime.now(timezone.utc),
        detail={"kind": "merge_request"},
    )


def _ci_event(event_id: str = "pipeline-1") -> NormalizedExternalEvent:
    return NormalizedExternalEvent(
        provider="gitlab",
        opaque_ref="acme/app!7",
        event_type="ci_failed",
        event_id=event_id,
        summary=f"Pipeline #{event_id} failed",
        source_url=None,
        occurred_at=datetime.now(timezone.utc),
        detail={"kind": "pipeline"},
    )


def test_trigger_complete_ends_wait_node_and_issue(
    test_db: Session,
    workflow_project: CloudProject,
    test_user: User,
) -> None:
    issue = _issue(test_db, workflow_project, test_user.id)
    binding = _binding(test_db, project=workflow_project, issue=issue, user_id=test_user.id)
    test_db.commit()

    external_event_evaluation_service.evaluate_event(
        test_db, binding=binding, event=_merged_event()
    )
    test_db.commit()
    test_db.refresh(issue)

    nodes = {
        str(node["id"]): node["status"]
        for node in issue.metadata_json["workflow"]["nodes"]
    }
    assert nodes["wait-1"] == "completed"
    assert nodes["end-1"] == "completed"
    assert issue.status == "in_review"

    remaining = external_event_binding_service.route(
        test_db, provider="gitlab", opaque_ref="acme/app!7"
    )
    assert remaining == []


def test_unmatched_event_type_is_ignored(
    test_db: Session,
    workflow_project: CloudProject,
    test_user: User,
) -> None:
    issue = _issue(test_db, workflow_project, test_user.id)
    binding = _binding(test_db, project=workflow_project, issue=issue, user_id=test_user.id)
    test_db.commit()
    unrelated = NormalizedExternalEvent(
        provider="gitlab",
        opaque_ref="acme/app!7",
        event_type="review_comment",
        event_id="note-1",
        summary="New comment by alice",
        source_url=None,
        occurred_at=None,
        detail={},
    )

    external_event_evaluation_service.evaluate_event(
        test_db, binding=binding, event=unrelated
    )
    test_db.commit()
    test_db.refresh(issue)

    nodes = {
        str(node["id"]): node["status"]
        for node in issue.metadata_json["workflow"]["nodes"]
    }
    assert nodes["wait-1"] == "waiting"
    assert issue.status == "in_progress"


def test_rerun_queues_new_execution_and_bumps_round(
    test_db: Session,
    workflow_project: CloudProject,
    test_user: User,
) -> None:
    issue = _issue(test_db, workflow_project, test_user.id)
    agent = ProjectChatAgent(
        cloud_project_id=workflow_project.id,
        loop_item_id=issue.id,
        assignee_agent_id="",
        title="Fix robot",
        name="Fix robot",
        description="",
        created_by_user_id=test_user.id,
        status="active",
    )
    test_db.add(agent)
    test_db.flush()
    run = ProjectAutomationRun(
        cloud_project_id=workflow_project.id,
        parent_id="rule-1",
        loop_item_id=issue.id,
        task_id=issue.id,
        task_title=issue.title,
        assignee_agent_id=agent.id,
        source="manual",
        status="succeeded",
        created_by_user_id=test_user.id,
    )
    test_db.add(run)
    test_db.flush()
    run_id = str(run.id)
    test_db.commit()

    binding = external_event_binding_service.create(
        test_db,
        provider="gitlab",
        opaque_ref="acme/app!7",
        cloud_project_id=str(workflow_project.id),
        loop_item_id=issue.id,
        issue_item_id=issue.id,
        workflow_node_id="wait-1",
        automation_run_id=run_id,
        created_by_user_id=test_user.id,
    )
    test_db.commit()

    external_event_evaluation_service.evaluate_event(
        test_db, binding=binding, event=_ci_event()
    )
    test_db.commit()

    execution = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.automation_run_id == run_id)
        .order_by(LoopItemExecution.id.desc())
        .first()
    )
    assert execution is not None
    assert execution.status in {"pending_approval", "queued"}
    assert execution.attempt_no == 1
    test_db.refresh(issue)
    wait_node = next(
        node
        for node in issue.metadata_json["workflow"]["nodes"]
        if node["id"] == "wait-1"
    )
    assert wait_node["wait_round"] == 1
    automation = issue.metadata_json.get("automation") or {}
    assert "CI failed" in str(automation.get("prompt") or "")


def test_buffer_append_dedupe_and_take() -> None:
    buffer = ExternalEventBuffer(url="redis://fake")
    buffer._client = FakeRedis()

    buffer.append("gitlab", "acme/app!7", "merged", {"event_id": "1", "summary": "a", "event_type": "merged"})
    buffer.append("gitlab", "acme/app!7", "merged", {"event_id": "1", "summary": "a", "event_type": "merged"})
    buffer.append("gitlab", "acme/app!7", "merged", {"event_id": "2", "summary": "b", "event_type": "merged"})

    assert len(buffer.take("gitlab", "acme/app!7", "merged")) == 2
    assert buffer.take("gitlab", "acme/app!7", "merged") == []


def test_buffer_reference_compensation_and_aggregate() -> None:
    buffer = ExternalEventBuffer(url="redis://fake")
    buffer._client = FakeRedis()

    buffer.append("gitlab", "acme/app!7", "merged", {"event_id": "1", "summary": "merged", "event_type": "merged"})
    buffer.append("gitlab", "acme/app!7", "ci_failed", {"event_id": "2", "summary": "failed", "event_type": "ci_failed"})
    reference_events = buffer.take_for_reference("gitlab", "acme/app!7")
    assert {event["event_type"] for event in reference_events} == {"merged", "ci_failed"}
    assert buffer.take_for_reference("gitlab", "acme/app!7") == []

    buffer.push_aggregate(
        task_id="task-1",
        node_id="node-1",
        provider="gitlab",
        opaque_ref="acme/app!7",
        event_type="ci_failed",
    )
    buffer.append("gitlab", "acme/app!7", "ci_failed", {"event_id": "3", "summary": "again", "event_type": "ci_failed"})
    settled = buffer.take_aggregate(task_id="task-1", node_id="node-1")
    assert len(settled) == 1
    assert settled[0]["event_id"] == "3"
    assert buffer.take("gitlab", "acme/app!7", "ci_failed") == []


def test_binding_dedupe_route_and_archive(
    test_db: Session,
    workflow_project: CloudProject,
    test_user: User,
) -> None:
    issue = _issue(test_db, workflow_project, test_user.id)
    first = _binding(test_db, project=workflow_project, issue=issue, user_id=test_user.id)
    second = _binding(test_db, project=workflow_project, issue=issue, user_id=test_user.id)
    test_db.commit()

    assert first.id == second.id
    assert len(
        external_event_binding_service.route(
            test_db, provider="gitlab", opaque_ref="acme/app!7"
        )
    ) == 1

    external_event_binding_service.archive(test_db, first)
    test_db.commit()
    assert (
        external_event_binding_service.route(
            test_db, provider="gitlab", opaque_ref="acme/app!7"
        )
        == []
    )


def test_debounce_settles_after_execution_end(
    test_db: Session,
    workflow_project: CloudProject,
    test_user: User,
) -> None:
    issue = _issue(test_db, workflow_project, test_user.id)
    wait_node = next(
        node
        for node in issue.metadata_json["workflow"]["nodes"]
        if node["id"] == "wait-1"
    )
    wait_node["wait_config"] = {
        "rules": [
            {
                "id": "rule-ci-debounce",
                "event_type": "ci_failed",
                "mode": "debounce",
                "action": "rerun",
                "rerun_prompt": "Fix CI",
            }
        ]
    }
    agent = ProjectChatAgent(
        cloud_project_id=workflow_project.id,
        loop_item_id=issue.id,
        title="Fix robot",
        name="Fix robot",
        description="",
        created_by_user_id=test_user.id,
        status="active",
    )
    test_db.add(agent)
    test_db.flush()
    run = ProjectAutomationRun(
        cloud_project_id=workflow_project.id,
        parent_id="rule-1",
        loop_item_id=issue.id,
        task_id=issue.id,
        task_title=issue.title,
        assignee_agent_id=agent.id,
        source="manual",
        status="running",
        created_by_user_id=test_user.id,
    )
    test_db.add(run)
    test_db.flush()
    run_id = str(run.id)
    test_db.commit()

    binding = external_event_binding_service.create(
        test_db,
        provider="gitlab",
        opaque_ref="acme/app!7",
        cloud_project_id=str(workflow_project.id),
        loop_item_id=issue.id,
        issue_item_id=issue.id,
        workflow_node_id="wait-1",
        automation_run_id=run_id,
        created_by_user_id=test_user.id,
    )
    test_db.commit()

    # A run is already active: debounce aggregates instead of double-running.
    execution = loop_item_execution_for_run(
        test_db,
        agent=agent,
        issue=issue,
        run_id=run_id,
        user_id=test_user.id,
    )
    test_db.commit()
    external_event_evaluation_service.evaluate_event(
        test_db, binding=binding, event=_ci_event("pipeline-1")
    )
    test_db.commit()
    assert (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.automation_run_id == run_id)
        .count()
        == 1
    )

    # The execution ends: the aggregate settles and queues the next round.
    external_event_evaluation_service.on_execution_terminal(
        test_db, execution=execution
    )
    test_db.commit()
    executions = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.automation_run_id == run_id)
        .order_by(LoopItemExecution.id.asc())
        .all()
    )
    assert len(executions) == 2
    assert executions[1].attempt_no == 2
    test_db.refresh(issue)
    wait_node = next(
        node
        for node in issue.metadata_json["workflow"]["nodes"]
        if node["id"] == "wait-1"
    )
    assert wait_node["wait_round"] == 1


def loop_item_execution_for_run(
    test_db: Session,
    *,
    agent: ProjectChatAgent,
    issue: LoopItem,
    run_id: str,
    user_id: int,
) -> LoopItemExecution:
    from app.services.loop_item_executions.service import loop_item_execution_service

    return loop_item_execution_service.create_for_assignment(
        test_db,
        loop_item_id=issue.id,
        cloud_project_id=str(issue.cloud_project_id),
        agent=agent,
        assigner_user_id=user_id,
        environment="local",
        execution_device_id=None,
        priority="medium",
        automation_context={"rule_id": "rule-1", "run_id": run_id},
    )
