"""Service-level acceptance contracts for text strategies and inbox admission."""

from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.core.config import settings
from app.models.delivery import Delivery, LoopItem, LoopNode
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.models.wework_notification import WeworkNotification
from app.schemas.cloud_project import (
    CloudProjectBoardConfig,
    CloudProjectResponse,
    CloudProjectUpdate,
)
from app.schemas.collaboration_strategy import CoordinatorDecision
from app.schemas.delivery import (
    DeliveryFinalize,
    LoopItemCreate,
    LoopItemResponse,
    LoopItemUpdate,
)
from app.schemas.issue_workflow import ProjectWorkflowDefinition
from app.services.cloud_projects.service import cloud_project_service
from app.services.delivery.service import DeliveryService
from app.services.loop_items.service import loop_item_service
from app.services.loop_items.strategy import STAGES
from app.services.loop_items.workflow import workflow_snapshot
from tests.services.test_project_workflow_gates import _project


@pytest.fixture(autouse=True)
def isolate_channels():
    with (
        patch("app.core.async_utils.schedule_async_task"),
        patch("app.services.project_chat.push.push_project_chat_message"),
    ):
        yield


def _member(db, project, name="pmo"):
    user = User(user_name=name + uuid4().hex[:8], password_hash="test")
    db.add(user)
    db.flush()
    db.add(
        ResourceMember.create(
            resource_type="CloudProject",
            resource_id=int(project.id),
            entity_id=str(user.id),
            role="Developer",
            status="approved",
        )
    )
    db.commit()
    return user


def _policy(owner, pmo, *, bullet=False):
    roles = {"产品": owner, "研发": owner, "UI": owner, "测试": owner, "PMO": pmo}
    body = "收集箱\n" + "\n".join(stage[1] for stage in STAGES) + "\n"
    if bullet:
        return body + "\n".join(
            f"- {role}：{name}，负责协作" for role, name in roles.items()
        )
    return (
        body
        + "| 职能 | 成员 | 职责 |\n| --- | --- | --- |\n"
        + "\n".join(f"| {role} | {name} | 协作 |" for role, name in roles.items())
    )


def _publish(db, project, user, pmo, text=None):
    version = (
        (project.metadata_json or {})
        .get("collaboration_strategy", {})
        .get("version", 0)
    )
    return cloud_project_service.update(
        db,
        int(project.id),
        user.id,
        CloudProjectUpdate(
            version=project.version,
            collaboration_strategy={
                "text": text or _policy(user.user_name, pmo.user_name),
                "expected_version": version,
            },
        ),
    )


def _inbox(db, project, user):
    return loop_item_service.create(
        db,
        int(project.id),
        user.id,
        LoopItemCreate(
            title="Ship safely",
            description="User outcome and scope",
            priority="high",
            intake_definition={
                "objective": "Outcome",
                "scope": "Scope",
                "non_goals": "Not in scope",
                "acceptance_criteria": "Proven behavior",
                "dependencies": "none",
                "proposed_owner": user.user_name,
            },
        ),
    )


def _action(db, item, user, kind, **values):
    return loop_item_service.update(
        db,
        item.id,
        user.id,
        LoopItemUpdate(
            version=item.version,
            workflow_action={"type": kind, "idempotency_key": str(uuid4()), **values},
        ),
        actor_is_human=True,
    )


def _submit(db, item, user):
    node = next(
        node
        for node in workflow_snapshot(item).nodes
        if node.id == workflow_snapshot(item).current_stage_id
    )
    values = [
        {
            "requirement_id": req.id,
            "kind": "text",
            "text": "Reviewed immutable evidence",
        }
        for req in node.required_deliverables
        if req.id != "code_or_pr"
    ]
    if any(req.id == "code_or_pr" for req in node.required_deliverables):
        values.append(
            {
                "requirement_id": "code_or_pr",
                "kind": "pull_request",
                "url": "https://github.com/weibo/wegent/pull/1",
                "state": "open",
                "provider": "github",
                "number": 1,
                "head_branch": "feature/strategy",
                "base_branch": "main",
                "head_commit": "a" * 40,
            }
        )
    delivery = Delivery(
        id=str(uuid4()),
        loop_item_id=item.id,
        created_by_user_id=user.id,
        status="draft",
        markdown_object_key="test.md",
    )
    db.add(delivery)
    db.commit()
    DeliveryService(storage=MagicMock()).finalize(
        db,
        delivery.id,
        user.id,
        DeliveryFinalize(workflow_node_id=node.id, fulfillments=values),
    )
    return delivery


