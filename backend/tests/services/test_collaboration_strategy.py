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
from app.services.loop_items.strategy_pipeline import (
    apply_indexed_change_requests,
    process_strategy_change_request_event,
)
from app.services.loop_items.workflow import workflow_snapshot
from app.services.project_automation_domain import ProjectAutomationEvent
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


def _role_policy(product, development, design, qa, pmo):
    return (
        "收集箱\n"
        + "\n".join(stage[1] for stage in STAGES)
        + "\n| 职能 | 成员 | 职责 |\n| --- | --- | --- |\n"
        + f"| 产品 | {product.user_name} | 需求 |\n"
        + f"| 研发 | {development.user_name} | 实现 |\n"
        + f"| UI | {design.user_name} | 设计 |\n"
        + f"| 测试 | {qa.user_name} | 测试 |\n"
        + f"| PMO | {pmo.user_name} | 跟踪 |\n"
    )


def _fulfillment(requirement):
    if requirement.id == "code_or_pr":
        return {
            "requirement_id": requirement.id,
            "kind": "pull_request",
            "url": "https://github.com/weibo/wegent/pull/1",
            "state": "open",
            "provider": "github",
            "number": 1,
            "head_branch": "feature/strategy",
            "base_branch": "main",
            "head_commit": "a" * 40,
        }
    return {
        "requirement_id": requirement.id,
        "kind": "text",
        "text": f"Evidence for {requirement.name}",
    }


def _submit_requirements(db, item, actors):
    node = next(
        node
        for node in workflow_snapshot(item).nodes
        if node.id == workflow_snapshot(item).current_stage_id
    )
    role_by_requirement = {
        "design": "design",
        "technical_spec": "development",
        "test_cases": "qa",
        "questions_closed": "product",
        "code_or_pr": "development",
        "testable_version": "development",
        "self_tests": "development",
        "qa_report": "qa",
        "business_acceptance": "product",
        "visual_acceptance": "design",
        "problem_closure_or_accepted_risk": "product",
        "release_authorization": "product",
        "release_record": "product",
        "online_verification": "product",
        "rollback": "product",
        "retrospective": "product",
    }
    deliveries = []
    for requirement in node.required_deliverables:
        actor = actors[role_by_requirement.get(requirement.id, "product")]
        delivery = Delivery(
            id=str(uuid4()),
            loop_item_id=item.id,
            created_by_user_id=actor.id,
            status="draft",
            markdown_object_key=f"{requirement.id}.md",
        )
        db.add(delivery)
        db.commit()
        DeliveryService(storage=MagicMock()).finalize(
            db,
            delivery.id,
            actor.id,
            DeliveryFinalize(
                workflow_node_id=node.id,
                fulfillments=[_fulfillment(requirement)],
            ),
        )
        deliveries.append(delivery)
    return deliveries


def _review(
    db,
    item,
    user,
    stage,
    decision="no_objection",
    key=None,
    comment="",
    function_role=None,
):
    return _action(
        db,
        item,
        user,
        "record_stage_review",
        node_id=stage,
        idempotency_key=key or str(uuid4()),
        review={
            "decision": decision,
            **({"function_role": function_role} if function_role else {}),
            "comment": comment,
            "evidence_refs": [f"issue:{item.id}:{item.version}"],
        },
    )


