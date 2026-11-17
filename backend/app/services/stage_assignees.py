# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Shared stage-assignee preflight, without writes or execution side effects."""

from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, LoopItem
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.services.cloud_project_visibility import project_participant_ids
from app.services.collaboration_permissions import collaboration_permission_service
from app.services.project_automation_domain import runnable_wegent_team

STAGE_ASSIGNEE_FLAG = "collab.enforceStageAssignee.v1"
STAGE_NAMES = (
    "需求提出",
    "共同评审",
    "开发准备",
    "开发实现",
    "质量验收",
    "发布上线",
)


def stage_workflow(project: CloudProject, metadata: dict[str, Any]) -> dict[str, Any]:
    workflow = metadata.get("workflow")
    if isinstance(workflow, dict):
        return workflow
    definition = (project.metadata_json or {}).get("workflow_definition")
    return definition if isinstance(definition, dict) else {}


def stage_assignee_enforcement_enabled(
    project: CloudProject, metadata: dict[str, Any]
) -> bool:
    """Explicit node constraints are enabled unless policy disables enforcement."""
    definition = (project.metadata_json or {}).get("workflow_definition") or {}
    if (definition.get("feature_flags") or {}).get(STAGE_ASSIGNEE_FLAG) is False:
        return False
    flags = stage_workflow(project, metadata).get("feature_flags") or {}
    if STAGE_ASSIGNEE_FLAG in flags:
        return flags[STAGE_ASSIGNEE_FLAG]
    definition = (project.metadata_json or {}).get("workflow_definition") or {}
    return (definition.get("feature_flags") or {}).get(STAGE_ASSIGNEE_FLAG, True)


def stage_assignee_policy_enabled(
    project: CloudProject, metadata: dict[str, Any]
) -> bool:
    """Named pilot stages require explicit enrollment in the workflow policy."""
    return stage_assignee_enforcement_enabled(project, metadata) and (
        stage_workflow(project, metadata)
        .get("feature_flags", {})
        .get(STAGE_ASSIGNEE_FLAG)
        is True
    )


def stage_requires_assignee(
    project: CloudProject, metadata: dict[str, Any], node: dict[str, Any]
) -> bool:
    if node.get("required_assignee_type") or node.get("required_assignee_role"):
        return True
    return stage_assignee_policy_enabled(project, metadata) and bool(
        node.get("name") in {"需求提出", "质量验收"}
        or (
            node.get("name") == "开发实现"
            and (metadata.get("quality_handoff") or {}).get("required_assignee_role")
        )
    )


def stage_node(
    project: CloudProject, metadata: dict[str, Any], stage_id: str | None = None
) -> dict[str, Any] | None:
    workflow = stage_workflow(project, metadata)
    identity = stage_id or workflow.get("current_stage_id")
    nodes = workflow.get("nodes") or []
    if identity:
        return next((node for node in nodes if node.get("id") == identity), None)
    tagged = [
        node for node in nodes if node.get("name") in (metadata.get("tags") or [])
    ]
    if tagged:
        return tagged[0] if len(tagged) == 1 else None
    ready = [
        node
        for node in nodes
        if node.get("node_type", "task") == "task"
        and not node.get("loop_id")
        and (
            node.get("status") == "ready"
            or (not node.get("status") and not node.get("depends_on"))
        )
    ]
    return ready[0] if len(ready) == 1 else None


def stage_name(project: CloudProject, metadata: dict[str, Any]) -> str | None:
    node = stage_node(project, metadata)
    if node:
        return node.get("name")
    return next((tag for tag in metadata.get("tags", []) if tag in STAGE_NAMES), None)


def normalized_assignee(
    db: Session, assignee_type: str, assignee_id: str | None
) -> dict[str, str | None]:
    target_type = "user" if assignee_type == "human" else assignee_type
    identity = str(assignee_id).strip() if assignee_id is not None else None
    if target_type == "user" and identity:
        user = (
            db.get(User, int(identity))
            if identity.isdecimal()
            else db.query(User).filter(User.user_name == identity).first()
        )
        if user is not None:
            identity = str(user.id)
    return {"assignee_type": target_type, "assignee_id": identity}