def test_revision_publish_is_immutable_and_inbox_has_no_stage_or_execution(
    test_db, test_user
):
    project = _project(test_db, test_user)
    pmo = _member(test_db, project)
    _publish(test_db, project, test_user, pmo)
    first = project.metadata_json["collaboration_strategy"]
    item = _inbox(test_db, project, test_user)
    workflow = workflow_snapshot(item)
    assert (
        item.status == "inbox"
        and workflow.nodes == []
        and workflow.current_stage_id is None
    )
    assert workflow.instance_id and workflow.strategy_state == "inbox"
    assert not set(item.metadata_json.get("tags", [])) & {stage[1] for stage in STAGES}
    assert test_db.query(LoopItemExecution).filter_by(loop_item_id=item.id).count() == 0
    assert (
        test_db.query(WeworkNotification)
        .filter(WeworkNotification.url.contains(f"/issues/{item.id}"))
        .count()
        == 0
    )
    _publish(test_db, project, test_user, pmo, first["text"] + "\nNew future guidance")
    assert project.metadata_json["collaboration_strategy"]["version"] == 2
    assert (
        "+New future guidance"
        in project.metadata_json["collaboration_strategy"]["diff"]
    )
    assert project.metadata_json["collaboration_strategy_versions"][0] == first
    assert workflow_snapshot(item).strategy_snapshot.version == 1
    response = CloudProjectResponse.model_validate(project.__dict__)
    assert (
        response.agentic_strategy_enabled
        and len(response.collaboration_strategy_versions) == 2
    )
    assert (
        LoopItemResponse.model_validate(
            loop_item_service.response_values(test_db, item, test_user.id)
        ).intake_definition.dependencies
        == "none"
    )


def test_publish_uses_w0056_default_assistant_roster_for_matching_stage(
    test_db, test_user
):
    project = _project(test_db, test_user)
    pmo = _member(test_db, project)
    test_db.add(
        LoopNode(
            id=str(uuid4()),
            resource_type="project_assistant_roster",
            cloud_project_id=str(project.id),
            user_id=test_user.id,
            title="产品助理",
            status="active",
            metadata_json={
                "role_id": "development",
                "endpoint_ref": f"local_wework:{test_user.id}:development",
                "endpoint_kind": "local_wework",
                "display_name": "研发助理",
                "capability_tags": [],
            },
        )
    )
    test_db.commit()
    _publish(test_db, project, test_user, pmo)
    definition = ProjectWorkflowDefinition.model_validate(
        project.metadata_json["workflow_definition"]
    )
    nodes = {node.id: node for node in definition.nodes}
    assert nodes["requirement_intake"].required_assignee_type == "user"
    assert nodes["requirement_intake"].required_assignee_id == str(test_user.id)
    assert nodes["requirement_intake"].execution_mode == "human"
    assert nodes["requirement_intake"].human_approval_required is True
    assert nodes["development_implementation"].execution_mode == "robot"
    assert nodes["development_implementation"].required_assignee_id == str(test_user.id)
    assert nodes["release_launch"].execution_mode == "human"


def test_inbox_cannot_skip_admission_and_missing_definition_can_retry(
    test_db, test_user
):
    project = _project(test_db, test_user)
    pmo = _member(test_db, project)
    _publish(test_db, project, test_user, pmo)
    item = loop_item_service.create(
        test_db, int(project.id), test_user.id, LoopItemCreate(title="Incomplete")
    )
    for status in ("requirement_intake", "completed"):
        with pytest.raises(HTTPException) as error:
            loop_item_service.update(
                test_db,
                item.id,
                test_user.id,
                LoopItemUpdate(version=item.version, status=status),
            )
        assert error.value.status_code == 409
    key = str(uuid4())
    with pytest.raises(HTTPException) as error:
        _action(test_db, item, test_user, "admit", idempotency_key=key)
    assert "objective" in error.value.detail["missing_conditions"]
    complete = _inbox(test_db, project, test_user).metadata_json["intake_definition"]
    loop_item_service.update(
        test_db,
        item.id,
        test_user.id,
        LoopItemUpdate(
            version=item.version,
            description="Defined",
            priority="high",
            intake_definition=complete,
        ),
    )
    _action(test_db, item, test_user, "admit", idempotency_key=key)
    assert item.status == "pending"
    assert workflow_snapshot(item).current_stage_id == "requirement_intake"
    assert [node.status for node in workflow_snapshot(item).nodes] == [
        "ready",
        *["blocked"] * 5,
    ]
    assert (
        test_db.query(WeworkNotification)
        .filter(
            WeworkNotification.url.contains(f"/issues/{item.id}"),
            WeworkNotification.user_id == pmo.id,
        )
        .count()
        == 2
    )


