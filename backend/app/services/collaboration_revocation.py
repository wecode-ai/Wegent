"""Current execution authority and revocation with Runtime-owned termination."""

import logging

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem, ProjectChatAgent, loop_datetime_value_is_unset
from app.models.loop_item_execution import LoopItemExecution
from app.schemas.base_role import BaseRole
from app.services.cloud_project_visibility import project_participant_ids
from app.services.cloud_projects.access import (
    CloudProjectAccess,
    require_cloud_project_role,
)
from app.services.collaboration_permissions import (
    PermissionDecision,
    collaboration_permission_service,
)

logger = logging.getLogger(__name__)
ACTIVE_WORK_STATUSES = (
    "pending_approval",
    "waiting_runtime",
    "queued",
    "claimed",
    "running",
)


def _require_issue(
    db: Session, access: CloudProjectAccess, execution: LoopItemExecution
) -> None:
    if access.project.task_provider in {"github", "gitlab"}:
        from app.services.loop_items.external_provider import (
            external_loop_item_provider,
        )

        item = external_loop_item_provider.get(
            db, execution.loop_item_id, execution.assigner_user_id
        )
        if str(item["cloud_project_id"]) != str(execution.cloud_project_id):
            raise HTTPException(404, "Issue is not in this project")
        return
    from app.services.loop_items.access import can_view_item

    item = db.get(LoopItem, execution.loop_item_id)
    if item is None or str(item.cloud_project_id) != str(execution.cloud_project_id):
        raise HTTPException(404, "Issue is not in this project")
    if not can_view_item(db, access, item, execution.assigner_user_id):
        raise HTTPException(404, "Issue is not accessible")


def _require_agent_use(
    db: Session, execution: LoopItemExecution, agent_id: str, team_id: int | None = None
) -> None:
    from app.services.execution.team_readiness import validate_team_execution_readiness

    if agent_id:
        agent = db.get(ProjectChatAgent, agent_id)
        if agent is not None:
            agent = collaboration_permission_service.require_project_agent(
                db,
                execution.cloud_project_id,
                agent_id,
                user_id=execution.assigner_user_id,
            )
            team_id = (agent.metadata_json or {}).get("wegent_team_id")
            profile_id = execution.runtime_selection.get("runtime_profile_id") or (
                agent.metadata_json or {}
            ).get("default_runtime_profile_id")
            if profile_id and not execution.assignment_pending:
                from app.models.delivery import RuntimeProfile

                profile = db.get(RuntimeProfile, str(profile_id))
                if (
                    profile is None
                    or profile.status != "active"
                    or not loop_datetime_value_is_unset(profile.deleted_at)
                ):
                    raise ValueError("Runtime profile is unavailable")
        elif agent_id.isdecimal():
            team_id = int(agent_id)
        else:
            raise HTTPException(422, "Agent is not enabled in this project")
    if team_id:
        team = collaboration_permission_service.require_project_team(
            db, execution.cloud_project_id, int(team_id)
        )
        if not execution.assignment_pending:
            validate_team_execution_readiness(
                db, team=team, execution_user_id=execution.assigner_user_id
            )


def _members(group: dict) -> list[dict]:
    members = [group.get("leader"), *(group.get("members") or [])]
    members.extend(
        stage["assignee"]
        for stage in group.get("stages", [])
        if isinstance(stage, dict) and stage.get("assignee") is not None
    )
    if any(
        not isinstance(member, dict)
        or member.get("kind") not in {"human", "agent"}
        or not member.get("id")
        for member in members
    ):
        raise HTTPException(422, "Collaboration group participants are invalid")
    return members


