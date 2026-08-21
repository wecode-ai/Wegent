# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Tests for the external event subscription service."""

import copy
import threading
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
    ProjectIncomingHook,
    loop_datetime_is_unset,
)
from app.models.loop_item_execution import LoopItemExecution
from app.models.user import User
from app.schemas.issue_workflow import instantiate_workflow
from app.services.external_events.adapters import NormalizedExternalEvent
from app.services.external_events.binding import external_event_binding_service
from app.services.external_events.buffer import ExternalEventBuffer
from app.services.external_events.evaluate import external_event_evaluation_service
from app.services.external_events.service import ExternalEventService
from app.services.loop_items.service import loop_item_service
from tests.utils.fake_redis import FakeRedis


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
                "id": "stage-1",
                "name": "Develop MR",
                "node_type": "stage",
                "depends_on": [],
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
                            "action": "complete",
                            "rerun_prompt": "",
                        },
                        {
                            "id": "rule-ci",
                            "event_type": "ci_failed",
                            "action": "rerun",
                            "rerun_prompt": "CI failed, please fix it",
                        },
                    ]
                },
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


def _merged_event(event_id: str = "mr-7") -> NormalizedExternalEvent:
    return NormalizedExternalEvent(
        provider="gitlab",
        opaque_ref="acme/app!7",
        event_type="merged",
        event_id=event_id,
        summary=f"MR !{event_id} merged",
        source_url="https://gitlab.example/acme/app/-/merge_requests/7",
        occurred_at=datetime.now(timezone.utc),
        detail={"kind": "merge_request"},
    )


def _ci_event(
    event_id: str = "pipeline-1",
) -> NormalizedExternalEvent:
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


def _comment_event(event_id: str = "note-1") -> NormalizedExternalEvent:
    return NormalizedExternalEvent(
        provider="gitlab",
        opaque_ref="acme/app!7",
        event_type="review_comment",
        event_id=event_id,
        summary=f"Comment #{event_id}",
        source_url=None,
        occurred_at=datetime.now(timezone.utc),
        detail={"kind": "note"},
    )


def test_trigger_complete_ends_wait_node_and_issue(
    test_db: Session,
    workflow_project: CloudProject,
    test_user: User,
) -> None:
    issue = _issue(test_db, workflow_project, test_user.id)
    binding = _binding(
        test_db, project=workflow_project, issue=issue, user_id=test_user.id
    )
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
    binding = _binding(
        test_db, project=workflow_project, issue=issue, user_id=test_user.id
    )
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
    stage_agent = ProjectChatAgent(
        cloud_project_id=workflow_project.id,
        loop_item_id=issue.id,
        assignee_agent_id="",
        title="Fix robot",
        name="Fix robot",
        description="",
        created_by_user_id=test_user.id,
        status="active",
    )
    wait_agent = ProjectChatAgent(
        cloud_project_id=workflow_project.id,
        loop_item_id=issue.id,
        assignee_agent_id="",
        title="Wait robot",
        name="Wait robot",
        description="",
        created_by_user_id=test_user.id,
        status="active",
    )
    test_db.add(stage_agent)
    test_db.add(wait_agent)
    test_db.flush()
    _set_wait_agent(issue, wait_agent)
    run = ProjectAutomationRun(
        cloud_project_id=workflow_project.id,
        parent_id="rule-1",
        loop_item_id=issue.id,
        task_id=issue.id,
        task_title=issue.title,
        assignee_agent_id=stage_agent.id,
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

    test_db.refresh(binding)
    rerun_run = test_db.get(
        ProjectAutomationRun, (binding.metadata_json or {}).get("automation_run_id")
    )
    assert rerun_run is not None
    assert rerun_run.metadata_json["workflow_node_id"] == "wait-1"
    snapshot = rerun_run.metadata_json["workflow_stage_input"]
    assert snapshot["target_stage"]["id"] == "wait-1"
    prompt = snapshot["target_stage"]["prompt"]
    assert "CI failed, please fix it" in prompt
    assert "Pipeline #pipeline-1 failed" in prompt

    execution = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.automation_run_id == str(rerun_run.id))
        .order_by(LoopItemExecution.id.desc())
        .first()
    )
    assert execution is not None
    assert execution.status in {"pending_approval", "queued"}
    assert execution.attempt_no == 1
    # The rerun runs on the robot configured on the wait node itself, never on
    # the upstream stage's robot that happened to register the binding.
    assert execution.agent_id == wait_agent.id
    assert execution.agent_id != stage_agent.id
    test_db.refresh(issue)
    wait_node = next(
        node
        for node in issue.metadata_json["workflow"]["nodes"]
        if node["id"] == "wait-1"
    )
    assert wait_node["wait_round"] == 1
    assert wait_node["status"] == "waiting"
    assert wait_node.get("repair_status") == "queued"