def test_explicit_strategy_application_notifies_pmo_and_preserves_manual_history(
    test_db, test_user
):
    project = _project(test_db, test_user)
    pmo = _member(test_db, project)
    item = loop_item_service.create(
        test_db,
        int(project.id),
        test_user.id,
        LoopItemCreate(title="Existing Issue", status="in_progress", tags=["质量验收"]),
        apply_project_workflow=False,
    )
    _publish(test_db, project, test_user, pmo)
    _action(
        test_db,
        item,
        test_user,
        "apply_project",
        reason="Review existing scope before admission",
    )
    assert item.status == "inbox" and "质量验收" not in item.metadata_json["tags"]
    assert workflow_snapshot(item).strategy_state == "inbox"
    messages = test_db.query(ProjectChatMessage).filter_by(task_id=item.id).all()
    assert len(messages) == 1
    assert messages[0].metadata_json["workflow_summary"]["event"] == "strategy_applied"
    assert "已应用项目策略" in messages[0].content
    assert item.metadata_json["status_history"][-1]["from_status"] == "in_progress"
    assert test_db.query(LoopItemExecution).filter_by(loop_item_id=item.id).count() == 0


def test_admission_mentions_pmo_and_same_receipt_never_repeats_notifications(
    test_db, test_user
):
    project = _project(test_db, test_user)
    pmo = _member(test_db, project)
    _publish(test_db, project, test_user, pmo)
    item = _inbox(test_db, project, test_user)
    version, key = item.version, str(uuid4())
    _action(test_db, item, test_user, "admit", idempotency_key=key)
    count = (
        test_db.query(WeworkNotification)
        .filter(WeworkNotification.url.contains(f"/issues/{item.id}"))
        .count()
    )
    loop_item_service.update(
        test_db,
        item.id,
        test_user.id,
        LoopItemUpdate(
            version=version, workflow_action={"type": "admit", "idempotency_key": key}
        ),
        actor_is_human=True,
    )
    assert (
        test_db.query(WeworkNotification)
        .filter(WeworkNotification.url.contains(f"/issues/{item.id}"))
        .count()
        == count
    )
    summaries = test_db.query(ProjectChatMessage).filter_by(task_id=item.id).all()
    assert summaries[0].sender_type == "system"
    assert summaries[0].metadata_json["mentions"] == [
        {"type": "user", "id": str(pmo.id), "label": pmo.user_name}
    ]
    assert (
        summaries[0].metadata_json["workflow_summary"]["owner"] == test_user.user_name
    )
    assert "已离开收集箱" in summaries[0].content
    assert "exit_inbox" not in summaries[0].content


