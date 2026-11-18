# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Deterministic change-request transitions for collaboration strategies."""

from datetime import datetime, timezone
from typing import Any, Mapping

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.models.delivery import (
    LoopItem,
    LoopItemTaskBinding,
    loop_datetime_is_unset,
)
from app.models.user import User
from app.schemas.issue_workflow import (
    IssueWorkflowInstance,
    WorkflowNodeDecision,
)
from app.services.project_automation_domain import ProjectAutomationEvent
from app.services.project_change_request_bindings import (
    project_change_request_binding_service,
)

STAGES = (
    "requirement_intake",
    "joint_review",
    "development_preparation",
    "development_implementation",
    "quality_acceptance",
    "release_launch",
)
QUALITY_STAGES = {"quality_acceptance", "release_launch"}
TERMINAL_PR_STATES = {"closed", "merged"}


def _workflow(item: LoopItem) -> IssueWorkflowInstance | None:
    from app.services.loop_items.workflow import workflow_snapshot

    return workflow_snapshot(item)


def _http_identity_from_badge(value: object) -> tuple[str, str, int] | None:
    if not isinstance(value, str):
        return None
    for provider in ("github", "gitlab"):
        try:
            marker = "/pull/" if provider == "github" else "/-/merge_requests/"
            number = int(value.rsplit(marker, 1)[1].split("/", 1)[0])
            instance, repository = (
                project_change_request_binding_service._identity_from_url(
                    provider, value, number
                )
            )
            return provider, repository, number
        except (ValueError, IndexError, HTTPException):
            continue
    return None


def _subject_identity(subject: Mapping[str, Any]) -> tuple[str, str, int] | None:
    provider = str(subject.get("provider") or "").strip().lower()
    repository = str(subject.get("repository") or "").strip().strip("/")
    if repository.endswith(".git"):
        repository = repository[:-4]
    try:
        number = int(subject["number"])
    except (KeyError, TypeError, ValueError):
        return None
    if provider not in {"github", "gitlab"} or not repository:
        return None
    return provider, repository, number


def _binding_identities(binding: LoopItemTaskBinding) -> set[tuple[str, str, int]]:
    identities: set[tuple[str, str, int]] = set()
    for value in project_change_request_binding_service.change_requests(binding):
        try:
            number = int(value["number"])
        except (KeyError, TypeError, ValueError):
            continue
        provider = str(value.get("provider") or "").strip().lower()
        repository = (
            str(value.get("repository") or "").strip().strip("/").removesuffix(".git")
        )
        if provider in {"github", "gitlab"} and repository:
            identities.add((provider, repository, number))
    return identities


def _badge_identities(item: LoopItem) -> set[tuple[str, str, int]]:
    identities: set[tuple[str, str, int]] = set()
    for badge in (item.metadata_json or {}).get("badges", []):
        if isinstance(badge, dict):
            identity = _http_identity_from_badge(badge.get("url"))
            if identity is not None:
                identities.add(identity)
    return identities


def matching_strategy_issues(
    db: Session, event: ProjectAutomationEvent
) -> list[LoopItem]:
    subject_identity = _subject_identity(
        event.payload.get("subject")
        if isinstance(event.payload.get("subject"), dict)
        else {}
    )
    if subject_identity is None:
        return []
    bindings = (
        db.query(LoopItemTaskBinding)
        .filter(
            LoopItemTaskBinding.cloud_project_id == str(event.project_id),
            LoopItemTaskBinding.loop_item_id.isnot(None),
            loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
            loop_datetime_is_unset(LoopItemTaskBinding.deleted_at),
        )
        .all()
    )
    bound_issue_ids = {
        str(binding.loop_item_id)
        for binding in bindings
        if subject_identity in _binding_identities(binding)
    }
    candidates = (
        db.query(LoopItem)
        .filter(
            LoopItem.cloud_project_id == str(event.project_id),
            loop_datetime_is_unset(LoopItem.deleted_at),
        )
        .order_by(LoopItem.id)
        .all()
    )
    matches: list[LoopItem] = []
    for item in candidates:
        workflow = _workflow(item)
        if workflow is None or workflow.strategy_snapshot is None:
            continue
        if item.id in bound_issue_ids or subject_identity in _badge_identities(item):
            matches.append(item)
    return matches