def test_rerun_without_configured_robot_never_inherits_upstream_stage(
    test_db: Session,
    workflow_project: CloudProject,
    test_user: User,
) -> None:
    issue = _issue(test_db, workflow_project, test_user.id)
    stage_agent = ProjectChatAgent(
        cloud_project_id=workflow_project.id,
        loop_item_id=issue.id,
        assignee_agent_id="",
        title="Fix robot",
        name="Fix robot",
        description="",
        created_by_user_id=test_user.id,
        status="active",
    )
    test_db.add(stage_agent)
    test_db.flush()
    run = ProjectAutomationRun(
        cloud_project_id=workflow_project.id,
        parent_id="rule-1",
        loop_item_id=issue.id,
        task_id=issue.id,
        task_title=issue.title,
        assignee_agent_id=stage_agent.id,
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

    # The wait node has a rerun rule but no configured robot (legacy
    # definition awaiting re-selection). The round must not run on the
    # upstream stage's robot and must not consume a round number.
    external_event_evaluation_service.evaluate_event(
        test_db, binding=binding, event=_ci_event()
    )
    test_db.commit()

    assert (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == issue.id)
        .count()
        == 0
    )
    test_db.refresh(issue)
    wait_node = next(
        node
        for node in issue.metadata_json["workflow"]["nodes"]
        if node["id"] == "wait-1"
    )
    assert wait_node.get("wait_round", 0) == 0
    assert wait_node["status"] == "waiting"


def test_wait_node_rerun_keeps_gate_waiting_and_never_reopens_stage(
    test_db: Session,
    workflow_project: CloudProject,
    test_user: User,
) -> None:
    issue = _issue(test_db, workflow_project, test_user.id)
    stage_agent = ProjectChatAgent(
        cloud_project_id=workflow_project.id,
        loop_item_id=issue.id,
        assignee_agent_id="",
        title="Fix robot",
        name="Fix robot",
        description="",
        created_by_user_id=test_user.id,
        status="active",
    )
    wait_agent = ProjectChatAgent(
        cloud_project_id=workflow_project.id,
        loop_item_id=issue.id,
        assignee_agent_id="",
        title="Wait robot",
        name="Wait robot",
        description="",
        created_by_user_id=test_user.id,
        status="active",
    )
    test_db.add(stage_agent)
    test_db.add(wait_agent)
    test_db.flush()
    _set_wait_agent(issue, wait_agent)
    run = ProjectAutomationRun(
        cloud_project_id=workflow_project.id,
        parent_id="rule-1",
        loop_item_id=issue.id,
        task_id=issue.id,
        task_title=issue.title,
        assignee_agent_id=stage_agent.id,
        source="manual",
        status="succeeded",
        created_by_user_id=test_user.id,
    )
    test_db.add(run)
    test_db.flush()
    test_db.commit()
    binding = external_event_binding_service.create(
        test_db,
        provider="gitlab",
        opaque_ref="acme/app!7",
        cloud_project_id=str(workflow_project.id),
        loop_item_id=issue.id,
        issue_item_id=issue.id,
        workflow_node_id="wait-1",
        automation_run_id=str(run.id),
        created_by_user_id=test_user.id,
    )
    test_db.commit()

    external_event_evaluation_service.evaluate_event(
        test_db, binding=binding, event=_ci_event()
    )
    test_db.commit()

    test_db.refresh(binding)
    rerun_run = test_db.get(
        ProjectAutomationRun, (binding.metadata_json or {}).get("automation_run_id")
    )
    assert rerun_run is not None
    test_db.refresh(issue)
    nodes = {str(node["id"]): node for node in issue.metadata_json["workflow"]["nodes"]}
    assert nodes["wait-1"]["status"] == "waiting"
    assert nodes["wait-1"]["wait_round"] == 1
    assert nodes["wait-1"].get("repair_status") == "queued"
    assert nodes["stage-1"]["status"] == "completed"
    assert nodes["stage-1"].get("repair_status") is None

    from app.services.project_workflow_projection import (
        sync_automation_workflow_node,
    )

    rerun_run.status = "running"
    sync_automation_workflow_node(test_db, rerun_run)
    test_db.commit()
    test_db.refresh(issue)
    wait_node = next(
        node
        for node in issue.metadata_json["workflow"]["nodes"]
        if node["id"] == "wait-1"
    )
    stage_node = next(
        node
        for node in issue.metadata_json["workflow"]["nodes"]
        if node["id"] == "stage-1"
    )
    assert wait_node["status"] == "waiting"
    assert wait_node.get("repair_status") == "running"
    assert wait_node.get("automation_run_id") == str(rerun_run.id)
    assert stage_node["status"] == "completed"

    rerun_run.status = "succeeded"
    sync_automation_workflow_node(test_db, rerun_run)
    test_db.commit()
    test_db.refresh(issue)
    wait_node = next(
        node
        for node in issue.metadata_json["workflow"]["nodes"]
        if node["id"] == "wait-1"
    )
    stage_node = next(
        node
        for node in issue.metadata_json["workflow"]["nodes"]
        if node["id"] == "stage-1"
    )
    assert wait_node["status"] == "waiting"
    assert wait_node.get("repair_status") == "succeeded"
    assert stage_node["status"] == "completed"


