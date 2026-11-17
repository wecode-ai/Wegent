# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Transactional stage ownership for observed GitHub PRs and quality reviews.

Callers own the Issue lock and commit for reviews. Event processing locks each
matching Issue itself. Notifications use the existing transaction outbox.
"""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from typing import Any, Mapping

from fastapi import HTTPException
from sqlalchemy import String, cast
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem, LoopItemComment
from app.models.user import User
from app.services.issue_assignments import (
    ASSIGNMENT_EVENT_TYPE,
    issue_assignment_service,
)
from app.services.loop_item_status_history import (
    later_project_status,
    write_status_change,
)
from app.services.project_automation_domain import ProjectAutomationEvent, utcnow
from app.services.stage_assignee_mutations import stage_observer_user_ids
from app.services.stage_assignees import (
    STAGE_NAMES,
    engineering_assignee_targets,
    require_stage_target,
    stage_assignee_enforcement_enabled,
)
from app.services.wework_notifications import create_notification
from shared.telemetry.decorators import trace_sync

_FAILED = {
    "failure",
    "failed",
    "cancelled",
    "canceled",
    "timed_out",
    "error",
    "action_required",
    "startup_failure",
}
_STAGES = {
    "implementation": {
        "implementation",
        "development",
        "development_implementation",
        "开发实现",
    },
    "quality": {"quality", "quality_acceptance", "quality_review", "质量验收"},
    "release": {"release", "release_launch", "发布上线"},
}


def _mapping(value: object) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _text(value: object) -> str:
    return str(value).strip() if value is not None else ""


def _workflow(item: LoopItem, project: CloudProject | None = None) -> dict[str, Any]:
    metadata = _mapping(item.metadata_json)
    workflow = _mapping(metadata.get("workflow"))
    if not workflow and project is not None:
        workflow = _mapping(_mapping(project.metadata_json).get("workflow_definition"))
    workflow = deepcopy(workflow)
    if not workflow.get("current_stage_id"):
        current = next(
            (
                node
                for node in workflow.get("nodes", [])
                if node.get("name") in metadata.get("tags", [])
            ),
            None,
        )
        if current:
            workflow["current_stage_id"] = current["id"]
    return workflow


def _stage(workflow: dict[str, Any], role: str) -> dict[str, Any] | None:
    return next(
        (
            node
            for node in workflow.get("nodes", [])
            if isinstance(node, dict)
            and (
                _text(node.get("id")).lower() in _STAGES[role]
                or _text(node.get("name")).lower() in _STAGES[role]
            )
        ),
        None,
    )


def _enabled(workflow: dict[str, Any], project: CloudProject) -> bool:
    return bool(workflow) and stage_assignee_enforcement_enabled(
        project, {"workflow": workflow}
    )


def _role_targets(
    project: CloudProject, item: LoopItem, role: str
) -> list[dict[str, Any]]:
    # Use the immutable Issue policy; project policy only supplies older snapshots.
    workflow = _workflow(item, project)
    quality = _stage(workflow, "quality") if role == "qa" else None
    if (
        quality
        and quality.get("required_assignee_type")
        and quality.get("required_assignee_id")
    ):
        return [
            {
                "assignee_type": quality["required_assignee_type"],
                "assignee_id": quality["required_assignee_id"],
            }
        ]
    roles = _mapping(workflow.get("assignee_roles"))
    values = roles.get(role)
    return (
        [dict(value) for value in values if isinstance(value, dict)]
        if isinstance(values, list)
        else []
    )


def _resolve_human(
    db: Session, project: CloudProject, candidates: list[dict[str, Any]]
) -> User | None:
    for candidate in candidates:
        if candidate.get("assignee_type") != "user":
            continue
        value = _text(candidate.get("assignee_id"))
        user = (
            db.get(User, int(value))
            if value.isdecimal()
            else db.query(User).filter(User.user_name == value).one_or_none()
        )
        if user is not None:
            try:
                require_stage_target(
                    db,
                    project=project,
                    target={
                        "assignee_type": "user",
                        "assignee_id": str(user.id),
                    },
                )
            except HTTPException:
                continue
            return user
    return None


def _engineering_candidates(
    project: CloudProject, item: LoopItem
) -> list[dict[str, Any]]:
    return engineering_assignee_targets(project, _mapping(item.metadata_json))


def _assign(
    db: Session,
    *,
    project: CloudProject,
    item: LoopItem,
    user: User | None,
    actor_user_id: int,
    metadata: dict[str, Any],
) -> None:
    from app.services.loop_items.service import loop_item_service

    if (
        user is not None
        and item.assignee_user_id == user.id
        and not item.assignee_agent_id
        and not item.assignee_team_id
        and not _mapping(metadata.get("collaboration_group")).get("id")
    ):
        return
    if user is not None:
        issue_assignment_service.record(
            db,
            project_id=project.id,
            issue_id=item.id,
            member_type="human",
            member_id=str(user.id),
            assigned_by_user_id=actor_user_id,
            workflow_step=None,
            notify=True,
            trigger="quality_handoff",
            replace_root_assignments=True,
        )
        loop_item_service.record_assignment_change(
            metadata,
            actor_user_id,
            "user",
            str(user.id),
            user.user_name,
        )
        create_notification(
            db,
            user_id=user.id,
            actor_user_id=actor_user_id,
            kind="assignment",
            title="Issue quality handoff",
            body=item.title or item.id,
            project_id=str(project.id),
            item_id=item.id,
            payload={"projectId": str(project.id), "itemId": item.id},
        )
    else:
        # Clear the active root assignment index as well as the visible owner.
        for entry in issue_assignment_service.active_for_issue(db, item.id):
            if entry.workflow_step:
                continue
            db.add(
                LoopItemComment(
                    cloud_project_id=str(project.id),
                    loop_item_id=item.id,
                    description="",
                    status="active",
                    created_by_user_id=actor_user_id,
                    updated_by_user_id=actor_user_id,
                    metadata_json={
                        "event_type": ASSIGNMENT_EVENT_TYPE,
                        "action": "unassign",
                        "assignment_event_id": entry.id,
                        "target_type": entry.member_type,
                        "target_id": entry.member_id,
                        "workflow_step": None,
                        "notify": False,
                        "trigger": "quality_handoff",
                    },
                )
            )
        db.flush()
        issue_assignment_service._refresh_active_index(db, item.id)
    item.assignee_user_id = user.id if user else None
    item.assignee_agent_id = ""
    item.assignee_team_id = None
    metadata.pop("collaboration_group", None)


def _notify_observers(
    db: Session,
    *,
    project: CloudProject,
    item: LoopItem,
    actor_user_id: int,
    reason: str,
    waiting: bool,
) -> None:
    recipients = stage_observer_user_ids(
        db,
        project=project,
        item=item,
        metadata=_mapping(item.metadata_json),
        waiting=waiting,
    )
    for recipient in recipients:
        create_notification(
            db,
            user_id=recipient,
            actor_user_id=actor_user_id,
            title="Issue quality status",
            body=f"{item.title}: {reason}",
            project_id=str(project.id),
            item_id=item.id,
            payload={"projectId": str(project.id), "itemId": item.id, "reason": reason},
        )


def _audit(
    db: Session,
    *,
    item: LoopItem,
    actor_user_id: int,
    result: dict[str, Any],
) -> None:
    db.add(
        LoopItemComment(
            cloud_project_id=str(item.cloud_project_id),
            loop_item_id=item.id,
            description=f"Quality handoff: {result['reason_code']}",
            status="active",
            created_by_user_id=actor_user_id,
            updated_by_user_id=actor_user_id,
            metadata_json={"event_type": "quality_handoff", **result},
        )
    )


def _advance(
    metadata: dict[str, Any], workflow: dict[str, Any], target: dict[str, Any]
) -> None:
    nodes = workflow.get("nodes", [])
    indexes = {node["id"]: index for index, node in enumerate(nodes)}
    current = indexes.get(workflow.get("current_stage_id"), -1)
    if indexes[target["id"]] > current:
        workflow["current_stage_id"] = target["id"]
        workflow["version"] = int(workflow.get("version") or 1) + 1
        metadata["tags"] = [
            tag for tag in metadata.get("tags", []) if tag not in STAGE_NAMES
        ]
        metadata["tags"].append(target["name"])
    metadata["workflow"] = workflow


def _snapshot(event: ProjectAutomationEvent) -> dict[str, Any]:
    payload = _mapping(event.payload)
    subject = _mapping(payload.get("subject"))
    snapshot = _mapping(payload.get("quality_snapshot"))
    return {
        **snapshot,
        "url": _text(snapshot.get("url") or subject.get("url")),
        "head_sha": _text(snapshot.get("head_sha") or subject.get("head_commit")),
        "event_head_matches": not subject.get("head_commit")
        or not snapshot.get("head_sha")
        or subject["head_commit"] == snapshot["head_sha"],
        "event_type": event.event_type,
        "conclusion": payload.get("conclusion"),
        "mergeable_state": payload.get("mergeable_state"),
        "check": (
            {
                key: _mapping(payload.get("check")).get(key)
                for key in ("name", "conclusion", "status", "head_sha")
            }
            if payload.get("check")
            else None
        ),
    }


def _failure(snapshot: dict[str, Any]) -> str | None:
    if (
        snapshot.get("event_type") == "change_request.merge_conflict"
        and not snapshot.get("complete")
        and snapshot.get("event_head_matches", True)
    ) or _text(
        snapshot.get("mergeable") or snapshot.get("mergeable_state")
    ).lower() in {
        "conflicting",
        "dirty",
    }:
        return "pr_merge_conflict"
    checks = snapshot.get("required_checks", [])
    if (
        snapshot.get("event_type") == "change_request.checks_failed"
        and not snapshot.get("complete")
        and snapshot.get("event_head_matches", True)
    ) or any(
        _text(check.get("conclusion") or check.get("state")).lower() in _FAILED
        for check in checks
        if isinstance(check, dict)
    ):
        return "pr_checks_failed"
    return None


def _ready(snapshot: dict[str, Any]) -> bool:
    checks = snapshot.get("required_checks")
    return bool(
        snapshot.get("complete") is True
        and bool(snapshot.get("head_sha"))
        and snapshot.get("draft") is False
        and _text(snapshot.get("state")).lower() == "open"
        and _text(snapshot.get("mergeable")).lower() == "mergeable"
        and isinstance(checks, list)
        and all(
            isinstance(check, dict)
            and check.get("head_sha", snapshot["head_sha"]) == snapshot["head_sha"]
            and _text(check.get("conclusion") or check.get("state")).lower()
            == "success"
            for check in checks
        )
    )


def _linked_urls(item: LoopItem) -> set[str]:
    return {
        _text(badge.get("url"))
        for badge in _mapping(item.metadata_json).get("badges", [])
        if isinstance(badge, dict)
        and badge.get("icon") == "git-pull-request"
        and "github.com/" in _text(badge.get("url"))
    }


def require_quality_snapshot(item: LoopItem, metadata: dict[str, Any]) -> None:
    """Reject manual quality entry without current, complete PR observations."""
    handoff = _mapping(metadata.get("quality_handoff"))
    snapshots = _mapping(handoff.get("pr_heads"))
    urls = {
        _text(badge.get("url"))
        for badge in metadata.get("badges", [])
        if isinstance(badge, dict)
        and badge.get("icon") == "git-pull-request"
        and "github.com/" in _text(badge.get("url"))
    }
    if (
        not urls
        or handoff.get("quality_blocked")
        or not all(_ready(_mapping(snapshots.get(url))) for url in urls)
    ):
        raise HTTPException(
            409,
            {
                "reason_code": "quality_pr_snapshot_required",
                "issue_version": item.version,
            },
        )


@trace_sync()
def process_quality_event(db: Session, event: ProjectAutomationEvent) -> int:
    """Apply trusted PR observations to every linked local Issue, without commit."""
    if event.source != "github" or not event.event_type.startswith("change_request."):
        return 0
    if event.event_type == "change_request.merged":
        # Merge events belong to release handoff, not technical QA admission.
        return 0
    snapshot = _snapshot(event)
    if not snapshot["url"] or not snapshot["head_sha"]:
        return 0
    project = db.get(CloudProject, str(event.project_id))
    if project is None or project.task_provider != "local":
        return 0
    if not stage_assignee_enforcement_enabled(project, {}):
        return 0
    from app.models.delivery import loop_datetime_is_unset

    # SessionLocal disables autoflush. Preserve earlier observations in a
    # multi-event transaction before refreshing the locked Issue identities.
    db.flush()
    items = (
        db.query(LoopItem)
        .filter(
            LoopItem.cloud_project_id == str(project.id),
            loop_datetime_is_unset(LoopItem.deleted_at),
            cast(LoopItem.metadata_json["badges"], String).contains(
                snapshot["url"], autoescape=True
            ),
        )
        .order_by(LoopItem.id)
        .with_for_update()
        .populate_existing()
        .all()
    )
    changed = 0
    for item in items:
        workflow = _workflow(item, project)
        if _enabled(workflow, project) and snapshot["url"] in _linked_urls(item):
            changed += int(_process_issue(db, project, item, event, snapshot, workflow))
    return changed


def _process_issue(
    db: Session,
    project: CloudProject,
    item: LoopItem,
    event: ProjectAutomationEvent,
    snapshot: dict[str, Any],
    workflow: dict[str, Any],
) -> bool:
    quality = _stage(workflow, "quality")
    implementation = _stage(workflow, "implementation")
    if quality is None or implementation is None or item.status == "completed":
        return False
    metadata = _mapping(item.metadata_json)
    handoff = _mapping(metadata.get("quality_handoff"))
    was_blocked = bool(handoff.get("quality_blocked"))
    heads = _mapping(handoff.get("pr_heads"))
    previous = _mapping(heads.get(snapshot["url"]))
    if (
        snapshot.get("event_type") == "change_request.checks_failed"
        and not snapshot.get("complete")
        and previous.get("complete")
        and previous.get("head_sha") == snapshot["head_sha"]
        and _mapping(snapshot.get("check")).get("name")
        not in {check.get("name") for check in previous.get("required_checks", [])}
    ):
        return False
    # A callback for an already superseded head cannot reclaim ownership.
    superseded = list(previous.get("superseded_heads") or [])
    if snapshot["head_sha"] in superseded:
        return False
    if previous.get("head_sha") and previous.get("head_sha") != snapshot["head_sha"]:
        superseded.append(previous["head_sha"])
    signature = hashlib.sha256(
        json.dumps(snapshot, sort_keys=True, default=str).encode()
    ).hexdigest()
    if previous.get("signature") == signature and not handoff.get("waiting_assignee"):
        return False
    snapshot = {**snapshot, "signature": signature, "superseded_heads": superseded}
    heads[snapshot["url"]] = snapshot
    handoff["pr_heads"] = heads
    reason = _failure(snapshot)
    all_ready = all(_ready(_mapping(heads.get(url))) for url in _linked_urls(item))
    if reason is None and not all_ready:
        # Persist pending observations so multiple required PRs can converge.
        if handoff.get("accepted_heads"):
            handoff["quality_blocked"] = True
            handoff["reason_code"] = "pr_checks_pending"
        if snapshot.get("observation_error"):
            handoff["reason_code"] = "quality_observation_unavailable"
        metadata["quality_handoff"] = handoff
        _persist_observation(item, metadata, event)
        if handoff.get("quality_blocked") and not was_blocked:
            actor = int(event.actor_user_id or project.created_by_user_id)
            reason_code = handoff.get("reason_code") or "pr_checks_pending"
            _audit(
                db,
                item=item,
                actor_user_id=actor,
                result={
                    "reason_code": reason_code,
                    "issue_version": item.version,
                    "pr_url": snapshot["url"],
                    "pr_head_sha": snapshot["head_sha"],
                    "quality_blocked": True,
                },
            )
            _notify_observers(
                db,
                project=project,
                item=item,
                actor_user_id=actor,
                reason=reason_code,
                waiting=False,
            )
        return True
    indexes = {
        node["id"]: index for index, node in enumerate(workflow.get("nodes", []))
    }
    current_quality = (
        indexes.get(workflow.get("current_stage_id"), -1) >= indexes[quality["id"]]
    )
    if (
        not reason
        and indexes.get(workflow.get("current_stage_id"), -1) > indexes[quality["id"]]
    ):
        # A healthy open PR cannot reclaim an Issue already handed to release.
        metadata["quality_handoff"] = handoff
        _persist_observation(item, metadata, event)
        return True
    role = "engineering" if reason else "qa"
    # Preserve completed substeps while the same accepted head stays healthy.
    if (
        not reason
        and not handoff.get("quality_blocked")
        and not handoff.get("waiting_assignee")
        and handoff.get("accepted_heads")
        == {url: heads[url]["head_sha"] for url in _linked_urls(item)}
    ):
        metadata["quality_handoff"] = handoff
        _persist_observation(item, metadata, event)
        return True
    candidates = (
        _engineering_candidates(project, item)
        if reason
        else _role_targets(project, item, role)
    )
    user = _resolve_human(db, project, candidates)
    transition = {
        "heads": {url: heads[url]["head_sha"] for url in sorted(heads)},
        "reason": reason or "quality_ready",
        "assignee_user_id": user.id if user else None,
    }
    if handoff.get("last_transition") == transition and (
        reason or not handoff.get("quality_blocked")
    ):
        metadata["quality_handoff"] = handoff
        _persist_observation(item, metadata, event)
        return True
    before = {
        "status": item.status,
        "stage_id": workflow.get("current_stage_id"),
        "assignee_user_id": item.assignee_user_id,
    }
    _advance(metadata, workflow, implementation if reason else quality)
    desired_status = "in_progress" if reason else "in_review"
    next_status = later_project_status(
        project, current_status=item.status, candidate_status=desired_status
    )
    if next_status != item.status:
        write_status_change(
            metadata,
            project=project,
            from_status=item.status,
            to_status=next_status,
            trigger="quality_handoff",
            by_user_id=event.actor_user_id,
        )
        item.status = next_status
    actor = int(event.actor_user_id or project.created_by_user_id)
    _assign(
        db,
        project=project,
        item=item,
        user=user,
        actor_user_id=actor,
        metadata=metadata,
    )
    handoff.update(
        {
            "required_assignee_role": role,
            "quality_blocked": bool(reason and current_quality),
            "waiting_assignee": user is None,
            "resolved_assignee": (
                {"assignee_type": "user", "assignee_id": str(user.id)} if user else None
            ),
            "reason_code": reason
            or ("waiting_assignee" if user is None else "quality_ready"),
            "issue_version": item.version,
            "at": utcnow().isoformat(),
        }
    )
    handoff["last_transition"] = transition
    if not reason:
        handoff["accepted_heads"] = {
            url: heads[url]["head_sha"] for url in _linked_urls(item)
        }
    metadata["quality_handoff"] = handoff
    item.metadata_json = metadata
    item.version += 1
    item.updated_by_user_id = actor
    result = {
        "reason_code": handoff["reason_code"],
        "issue_version": item.version,
        "pr_url": snapshot["url"],
        "pr_head_sha": snapshot["head_sha"],
        "before": before,
        "after": {
            "status": item.status,
            "stage_id": workflow.get("current_stage_id"),
            "assignee_user_id": item.assignee_user_id,
        },
    }
    _audit(db, item=item, actor_user_id=actor, result=result)
    _notify_observers(
        db,
        project=project,
        item=item,
        actor_user_id=actor,
        reason=handoff["reason_code"],
        waiting=user is None,
    )
    return True


def _persist_observation(
    item: LoopItem, metadata: dict[str, Any], event: ProjectAutomationEvent
) -> None:
    item.metadata_json = metadata
    item.version += 1
    if event.actor_user_id:
        item.updated_by_user_id = int(event.actor_user_id)


@trace_sync()
def submit_quality_review(
    db: Session,
    *,
    project: CloudProject,
    item: LoopItem,
    user_id: int,
    review: Any,
    issue_version: int | None = None,
) -> dict[str, Any]:
    """Record one owner review and hand off, or return its exact replay result.

    Call before the generic PATCH version check; pass its version through
    ``issue_version``. Successful first submissions increment Issue version.
    """
    values = review.model_dump() if hasattr(review, "model_dump") else dict(review)
    metadata = _mapping(item.metadata_json)
    handoff = _mapping(metadata.get("quality_handoff"))
    reviews = _mapping(handoff.get("reviews"))
    key = _text(values.get("idempotency_key"))
    digest = hashlib.sha256(
        json.dumps({**values, "user_id": user_id}, sort_keys=True).encode()
    ).hexdigest()
    previous = _mapping(reviews.get(key))
    if previous:
        if previous.get("request_digest") != digest:
            raise HTTPException(
                409, {"reason_code": "quality_review_idempotency_conflict"}
            )
        return previous
    if issue_version is not None and item.version != issue_version:
        raise HTTPException(
            409,
            {"reason_code": "issue_version_mismatch", "issue_version": item.version},
        )
    workflow = _workflow(item, project)
    quality = _stage(workflow, "quality")
    role = handoff.get("required_assignee_role")
    if (
        not _enabled(workflow, project)
        or not quality
        or workflow.get("current_stage_id") != quality["id"]
    ):
        raise HTTPException(409, {"reason_code": "quality_stage_required"})
    if handoff.get("quality_blocked") or role not in {"qa", "product", "ui"}:
        raise HTTPException(409, {"reason_code": "quality_blocked"})
    if (
        item.assignee_user_id != user_id
        or _resolve_human(
            db, project, [{"assignee_type": "user", "assignee_id": str(user_id)}]
        )
        is None
    ):
        raise HTTPException(403, {"reason_code": "quality_review_owner_required"})
    accepted = _mapping(handoff.get("accepted_heads"))
    observed = _mapping(handoff.get("pr_heads"))
    if (
        not accepted
        or values.get("pr_head_sha") not in accepted.values()
        or any(
            _mapping(observed.get(url)).get("head_sha") != head
            or not _ready(_mapping(observed.get(url)))
            for url, head in accepted.items()
        )
    ):
        raise HTTPException(409, {"reason_code": "quality_review_head_mismatch"})
    if not key or not values.get("evidence"):
        raise HTTPException(422, {"reason_code": "quality_review_evidence_required"})
    decision = values.get("decision")
    if decision not in {"no_objection", "accepted", "changes_requested"}:
        raise HTTPException(422, {"reason_code": "quality_review_decision_invalid"})
    next_role = (
        "engineering"
        if decision == "changes_requested"
        else {"qa": "product", "product": "ui", "ui": "ui"}[role]
    )
    user = _resolve_human(
        db,
        project,
        (
            _engineering_candidates(project, item)
            if next_role == "engineering"
            else _role_targets(project, item, next_role)
        ),
    )
    _assign(
        db,
        project=project,
        item=item,
        user=user,
        actor_user_id=user_id,
        metadata=metadata,
    )
    result = {
        "reason_code": (
            "quality_changes_requested"
            if decision == "changes_requested"
            else "quality_review_accepted"
        ),
        "review_role": role,
        "reviewer_user_id": user_id,
        "decision": decision,
        "evidence": values["evidence"],
        "pr_heads": accepted,
        "issue_version": item.version,
        "at": utcnow().isoformat(),
        "next_role": next_role,
        "next_assignee_user_id": user.id if user else None,
        "request_digest": digest,
    }
    reviews[key] = result
    handoff.update(
        {
            "reviews": reviews,
            "required_assignee_role": next_role,
            "quality_blocked": decision == "changes_requested",
            "waiting_assignee": user is None,
            "resolved_assignee": (
                {"assignee_type": "user", "assignee_id": str(user.id)} if user else None
            ),
            "acceptance_complete": role == "ui" and decision != "changes_requested",
        }
    )
    metadata["quality_handoff"] = handoff
    item.metadata_json = metadata
    item.updated_by_user_id = user_id
    item.version += 1
    _audit(db, item=item, actor_user_id=user_id, result=result)
    _notify_observers(
        db,
        project=project,
        item=item,
        actor_user_id=user_id,
        reason=result["reason_code"],
        waiting=user is None,
    )
    return result