def _role_user(
    db: Session,
    project: CloudProject,
    workflow: IssueWorkflowInstance,
    *role_names: str,
) -> User | None:
    from app.services.cloud_project_visibility import project_participant_ids

    participants = project_participant_ids(db, project)
    for role in role_names:
        for name in workflow.strategy_snapshot.role_mapping.get(role, []):
            user = db.query(User).filter(User.user_name == name).first()
            if user is not None and user.id in participants:
                return user
    return None


def _development_user(
    db: Session, project: CloudProject, workflow: IssueWorkflowInstance
) -> User | None:
    return (
        _role_user(db, project, workflow, "development")
        or db.query(User).filter(User.user_name == "hongyu9").first()
    )


def _qa_user(
    db: Session, project: CloudProject, workflow: IssueWorkflowInstance
) -> User | None:
    return (
        _role_user(db, project, workflow, "qa")
        or db.query(User).filter(User.user_name.in_(["yunpeng7", "sifang"])).first()
    )


def _current_node(workflow: IssueWorkflowInstance, node_id: str):
    return next((node for node in workflow.nodes if node.id == node_id), None)


def _complete_before(
    workflow: IssueWorkflowInstance, stop_stage: str, actor_user_id: int
) -> None:
    stop = STAGES.index(stop_stage)
    now = datetime.now(timezone.utc)
    for node in workflow.nodes:
        if node.id not in STAGES or STAGES.index(node.id) >= stop:
            continue
        if node.status in {"completed", "forced_completed"}:
            continue
        node.status = "completed"
        node.activated_at = node.activated_at or now
        node.decision_history.append(
            WorkflowNodeDecision(
                action="approve",
                actor_user_id=actor_user_id,
                reason="A valid change request established the implementation lower bound",
                decided_at=now,
                source="assistant",
            )
        )


def _record_repair(
    workflow: IssueWorkflowInstance,
    item: LoopItem,
    *,
    old_status: str,
    old_stage: str | None,
    new_status: str,
    new_stage: str | None,
    source: str,
) -> None:
    if old_status == new_status and old_stage == new_stage:
        return
    workflow.status_stage_repairs.append(
        {
            "from_status": old_status,
            "to_status": new_status,
            "from_stage": old_stage,
            "to_stage": new_stage,
            "source": source,
            "at": datetime.now(timezone.utc).isoformat(),
        }
    )


def _write_status_history(
    db: Session,
    item: LoopItem,
    *,
    old_status: str,
    new_status: str,
    actor_user_id: int,
    source: str,
) -> None:
    if old_status == new_status:
        return
    from app.services.loop_item_status_history import write_status_change

    metadata = dict(item.metadata_json or {})
    write_status_change(
        metadata,
        project=db.get(CloudProject, item.cloud_project_id),
        from_status=old_status,
        to_status=new_status,
        trigger=source,
        by_user_id=actor_user_id,
    )
    item.metadata_json = metadata


def _ensure_active_workflow(
    db: Session, item: LoopItem, workflow: IssueWorkflowInstance
) -> IssueWorkflowInstance:
    if workflow.nodes:
        workflow.strategy_state = "active"
        return workflow
    from app.schemas.issue_workflow import instantiate_workflow
    from app.services.loop_items.strategy import compile_strategy

    project = db.get(CloudProject, item.cloud_project_id)
    compiled = instantiate_workflow(
        compile_strategy(
            db, project, workflow.strategy_snapshot.model_dump(mode="json")
        )
    )
    compiled.instance_id = workflow.instance_id
    compiled.strategy_snapshot = workflow.strategy_snapshot
    compiled.strategy_state = "active"
    return compiled


def _assign_stage(
    db: Session,
    item: LoopItem,
    workflow: IssueWorkflowInstance,
    stage_id: str,
    owner: User | None,
    actor_user_id: int,
) -> None:
    from app.services.loop_items.workflow import (
        _retire_assignments,
        route_workflow_stages,
    )

    node = _current_node(workflow, stage_id)
    if node is None or owner is None:
        return
    _retire_assignments(db, item, actor_user_id, {stage_id})
    node.required_assignee_type = "user"
    node.required_assignee_id = str(owner.id)
    node.execution_mode = "human"
    node.human_approval_required = True
    item.assignee_user_id = owner.id
    item.assignee_agent_id = ""
    item.assignee_team_id = None
    item.metadata_json = {
        **(item.metadata_json or {}),
        "workflow": workflow.model_dump(mode="json"),
    }
    db.flush()
    route_workflow_stages(db, item, actor_user_id, [node])