def test_buffer_append_dedupe_and_take() -> None:
    buffer = ExternalEventBuffer(url="redis://fake")
    buffer._client = FakeRedis()

    buffer.append(
        "gitlab",
        "acme/app!7",
        "merged",
        {"event_id": "1", "summary": "a", "event_type": "merged"},
    )
    buffer.append(
        "gitlab",
        "acme/app!7",
        "merged",
        {"event_id": "1", "summary": "a", "event_type": "merged"},
    )
    buffer.append(
        "gitlab",
        "acme/app!7",
        "merged",
        {"event_id": "2", "summary": "b", "event_type": "merged"},
    )

    assert len(buffer.take("gitlab", "acme/app!7", "merged")) == 2
    assert buffer.take("gitlab", "acme/app!7", "merged") == []


def test_buffer_reference_compensation_and_aggregate() -> None:
    buffer = ExternalEventBuffer(url="redis://fake")
    buffer._client = FakeRedis()

    buffer.append(
        "gitlab",
        "acme/app!7",
        "merged",
        {"event_id": "1", "summary": "merged", "event_type": "merged"},
    )
    buffer.append(
        "gitlab",
        "acme/app!7",
        "ci_failed",
        {"event_id": "2", "summary": "failed", "event_type": "ci_failed"},
    )
    reference_events = buffer.take_for_reference("gitlab", "acme/app!7")
    assert {event["event_type"] for event in reference_events} == {
        "merged",
        "ci_failed",
    }
    assert buffer.take_for_reference("gitlab", "acme/app!7") == []

    buffer.push_aggregate(
        task_id="task-1",
        node_id="node-1",
        provider="gitlab",
        opaque_ref="acme/app!7",
        event_type="ci_failed",
    )
    buffer.append(
        "gitlab",
        "acme/app!7",
        "ci_failed",
        {"event_id": "3", "summary": "again", "event_type": "ci_failed"},
    )
    settled = buffer.take_aggregate(task_id="task-1", node_id="node-1")
    assert len(settled) == 1
    assert settled[0]["event_id"] == "3"
    assert buffer.take("gitlab", "acme/app!7", "ci_failed") == []


def test_buffer_window_open_append_and_generation_take() -> None:
    buffer = ExternalEventBuffer(url="redis://fake")
    buffer._client = FakeRedis()

    snapshot = buffer.open_window(
        task_id="task-1",
        node_id="node-1",
        event_type="ci_failed",
        event={"event_id": "1", "summary": "first", "event_type": "ci_failed"},
        window_seconds=5,
    )
    assert snapshot is not None
    assert snapshot["generation"] == 1
    assert len(snapshot["events"]) == 1

    assert buffer.append_window(
        task_id="task-1",
        node_id="node-1",
        event_type="ci_failed",
        event={"event_id": "2", "summary": "second", "event_type": "ci_failed"},
    )
    assert not buffer.append_window(
        task_id="task-1",
        node_id="node-1",
        event_type="merged",
        event={"event_id": "3", "summary": "other", "event_type": "merged"},
    )

    # A stale generation never settles the window; the live one does.
    assert (
        buffer.take_window(
            task_id="task-1",
            node_id="node-1",
            event_type="ci_failed",
            generation=snapshot["generation"] + 1,
        )
        == []
    )
    settled = buffer.take_window(
        task_id="task-1",
        node_id="node-1",
        event_type="ci_failed",
        generation=snapshot["generation"],
    )
    assert [event["event_id"] for event in settled] == ["1", "2"]
    assert (
        buffer.take_window(
            task_id="task-1",
            node_id="node-1",
            event_type="ci_failed",
            generation=snapshot["generation"],
        )
        == []
    )


def test_buffer_window_reopen_merges_prior_events_and_bumps_generation() -> None:
    buffer = ExternalEventBuffer(url="redis://fake")
    buffer._client = FakeRedis()

    first = buffer.open_window(
        task_id="task-1",
        node_id="node-1",
        event_type="ci_failed",
        event={"event_id": "1", "summary": "first", "event_type": "ci_failed"},
        window_seconds=5,
    )
    second = buffer.open_window(
        task_id="task-1",
        node_id="node-1",
        event_type="ci_failed",
        event={"event_id": "2", "summary": "second", "event_type": "ci_failed"},
        window_seconds=5,
    )
    assert second["generation"] == first["generation"] + 1
    assert [event["event_id"] for event in second["events"]] == ["1", "2"]