def test_six_stages_require_evidence_and_qa_rework_preserves_prior_attempts(
    test_db, test_user
):
    project = _project(test_db, test_user)
    pmo = _member(test_db, project)
    _publish(test_db, project, test_user, pmo)
    item = _inbox(test_db, project, test_user)
    _action(test_db, item, test_user, "admit")
    for stage, *_ in STAGES[:4]:
        with pytest.raises(HTTPException) as error:
            _action(
                test_db, item, test_user, "decide_node", node_id=stage, action="approve"
            )
        assert error.value.detail["code"] == "workflow_deliverables_missing"
        _submit(test_db, item, test_user)
        _action(
            test_db, item, test_user, "decide_node", node_id=stage, action="approve"
        )
    failed = _submit(test_db, item, test_user)
    _action(
        test_db,
        item,
        test_user,
        "decide_node",
        node_id="quality_acceptance",
        action="reject",
        reason="Visual design needs preparation",
        rework_to="development_preparation",
    )
    workflow = workflow_snapshot(item)
    assert workflow.current_stage_id == "development_preparation"
    assert workflow.nodes[2].attempts == 2
    assert failed.id in workflow.nodes[4].delivery_ids
    assert (
        workflow.nodes[4].decision_history[-1].reason
        == "Visual design needs preparation"
    )
    for stage, *_ in STAGES[2:]:
        if stage == "quality_acceptance":
            with pytest.raises(HTTPException):
                _action(
                    test_db,
                    item,
                    test_user,
                    "decide_node",
                    node_id=stage,
                    action="approve",
                )
        _submit(test_db, item, test_user)
        _action(
            test_db, item, test_user, "decide_node", node_id=stage, action="approve"
        )
    assert item.status == "completed"
    assert all(node.status == "completed" for node in workflow_snapshot(item).nodes)
    completions = [
        message
        for message in test_db.query(ProjectChatMessage).filter_by(task_id=item.id)
        if message.metadata_json["workflow_summary"]["event"] == "stage_completed"
    ]
    first = next(
        message
        for message in completions
        if message.metadata_json["workflow_summary"]["changed_stage"] == "需求提出"
    )
    assert first.metadata_json["workflow_summary"]["stage"] == "共同评审"
    assert "阶段完成：需求提出" in first.content
    assert "stage_completed" not in first.content


def test_wait_block_resume_and_upgrade_preserve_instance_and_evidence(
    test_db, test_user
):
    project = _project(test_db, test_user)
    pmo = _member(test_db, project)
    _publish(test_db, project, test_user, pmo)
    item = _inbox(test_db, project, test_user)
    _action(test_db, item, test_user, "admit")
    instance = workflow_snapshot(item).instance_id
    delivery = _submit(test_db, item, test_user)
    for state in ("waiting", "blocked", "ready"):
        _action(
            test_db,
            item,
            test_user,
            "set_stage_state",
            node_id="requirement_intake",
            state=state,
            reason="Human review",
        )
        assert item.status == "pending"
        assert workflow_snapshot(item).nodes[0].status == state
    _action(
        test_db,
        item,
        test_user,
        "decide_node",
        node_id="requirement_intake",
        action="approve",
    )
    replacement = _member(test_db, project, "product")
    new_text = project.metadata_json["collaboration_strategy"]["text"].replace(
        f"| 产品 | {test_user.user_name} |", f"| 产品 | {replacement.user_name} |"
    )
    _publish(
        test_db,
        project,
        test_user,
        pmo,
        new_text + "\nApproved v2",
    )
    _action(test_db, item, test_user, "upgrade_strategy", reason="Adopt reviewed v2")
    workflow = workflow_snapshot(item)
    assert workflow.instance_id == instance and workflow.strategy_snapshot.version == 2
    assert delivery.id in workflow.nodes[0].delivery_ids
    assert workflow.strategy_upgrade_history[-1]["from_version"] == 1
    assert workflow.nodes[0].required_assignee_id == str(test_user.id)
    assert workflow.nodes[1].required_assignee_id == str(replacement.id)
    impact = workflow.strategy_upgrade_history[-1]["migration_impact"]
    assert impact["assignment_changes"][0] == {
        "stage_id": "joint_review",
        "from_user_id": str(test_user.id),
        "to_user_id": str(replacement.id),
    }
    from app.services.issue_assignments import issue_assignment_service

    active = issue_assignment_service.active_for_issue(test_db, item.id)
    assert [
        (entry.workflow_step, entry.member_id)
        for entry in active
        if entry.workflow_step
    ] == [("joint_review", str(replacement.id))]