def _persist(
    db: Session,
    item: LoopItem,
    workflow: IssueWorkflowInstance,
    *,
    actor_user_id: int,
) -> None:
    from app.services.loop_items.strategy import synchronize_strategy_stage
    from app.services.loop_items.workflow import advance_content_revision

    synchronize_strategy_stage(item, workflow)
    metadata = dict(item.metadata_json or {})
    metadata["workflow"] = workflow.model_dump(mode="json")
    item.metadata_json = advance_content_revision(metadata, actor_user_id=actor_user_id)
    item.version += 1
    db.flush()


def _move_to_development(
    db: Session,
    item: LoopItem,
    workflow: IssueWorkflowInstance,
    *,
    actor_user_id: int,
    source: str,
    event_label: str = "stage_ready",
    notify: bool = True,
) -> None:
    from app.services.loop_items.strategy import notify_strategy_event

    project = db.get(CloudProject, item.cloud_project_id)
    workflow = _ensure_active_workflow(db, item, workflow)
    from app.services.loop_items.workflow import _retire_assignments

    _retire_assignments(
        db,
        item,
        actor_user_id,
        {node.id for node in workflow.nodes if node.id != "development_implementation"},
    )
    old_status, old_stage = item.status, workflow.current_stage_id
    _complete_before(workflow, "development_implementation", actor_user_id)
    development = _current_node(workflow, "development_implementation")
    if development is None:
        return
    if development.status not in {"completed", "forced_completed"}:
        development.status = "ready"
        development.attempts = max(1, development.attempts)
        development.activated_at = development.activated_at or datetime.now(
            timezone.utc
        )
    workflow.current_stage_id = "development_implementation"
    workflow.strategy_state = "active"
    workflow.quality_blocked = False
    _record_repair(
        workflow,
        item,
        old_status=old_status,
        old_stage=old_stage,
        new_status="in_progress",
        new_stage="development_implementation",
        source=source,
    )
    item.status = "in_progress"
    _write_status_history(
        db,
        item,
        old_status=old_status,
        new_status="in_progress",
        actor_user_id=actor_user_id,
        source=source,
    )
    item.metadata_json = {
        **(item.metadata_json or {}),
        "workflow": workflow.model_dump(mode="json"),
    }
    _assign_stage(
        db,
        item,
        workflow,
        "development_implementation",
        _development_user(db, project, workflow),
        actor_user_id,
    )
    if notify:
        notify_strategy_event(
            db,
            item,
            actor_user_id,
            workflow,
            event_label,
            source,
            changed_stage="开发实现",
        )


def _quality_ready(
    workflow: IssueWorkflowInstance,
) -> bool:
    state = workflow.change_request_state.get("pull_requests") or {}
    required = workflow.change_request_state.get("required_pr_ids") or list(state)
    if not required:
        return False
    for pull_request_id in required:
        value = state.get(pull_request_id)
        if not isinstance(value, dict):
            return False
        if value.get("state") == "merged":
            return False
        if value.get("state") != "open" or value.get("is_draft") is True:
            return False
        if value.get("mergeable") != "MERGEABLE":
            return False
        if value.get("checks_summary") != "success":
            return False
    return True


def _all_merged(workflow: IssueWorkflowInstance) -> bool:
    state = workflow.change_request_state.get("pull_requests") or {}
    required = workflow.change_request_state.get("required_pr_ids") or list(state)
    return bool(required) and all(
        isinstance(state.get(value), dict) and state[value].get("state") == "merged"
        for value in required
    )