def test_buffer_append_is_atomic_under_concurrency() -> None:
    buffer = ExternalEventBuffer(url="redis://fake")
    fake = FakeRedis()
    buffer._client = fake
    writers = 8
    rounds = 20
    barrier = threading.Barrier(writers)
    failures: list[BaseException] = []

    def writer(index: int) -> None:
        try:
            barrier.wait()
            for round_index in range(rounds):
                buffer.append(
                    "gitlab",
                    "acme/app!7",
                    "merged",
                    {
                        "event_id": f"{index}-{round_index}",
                        "summary": "merged",
                        "event_type": "merged",
                    },
                )
        except BaseException as exc:  # pragma: no cover - failure surface
            failures.append(exc)

    threads = [
        threading.Thread(target=writer, args=(index,)) for index in range(writers)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert not failures
    events = buffer.take("gitlab", "acme/app!7", "merged")
    assert len(events) == writers * rounds


def test_binding_dedupe_route_and_archive(
    test_db: Session,
    workflow_project: CloudProject,
    test_user: User,
) -> None:
    issue = _issue(test_db, workflow_project, test_user.id)
    first = _binding(
        test_db, project=workflow_project, issue=issue, user_id=test_user.id
    )
    second = _binding(
        test_db, project=workflow_project, issue=issue, user_id=test_user.id
    )
    test_db.commit()

    assert first.id == second.id
    assert (
        len(
            external_event_binding_service.route(
                test_db, provider="gitlab", opaque_ref="acme/app!7"
            )
        )
        == 1
    )

    external_event_binding_service.archive(test_db, first)
    test_db.commit()
    assert (
        external_event_binding_service.route(
            test_db, provider="gitlab", opaque_ref="acme/app!7"
        )
        == []
    )


def test_route_reports_failed_when_every_evaluation_fails(
    test_db: Session,
    workflow_project: CloudProject,
    test_user: User,
) -> None:
    issue = _issue(test_db, workflow_project, test_user.id)
    _binding(test_db, project=workflow_project, issue=issue, user_id=test_user.id)
    hook = ProjectIncomingHook(
        cloud_project_id=str(workflow_project.id),
        parent_id=str(workflow_project.id),
        title="hook",
        description="",
        status="active",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    test_db.add(hook)
    test_db.commit()

    class ExplodingEvaluation:
        def evaluate_event(self, db: Session, *, binding, event) -> None:
            del db, binding, event
            raise RuntimeError("evaluation exploded")

    service = ExternalEventService(evaluation_service=ExplodingEvaluation())

    assert (
        service.route(
            test_db,
            hook=hook,
            event=_merged_event(),
        )
        == "failed"
    )


def test_merge_policy_settles_after_execution_end(
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
                "id": "rule-ci",
                "event_type": "ci_failed",
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
    _set_wait_agent(issue, agent)
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

    # The execution ends: the aggregate settles and queues the next round as
    # a wait-node-scoped rerun run.
    external_event_evaluation_service.on_execution_terminal(
        test_db, execution=execution
    )
    test_db.commit()
    executions = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == issue.id)
        .order_by(LoopItemExecution.id.asc())
        .all()
    )
    assert len(executions) == 2
    assert executions[1].attempt_no == 2
    test_db.refresh(binding)
    rerun_run = test_db.get(
        ProjectAutomationRun, (binding.metadata_json or {}).get("automation_run_id")
    )
    assert rerun_run is not None
    assert rerun_run.metadata_json["workflow_node_id"] == "wait-1"
    assert executions[1].automation_run_id == str(rerun_run.id)
    test_db.refresh(issue)
    wait_node = next(
        node
        for node in issue.metadata_json["workflow"]["nodes"]
        if node["id"] == "wait-1"
    )
    assert wait_node["wait_round"] == 1


def test_immediate_policy_fires_one_round_per_event_after_execution_ends(
    test_db: Session,
    workflow_project: CloudProject,
    test_user: User,
) -> None:
    issue = _issue(test_db, workflow_project, test_user.id)
    _set_wait_rules(
        issue,
        [
            {
                "id": "rule-merged",
                "event_type": "merged",
                "action": "rerun",
                "rerun_prompt": "Handle merge",
            }
        ],
    )
    run_id = _repair_agent_run(
        test_db, project=workflow_project, issue=issue, user_id=test_user.id
    )
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

    execution = loop_item_execution_for_run(
        test_db,
        agent=db_get_agent(test_db, run_id),
        issue=issue,
        run_id=run_id,
        user_id=test_user.id,
    )
    test_db.commit()
    external_event_evaluation_service.evaluate_event(
        test_db, binding=binding, event=_merged_event("mr-1")
    )
    external_event_evaluation_service.evaluate_event(
        test_db, binding=binding, event=_merged_event("mr-2")
    )
    test_db.commit()

    # The run ends: the immediate policy settles one event per round, serially.
    external_event_evaluation_service.on_execution_terminal(
        test_db, execution=execution
    )
    test_db.commit()
    executions = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == issue.id)
        .order_by(LoopItemExecution.id.asc())
        .all()
    )
    assert len(executions) == 2
    assert executions[1].attempt_no == 2
    first_round = _round_run(test_db, executions[1])
    prompt = first_round.metadata_json["workflow_stage_input"]["target_stage"]["prompt"]
    assert "MR !mr-1 merged" in prompt
    assert "MR !mr-2 merged" not in prompt

    # The next round's end settles the remaining event as its own round.
    external_event_evaluation_service.on_execution_terminal(
        test_db, execution=executions[1]
    )
    test_db.commit()
    executions = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == issue.id)
        .order_by(LoopItemExecution.id.asc())
        .all()
    )
    assert len(executions) == 3
    assert executions[2].attempt_no == 3
    second_round = _round_run(test_db, executions[2])
    prompt = second_round.metadata_json["workflow_stage_input"]["target_stage"][
        "prompt"
    ]
    assert "MR !mr-2 merged" in prompt
    assert "MR !mr-1 merged" not in prompt
    test_db.refresh(issue)
    wait_node = next(
        node
        for node in issue.metadata_json["workflow"]["nodes"]
        if node["id"] == "wait-1"
    )
    assert wait_node["wait_round"] == 2


