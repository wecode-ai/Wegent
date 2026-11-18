"""Behavioral contracts for the product-to-release workflow gates."""

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.delivery import (
    CloudProject,
    Delivery,
    DeliveryAsset,
    LoopItemComment,
    LoopItemTaskBinding,
)
from app.models.loop_item_execution import LoopItemExecution
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.schemas.delivery import DeliveryFinalize, LoopItemCreate, LoopItemUpdate
from app.schemas.issue_workflow import ProjectWorkflowDefinition, instantiate_workflow
from app.services.delivery.service import DeliveryService
from app.services.loop_items.service import loop_item_service
from app.services.loop_items.workflow import workflow_snapshot
from tests.utils.collaboration import authorize_project


@pytest.fixture(autouse=True)
def isolate_notifications():
    with (
        patch("app.core.async_utils.schedule_async_task"),
        patch("app.tasks.robot_queue_tasks.emit_runtime_cancels"),
    ):
        yield


def _project(db: Session, user: User) -> CloudProject:
    identifier = uuid.uuid4().hex
    definition = ProjectWorkflowDefinition(
        stage_mode="dag",
        nodes=[
            {
                "id": "product_intake",
                "name": "Product",
                "required_deliverables": [
                    {
                        "id": "acceptance_criteria",
                        "name": "Acceptance criteria",
                        "value_type": "text",
                    }
                ],
            },
            {"id": "ux_spec", "name": "UX", "depends_on": ["product_intake"]},
            {
                "id": "dev_implementation",
                "name": "Development",
                "depends_on": ["ux_spec"],
            },
            {
                "id": "code_review",
                "name": "Review",
                "depends_on": ["dev_implementation"],
                "rework_to": "dev_implementation",
            },
            {
                "id": "qa_test",
                "name": "QA",
                "depends_on": ["code_review"],
                "rework_to": "dev_implementation",
            },
            {"id": "merge_release", "name": "Release", "depends_on": ["qa_test"]},
        ],
    )
    project = CloudProject(
        public_id=identifier,
        project_key=f"WF{identifier[:5]}",
        name="Workflow",
        description="",
        storage_prefix=f"projects/{identifier}",
        created_by_user_id=user.id,
        metadata_json={"workflow_definition": definition.model_dump(mode="json")},
    )
    authorize_project(db, project)
    db.commit()
    return project


def _create(db: Session, user: User, project: CloudProject):
    return loop_item_service.create(
        db, int(project.id), user.id, LoopItemCreate(title="Ship a feature")
    )


def _decide(
    db: Session, user: User, item, node_id: str, action: str = "approve", **kwargs
):
    actor_is_human = kwargs.pop("actor_is_human", True)
    return loop_item_service.update(
        db,
        item.id,
        user.id,
        LoopItemUpdate(
            version=item.version,
            workflow_action={
                "type": "decide_node",
                "node_id": node_id,
                "action": action,
                **kwargs,
            },
        ),
        actor_is_human=actor_is_human,
    )


def _deliver(db: Session, user: User, item, node_id="product_intake"):
    service = DeliveryService(storage=MagicMock())
    delivery = Delivery(
        id=str(uuid.uuid4()),
        loop_item_id=item.id,
        created_by_user_id=user.id,
        status="draft",
        markdown_object_key="markdown.md",
    )
    db.add(delivery)
    db.commit()
    return service.finalize(
        db,
        delivery.id,
        user.id,
        DeliveryFinalize(
            workflow_node_id=node_id,
            fulfillments=[
                {
                    "requirement_id": "acceptance_criteria",
                    "kind": "text",
                    "text": "The user can save and reload the workflow.",
                }
            ],
        ),
    )


def test_new_issue_activates_only_root_and_gates_missing_evidence(test_db, test_user):
    project = _project(test_db, test_user)
    item = _create(test_db, test_user, project)
    assert [node.status for node in workflow_snapshot(item).nodes] == [
        "ready",
        *["blocked"] * 5,
    ]
    version = item.version
    with pytest.raises(HTTPException) as failure:
        _decide(test_db, test_user, item, "product_intake")
    assert failure.value.status_code == 409
    assert (
        failure.value.detail["missing_deliverables"][0]["id"] == "acceptance_criteria"
    )
    assert item.version == version

    _deliver(test_db, test_user, item)
    _decide(test_db, test_user, item, "product_intake")
    workflow = workflow_snapshot(item)
    assert workflow.current_stage_id == "ux_spec"
    assert workflow.nodes[0].status == "completed"
    assert [node.status for node in workflow.nodes[1:]] == ["ready", *["blocked"] * 4]