def require_stage_target(
    db: Session,
    *,
    project: CloudProject,
    target: dict[str, Any],
    actor_user_id: int | None = None,
) -> dict[str, Any]:
    target = normalized_assignee(db, target["assignee_type"], target["assignee_id"])
    target_id = target["assignee_id"] or ""
    if target["assignee_type"] == "user":
        user = db.get(User, int(target_id)) if target_id.isdecimal() else None
        if user is None or not user.is_active:
            raise HTTPException(422, "Required stage assignee is unavailable")
        if user.id not in project_participant_ids(
            db, project, required_role=BaseRole.Developer
        ):
            raise HTTPException(422, "Required stage assignee has no project access")
    elif target["assignee_type"] == "agent":
        collaboration_permission_service.require_project_agent(
            db, project.id, target_id
        )
    elif target["assignee_type"] == "team" and target_id.isdecimal():
        runnable_wegent_team(
            db,
            actor_user_id or project.created_by_user_id,
            int(target_id),
            project_id=project.id,
        )
    else:
        raise HTTPException(422, "Required stage assignee is invalid")
    return target


def resolve_role_assignee(
    db: Session,
    *,
    project: CloudProject,
    metadata: dict[str, Any],
    role: str,
    actor_user_id: int | None = None,
) -> dict[str, Any] | None:
    """Resolve ordered, explicit role targets using current project permissions."""
    for target in (
        stage_workflow(project, metadata).get("assignee_roles", {}).get(role, [])
    ):
        try:
            return require_stage_target(
                db, project=project, target=target, actor_user_id=actor_user_id
            )
        except HTTPException:
            continue
    return None


def engineering_assignee_targets(
    project: CloudProject, metadata: dict[str, Any]
) -> list[dict[str, Any]]:
    """Use the Issue owner, explicit project targets, then the pilot mapping."""
    owners = metadata.get("owner") or {}
    owner = owners.get("eng") if isinstance(owners, dict) else None
    if owner:
        return [{"assignee_type": "user", "assignee_id": str(owner)}]
    configured = (
        stage_workflow(project, metadata)
        .get("assignee_roles", {})
        .get("engineering", [])
    )
    if configured:
        return configured
    return (
        [{"assignee_type": "user", "assignee_id": "hongyu9"}]
        if stage_assignee_policy_enabled(project, metadata)
        else []
    )


def _engineering_assignee(
    db: Session,
    *,
    project: CloudProject,
    metadata: dict[str, Any],
    actor_user_id: int | None,
) -> dict[str, Any] | None:
    for target in engineering_assignee_targets(project, metadata):
        try:
            return require_stage_target(
                db, project=project, target=target, actor_user_id=actor_user_id
            )
        except HTTPException:
            continue
    return None


def _mismatch(
    item: LoopItem,
    stage_id: str | None,
    expected: dict[str, Any],
    actual: dict[str, Any],
    reason: str,
) -> HTTPException:
    return HTTPException(
        422,
        {
            "reason_code": "stage_assignee_mismatch",
            "issue_version": item.version,
            "stage_id": stage_id,
            "expected_assignee": expected,
            "actual_assignee": actual,
            "reason": reason,
        },
    )


def _advance_to_review(
    project: CloudProject, metadata: dict[str, Any], actor_user_id: int | None
) -> dict[str, Any]:
    result = deepcopy(metadata)
    workflow = result.get("workflow")
    review = next(
        (
            node
            for node in stage_workflow(project, result).get("nodes", [])
            if node.get("name") == "共同评审"
        ),
        None,
    )
    if isinstance(workflow, dict):
        if review is None:
            raise ValueError("Common review stage is missing from the Issue snapshot")
        workflow["current_stage_id"] = review["id"]
        workflow["version"] = int(workflow.get("version") or 1) + 1
    result["tags"] = [tag for tag in result.get("tags", []) if tag not in STAGE_NAMES]
    result["tags"].append("共同评审")
    result.setdefault("stage_assignee_history", []).append(
        {
            "from_stage": "需求提出",
            "to_stage": "共同评审",
            "reason": "assignee_changed",
            "actor_user_id": actor_user_id,
            "at": datetime.now(timezone.utc).isoformat(),
        }
    )
    return result


def _expected_assignee(
    db: Session,
    *,
    project: CloudProject,
    metadata: dict[str, Any],
    node: dict[str, Any],
    introduction: bool,
    actor_user_id: int | None,
) -> dict[str, Any] | None:
    if introduction:
        return normalized_assignee(db, "user", "jiangyang7")
    handoff = metadata.get("quality_handoff") or {}
    name = node.get("name") or stage_name(project, metadata)
    policy_enabled = stage_assignee_policy_enabled(project, metadata)
    role = (
        handoff.get("required_assignee_role")
        if policy_enabled and name in {"开发实现", "质量验收"}
        else None
    )
    if node.get("required_assignee_type") and (
        not role or (name == "质量验收" and role == "qa")
    ):
        return normalized_assignee(
            db, node["required_assignee_type"], node.get("required_assignee_id")
        )
    role = (
        role
        or node.get("required_assignee_role")
        or ("qa" if policy_enabled and name == "质量验收" else None)
    )
    if role:
        if role == "engineering":
            return _engineering_assignee(
                db,
                project=project,
                metadata=metadata,
                actor_user_id=actor_user_id,
            ) or {"assignee_type": "role", "assignee_id": role}
        return resolve_role_assignee(
            db,
            project=project,
            metadata=metadata,
            role=role,
            actor_user_id=actor_user_id,
        ) or {"assignee_type": "role", "assignee_id": role}
    return None