def _set_wait_rules(issue: LoopItem, rules: list[dict]) -> None:
    metadata = copy.deepcopy(issue.metadata_json or {})
    wait_node = next(
        node for node in metadata["workflow"]["nodes"] if node["id"] == "wait-1"
    )
    wait_node["wait_config"] = {"rules": rules}
    issue.metadata_json = metadata


def _set_wait_agent(issue: LoopItem, agent: ProjectChatAgent) -> None:
    """Configure the robot that owns this wait node's rerun rounds."""

    metadata = copy.deepcopy(issue.metadata_json or {})
    wait_node = next(
        node for node in metadata["workflow"]["nodes"] if node["id"] == "wait-1"
    )
    wait_node["wait_config"]["agent_id"] = agent.id
    issue.metadata_json = metadata


def _repair_agent_run(
    test_db: Session,
    *,
    project: CloudProject,
    issue: LoopItem,
    user_id: int,
    status: str = "running",
) -> str:
    agent = ProjectChatAgent(
        cloud_project_id=project.id,
        loop_item_id=issue.id,
        title="Fix robot",
        name="Fix robot",
        description="",
        created_by_user_id=user_id,
        status="active",
    )
    test_db.add(agent)
    test_db.flush()
    _set_wait_agent(issue, agent)
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id="rule-1",
        loop_item_id=issue.id,
        task_id=issue.id,
        task_title=issue.title,
        assignee_agent_id=agent.id,
        source="manual",
        status=status,
        created_by_user_id=user_id,
    )
    test_db.add(run)
    test_db.flush()
    test_db.commit()
    return str(run.id)


def test_windowed_event_merges_within_deadline_and_settles_once(
    test_db: Session,
    workflow_project: CloudProject,
    test_user: User,
) -> None:
    from unittest.mock import patch

    from app.tasks.external_event_tasks import settle_external_event_window

    issue = _issue(test_db, workflow_project, test_user.id)
    _set_wait_rules(
        issue,
        [
            {
                "id": "rule-comment",
                "event_type": "review_comment",
                "action": "rerun",
                "rerun_prompt": "Handle review",
            }
        ],
    )
    run_id = _repair_agent_run(
        test_db,
        project=workflow_project,
        issue=issue,
        user_id=test_user.id,
        status="succeeded",
    )
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

    scheduled: list[dict] = []
    with patch.object(settle_external_event_window, "apply_async") as apply:
        apply.side_effect = lambda **kwargs: scheduled.append(kwargs)
        external_event_evaluation_service.evaluate_event(
            test_db,
            binding=binding,
            event=_comment_event("note-1"),
        )
        external_event_evaluation_service.evaluate_event(
            test_db,
            binding=binding,
            event=_comment_event("note-2"),
        )
        test_db.commit()
        assert len(scheduled) == 1
        assert scheduled[0]["kwargs"]["event_type"] == "review_comment"
        assert scheduled[0]["countdown"] == 5
        generation = scheduled[0]["kwargs"]["generation"]

    assert (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == issue.id)
        .count()
        == 0
    )
    external_event_evaluation_service.settle_window(
        test_db,
        binding=binding,
        event_type="review_comment",
        generation=generation,
    )
    test_db.commit()

    executions = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == issue.id)
        .order_by(LoopItemExecution.id.asc())
        .all()
    )
    assert len(executions) == 1
    assert executions[0].attempt_no == 1
    round_run = _round_run(test_db, executions[0])
    prompt = round_run.metadata_json["workflow_stage_input"]["target_stage"]["prompt"]
    assert "Comment #note-1" in prompt
    assert "Comment #note-2" in prompt
    test_db.refresh(issue)
    wait_node = next(
        node
        for node in issue.metadata_json["workflow"]["nodes"]
        if node["id"] == "wait-1"
    )
    assert wait_node["wait_round"] == 1