def test_wrong_stage_delivery_and_skipping_approval_are_rejected(test_db, test_user):
    item = _create(test_db, test_user, _project(test_db, test_user))
    with pytest.raises(HTTPException, match="409"):
        _deliver(test_db, test_user, item, "ux_spec")
    with pytest.raises(HTTPException) as failure:
        _decide(test_db, test_user, item, "qa_test")
    assert failure.value.detail["missing_dependencies"] == ["code_review"]


def test_decision_replay_does_not_write_or_dispatch_twice(test_db, test_user):
    item = _create(test_db, test_user, _project(test_db, test_user))
    _deliver(test_db, test_user, item)
    request = LoopItemUpdate(
        version=item.version,
        workflow_action={
            "type": "decide_node",
            "node_id": "product_intake",
            "action": "approve",
            "idempotency_key": "approval-1",
        },
    )
    _decide(test_db, test_user, item, "product_intake", idempotency_key="approval-1")
    version = item.version
    count = test_db.query(LoopItemComment).count()
    replay = loop_item_service.update(
        test_db, item.id, test_user.id, request, actor_is_human=True
    )
    assert replay.version == version
    assert test_db.query(LoopItemComment).count() == count
    assert len(workflow_snapshot(replay).nodes[0].decision_history) == 1
    with pytest.raises(HTTPException) as failure:
        _decide(test_db, test_user, item, "ux_spec", idempotency_key="approval-1")
    assert failure.value.status_code == 409


def test_qa_rework_preserves_history_and_invalidates_old_attempt_evidence(
    test_db, test_user
):
    item = _create(test_db, test_user, _project(test_db, test_user))
    delivery = _deliver(test_db, test_user, item)
    for node_id in ["product_intake", "ux_spec", "dev_implementation", "code_review"]:
        _decide(test_db, test_user, item, node_id)
    _decide(
        test_db,
        test_user,
        item,
        "qa_test",
        "reject",
        reason="Regression in the final build",
    )
    workflow = workflow_snapshot(item)
    assert workflow.current_stage_id == "dev_implementation"
    assert workflow.nodes[2].attempts == 2
    assert [node.status for node in workflow.nodes[3:]] == ["blocked"] * 3
    assert workflow.nodes[0].delivery_ids == [delivery.id]
    assert (
        workflow.nodes[4].decision_history[0].reason == "Regression in the final build"
    )


def test_rework_evidence_must_be_resubmitted_for_new_attempt(test_db, test_user):
    item = _create(test_db, test_user, _project(test_db, test_user))
    _deliver(test_db, test_user, item)
    _decide(test_db, test_user, item, "product_intake")
    # A stage can request another attempt without erasing the original evidence.
    _decide(
        test_db, test_user, item, "ux_spec", "reject", reason="Revise the specification"
    )
    _decide(test_db, test_user, item, "ux_spec")
    # Reset Product through an explicit, configured feedback edge in a fixture.
    workflow = workflow_snapshot(item)
    workflow.nodes[2].rework_to = "product_intake"
    item.metadata_json = {
        **item.metadata_json,
        "workflow": workflow.model_dump(mode="json"),
    }
    test_db.commit()
    _decide(
        test_db,
        test_user,
        item,
        "dev_implementation",
        "reject",
        reason="Acceptance criteria changed",
    )
    with pytest.raises(HTTPException) as failure:
        _decide(test_db, test_user, item, "product_intake")
    assert failure.value.detail["code"] == "workflow_deliverables_missing"


def test_force_advance_requires_admin_and_audits_skipped_stages(test_db, test_user):
    project = _project(test_db, test_user)
    item = _create(test_db, test_user, project)
    with pytest.raises(ValidationError):
        _decide(test_db, test_user, item, "qa_test", "force_advance", reason="  ")
    _decide(
        test_db,
        test_user,
        item,
        "qa_test",
        "force_advance",
        reason="Approved emergency hotfix",
    )
    workflow = workflow_snapshot(item)
    assert workflow.nodes[-1].status == "ready"
    assert workflow.nodes[4].decision_history[0].skipped_node_ids == sorted(
        node.id for node in workflow.nodes[:-1]
    )
    audit = (
        test_db.query(LoopItemComment)
        .filter(LoopItemComment.loop_item_id == item.id)
        .all()[-1]
    )
    assert "Approved emergency hotfix" in audit.description
    assert "product_intake" in audit.description
    assert audit.created_by_user_id == test_user.id


