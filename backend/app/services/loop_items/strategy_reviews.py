# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Deterministic review, handoff and release gates for strategy stages."""

from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.models.delivery import Delivery, LoopItem
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.schemas.collaboration_strategy import (
    StageReviewDecision,
    StageReviewInput,
    StageReviewRole,
)
from app.schemas.issue_workflow import (
    IssueWorkflowInstance,
    WorkflowAction,
    WorkflowNodeDecision,
    WorkflowNodeInstance,
)
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.loop_items.strategy_coordinator import comment_evidence_refs

JOINT_REVIEW_ROLES: tuple[StageReviewRole, ...] = ("development", "design", "qa")
QUALITY_REVIEW_ROLES: tuple[StageReviewRole, ...] = ("qa", "product", "design")


def _current_node(
    workflow: IssueWorkflowInstance, node_id: str
) -> WorkflowNodeInstance:
    node = next((entry for entry in workflow.nodes if entry.id == node_id), None)
    if node is None:
        raise HTTPException(404, "Workflow stage not found")
    if workflow.current_stage_id != node.id:
        raise HTTPException(409, "Only the current stage can record a review")
    return node


def _reviewer_role(
    db: Session,
    workflow: IssueWorkflowInstance,
    node_id: str,
    user_id: int,
    requested_role: StageReviewRole | None = None,
) -> StageReviewRole:
    user = db.get(User, user_id)
    if user is None or workflow.strategy_snapshot is None:
        raise HTTPException(403, "The reviewer is not an active project participant")
    allowed: tuple[StageReviewRole, ...]
    if node_id == "joint_review":
        allowed = (*JOINT_REVIEW_ROLES, "product")
    elif node_id == "quality_acceptance":
        allowed = QUALITY_REVIEW_ROLES
    else:
        raise HTTPException(409, "This stage does not accept role reviews")
    node = _current_node(workflow, node_id)
    matching = tuple(
        candidate
        for candidate in allowed
        if user.user_name in workflow.strategy_snapshot.role_mapping.get(candidate, [])
    )
    if requested_role is not None:
        if requested_role not in matching:
            raise HTTPException(
                403,
                {
                    "code": "strategy_review_role_denied",
                    "current_stage_id": node_id,
                    "message": "The reviewer does not hold the requested functional role",
                },
            )
        return requested_role
    if len(matching) > 1:
        raise HTTPException(
            409,
            {
                "code": "strategy_review_role_required",
                "current_stage_id": node_id,
                "roles": list(matching),
                "message": "Select the functional role for this review",
            },
        )
    if node.required_assignee_type == "user" and node.required_assignee_id == str(
        user_id
    ):
        assigned_role = next(
            (
                candidate
                for candidate in allowed
                if workflow.strategy_snapshot.role_mapping.get(candidate, [])[:1]
                == [user.user_name]
            ),
            None,
        )
        if assigned_role is not None:
            return assigned_role
    if not matching:
        raise HTTPException(
            403,
            {
                "code": "strategy_review_role_denied",
                "current_stage_id": node_id,
                "message": "The reviewer does not hold an allowed functional role",
            },
        )
    return matching[0]


def _valid_evidence(
    db: Session, item: LoopItem, workflow: IssueWorkflowInstance
) -> set[str]:
    valid = {
        f"strategy:{workflow.strategy_snapshot.version}",
        f"issue:{item.id}:{item.version}",
    }
    valid.update(
        f"delivery:{row.id}"
        for row in db.query(Delivery).filter(
            Delivery.loop_item_id == item.id,
            Delivery.status == "delivered",
        )
    )
    valid.update(comment_evidence_refs(db, item))
    for badge in (item.metadata_json or {}).get("badges", []):
        if isinstance(badge, dict) and isinstance(badge.get("url"), str):
            url = badge["url"]
            valid.update({url, f"pull_request:{url}", f"pr:{url}"})
    return valid


def _latest_reviews(
    workflow: IssueWorkflowInstance,
    node_id: str,
    issue_version: int,
    attempt: int,
) -> dict[StageReviewRole, StageReviewDecision]:
    latest: dict[StageReviewRole, StageReviewDecision] = {}
    for review in workflow.stage_reviews:
        if (
            review.stage_id == node_id
            and review.issue_version == issue_version
            and review.attempt == attempt
            and review.strategy_version == workflow.strategy_snapshot.version
        ):
            latest[review.function_role] = review
    return latest


def _missing_review_roles(
    workflow: IssueWorkflowInstance,
    node_id: str,
    issue_version: int,
    attempt: int,
    roles: tuple[StageReviewRole, ...],
) -> tuple[list[str], list[str]]:
    latest = _latest_reviews(workflow, node_id, issue_version, attempt)
    missing = [role for role in roles if role not in latest]
    blocked = [
        f"{role}:{latest[role].decision}"
        for role in roles
        if role in latest and latest[role].decision != "no_objection"
    ]
    return missing, blocked


def _role_user(db: Session, workflow: IssueWorkflowInstance, role: str) -> User | None:
    names = workflow.strategy_snapshot.role_mapping.get(role, [])
    if not names:
        return None
    return db.query(User).filter(User.user_name == names[0]).first()