def test_windowed_event_stale_generation_does_not_fire(
    test_db: Session,
    workflow_project: CloudProject,
    test_user: User,
) -> None:
    issue = _issue(test_db, workflow_project, test_user.id)
    _set_wait_rules(
        issue,
        [
            {
                "id": "rule-comment",
                "event_type": "review_comment",
                "action": "rerun",
                "rerun_prompt": "Handle review",
            }
        ],
    )
    run_id = _repair_agent_run(
        test_db,
        project=workflow_project,
        issue=issue,
        user_id=test_user.id,
        status="succeeded",
    )
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

    from unittest.mock import patch

    from app.tasks.external_event_tasks import settle_external_event_window

    scheduled: list[dict] = []
    with patch.object(settle_external_event_window, "apply_async") as apply:
        apply.side_effect = lambda **kwargs: scheduled.append(kwargs)
        external_event_evaluation_service.evaluate_event(
            test_db,
            binding=binding,
            event=_comment_event("note-1"),
        )
        test_db.commit()
        generation = scheduled[0]["kwargs"]["generation"]

    external_event_evaluation_service.settle_window(
        test_db,
        binding=binding,
        event_type="review_comment",
        generation=generation + 1,
    )
    test_db.commit()
    assert (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == issue.id)
        .count()
        == 0
    )

    external_event_evaluation_service.settle_window(
        test_db,
        binding=binding,
        event_type="review_comment",
        generation=generation,
    )
    test_db.commit()
    assert (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == issue.id)
        .count()
        == 1
    )


def test_windowed_event_parks_while_repair_round_active(
    test_db: Session,
    workflow_project: CloudProject,
    test_user: User,
) -> None:
    issue = _issue(test_db, workflow_project, test_user.id)
    _set_wait_rules(
        issue,
        [
            {
                "id": "rule-comment",
                "event_type": "review_comment",
                "action": "rerun",
                "rerun_prompt": "Handle review",
            }
        ],
    )
    run_id = _repair_agent_run(
        test_db, project=workflow_project, issue=issue, user_id=test_user.id
    )
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

    from unittest.mock import patch

    from app.tasks.external_event_tasks import settle_external_event_window

    scheduled: list[dict] = []
    with patch.object(settle_external_event_window, "apply_async") as apply:
        apply.side_effect = lambda **kwargs: scheduled.append(kwargs)
        external_event_evaluation_service.evaluate_event(
            test_db,
            binding=binding,
            event=_comment_event("note-1"),
        )
        test_db.commit()
        generation = scheduled[0]["kwargs"]["generation"]

    execution = loop_item_execution_for_run(
        test_db,
        agent=db_get_agent(test_db, run_id),
        issue=issue,
        run_id=run_id,
        user_id=test_user.id,
    )
    test_db.commit()

    # A repair round is active when the window expires: events park instead
    # of starting a concurrent round, then settle when the round ends.
    external_event_evaluation_service.settle_window(
        test_db,
        binding=binding,
        event_type="review_comment",
        generation=generation,
    )
    test_db.commit()
    assert (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == issue.id)
        .count()
        == 1
    )
    external_event_evaluation_service.on_execution_terminal(
        test_db, execution=execution
    )
    test_db.commit()
    executions = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == issue.id)
        .order_by(LoopItemExecution.id.asc())
        .all()
    )
    assert len(executions) == 2
    assert executions[1].attempt_no == 2


def db_get_agent(test_db: Session, run_id: str) -> ProjectChatAgent:
    run = test_db.get(ProjectAutomationRun, run_id)
    assert run is not None and run.assignee_agent_id
    agent = test_db.get(ProjectChatAgent, run.assignee_agent_id)
    assert agent is not None
    return agent


def _round_run(test_db: Session, execution: LoopItemExecution) -> ProjectAutomationRun:
    run = test_db.get(ProjectAutomationRun, execution.automation_run_id)
    assert run is not None
    return run


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


def test_provider_event_catalog_lists_gitlab_event_types() -> None:
    from app.services.external_events.adapters import provider_event_catalog

    catalog = provider_event_catalog()
    gitlab = [entry for entry in catalog if entry["provider"] == "gitlab"]
    assert {entry["event_type"] for entry in gitlab} == {
        "merged",
        "ci_failed",
        "review_comment",
    }
    assert all(entry["category"] and entry["description"] for entry in gitlab)


def test_provider_event_catalog_covers_adapter_outputs() -> None:
    from app.services.external_events.adapters import (
        normalize_external_event,
        provider_event_catalog,
    )

    catalog = provider_event_catalog()
    produced = {
        entry["event_type"] for entry in catalog if entry["provider"] == "gitlab"
    }
    payloads = [
        {
            "object_kind": "merge_request",
            "project": {"path_with_namespace": "acme/app"},
            "object_attributes": {
                "id": 1,
                "iid": 7,
                "action": "merge",
                "url": "https://example.test/mr/7",
            },
        },
        {
            "object_kind": "pipeline",
            "project": {"path_with_namespace": "acme/app"},
            "object_attributes": {"id": 2, "status": "failed"},
        },
        {
            "object_kind": "note",
            "project": {"path_with_namespace": "acme/app"},
            "object_attributes": {"id": 3, "noteable_type": "MergeRequest"},
            "merge_request": {"iid": 7},
            "user": {"username": "tester"},
        },
    ]
    for payload in payloads:
        event = normalize_external_event(payload, {})
        assert event is not None
        assert event.event_type in produced