def _enter_quality(
    db: Session,
    item: LoopItem,
    workflow: IssueWorkflowInstance,
    *,
    actor_user_id: int,
) -> None:
    from app.services.loop_items.strategy import notify_strategy_event

    project = db.get(CloudProject, item.cloud_project_id)
    if workflow.current_stage_id == "quality_acceptance":
        old_status = item.status
        required_ids = list(workflow.change_request_state.get("required_pr_ids") or [])
        pull_requests = workflow.change_request_state.get("pull_requests") or {}
        first_pull_request = next(
            (value for value in pull_requests.values() if isinstance(value, dict)),
            {},
        )
        workflow.quality_blocked = False
        workflow.change_request_state["quality_entry_event"] = {
            "head_sha": state_head(workflow),
            "checks_summary": "success",
            "pr_url": first_pull_request.get("url"),
            "required_pr_ids": required_ids,
            "idempotency_key": f"quality-ready:{','.join(required_ids)}:{state_head(workflow) or ''}",
            "old_status": old_status,
            "old_stage": "quality_acceptance",
            "new_status": "in_review",
            "new_stage": "quality_acceptance",
        }
        item.status = "in_review"
        _write_status_history(
            db,
            item,
            old_status=old_status,
            new_status="in_review",
            actor_user_id=actor_user_id,
            source="change_request.quality_ready",
        )
        item.metadata_json = {
            **(item.metadata_json or {}),
            "workflow": workflow.model_dump(mode="json"),
        }
        _assign_stage(
            db,
            item,
            workflow,
            "quality_acceptance",
            _qa_user(db, project, workflow),
            actor_user_id,
        )
        notify_strategy_event(
            db,
            item,
            actor_user_id,
            workflow,
            "stage_ready",
            "The repaired PR is ready for another quality review",
            changed_stage="质量验收",
        )
        return
    _move_to_development(
        db,
        item,
        workflow,
        actor_user_id=actor_user_id,
        source="PR quality entry",
        notify=False,
    )
    workflow = _workflow(item)
    development = _current_node(workflow, "development_implementation")
    quality = _current_node(workflow, "quality_acceptance")
    if development is None or quality is None:
        return
    development.status = "completed"
    quality.status = "ready"
    quality.attempts = max(1, quality.attempts)
    quality.activated_at = quality.activated_at or datetime.now(timezone.utc)
    workflow.current_stage_id = "quality_acceptance"
    workflow.quality_blocked = False
    required_ids = list(workflow.change_request_state.get("required_pr_ids") or [])
    pull_requests = workflow.change_request_state.get("pull_requests") or {}
    first_pull_request = next(
        (value for value in pull_requests.values() if isinstance(value, dict)),
        {},
    )
    from app.services.loop_items.workflow import _retire_assignments

    _retire_assignments(db, item, actor_user_id, {"development_implementation"})
    workflow.change_request_state["quality_entry_event"] = {
        **{
            "head_sha": state_head(workflow),
            "checks_summary": "success",
            "pr_url": first_pull_request.get("url"),
            "required_pr_ids": required_ids,
            "idempotency_key": f"quality-ready:{','.join(required_ids)}:{state_head(workflow) or ''}",
            "old_status": item.status,
            "old_stage": "development_implementation",
            "new_status": "in_review",
            "new_stage": "quality_acceptance",
        }
    }
    old_status = item.status
    item.status = "in_review"
    _write_status_history(
        db,
        item,
        old_status=old_status,
        new_status="in_review",
        actor_user_id=actor_user_id,
        source="change_request.quality_ready",
    )
    item.metadata_json = {
        **(item.metadata_json or {}),
        "workflow": workflow.model_dump(mode="json"),
    }
    _assign_stage(
        db,
        item,
        workflow,
        "quality_acceptance",
        _qa_user(db, project, workflow),
        actor_user_id,
    )
    notify_strategy_event(
        db,
        item,
        actor_user_id,
        workflow,
        "change_request_quality_ready",
        "All required checks passed and the PR is mergeable",
        changed_stage="质量验收",
    )


def state_head(workflow: IssueWorkflowInstance) -> str | None:
    state = workflow.change_request_state.get("pull_requests") or {}
    return next(
        (
            str(value.get("head_sha"))
            for value in state.values()
            if isinstance(value, dict) and value.get("head_sha")
        ),
        None,
    )