def _require_group(
    db: Session, access: CloudProjectAccess, execution: LoopItemExecution
) -> None:
    group = execution.execution_intent.get("origin_context", {}).get(
        "collaboration_group"
    )
    if not isinstance(group, dict):
        return
    current = collaboration_permission_service.require_project_group(
        db, execution.cloud_project_id, str(group.get("id") or "")
    )
    current_members = {
        (member.get("kind"), str(member.get("id")))
        for member in _members((current.json or {}).get("spec", {}))
    }
    humans = project_participant_ids(
        db, access.project, required_role=BaseRole.Developer
    )
    for member in _members(group):
        if (member.get("kind"), str(member.get("id"))) not in current_members:
            raise HTTPException(422, "Collaboration group membership was revoked")
        if member.get("kind") == "agent":
            _require_agent_use(db, execution, str(member["id"]))
        elif member.get("kind") != "human" or int(member["id"]) not in humans:
            raise HTTPException(422, "Collaboration group participant cannot execute")


def _device_authorized(db: Session, execution: LoopItemExecution) -> bool:
    if execution.execution_environment == "wegent":
        return True
    device_id = execution.runtime_device_id or execution.execution_device_id
    if not device_id:
        return True
    from app.services.device.identity import resolve_owned_device_alias
    from app.services.runner_routing import execution_environment_ids

    runner = resolve_owned_device_alias(
        db, user_id=execution.executor_owner_user_id, device_id=device_id
    )
    return runner is not None and runner.id in execution_environment_ids(
        db, execution.cloud_project_id, execution.agent_id
    )


def execution_permission(
    db: Session, execution: LoopItemExecution
) -> PermissionDecision:
    decision = collaboration_permission_service.check(
        db, execution.assigner_user_id, "execute", execution.cloud_project_id
    )
    if not decision.allowed:
        return decision
    try:
        access = require_cloud_project_role(
            db, execution.cloud_project_id, execution.assigner_user_id
        )
        _require_issue(db, access, execution)
        _require_group(db, access, execution)
        _require_agent_use(db, execution, execution.agent_id or "", execution.team_id)
    except HTTPException as exc:
        if exc.status_code >= 500:
            raise
        logger.debug(
            "Execution authorization denied execution=%s status=%s",
            execution.id,
            exc.status_code,
        )
        return PermissionDecision(
            False, decision.role, decision.sources, "issue_or_resource_unavailable"
        )
    except ValueError:
        return PermissionDecision(
            False, decision.role, decision.sources, "execution_dependencies_unavailable"
        )
    if not _device_authorized(db, execution):
        return PermissionDecision(
            False, decision.role, decision.sources, "device_authorization_revoked"
        )
    return decision


def execution_authorized(db: Session, execution: LoopItemExecution) -> bool:
    return execution_permission(db, execution).allowed


def revoke_unauthorized_project_work(
    db: Session, project_id: str | int, actor_user_id: int | None = None
) -> list[LoopItemExecution]:
    """Return cancellation requests that callers publish after their commit."""
    from app.services.loop_item_executions.service import loop_item_execution_service

    rows = db.query(LoopItemExecution).filter(
        LoopItemExecution.cloud_project_id == str(project_id),
        LoopItemExecution.status.in_(ACTIVE_WORK_STATUSES),
    )
    if actor_user_id is not None:
        rows = rows.filter(LoopItemExecution.assigner_user_id == actor_user_id)
    pending = []
    for row in rows.all():
        decision = execution_permission(db, row)
        if not decision.allowed:
            cancelled = loop_item_execution_service.cancel(
                db,
                execution_id=row.id,
                note=f"Collaboration authorization revoked: {decision.reason}",
                commit=False,
            )
            if cancelled.status == "cancel_requested":
                pending.append(cancelled)
    return pending


def sweep_revoked_work(db: Session) -> list[LoopItemExecution]:
    """Revalidate current authority and republish durable cancellation intents."""
    pending = db.query(LoopItemExecution).filter_by(status="cancel_requested").all()
    project_ids = (
        db.query(LoopItemExecution.cloud_project_id)
        .filter(LoopItemExecution.status.in_(ACTIVE_WORK_STATUSES))
        .distinct()
        .all()
    )
    pending.extend(
        run
        for (project_id,) in project_ids
        for run in revoke_unauthorized_project_work(db, project_id)
    )
    db.commit()
    return pending