def test_coordinator_output_is_advisory_versioned_and_scoped(test_db, test_user):
    project = _project(test_db, test_user)
    pmo = _member(test_db, project)
    _publish(test_db, project, test_user, pmo)
    item = _inbox(test_db, project, test_user)
    _action(test_db, item, test_user, "evaluate")
    decision = workflow_snapshot(item).coordinator_decision
    assert decision.stage == "inbox" and decision.integration_status == "recorded"
    assert decision.clarification is None and decision.evidence_refs
    assert item.status == "inbox"
    for index in range(101):
        test_db.add(
            ProjectChatMessage(
                message_id=f"history-{uuid4()}",
                project_id=str(project.id),
                task_id=item.id,
                sender_type="user",
                sender_id=str(test_user.id),
                sender_name=test_user.user_name,
                content=f"Historical discussion {index}",
            )
        )
    test_db.commit()
    _action(test_db, item, test_user, "evaluate")
    assert len(workflow_snapshot(item).coordinator_decision.evidence_refs) <= 100
    decision = workflow_snapshot(item).coordinator_decision
    key = str(uuid4())
    payload = decision.model_dump()
    payload.update(
        issue_version=item.version, idempotency_key=key, integration_status="recorded"
    )
    payload["evidence_refs"] = ["delivery:another-issue"]
    with pytest.raises(HTTPException) as error:
        _action(
            test_db,
            item,
            test_user,
            "record_coordinator_decision",
            decision=payload,
            idempotency_key=key,
        )
    assert error.value.detail["code"] == "coordinator_evidence_invalid"
    payload.update(
        evidence_refs=[f"issue:{item.id}:{item.version}"],
        confidence=0.4,
        clarification=None,
    )
    with pytest.raises(ValidationError):
        CoordinatorDecision.model_validate(payload)


@pytest.mark.parametrize("stored_board", [False, True])
def test_text_roles_bullets_and_historical_default_lane_survive_publish(
    test_db, test_user, stored_board
):
    project = _project(test_db, test_user)
    project.metadata_json = (
        {"board_config": CloudProjectBoardConfig().model_dump()} if stored_board else {}
    )
    test_db.commit()
    historical = loop_item_service.create(
        test_db,
        int(project.id),
        test_user.id,
        LoopItemCreate(title="Historical", status="pending"),
    )
    pmo = _member(test_db, project)
    _publish(
        test_db,
        project,
        test_user,
        pmo,
        _policy(test_user.user_name, pmo.user_name, bullet=True),
    )
    assert historical.status == "pending" and workflow_snapshot(historical) is None
    assert "pending" in {
        entry["id"] for entry in project.metadata_json["board_config"]["statuses"]
    }
    assert project.metadata_json["collaboration_strategy"]["role_mapping"]["pmo"] == [
        pmo.user_name
    ]
    assert (
        CloudProjectResponse.model_validate(
            project.__dict__
        ).board_config.processing_start_status_id
        == "requirement_intake"
    )


def test_rollback_preserves_running_snapshot_and_disables_new_strategy(
    test_db, test_user, monkeypatch
):
    project = _project(test_db, test_user)
    pmo = _member(test_db, project)
    _publish(test_db, project, test_user, pmo)
    item = _inbox(test_db, project, test_user)
    _action(test_db, item, test_user, "admit")
    monkeypatch.setattr(settings, "COLLAB_AGENTIC_STRATEGY_V1", False)
    manual = _inbox(test_db, project, test_user)
    assert workflow_snapshot(manual) is None
    _submit(test_db, item, test_user)
    _action(
        test_db,
        item,
        test_user,
        "decide_node",
        node_id="requirement_intake",
        action="approve",
    )
    assert item.status == "pending"
    assert workflow_snapshot(item).current_stage_id == "joint_review"
    with pytest.raises(HTTPException):
        _action(test_db, item, test_user, "evaluate")


def test_proposed_owner_can_work_but_unrelated_member_cannot_decide(test_db, test_user):
    project = _project(test_db, test_user)
    pmo = _member(test_db, project)
    owner = _member(test_db, project, "developer")
    _publish(test_db, project, test_user, pmo)
    item = _inbox(test_db, project, test_user)
    intake = item.metadata_json["intake_definition"]
    loop_item_service.update(
        test_db,
        item.id,
        test_user.id,
        LoopItemUpdate(
            version=item.version,
            intake_definition={**intake, "proposed_owner": owner.user_name},
        ),
    )
    _action(test_db, item, test_user, "admit")
    with pytest.raises(HTTPException) as denied:
        _action(
            test_db,
            item,
            pmo,
            "decide_node",
            node_id="requirement_intake",
            action="approve",
        )
    assert denied.value.status_code == 403
    _submit(test_db, item, owner)
    _action(
        test_db,
        item,
        owner,
        "decide_node",
        node_id="requirement_intake",
        action="approve",
    )
    assert item.status == "pending"
    assert workflow_snapshot(item).current_stage_id == "joint_review"