def test_provider_catalog_declares_event_type_delivery_policies() -> None:
    from app.services.external_events.adapters import (
        GITLAB_COMMENT_AGGREGATE_WINDOW_SECONDS,
        event_type_policy,
    )

    merged = event_type_policy("gitlab", "merged")
    assert merged is not None
    assert merged.window_seconds is None
    assert merged.merge_while_running is False

    ci = event_type_policy("gitlab", "ci_failed")
    assert ci is not None
    assert ci.window_seconds is None
    assert ci.merge_while_running is True

    comment = event_type_policy("gitlab", "review_comment")
    assert comment is not None
    assert comment.window_seconds == GITLAB_COMMENT_AGGREGATE_WINDOW_SECONDS
    assert comment.merge_while_running is True

    # Providers outside the catalog have no declaration: the default
    # (immediate) policy applies at runtime.
    assert event_type_policy("github", "merged") is None


def test_rule_matching_is_scoped_to_provider(
    test_db: Session,
    workflow_project: CloudProject,
    test_user: User,
) -> None:
    issue = _issue(test_db, workflow_project, test_user.id)
    _set_wait_rules(
        issue,
        [
            {
                "id": "rule-merged",
                "provider": "gitlab",
                "event_type": "merged",
                "action": "complete",
                "rerun_prompt": "",
            }
        ],
    )
    binding = _binding(
        test_db, project=workflow_project, issue=issue, user_id=test_user.id
    )
    test_db.commit()

    # A github "merged" event does not match the gitlab rule: the gate stays.
    github_merged = NormalizedExternalEvent(
        provider="github",
        opaque_ref="owner/repo#7",
        event_type="merged",
        event_id="pr-7",
        summary="PR #7 merged",
        source_url=None,
        occurred_at=None,
        detail={},
    )
    external_event_evaluation_service.evaluate_event(
        test_db, binding=binding, event=github_merged
    )
    test_db.commit()
    test_db.refresh(issue)
    nodes = {
        str(node["id"]): node["status"]
        for node in issue.metadata_json["workflow"]["nodes"]
    }
    assert nodes["wait-1"] == "waiting"

    # The matching gitlab event completes the node.
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


def test_rule_without_provider_matches_any_provider(
    test_db: Session,
    workflow_project: CloudProject,
    test_user: User,
) -> None:
    issue = _issue(test_db, workflow_project, test_user.id)
    _set_wait_rules(
        issue,
        [
            {
                "id": "rule-merged",
                "event_type": "merged",
                "action": "complete",
                "rerun_prompt": "",
            }
        ],
    )
    binding = _binding(
        test_db,
        project=workflow_project,
        issue=issue,
        user_id=test_user.id,
        provider="github",
        opaque_ref="owner/repo#7",
    )
    test_db.commit()
    external_event_evaluation_service.evaluate_event(
        test_db,
        binding=binding,
        event=NormalizedExternalEvent(
            provider="github",
            opaque_ref="owner/repo#7",
            event_type="merged",
            event_id="pr-7",
            summary="PR #7 merged",
            source_url=None,
            occurred_at=None,
            detail={},
        ),
    )
    test_db.commit()
    test_db.refresh(issue)
    nodes = {
        str(node["id"]): node["status"]
        for node in issue.metadata_json["workflow"]["nodes"]
    }
    assert nodes["wait-1"] == "completed"


def _continue_rule() -> dict:
    return {
        "id": "rule-continue",
        "event_type": "ci_failed",
        "action": "continue",
        "prompt": "CI failed, please fix it",
    }


def _ran_execution(
    test_db: Session,
    *,
    issue: LoopItem,
    project: CloudProject,
    user_id: int,
    run_id: str,
    device_id: str = "device-1",
    task_id: str = "task-1",
) -> LoopItemExecution:
    execution = LoopItemExecution(
        loop_item_id=issue.id,
        cloud_project_id=project.id,
        executor_owner_user_id=user_id,
        automation_run_id=run_id,
        execution_device_id=device_id,
        runtime_device_id=device_id,
        runtime_task_id=task_id,
        status="succeeded",
    )
    test_db.add(execution)
    test_db.flush()
    return execution