def test_member_cannot_force_advance(test_db, test_user):
    project = _project(test_db, test_user)
    item = _create(test_db, test_user, project)
    member = User(
        user_name=f"member-{uuid.uuid4().hex}", password_hash="unused", is_active=True
    )
    test_db.add(member)
    test_db.flush()
    test_db.add(
        ResourceMember.create(
            resource_type="CloudProject",
            resource_id=int(project.id),
            entity_id=str(member.id),
            role="Developer",
            status="approved",
        )
    )
    test_db.commit()
    with pytest.raises(HTTPException) as failure:
        _decide(test_db, member, item, "product_intake", "force_advance", reason="Skip")
    assert failure.value.status_code == 403


def test_workflow_decision_invalidates_clients_once_after_commit(test_db, test_user):
    item = _create(test_db, test_user, _project(test_db, test_user))
    values = LoopItemUpdate(
        version=item.version,
        workflow_action={
            "type": "decide_node",
            "node_id": "product_intake",
            "action": "force_advance",
            "reason": "Emergency approval",
            "idempotency_key": "invalidate-once",
        },
    )
    with patch("app.services.loop_item_events.publish_loop_item_changed") as publish:
        loop_item_service.update(
            test_db, item.id, test_user.id, values, actor_is_human=True
        )
        loop_item_service.update(
            test_db, item.id, test_user.id, values, actor_is_human=True
        )
    publish.assert_called_once()
    assert publish.call_args.kwargs["item"].version == item.version
    assert publish.call_args.kwargs["reason"] == "workflow_decision"


def test_assistant_cannot_approve_human_release_or_force_advance(test_db, test_user):
    from app.mcp_server.tools.wework_space import _update_item

    item = _create(test_db, test_user, _project(test_db, test_user))
    _decide(
        test_db,
        test_user,
        item,
        "qa_test",
        "force_advance",
        reason="Prepare release gate",
    )
    for action in ["approve", "force_advance"]:
        with pytest.raises(HTTPException) as failure:
            _decide(
                test_db,
                test_user,
                item,
                "merge_release",
                action,
                reason="Assistant requests release",
                actor_is_human=False,
            )
        assert failure.value.status_code == 403
    with pytest.raises(HTTPException) as mcp_failure:
        _update_item(
            test_db,
            test_db.get(CloudProject, item.cloud_project_id),
            item.id,
            test_user.id,
            LoopItemUpdate(
                version=item.version,
                workflow_action={
                    "type": "decide_node",
                    "node_id": "merge_release",
                    "action": "approve",
                },
            ),
        )
    assert mcp_failure.value.status_code == 403


def test_status_and_raw_workflow_cannot_bypass_gates(test_db, test_user):
    item = _create(test_db, test_user, _project(test_db, test_user))
    with pytest.raises(HTTPException) as failure:
        loop_item_service.update(
            test_db,
            item.id,
            test_user.id,
            LoopItemUpdate(version=item.version, status="completed"),
        )
    assert failure.value.detail["code"] == "workflow_incomplete"
    with pytest.raises(HTTPException) as failure:
        loop_item_service.update(
            test_db,
            item.id,
            test_user.id,
            LoopItemUpdate(version=item.version, workflow=None),
        )
    assert failure.value.status_code == 422


def test_apply_existing_issue_once_and_flag_rollback_preserves_instances(
    test_db, test_user, monkeypatch
):
    project = _project(test_db, test_user)
    item = loop_item_service.create(
        test_db,
        int(project.id),
        test_user.id,
        LoopItemCreate(title="Historical Issue"),
        apply_project_workflow=False,
    )
    original_history = item.metadata_json["status_history"]
    loop_item_service.update(
        test_db,
        item.id,
        test_user.id,
        LoopItemUpdate(version=item.version, workflow_action={"type": "apply_project"}),
    )
    assert item.metadata_json["status_history"] == original_history
    with pytest.raises(HTTPException, match="409"):
        loop_item_service.update(
            test_db,
            item.id,
            test_user.id,
            LoopItemUpdate(
                version=item.version, workflow_action={"type": "apply_project"}
            ),
        )
    monkeypatch.setattr(settings, "COLLAB_AGENTIC_STRATEGY_V1", False)
    assert workflow_snapshot(_create(test_db, test_user, project)) is not None
    _decide(
        test_db,
        test_user,
        item,
        "product_intake",
        "force_advance",
        reason="Complete an existing workflow",
    )
    assert workflow_snapshot(item).current_stage_id == "ux_spec"