def test_pmo_without_issue_visibility_cannot_receive_or_leak_stage_transition(
    test_db, test_user
):
    project = _project(test_db, test_user)
    pmo = _member(test_db, project)
    _publish(test_db, project, test_user, pmo)
    item = _inbox(test_db, project, test_user)
    item.metadata_json = {**item.metadata_json, "security_level": "related"}
    test_db.commit()
    with pytest.raises(HTTPException) as denied:
        _action(test_db, item, test_user, "admit")
    assert denied.value.status_code == 422
    test_db.rollback()
    test_db.refresh(item)
    assert item.status == "inbox" and workflow_snapshot(item).nodes == []
    assert test_db.query(ProjectChatMessage).filter_by(task_id=item.id).count() == 0
    assert (
        test_db.query(WeworkNotification)
        .filter(WeworkNotification.url.contains(f"/issues/{item.id}"))
        .count()
        == 0
    )


def test_comment_event_refreshes_scoped_pending_coordinator_without_dispatch(
    test_db, test_user
):
    from app.schemas.project_chat import ProjectChatSend
    from app.services.project_chat.service import project_chat_service

    project = _project(test_db, test_user)
    pmo = _member(test_db, project)
    _publish(test_db, project, test_user, pmo)
    item = _inbox(test_db, project, test_user)
    result = project_chat_service.send(
        test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        request=ProjectChatSend(
            client_message_id=str(uuid4()),
            project_id=str(project.id),
            task_id=item.id,
            content="Please clarify the acceptance criteria",
        ),
    )
    decision = workflow_snapshot(item).coordinator_decision
    assert f"comment:{result.message.message_id}" in decision.evidence_refs
    assert decision.integration_status == "recorded" and item.status == "inbox"
    assert test_db.query(LoopItemExecution).filter_by(loop_item_id=item.id).count() == 0
    comment = loop_item_service.add_comment(
        test_db, item.id, test_user.id, "Native Issue comment adds acceptance evidence"
    )
    decision = workflow_snapshot(item).coordinator_decision
    assert f"comment:{comment['id']}" in decision.evidence_refs
    assert decision.issue_version == item.version
    assert (
        workflow_snapshot(item).coordinator_trigger["event_key"]
        == f"comment:{comment['id']}"
    )


def test_quality_evidence_requires_its_function_and_development_approval_is_scoped(
    test_db, test_user
):
    project = _project(test_db, test_user)
    pmo = _member(test_db, project)
    designer = _member(test_db, project, "designer")
    qa = _member(test_db, project, "tester")
    policy = (
        _policy(test_user.user_name, pmo.user_name)
        .replace(f"| UI | {test_user.user_name} |", f"| UI | {designer.user_name} |")
        .replace(f"| 测试 | {test_user.user_name} |", f"| 测试 | {qa.user_name} |")
    )
    _publish(test_db, project, test_user, pmo, policy)
    item = _inbox(test_db, project, test_user)
    _action(test_db, item, test_user, "admit")
    with pytest.raises(HTTPException) as denied:
        _action(
            test_db,
            item,
            qa,
            "decide_node",
            node_id="development_implementation",
            action="approve",
        )
    assert denied.value.status_code == 403
    _action(
        test_db,
        item,
        test_user,
        "decide_node",
        node_id="development_implementation",
        action="force_advance",
        reason="Maintainer authorizes the recorded exceptional transition",
    )
    assert item.status == "in_review"
    delivery = Delivery(
        id=str(uuid4()),
        loop_item_id=item.id,
        created_by_user_id=qa.id,
        status="draft",
        markdown_object_key="visual.md",
    )
    test_db.add(delivery)
    test_db.commit()
    evidence = DeliveryFinalize(
        workflow_node_id="quality_acceptance",
        fulfillments=[
            {
                "requirement_id": "visual_acceptance",
                "kind": "text",
                "text": "Visual inspection approved",
            }
        ],
    )
    service = DeliveryService(storage=MagicMock())
    with pytest.raises(HTTPException) as denied:
        service.finalize(test_db, delivery.id, qa.id, evidence)
    assert denied.value.detail["code"] == "strategy_deliverable_permission_denied"
    visual = Delivery(
        id=str(uuid4()),
        loop_item_id=item.id,
        created_by_user_id=designer.id,
        status="draft",
        markdown_object_key="design.md",
    )
    test_db.add(visual)
    test_db.commit()
    service.finalize(test_db, visual.id, designer.id, evidence)
    assert visual.id in workflow_snapshot(item).nodes[4].delivery_ids