def test_continue_round_sends_prompt_into_current_task(
    test_db: Session,
    workflow_project: CloudProject,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    issue = _issue(test_db, workflow_project, test_user.id)
    _set_wait_rules(issue, [_continue_rule()])
    run = ProjectAutomationRun(
        cloud_project_id=workflow_project.id,
        parent_id="rule-continue",
        loop_item_id=issue.id,
        task_id=issue.id,
        task_title=issue.title,
        assignee_agent_id="",
        source="manual",
        status="succeeded",
        created_by_user_id=test_user.id,
    )
    test_db.add(run)
    test_db.flush()
    run_id = str(run.id)
    _ran_execution(
        test_db,
        issue=issue,
        project=workflow_project,
        user_id=test_user.id,
        run_id=run_id,
    )
    test_db.commit()
    binding = _binding(
        test_db,
        project=workflow_project,
        issue=issue,
        user_id=test_user.id,
        opaque_ref="acme/app!7",
    )
    test_db.commit()

    sent: list[dict[str, object]] = []

    async def fake_send(*, db: Session, user_id: int, request: object) -> None:
        sent.append({"user_id": user_id, "request": request})

    monkeypatch.setattr(
        "app.services.runtime_work_service.send_runtime_message", fake_send
    )

    accepted = external_event_evaluation_service.continue_round(
        test_db, binding=binding, instruction="CI failed, please fix it"
    )
    test_db.commit()

    assert accepted is True
    assert len(sent) == 1
    assert sent[0]["user_id"] == test_user.id
    request = sent[0]["request"]
    assert request.address.device_id == "device-1"
    assert request.address.local_task_id == "task-1"
    assert request.message == "CI failed, please fix it"

    test_db.refresh(issue)
    wait_node = next(
        node
        for node in issue.metadata_json["workflow"]["nodes"]
        if node["id"] == "wait-1"
    )
    assert wait_node["wait_round"] == 1
    assert "continue_error" not in wait_node
    # Continue never creates a new run or execution.
    assert (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == issue.id)
        .count()
        == 1
    )
    assert (
        test_db.query(ProjectAutomationRun)
        .filter(ProjectAutomationRun.loop_item_id == issue.id)
        .count()
        == 1
    )


def test_continue_rule_event_enqueues_worker_round(
    test_db: Session,
    workflow_project: CloudProject,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    issue = _issue(test_db, workflow_project, test_user.id)
    _set_wait_rules(issue, [_continue_rule()])
    binding = _binding(
        test_db,
        project=workflow_project,
        issue=issue,
        user_id=test_user.id,
        opaque_ref="acme/app!7",
    )
    test_db.commit()

    queued: list[dict[str, str]] = []

    def fake_apply_async(*, kwargs: dict[str, str], **ignored: object) -> None:
        queued.append(kwargs)

    monkeypatch.setattr(
        "app.tasks.external_event_tasks.dispatch_external_event_continue.apply_async",
        fake_apply_async,
    )

    external_event_evaluation_service.evaluate_event(
        test_db, binding=binding, event=_ci_event()
    )
    test_db.commit()

    assert len(queued) == 1
    assert queued[0]["binding_id"] == binding.id
    instruction = queued[0]["instruction"]
    assert "CI failed, please fix it" in instruction
    assert "Pipeline #pipeline-1 failed" in instruction
    test_db.refresh(issue)
    wait_node = next(
        node
        for node in issue.metadata_json["workflow"]["nodes"]
        if node["id"] == "wait-1"
    )
    # The round counter moves only after the worker accepts the send.
    assert wait_node.get("wait_round", 0) == 0


def test_continue_round_without_runnable_task_records_error(
    test_db: Session,
    workflow_project: CloudProject,
    test_user: User,
) -> None:
    issue = _issue(test_db, workflow_project, test_user.id)
    _set_wait_rules(issue, [_continue_rule()])
    binding = _binding(
        test_db,
        project=workflow_project,
        issue=issue,
        user_id=test_user.id,
        opaque_ref="acme/app!7",
    )
    test_db.commit()

    accepted = external_event_evaluation_service.continue_round(
        test_db, binding=binding, instruction="CI failed, please fix it"
    )
    test_db.commit()

    assert accepted is False
    test_db.refresh(issue)
    wait_node = next(
        node
        for node in issue.metadata_json["workflow"]["nodes"]
        if node["id"] == "wait-1"
    )
    assert wait_node.get("continue_error") == "No runnable task for continue"
    assert wait_node.get("wait_round", 0) == 0


def test_continue_round_records_error_when_device_unreachable(
    test_db: Session,
    workflow_project: CloudProject,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    issue = _issue(test_db, workflow_project, test_user.id)
    _set_wait_rules(issue, [_continue_rule()])
    run = ProjectAutomationRun(
        cloud_project_id=workflow_project.id,
        parent_id="rule-continue",
        loop_item_id=issue.id,
        task_id=issue.id,
        task_title=issue.title,
        assignee_agent_id="",
        source="manual",
        status="succeeded",
        created_by_user_id=test_user.id,
    )
    test_db.add(run)
    test_db.flush()
    _ran_execution(
        test_db,
        issue=issue,
        project=workflow_project,
        user_id=test_user.id,
        run_id=str(run.id),
    )
    test_db.commit()
    binding = _binding(
        test_db,
        project=workflow_project,
        issue=issue,
        user_id=test_user.id,
        opaque_ref="acme/app!7",
    )
    test_db.commit()

    async def failing_send(**kwargs: object) -> None:
        raise RuntimeError("device offline")

    monkeypatch.setattr(
        "app.services.runtime_work_service.send_runtime_message", failing_send
    )

    accepted = external_event_evaluation_service.continue_round(
        test_db, binding=binding, instruction="CI failed, please fix it"
    )
    test_db.commit()

    assert accepted is False
    test_db.refresh(issue)
    wait_node = next(
        node
        for node in issue.metadata_json["workflow"]["nodes"]
        if node["id"] == "wait-1"
    )
    assert wait_node.get("continue_error") == "Device is not reachable"
    assert wait_node.get("wait_round", 0) == 0