def _enter_release(
    db: Session,
    item: LoopItem,
    workflow: IssueWorkflowInstance,
    *,
    actor_user_id: int,
) -> None:
    from app.services.loop_items.strategy import notify_strategy_event
    from app.services.loop_items.workflow import _retire_assignments

    project = db.get(CloudProject, item.cloud_project_id)
    development = _current_node(workflow, "development_implementation")
    quality = _current_node(workflow, "quality_acceptance")
    release = _current_node(workflow, "release_launch")
    if development is None or quality is None or release is None:
        return
    development.status = "completed"
    quality.status = "completed"
    release.status = "ready"
    release.attempts = max(1, release.attempts)
    release.activated_at = release.activated_at or datetime.now(timezone.utc)
    workflow.current_stage_id = "release_launch"
    workflow.quality_blocked = False
    _retire_assignments(
        db, item, actor_user_id, {"development_implementation", "quality_acceptance"}
    )
    old_status = item.status
    item.status = "in_review"
    _write_status_history(
        db,
        item,
        old_status=old_status,
        new_status="in_review",
        actor_user_id=actor_user_id,
        source="change_request.merged",
    )
    item.metadata_json = {
        **(item.metadata_json or {}),
        "workflow": workflow.model_dump(mode="json"),
    }
    _assign_stage(
        db,
        item,
        workflow,
        "release_launch",
        _role_user(db, project, workflow, "product", "development"),
        actor_user_id,
    )
    notify_strategy_event(
        db,
        item,
        actor_user_id,
        workflow,
        "change_request_merged",
        "All required pull requests merged; release confirmation is required",
        changed_stage="发布上线",
    )