def _assign_stage_owner(
    db: Session,
    item: LoopItem,
    user_id: int,
    workflow: IssueWorkflowInstance,
    node: WorkflowNodeInstance,
    role: str,
) -> User | None:
    target = _role_user(db, workflow, role)
    if target is None:
        return None
    from app.services.issue_assignments import issue_assignment_service
    from app.services.loop_items.workflow import _retire_assignments

    _retire_assignments(db, item, user_id, {node.id})
    node.required_assignee_type = "user"
    node.required_assignee_id = str(target.id)
    node.execution_mode = "human"
    node.human_approval_required = True
    metadata = dict(item.metadata_json or {})
    metadata.pop("collaboration_group", None)
    item.assignee_user_id = target.id
    item.assignee_agent_id = ""
    item.assignee_team_id = None
    item.metadata_json = metadata
    issue_assignment_service.record(
        db,
        project_id=item.cloud_project_id,
        issue_id=item.id,
        member_type="human",
        member_id=str(target.id),
        assigned_by_user_id=user_id,
        workflow_step=node.id,
        notify=True,
        trigger="automation",
        automation_context={
            "trigger": "strategy_review_handoff",
            "stage_id": node.id,
            "role": role,
        },
    )
    return target


def _quality_next_role(
    workflow: IssueWorkflowInstance,
    node_id: str,
    issue_version: int,
    attempt: int,
) -> str | None:
    latest = _latest_reviews(workflow, node_id, issue_version, attempt)
    return next(
        (
            role
            for role in QUALITY_REVIEW_ROLES
            if role not in latest or latest[role].decision != "no_objection"
        ),
        None,
    )


def record_stage_review(
    db: Session,
    item: LoopItem,
    user_id: int,
    workflow: IssueWorkflowInstance,
    action: WorkflowAction,
    *,
    actor_is_human: bool,
) -> None:
    from app.services.loop_items.strategy import notify_strategy_event

    if not actor_is_human:
        raise HTTPException(403, "Stage reviews require authorized human confirmation")
    node = _current_node(workflow, action.node_id or "")
    review: StageReviewInput = action.review
    role = _reviewer_role(db, workflow, node.id, user_id, review.function_role)
    if node.id == "quality_acceptance":
        expected_role = _quality_next_role(
            workflow,
            node.id,
            item.version,
            max(1, node.attempts),
        )
        if expected_role is not None and role != expected_role:
            raise HTTPException(
                409,
                {
                    "code": "strategy_review_order_required",
                    "current_stage_id": node.id,
                    "expected_role": expected_role,
                    "requested_role": role,
                    "message": "Quality reviews advance in QA, product, then UI order",
                },
            )
    invalid = set(review.evidence_refs) - _valid_evidence(db, item, workflow)
    if invalid:
        raise HTTPException(
            422,
            {
                "code": "strategy_review_evidence_invalid",
                "invalid_refs": sorted(invalid),
            },
        )
    decision = StageReviewDecision(
        **review.model_dump(exclude={"function_role"}),
        stage_id=node.id,
        function_role=role,
        reviewer_id=user_id,
        attempt=max(1, node.attempts),
        issue_version=item.version,
        strategy_version=workflow.strategy_snapshot.version,
        created_at=datetime.now(timezone.utc),
        idempotency_key=action.idempotency_key or "",
    )
    workflow.stage_reviews.append(decision)
    if node.id == "quality_acceptance":
        if review.decision != "no_objection":
            workflow.quality_blocked = True
            node.attempts += 1
            _assign_stage_owner(db, item, user_id, workflow, node, "development")
            notify_strategy_event(
                db,
                item,
                user_id,
                workflow,
                "quality_blocked",
                review.comment,
                changed_stage=node.name,
            )
        else:
            next_role = _quality_next_role(
                workflow, node.id, item.version, max(1, node.attempts)
            )
            workflow.quality_blocked = bool(next_role and workflow.quality_blocked)
            if next_role is not None:
                _assign_stage_owner(db, item, user_id, workflow, node, next_role)
            notify_strategy_event(
                db,
                item,
                user_id,
                workflow,
                "quality_handoff",
                next_role or "QA、产品与 UI 均已无异议，等待产品推进",
                changed_stage=node.name,
            )
    else:
        notify_strategy_event(
            db,
            item,
            user_id,
            workflow,
            "stage_review_recorded",
            f"{role}:{review.decision}",
            changed_stage=node.name,
        )


def require_stage_review_gate(
    db: Session,
    item: LoopItem,
    workflow: IssueWorkflowInstance,
    node: WorkflowNodeInstance,
) -> None:
    if node.id == "joint_review":
        missing, blocked = _missing_review_roles(
            workflow, node.id, item.version, max(1, node.attempts), JOINT_REVIEW_ROLES
        )
    elif node.id == "quality_acceptance":
        missing, blocked = _missing_review_roles(
            workflow, node.id, item.version, max(1, node.attempts), QUALITY_REVIEW_ROLES
        )
    elif node.id == "release_launch":
        raise HTTPException(
            409,
            {
                "code": "release_record_required",
                "current_stage_id": node.id,
                "message": "Record a successful release instead of approving the stage",
            },
        )
    else:
        return
    if missing or blocked:
        raise HTTPException(
            409,
            {
                "code": "strategy_stage_review_incomplete",
                "current_stage_id": node.id,
                "missing_roles": missing,
                "blocking_reviews": blocked,
                "message": "Every required functional role must agree without objection",
            },
        )


