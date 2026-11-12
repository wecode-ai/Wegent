"""Current execution authority and revocation with Runtime-owned termination."""

import logging

from fastapi import HTTPException
from sqlalchemy import case, func, or_, select
from sqlalchemy.orm import Session

from app.models.delivery import (
    CollaborationChatGroup,
    LoopItem,
    ProjectChatAgent,
    loop_datetime_value_is_unset,
)
from app.models.loop_item_execution import LoopItemExecution
from app.schemas.base_role import BaseRole
from app.services.cloud_project_visibility import project_participant_ids
from app.services.cloud_projects.access import (
    CloudProjectAccess,
    require_cloud_project_role,
)
from app.services.collaboration_container_access import (
    require_collaboration_container_access,
)
from app.services.collaboration_permissions import (
    PermissionDecision,
    collaboration_permission_service,
    resource_query,
)
from app.services.execution_permission_scope import execution_resource_scope
from shared.telemetry.decorators import trace_sync

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
    if isinstance(access.project, CollaborationChatGroup):
        from app.services.thread_participation import require_thread_participation

        require_thread_participation(db, item, execution.assigner_user_id, execute=True)


def _require_agent_use(
    db: Session, execution: LoopItemExecution, agent_id: str, team_id: int | None = None
) -> None:
    from app.services.execution.team_readiness import validate_team_execution_readiness

    if agent_id:
        agent = db.get(ProjectChatAgent, agent_id)
        if agent is not None:
            from app.services.issue_resource_context import require_assignment_agent

            agent = require_assignment_agent(
                db,
                container_id=str(execution.cloud_project_id),
                agent_id=agent_id,
                user_id=execution.assigner_user_id,
                item=db.get(LoopItem, execution.loop_item_id),
                execute=True,
            )
            team_id = (agent.metadata_json or {}).get("wegent_team_id")
            profile_id = execution.runtime_selection.get("runtime_profile_id") or (
                agent.metadata_json or {}
            ).get("default_runtime_profile_id")
            if profile_id and not execution.assignment_pending:
                from app.models.delivery import RuntimeProfile

                profile = resource_query(
                    db.query(RuntimeProfile).filter(
                        RuntimeProfile.id == str(profile_id)
                    ),
                    current=True,
                ).one_or_none()
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
        from app.services.issue_resource_context import execution_resource_owner

        team = collaboration_permission_service.require_project_team(
            db, execution_resource_owner(db, execution), int(team_id)
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
    from app.services.issue_resource_context import execution_resource_owner

    current = collaboration_permission_service.require_project_group(
        db, execution_resource_owner(db, execution), str(group.get("id") or "")
    )
    current_members = {
        (member.get("kind"), str(member.get("id")))
        for member in _members((current.json or {}).get("spec", {}))
    }
    if isinstance(access.project, CollaborationChatGroup):
        from app.services.chat_group_access import chat_group_members
        from app.services.collaboration_group_execution import (
            collaboration_group_snapshot_for_dispatch,
        )
        from app.services.loop_item_executions.comment_continuation import (
            _require_group_dispatch,
        )

        if execution.executor_type == "collaboration_group_dispatch":
            collaboration_group_snapshot_for_dispatch(
                item=db.get(LoopItem, execution.loop_item_id), execution=execution
            )
        elif (
            execution.runtime_origin_context.get("dispatch_kind")
            == "collaboration_group"
        ):
            _require_group_dispatch(db, execution, execution.runtime_origin_context)
        humans = {
            member["user_id"]
            for member in chat_group_members(db, access.project.id, lock=True)
            if member["can_be_assignee"]
        }
    else:
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
    from app.services.issue_resource_context import execution_resource_owner

    try:
        resource_owner_id = execution_resource_owner(db, execution)
    except HTTPException as error:
        if error.status_code >= 500:
            raise
        return False
    from app.services.issue_resource_context import execution_resource_agent_id

    return runner is not None and runner.id in execution_environment_ids(
        db, resource_owner_id, execution_resource_agent_id(execution), current=True
    )


@trace_sync("collaboration.execution_permission", "backend.collaboration")
@execution_resource_scope()
def execution_permission(
    db: Session, execution: LoopItemExecution
) -> PermissionDecision:
    from app.db.session import get_db_session
    from app.services.project_coordination_authority import (
        coordination_scope,
        require_binding,
    )

    try:
        scope = coordination_scope(db, execution)
        if scope is not None:
            # Claims may reuse a REPEATABLE READ transaction. Read current authority
            # in a separate short session without committing the caller's work.
            with get_db_session() as current:
                require_binding(current, execution, scope)
                return _execution_permission(current, execution)
    except HTTPException as exc:
        if exc.status_code >= 500:
            raise
        return PermissionDecision(False, None, reason="project_coordination_revoked")
    return _execution_permission(db, execution)


def _execution_permission(
    db: Session, execution: LoopItemExecution
) -> PermissionDecision:
    from app.services.project_chat.group_message_authority import (
        prepare_group_message_authority,
    )

    try:
        prepare_group_message_authority(
            db,
            group_id=str(execution.cloud_project_id),
            thread_id=str(execution.loop_item_id),
            actor_user_id=execution.assigner_user_id,
        )
    except HTTPException as error:
        if error.status_code >= 500:
            raise
        return PermissionDecision(False, None, reason="not_accessible")
    decision = collaboration_permission_service.check_container(
        db, execution.assigner_user_id, "execute", execution.cloud_project_id
    )
    if not decision.allowed:
        return decision
    try:
        access = require_collaboration_container_access(
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

    payload = case(
        (
            func.json_valid(LoopItemExecution.execution_payload) == 1,
            LoopItemExecution.execution_payload,
        ),
        else_="{}",
    )
    manager_id = func.json_extract(payload, "$.origin_context.manager_agent_id")
    if db.get_bind().dialect.name == "mysql":
        manager_id = func.json_unquote(manager_id)
    rows = db.query(LoopItemExecution).filter(
        or_(
            LoopItemExecution.cloud_project_id == str(project_id),
            LoopItemExecution.agent_id.in_(
                select(ProjectChatAgent.id).where(
                    ProjectChatAgent.cloud_project_id == str(project_id)
                )
            ),
            manager_id.in_(
                select(ProjectChatAgent.id).where(
                    ProjectChatAgent.cloud_project_id == str(project_id)
                )
            ),
        ),
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