def _stage_selection_error(
    project: CloudProject,
    metadata: dict[str, Any],
    stage_id: str | None,
    node: dict[str, Any],
    expected: dict[str, Any] | None,
) -> tuple[str | None, str | None]:
    workflow = stage_workflow(project, metadata)
    nodes = workflow.get("nodes") or []
    constrained = expected is not None or any(
        stage_requires_assignee(project, metadata, candidate) for candidate in nodes
    )
    if not constrained:
        return None, None
    known_ids = {candidate.get("id") for candidate in nodes}
    for identity in (workflow.get("current_stage_id"), stage_id):
        if identity and identity not in known_ids:
            return identity, "Workflow stage does not exist"
    if not node and nodes:
        return None, "Workflow stage selection is required"
    return None, None


def _require_server_quality_state(item: LoopItem, metadata: dict[str, Any]) -> None:
    if metadata.get("quality_handoff") != (item.metadata_json or {}).get(
        "quality_handoff"
    ):
        raise HTTPException(
            422,
            {
                "reason_code": "quality_handoff_server_managed",
                "issue_version": item.version,
            },
        )


def _require_quality_entry(
    project: CloudProject,
    item: LoopItem,
    metadata: dict[str, Any],
    node: dict[str, Any],
) -> None:
    if not stage_assignee_policy_enabled(project, metadata):
        return
    original = item.metadata_json or {}
    target_name = node.get("name") or stage_name(project, metadata)
    if target_name != "质量验收":
        return
    current_name = stage_name(project, original)
    role = (metadata.get("quality_handoff") or {}).get("required_assignee_role")
    if current_name == "质量验收" and role == "engineering":
        return
    from app.services.quality_handoffs import require_quality_snapshot

    require_quality_snapshot(item, metadata)


def validate_stage_assignee(
    db: Session,
    *,
    project: CloudProject,
    item: LoopItem,
    assignee_type: str,
    assignee_id: str | None,
    stage_id: str | None = None,
    metadata: dict[str, Any] | None = None,
    allow_stage_advance: bool = False,
    actor_user_id: int | None = None,
) -> dict[str, Any]:
    """Validate under the caller's Issue lock before any writes or dispatch."""
    effective = deepcopy(metadata if metadata is not None else item.metadata_json or {})
    _require_server_quality_state(item, effective)
    if not stage_assignee_enforcement_enabled(project, effective):
        return effective
    node = stage_node(project, effective, stage_id) or {}
    if stage_id and not node:
        node = stage_node(project, effective) or {}
    introduction = stage_assignee_policy_enabled(project, effective) and (
        node.get("name") == "需求提出"
        or (not stage_id and stage_name(project, effective) == "需求提出")
    )
    expected = _expected_assignee(
        db,
        project=project,
        metadata=effective,
        node=node,
        introduction=introduction,
        actor_user_id=actor_user_id,
    )
    identity = stage_id or node.get("id") or stage_name(project, effective)
    invalid_identity, selection_error = _stage_selection_error(
        project, effective, stage_id, node, expected
    )
    if selection_error:
        raise _mismatch(
            item,
            invalid_identity or identity,
            expected or {"assignee_type": "stage", "assignee_id": None},
            normalized_assignee(db, assignee_type, assignee_id),
            selection_error,
        )
    _require_quality_entry(project, item, effective, node)
    if expected is None:
        return effective
    actual = normalized_assignee(db, assignee_type, assignee_id)
    if expected != actual:
        if introduction and allow_stage_advance and not stage_id and assignee_id:
            try:
                effective = _advance_to_review(project, effective, actor_user_id)
            except ValueError as exc:
                raise _mismatch(item, identity, expected, actual, str(exc)) from exc
            return validate_stage_assignee(
                db,
                project=project,
                item=item,
                assignee_type=assignee_type,
                assignee_id=assignee_id,
                metadata=effective,
                actor_user_id=actor_user_id,
            )
        raise _mismatch(
            item, identity, expected, actual, "Stage requires another assignee"
        )
    try:
        require_stage_target(
            db, project=project, target=expected, actor_user_id=actor_user_id
        )
    except HTTPException as exc:
        raise _mismatch(
            item, identity, expected, actual, "Required assignee lost project access"
        ) from exc
    return effective