def test_forged_completed_creation_is_rejected(test_db, test_user):
    project = _project(test_db, test_user)
    workflow = instantiate_workflow(
        ProjectWorkflowDefinition.model_validate(
            project.metadata_json["workflow_definition"]
        )
    )
    workflow.nodes[0].status = "completed"
    with pytest.raises(HTTPException, match="422"):
        loop_item_service.create(
            test_db,
            int(project.id),
            test_user.id,
            LoopItemCreate(title="Bypass", workflow=workflow),
        )


def _submit_evidence(db, user, item, node_id, values, *, file_ids=()):
    delivery = Delivery(
        id=str(uuid.uuid4()),
        loop_item_id=item.id,
        created_by_user_id=user.id,
        status="draft",
        markdown_object_key="markdown.md",
    )
    db.add(delivery)
    for asset_id in file_ids:
        db.add(
            DeliveryAsset(
                id=asset_id,
                delivery_id=delivery.id,
                kind="file",
                relative_path=f"{asset_id}.txt",
                display_name="Test evidence",
                object_key=f"files/{asset_id}",
                size_bytes=12,
                sha256="a" * 64,
            )
        )
    db.commit()
    return DeliveryService(storage=MagicMock()).finalize(
        db,
        delivery.id,
        user.id,
        DeliveryFinalize(workflow_node_id=node_id, fulfillments=values),
    )


def test_all_six_stages_require_real_deliveries_and_human_release(test_db, test_user):
    project = _project(test_db, test_user)
    definition = ProjectWorkflowDefinition.model_validate(
        project.metadata_json["workflow_definition"]
    )
    required = [
        [("acceptance_criteria", "text")],
        [("ux_spec_file", "file"), ("interaction_states", "text")],
        [("code_snapshot_or_pull_request", "code_snapshot")],
        [("review_decision", "text"), ("review_comments", "url")],
        [("test_evidence", "file"), ("qa_decision", "text")],
        [("merged_pull_request", "pull_request"), ("deployment_url", "url")],
    ]
    for node, requirements in zip(definition.nodes, required):
        node.required_deliverables = [
            {
                "id": identifier,
                "name": identifier,
                "value_type": kind,
                **(
                    {"accepted_value_types": ["pull_request"]}
                    if kind == "code_snapshot"
                    else {}
                ),
                **(
                    {"pull_request_state": "merged"}
                    if identifier == "merged_pull_request"
                    else {}
                ),
            }
            for identifier, kind in requirements
        ]
    definition = ProjectWorkflowDefinition.model_validate(definition.model_dump())
    project.metadata_json = {
        **project.metadata_json,
        "workflow_definition": definition.model_dump(mode="json"),
    }
    test_db.commit()
    item = _create(test_db, test_user, project)
    for node in definition.nodes:
        with pytest.raises(HTTPException) as missing:
            _decide(test_db, test_user, item, node.id)
        assert missing.value.detail["code"] == "workflow_deliverables_missing"
        values, file_ids = [], []
        for requirement in node.required_deliverables:
            value = {"requirement_id": requirement.id, "kind": requirement.value_type}
            if requirement.value_type == "text":
                value["text"] = "Verified requirement with reproducible evidence"
            elif requirement.value_type == "url":
                value["url"] = "https://example.com/evidence/42"
            elif requirement.value_type == "file":
                asset_id = str(uuid.uuid4())
                file_ids.append(asset_id)
                value["asset_ids"] = [asset_id]
            else:
                value.update(
                    kind="pull_request",
                    provider="github",
                    url="https://github.com/example/repo/pull/42",
                    number=42,
                    head_branch="feature/workflow",
                    base_branch="main",
                    head_commit="abcdef0123456789",
                    state="merged" if node.id == "merge_release" else "open",
                )
            values.append(value)
        if node.id == "merge_release":
            unmerged = [
                {**value, "state": "open"} if value["kind"] == "pull_request" else value
                for value in values
            ]
            with pytest.raises(HTTPException, match="422"):
                _submit_evidence(test_db, test_user, item, node.id, unmerged)
        delivery = _submit_evidence(
            test_db, test_user, item, node.id, values, file_ids=file_ids
        )
        if node.id == "qa_test":
            _decide(
                test_db,
                test_user,
                item,
                node.id,
                "reject",
                reason="Failed regression test",
            )
            assert delivery.id in workflow_snapshot(item).nodes[4].delivery_ids
            _decide(
                test_db,
                test_user,
                item,
                "dev_implementation",
                "force_advance",
                reason="Hotfix reviewed by maintainer",
            )
            # Review and QA must both run again; old QA evidence remains visible.
            _decide(
                test_db,
                test_user,
                item,
                "code_review",
                "force_advance",
                reason="Hotfix review approved",
            )
            with pytest.raises(HTTPException) as old_evidence:
                _decide(test_db, test_user, item, "qa_test")
            assert old_evidence.value.detail["code"] == "workflow_deliverables_missing"
            fresh_values = [
                (
                    {**value, "asset_ids": [str(uuid.uuid4())]}
                    if value["kind"] == "file"
                    else value
                )
                for value in values
            ]
            fresh_file_ids = [
                value["asset_ids"][0]
                for value in fresh_values
                if value["kind"] == "file"
            ]
            _submit_evidence(
                test_db, test_user, item, node.id, fresh_values, file_ids=fresh_file_ids
            )
        _decide(test_db, test_user, item, node.id)
    assert workflow_snapshot(item).orchestration_status == "completed"
    completed = loop_item_service.update(
        test_db,
        item.id,
        test_user.id,
        LoopItemUpdate(version=item.version, status="completed"),
    )
    assert completed.status == "completed"