def missing_stage_conditions(
    workflow: IssueWorkflowInstance,
    node: WorkflowNodeInstance,
    issue_version: int,
) -> list[str]:
    """Return deterministic additional conditions for coordinator output."""
    conditions: list[str] = []
    if node.id in {"joint_review", "quality_acceptance"}:
        roles = (
            JOINT_REVIEW_ROLES if node.id == "joint_review" else QUALITY_REVIEW_ROLES
        )
        missing, blocked = _missing_review_roles(
            workflow,
            node.id,
            issue_version,
            max(1, node.attempts),
            roles,
        )
        conditions.extend(f"评审无异议：{role}" for role in missing)
        conditions.extend(f"评审阻塞：{value}" for value in blocked)
    elif node.id == "release_launch":
        required, pull_requests = _required_pull_requests(workflow)
        if not required:
            conditions.append("关联必要 PR")
        for pull_request_id in required:
            current = pull_requests.get(pull_request_id)
            if not isinstance(current, dict) or current.get("state") != "merged":
                conditions.append(f"PR 已合并：{pull_request_id}")
        successful = any(
            isinstance(record, dict) and record.get("successful") is True
            for record in workflow.release_records
        )
        if not successful:
            conditions.append("成功发布版本与提交映射")
    return conditions


def _required_pull_requests(
    workflow: IssueWorkflowInstance,
) -> tuple[list[str], dict[str, dict]]:
    state = workflow.change_request_state.get("pull_requests")
    pull_requests = state if isinstance(state, dict) else {}
    configured = workflow.change_request_state.get("required_pr_ids")
    required = (
        [str(value) for value in configured]
        if isinstance(configured, list)
        else list(pull_requests)
    )
    return required, pull_requests


def record_release(
    db: Session,
    item: LoopItem,
    user_id: int,
    workflow: IssueWorkflowInstance,
    action: WorkflowAction,
    *,
    actor_is_human: bool,
) -> None:
    from app.services.loop_items.strategy import notify_strategy_event
    from app.services.loop_items.workflow import _retire_assignments

    require_cloud_project_role(
        db, int(item.cloud_project_id), user_id, BaseRole.Maintainer
    )
    if not actor_is_human:
        raise HTTPException(403, "Release confirmation requires a human maintainer")
    node = _current_node(workflow, "release_launch")
    release = action.release
    required, pull_requests = _required_pull_requests(workflow)
    if not required:
        raise HTTPException(
            409,
            {
                "code": "release_prs_missing",
                "message": "Required pull requests are not mapped",
            },
        )
    unmerged = [
        value
        for value in required
        if not isinstance(pull_requests.get(value), dict)
        or pull_requests[value].get("state") != "merged"
    ]
    if unmerged:
        raise HTTPException(
            409,
            {
                "code": "release_prs_not_merged",
                "pull_requests": unmerged,
            },
        )
    required_commits = {
        str(
            pull_requests[value].get("merge_commit")
            or pull_requests[value].get("head_sha")
            or ""
        ).lower()
        for value in required
    } - {""}
    if release.successful and not required_commits <= set(release.merge_commits):
        raise HTTPException(
            409,
            {
                "code": "release_merge_commits_missing",
                "required_merge_commits": sorted(required_commits),
            },
        )
    if release.successful and not all(
        (
            release.online_verification.strip(),
            release.rollback_summary.strip(),
            release.retrospective.strip(),
        )
    ):
        raise HTTPException(
            422,
            {
                "code": "release_verification_missing",
                "message": "Online verification, rollback and retrospective evidence are required",
            },
        )
    record = {
        **release.model_dump(mode="json"),
        "issue_id": item.id,
        "recorded_by_user_id": user_id,
        "recorded_at": datetime.now(timezone.utc).isoformat(),
        "idempotency_key": action.idempotency_key,
        "pull_request_ids": required,
    }
    workflow.release_records.append(record)
    if not release.successful:
        notify_strategy_event(
            db,
            item,
            user_id,
            workflow,
            "release_failed",
            release.version,
            changed_stage=node.name,
        )
        return
    _retire_assignments(db, item, user_id, {node.id})
    node.status = "completed"
    node.decision_history.append(
        WorkflowNodeDecision(
            action="approve",
            actor_user_id=user_id,
            reason=f"Release {release.version}",
            decided_at=datetime.now(timezone.utc),
            source="human",
        )
    )
    workflow.current_stage_id = None
    workflow.orchestration_status = "completed"
    notify_strategy_event(
        db,
        item,
        user_id,
        workflow,
        "release_recorded",
        release.version,
        changed_stage=node.name,
    )