def _set_merged_pr(db, item, number=1, merge_commit="b" * 40):
    workflow = workflow_snapshot(item)
    pr_id = f"github:weibo/wegent#{number}"
    workflow.change_request_state = {
        "required_pr_ids": [pr_id],
        "pull_requests": {
            pr_id: {
                "provider": "github",
                "repository": "weibo/wegent",
                "number": number,
                "url": f"https://github.com/weibo/wegent/pull/{number}",
                "state": "merged",
                "head_sha": "a" * 40,
                "merge_commit": merge_commit,
                "checks_summary": "success",
                "mergeable": "MERGED",
            }
        },
    }
    item.metadata_json = {
        **(item.metadata_json or {}),
        "workflow": workflow.model_dump(mode="json"),
    }
    db.commit()
    return pr_id, merge_commit


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
    developer = _member(test_db, project, "developer")
    designer = _member(test_db, project, "designer")
    qa = _member(test_db, project, "tester")
    _publish(
        test_db,
        project,
        test_user,
        pmo,
        _role_policy(test_user, developer, designer, qa, pmo),
    )
    item = _inbox(test_db, project, test_user)
    _action(test_db, item, test_user, "admit")
    actors = {
        "product": test_user,
        "development": developer,
        "design": designer,
        "qa": qa,
    }
    for stage, *_ in STAGES[:4]:
        with pytest.raises(HTTPException) as error:
            _action(
                test_db, item, test_user, "decide_node", node_id=stage, action="approve"
            )
        assert error.value.detail["code"] in {
            "workflow_deliverables_missing",
            "strategy_stage_review_incomplete",
        }
        _submit_requirements(test_db, item, actors)
        if stage == "joint_review":
            for reviewer in (developer, designer, qa):
                _review(test_db, item, reviewer, stage)
        _action(
            test_db, item, test_user, "decide_node", node_id=stage, action="approve"
        )
    deliveries = _submit_requirements(test_db, item, actors)
    with pytest.raises(HTTPException) as review_order:
        _review(test_db, item, test_user, "quality_acceptance")
    assert review_order.value.detail["code"] == "strategy_review_order_required"
    assert review_order.value.detail["expected_role"] == "qa"
    _review(
        test_db,
        item,
        qa,
        "quality_acceptance",
        decision="objection",
        comment="Regression failure preserved for engineering rework",
    )
    workflow = workflow_snapshot(item)
    assert workflow.current_stage_id == "quality_acceptance"
    assert workflow.quality_blocked is True
    assert workflow.nodes[4].attempts == 2
    assert item.assignee_user_id == developer.id
    assert all(delivery.id in workflow.nodes[4].delivery_ids for delivery in deliveries)
    _submit_requirements(test_db, item, actors)
    for reviewer in (qa, test_user, designer):
        _review(test_db, item, reviewer, "quality_acceptance")
    assert item.assignee_user_id == designer.id
    _action(
        test_db,
        item,
        test_user,
        "decide_node",
        node_id="quality_acceptance",
        action="approve",
    )
    _, merge_commit = _set_merged_pr(test_db, item)
    _action(
        test_db,
        item,
        test_user,
        "record_release",
        release={
            "version": "v2.0.0",
            "url": "https://example.com/releases/v2.0.0",
            "released_at": "2026-11-18T08:00:00Z",
            "environment": "production",
            "merge_commits": [merge_commit],
            "online_verification": "Release verification passed",
            "rollback_summary": "Previous artifact remains available",
            "retrospective": "No remaining release blockers",
            "successful": True,
        },
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


def test_joint_review_requires_current_role_consensus_and_is_idempotent(
    test_db, test_user
):
    project = _project(test_db, test_user)
    pmo = _member(test_db, project)
    developer = _member(test_db, project, "developer")
    designer = _member(test_db, project, "designer")
    qa = _member(test_db, project, "tester")
    _publish(
        test_db,
        project,
        test_user,
        pmo,
        _role_policy(test_user, developer, designer, qa, pmo),
    )
    item = _inbox(test_db, project, test_user)
    _action(test_db, item, test_user, "admit")
    actors = {
        "product": test_user,
        "development": developer,
        "design": designer,
        "qa": qa,
    }
    _submit_requirements(test_db, item, actors)
    _action(
        test_db,
        item,
        test_user,
        "decide_node",
        node_id="requirement_intake",
        action="approve",
    )
    _submit_requirements(test_db, item, actors)
    with pytest.raises(HTTPException) as missing:
        _action(
            test_db,
            item,
            test_user,
            "decide_node",
            node_id="joint_review",
            action="approve",
        )
    assert missing.value.detail["missing_roles"] == ["development", "design", "qa"]
    key = str(uuid4())
    version = item.version
    _review(test_db, item, developer, "joint_review", key=key)
    _review(test_db, item, developer, "joint_review", key=key)
    assert item.version == version
    assert len(workflow_snapshot(item).stage_reviews) == 1
    _review(test_db, item, designer, "joint_review")
    with pytest.raises(HTTPException) as incomplete:
        _action(
            test_db,
            item,
            test_user,
            "decide_node",
            node_id="joint_review",
            action="approve",
        )
    assert incomplete.value.detail["missing_roles"] == ["qa"]
    _review(
        test_db,
        item,
        qa,
        "joint_review",
        decision="conditional",
        comment="Performance depends on a pending benchmark",
    )
    with pytest.raises(HTTPException) as conditional:
        _action(
            test_db,
            item,
            test_user,
            "decide_node",
            node_id="joint_review",
            action="approve",
        )
    assert conditional.value.detail["blocking_reviews"] == ["qa:conditional"]
    _review(test_db, item, qa, "joint_review")
    _action(
        test_db,
        item,
        test_user,
        "decide_node",
        node_id="joint_review",
        action="approve",
    )
    assert workflow_snapshot(item).current_stage_id == "development_preparation"


def test_multi_role_reviewer_must_select_function_role(test_db, test_user):
    project = _project(test_db, test_user)
    pmo = _member(test_db, project, "pmo")
    _publish(
        test_db,
        project,
        test_user,
        pmo,
        _role_policy(test_user, test_user, test_user, test_user, pmo),
    )
    item = _inbox(test_db, project, test_user)
    _action(test_db, item, test_user, "admit")
    actors = {
        "product": test_user,
        "development": test_user,
        "design": test_user,
        "qa": test_user,
    }
    _submit_requirements(test_db, item, actors)
    _action(
        test_db,
        item,
        test_user,
        "decide_node",
        node_id="requirement_intake",
        action="approve",
    )
    _submit_requirements(test_db, item, actors)
    with pytest.raises(HTTPException) as ambiguous:
        _review(test_db, item, test_user, "joint_review")
    assert ambiguous.value.detail["code"] == "strategy_review_role_required"
    for role in ("development", "design", "qa"):
        _review(
            test_db,
            item,
            test_user,
            "joint_review",
            function_role=role,
        )
    _action(
        test_db,
        item,
        test_user,
        "decide_node",
        node_id="joint_review",
        action="approve",
    )
    assert workflow_snapshot(item).current_stage_id == "development_preparation"


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
        == "pending"
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


def test_change_request_lower_bounds_and_provider_pipeline_are_atomic_and_idempotent(
    test_db, test_user
):
    project = _project(test_db, test_user)
    pmo = _member(test_db, project)
    developer = _member(test_db, project, "developer")
    designer = _member(test_db, project, "designer")
    qa = _member(test_db, project, "tester")
    _publish(
        test_db,
        project,
        test_user,
        pmo,
        _role_policy(test_user, developer, designer, qa, pmo),
    )
    item = _inbox(test_db, project, test_user)
    url = "https://github.com/weibo/wegent/pull/7"
    item.metadata_json = {
        **(item.metadata_json or {}),
        "badges": [{"id": url, "label": "#7", "url": url}],
    }
    test_db.commit()

    assert apply_indexed_change_requests(test_db, item, actor_user_id=test_user.id)
    workflow = workflow_snapshot(item)
    assert item.status == "in_progress"
    assert workflow.current_stage_id == "development_implementation"
    assert item.assignee_user_id == developer.id
    assert workflow.status_stage_repairs[-1]["source"] == "change_request.indexed"

    workflow.nodes[3].status = "completed"
    workflow.nodes[4].status = "ready"
    workflow.nodes[4].attempts = 1
    workflow.current_stage_id = "quality_acceptance"
    item.status = "in_review"
    item.metadata_json = {
        **(item.metadata_json or {}),
        "workflow": workflow.model_dump(mode="json"),
    }
    test_db.commit()
    subject = {
        "type": "change_request",
        "provider": "github",
        "repository": "weibo/wegent",
        "number": 7,
        "url": url,
        "head_commit": "a" * 40,
        "state": "open",
        "is_draft": False,
        "mergeable": "MERGEABLE",
    }
    event = ProjectAutomationEvent(
        event_type="change_request.checks_failed",
        project_id=str(project.id),
        subject_id="1#7",
        subject_type="change_request",
        source="github",
        actor_user_id=test_user.id,
        payload={"subject": subject, "check": {"name": "Backend tests"}},
        event_id="event-checks-7",
    )
    assert process_strategy_change_request_event(test_db, event) == 1
    blocked = workflow_snapshot(item)
    assert blocked.current_stage_id == "quality_acceptance"
    assert blocked.quality_blocked is True
    assert item.assignee_user_id == developer.id
    assert len(blocked.provider_event_receipts) == 1
    assert process_strategy_change_request_event(test_db, event) == 0
    assert len(workflow_snapshot(item).provider_event_receipts) == 1

    ready_subject = {**subject, "head_commit": "b" * 40}
    ready = ProjectAutomationEvent(
        event_type="change_request.quality_ready",
        project_id=str(project.id),
        subject_id="1#7",
        subject_type="change_request",
        source="github",
        actor_user_id=test_user.id,
        payload={"subject": ready_subject},
        event_id="event-quality-7",
    )
    assert process_strategy_change_request_event(test_db, ready) == 1
    quality = workflow_snapshot(item)
    assert quality.current_stage_id == "quality_acceptance"
    assert quality.quality_blocked is False
    assert item.assignee_user_id == qa.id

    merge_commit = "c" * 40
    merged = ProjectAutomationEvent(
        event_type="change_request.merged",
        project_id=str(project.id),
        subject_id="1#7",
        subject_type="change_request",
        source="github",
        actor_user_id=test_user.id,
        payload={
            "subject": {**ready_subject, "merge_commit": merge_commit},
            "merge_commit": merge_commit,
        },
        event_id="event-merged-7",
    )
    assert process_strategy_change_request_event(test_db, merged) == 1
    release = workflow_snapshot(item)
    assert release.current_stage_id == "release_launch"
    assert item.status == "in_review"
    assert release.nodes[3].status == "completed"
    assert release.nodes[4].status == "completed"


def test_shared_pull_request_updates_each_scoped_strategy_issue(test_db, test_user):
    project = _project(test_db, test_user)
    pmo = _member(test_db, project)
    developer = _member(test_db, project, "developer")
    designer = _member(test_db, project, "designer")
    qa = _member(test_db, project, "tester")
    _publish(
        test_db,
        project,
        test_user,
        pmo,
        _role_policy(test_user, developer, designer, qa, pmo),
    )
    url = "https://github.com/weibo/wegent/pull/8"
    items = [_inbox(test_db, project, test_user) for _ in range(2)]
    for item in items:
        item.metadata_json = {
            **(item.metadata_json or {}),
            "badges": [{"id": url, "label": "#8", "url": url}],
        }
        apply_indexed_change_requests(test_db, item, actor_user_id=test_user.id)
    test_db.commit()

    event = ProjectAutomationEvent(
        event_type="change_request.quality_ready",
        project_id=str(project.id),
        subject_id="1#8",
        subject_type="change_request",
        source="github",
        actor_user_id=test_user.id,
        payload={
            "subject": {
                "provider": "github",
                "repository": "weibo/wegent",
                "number": 8,
                "url": url,
                "head_commit": "d" * 40,
                "state": "open",
                "is_draft": False,
                "mergeable": "MERGEABLE",
            }
        },
        event_id="event-quality-8",
    )
    assert process_strategy_change_request_event(test_db, event) == 2
    test_db.commit()
    for item in items:
        current = test_db.get(LoopItem, item.id)
        workflow = workflow_snapshot(current)
        assert workflow.current_stage_id == "quality_acceptance"
        assert current.status == "in_review"
        assert current.assignee_user_id == qa.id