def test_rework_creates_fresh_robot_assignment_and_stage_binding(test_db, test_user):
    from app.services.loop_item_executions.service import loop_item_execution_service
    from tests.services.test_loop_item_assignment import _make_bot

    project = _project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    definition = ProjectWorkflowDefinition.model_validate(
        project.metadata_json["workflow_definition"]
    )
    definition.nodes[2].execution_mode = "robot"
    definition.nodes[2].required_assignee_type = "agent"
    definition.nodes[2].required_assignee_id = bot.id
    project.metadata_json = {
        **project.metadata_json,
        "workflow_definition": definition.model_dump(mode="json"),
    }
    test_db.commit()
    item = _create(test_db, test_user, project)
    _decide(
        test_db,
        test_user,
        item,
        "ux_spec",
        "force_advance",
        reason="Prepare development",
    )
    first = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == item.id)
        .one()
    )
    first.runtime_device_id = first.execution_device_id
    loop_item_execution_service._bind_issue_execution_task(test_db, execution=first)
    test_db.commit()
    binding = (
        test_db.query(LoopItemTaskBinding)
        .filter(LoopItemTaskBinding.loop_item_id == item.id)
        .one()
    )
    assert binding.metadata_json["workflow_node_id"] == "dev_implementation"
    assert binding.metadata_json["workflow_attempt"] == 1
    _decide(test_db, test_user, item, "dev_implementation")
    _decide(
        test_db, test_user, item, "code_review", "reject", reason="Fix review finding"
    )
    executions = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == item.id)
        .order_by(LoopItemExecution.id)
        .all()
    )
    assert len(executions) == 2
    assert executions[1].runtime_origin_context["workflow_attempt"] == 2
    assert executions[1].id != first.id
    assert workflow_snapshot(item).nodes[2].execution_id == executions[1].id

    from app.services.loop_items.workflow_observability import stage_durations

    node = workflow_snapshot(item).nodes[2]
    activated_at = datetime(2026, 11, 16, 8, tzinfo=timezone.utc)
    node.activated_at = activated_at
    node.deliverables_completed_at = activated_at + timedelta(seconds=20)
    node.state_history = [
        {"to": "waiting", "at": (activated_at - timedelta(seconds=60)).isoformat()},
        {"to": "ready", "at": (activated_at - timedelta(seconds=40)).isoformat()},
        {"to": "waiting", "at": (activated_at + timedelta(seconds=10)).isoformat()},
        {"to": "ready", "at": (activated_at + timedelta(seconds=15)).isoformat()},
    ]
    executions[1].started_at = activated_at.replace(tzinfo=None) + timedelta(seconds=5)
    executions[1].completed_at = activated_at.replace(tzinfo=None) + timedelta(
        seconds=17
    )
    test_db.flush()
    assert stage_durations(
        test_db, item, node, activated_at + timedelta(seconds=30)
    ) == {
        "activation_to_decision": 30,
        "rework_attempt": 30,
        "activation_to_deliverables": 20,
        "awaiting_approval": 10,
        "execution": 12,
        "waiting_for_execution": 5,
        "waiting": 5,
    }