def apply_change_request_lower_bound(
    db: Session,
    item: LoopItem,
    subject: Mapping[str, Any],
    *,
    actor_user_id: int,
    source: str = "change_request.indexed",
) -> bool:
    workflow = _workflow(item)
    if workflow is None or workflow.strategy_snapshot is None:
        return False
    identity = _subject_identity(subject)
    if identity is None:
        return False
    provider, repository, number = identity
    key = f"{provider}:{repository}#{number}"
    state = dict(workflow.change_request_state.get("pull_requests") or {})
    current = dict(state.get(key) or {})
    current.update(
        {
            "provider": provider,
            "repository": repository,
            "number": number,
            "url": subject.get("url") or current.get("url"),
            "head_sha": subject.get("head_commit") or current.get("head_sha"),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
    )
    state[key] = current
    workflow.change_request_state["pull_requests"] = state
    required = list(workflow.change_request_state.get("required_pr_ids") or [])
    if key not in required:
        required.append(key)
    workflow.change_request_state["required_pr_ids"] = required
    current_stage = workflow.current_stage_id
    if current_stage not in STAGES or STAGES.index(current_stage) < STAGES.index(
        "development_implementation"
    ):
        _move_to_development(
            db,
            item,
            workflow,
            actor_user_id=actor_user_id,
            source=source,
            event_label="change_request_lower_bound",
        )
        return True
    item.metadata_json = {
        **(item.metadata_json or {}),
        "workflow": workflow.model_dump(mode="json"),
    }
    db.flush()
    return False


def apply_indexed_change_requests(
    db: Session, item: LoopItem, *, actor_user_id: int
) -> bool:
    """Apply both execution lower bounds after Issue text or activity indexing."""
    changed = False
    for badge in (item.metadata_json or {}).get("badges", []):
        if not isinstance(badge, dict):
            continue
        url = badge.get("url")
        identity = _http_identity_from_badge(url)
        if identity is None:
            continue
        provider, repository, number = identity
        changed = (
            apply_change_request_lower_bound(
                db,
                item,
                {
                    "provider": provider,
                    "repository": repository,
                    "number": number,
                    "url": url,
                    "head_commit": None,
                },
                actor_user_id=actor_user_id,
                source="change_request.indexed",
            )
            or changed
        )
    return changed


def process_strategy_change_request_event(
    db: Session, event: ProjectAutomationEvent
) -> int:
    """Apply one provider event to every explicitly scoped strategy Issue."""
    if event.event_type not in {
        "change_request.checks_failed",
        "change_request.merge_conflict",
        "change_request.quality_ready",
        "change_request.merged",
    }:
        return 0
    subject = event.payload.get("subject")
    if not isinstance(subject, dict):
        return 0
    actor_user_id = event.actor_user_id or 0
    processed = 0
    for item in matching_strategy_issues(db, event):
        workflow = _workflow(item)
        if workflow is None or workflow.strategy_snapshot is None:
            continue
        identity = _subject_identity(subject)
        if identity is None:
            continue
        provider, repository, number = identity
        pr_id = f"{provider}:{repository}#{number}"
        head_sha = str(
            subject.get("head_commit") or event.payload.get("head_sha") or ""
        )
        event_key = ":".join(
            filter(None, [event.event_id or event.event_type, pr_id, head_sha])
        )
        if event_key in workflow.provider_event_receipts:
            continue
        if not actor_user_id:
            project = db.get(CloudProject, item.cloud_project_id)
            actor_user_id = int(project.created_by_user_id or 0)
        if not actor_user_id:
            continue
        apply_change_request_lower_bound(
            db, item, subject, actor_user_id=actor_user_id, source=event.event_type
        )
        workflow = _workflow(item)
        pull_request_state = dict(
            workflow.change_request_state.get("pull_requests") or {}
        )
        current = dict(pull_request_state.get(pr_id) or {})
        current.update(
            {
                "head_sha": head_sha or current.get("head_sha"),
                "mergeable": subject.get("mergeable") or current.get("mergeable"),
                "checks_summary": (
                    "success"
                    if event.event_type == "change_request.quality_ready"
                    else (
                        "failed"
                        if event.event_type == "change_request.checks_failed"
                        else current.get("checks_summary")
                    )
                ),
                "state": (
                    "merged"
                    if event.event_type == "change_request.merged"
                    else current.get("state") or "open"
                ),
                "merge_commit": event.payload.get("merge_commit")
                or subject.get("merge_commit")
                or current.get("merge_commit"),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        )
        pull_request_state[pr_id] = current
        workflow.change_request_state["pull_requests"] = pull_request_state
        project = db.get(CloudProject, item.cloud_project_id)
        if event.event_type in {
            "change_request.checks_failed",
            "change_request.merge_conflict",
        }:
            if workflow.current_stage_id in QUALITY_STAGES:
                workflow.quality_blocked = True
                quality_node = _current_node(workflow, workflow.current_stage_id)
                if quality_node is not None:
                    quality_node.attempts += 1
                    quality_node.deliverables_completed_at = None
                workflow.change_request_state["blocked_reason"] = event.event_type
                item.metadata_json = {
                    **(item.metadata_json or {}),
                    "workflow": workflow.model_dump(mode="json"),
                }
                _assign_stage(
                    db,
                    item,
                    workflow,
                    workflow.current_stage_id,
                    _development_user(db, project, workflow),
                    actor_user_id,
                )
                from app.services.loop_items.strategy import notify_strategy_event

                notify_strategy_event(
                    db,
                    item,
                    actor_user_id,
                    workflow,
                    (
                        "change_request_checks_failed"
                        if event.event_type == "change_request.checks_failed"
                        else "change_request_conflict"
                    ),
                    "A failed check or merge conflict returned the quality stage to engineering",
                    changed_stage="质量验收",
                )
            else:
                _move_to_development(
                    db,
                    item,
                    workflow,
                    actor_user_id=actor_user_id,
                    source=event.event_type,
                    event_label=(
                        "change_request_checks_failed"
                        if event.event_type == "change_request.checks_failed"
                        else "change_request_conflict"
                    ),
                )
        elif event.event_type == "change_request.quality_ready" and _quality_ready(
            workflow
        ):
            _enter_quality(db, item, workflow, actor_user_id=actor_user_id)
        elif event.event_type == "change_request.merged" and _all_merged(workflow):
            _enter_release(db, item, workflow, actor_user_id=actor_user_id)
        elif event.event_type == "change_request.merged":
            _move_to_development(
                db,
                item,
                workflow,
                actor_user_id=actor_user_id,
                source="A required pull request merged while others remain open",
                event_label="change_request_merged",
            )
        workflow = _workflow(item)
        workflow.provider_event_receipts[event_key] = {
            "event_type": event.event_type,
            "pr_id": pr_id,
            "head_sha": head_sha,
            "recorded_at": datetime.now(timezone.utc).isoformat(),
        }
        workflow.provider_event_receipts = dict(
            list(workflow.provider_event_receipts.items())[-500:]
        )
        _persist(db, item, workflow, actor_user_id=actor_user_id)
        processed += 1
    return processed