@pytest.mark.asyncio
async def test_task_token_cannot_impersonate_human_release_confirmation(
    test_db, test_user
):
    from fastapi import BackgroundTasks
    from starlette.requests import Request

    from app.api.endpoints.deliveries import update_loop_item
    from app.services.auth.task_token import create_task_token

    item = _create(test_db, test_user, _project(test_db, test_user))
    _decide(
        test_db, test_user, item, "qa_test", "force_advance", reason="Prepare release"
    )
    token = create_task_token(
        task_id=1, subtask_id=1, user_id=test_user.id, user_name=test_user.user_name
    )
    request = Request(
        {"type": "http", "headers": [(b"authorization", f"Bearer {token}".encode())]}
    )
    with pytest.raises(HTTPException) as failure:
        await update_loop_item(
            item.id,
            LoopItemUpdate(
                version=item.version,
                workflow_action={
                    "type": "decide_node",
                    "node_id": "merge_release",
                    "action": "approve",
                },
            ),
            request,
            BackgroundTasks(),
            db=test_db,
            current_user=test_user,
        )
    assert failure.value.status_code == 403


def test_workflow_metrics_record_rejected_gate_and_approval_once(test_db, test_user):
    item = _create(test_db, test_user, _project(test_db, test_user))
    events, duration, violations = MagicMock(), MagicMock(), MagicMock()
    module = "app.services.loop_items.workflow_observability"
    with (
        patch(f"{module}.is_telemetry_enabled", return_value=True),
        patch(
            f"{module}._instruments",
            return_value={
                "events": events,
                "duration": duration,
                "violations": violations,
            },
        ),
    ):
        with pytest.raises(HTTPException):
            _decide(test_db, test_user, item, "product_intake")
        _deliver(test_db, test_user, item)
        assert workflow_snapshot(item).nodes[0].deliverables_completed_at is not None
        values = LoopItemUpdate(
            version=item.version,
            workflow_action={
                "type": "decide_node",
                "node_id": "product_intake",
                "action": "approve",
                "idempotency_key": "metric-once",
            },
        )
        loop_item_service.update(
            test_db, item.id, test_user.id, values, actor_is_human=True
        )
        loop_item_service.update(
            test_db, item.id, test_user.id, values, actor_is_human=True
        )
    recorded_events = [call.args[1]["event"] for call in events.add.call_args_list]
    assert recorded_events.count("gate_rejected") == 1
    assert recorded_events.count("approve") == 1
    phases = {call.args[1]["phase"] for call in duration.record.call_args_list}
    assert phases == {
        "activation_to_decision",
        "activation_to_deliverables",
        "awaiting_approval",
    }
    assert all(call.args[0] == 0 for call in violations.add.call_args_list)
    decision = workflow_snapshot(item).nodes[0].decision_history[-1]
    assert "awaiting_approval" in decision.stage_durations_seconds


@pytest.mark.asyncio
async def test_new_workflow_robot_stage_notifies_existing_queue_consumer(
    test_db, test_user
):
    from fastapi import BackgroundTasks

    from app.api.endpoints.deliveries import create_loop_item
    from app.tasks.robot_queue_tasks import consume_queues_background
    from tests.services.test_loop_item_assignment import _make_bot

    project = _project(test_db, test_user)
    bot = _make_bot(test_db, project, test_user)
    definition = ProjectWorkflowDefinition.model_validate(
        project.metadata_json["workflow_definition"]
    )
    definition.nodes[0].execution_mode = "robot"
    definition.nodes[0].required_assignee_type = "agent"
    definition.nodes[0].required_assignee_id = bot.id
    project.metadata_json = {
        **project.metadata_json,
        "workflow_definition": definition.model_dump(mode="json"),
    }
    test_db.commit()
    tasks = BackgroundTasks()
    response = await create_loop_item(
        int(project.id),
        LoopItemCreate(title="Notify root stage"),
        tasks,
        db=test_db,
        current_user=test_user,
    )
    assert response.workflow.nodes[0].execution_id is not None
    assert len(tasks.tasks) == 1
    assert tasks.tasks[0].func is consume_queues_background
