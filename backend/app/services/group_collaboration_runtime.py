"""Authorize Group runtime callbacks against their exact persisted dispatch."""

from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import CollaborationChatGroup, LoopItem, ProjectChatAgent
from app.models.loop_item_execution import LoopItemExecution
from app.services.collaboration_container_access import (
    get_collaboration_container,
    lock_scoped_thread,
)
from app.services.collaboration_group_execution import (
    collaboration_group_agent_matches,
    collaboration_group_snapshot_for_dispatch,
    resolve_collaboration_group_agent,
)
from app.services.collaboration_permissions import resource_query
from app.services.issue_resource_context import (
    execution_resource_owner,
    require_assignment_agent,
)
from shared.telemetry.decorators import trace_sync


@dataclass(frozen=True)
class GroupRuntimeContext:
    group: CollaborationChatGroup
    item: LoopItem
    dispatch: LoopItemExecution
    manager: ProjectChatAgent

    @property
    def actor_user_id(self) -> int:
        return self.dispatch.assigner_user_id


@trace_sync("collaboration.group_runtime_context", "backend.collaboration")
def require_group_runtime_context(
    db: Session,
    *,
    container_id: int | str,
    item_id: str,
    dispatch_id: str,
    caller_user_id: int,
    manager_agent_id: str | None = None,
) -> GroupRuntimeContext | None:
    """Keep runtime ownership separate from current Group execution authority."""
    group = get_collaboration_container(db, container_id)
    if not isinstance(group, CollaborationChatGroup):
        return None
    candidates = (
        db.query(LoopItemExecution)
        .filter_by(cloud_project_id=str(container_id), loop_item_id=item_id)
        .all()
    )
    execution = next(
        (
            row
            for row in candidates
            if row.executor_type == "collaboration_group_dispatch"
            and row.runtime_origin_context.get("dispatch_id") == dispatch_id
        ),
        None,
    )
    if execution is None:
        raise HTTPException(409, "Collaboration dispatch is unavailable")
    if execution.executor_owner_user_id != caller_user_id:
        raise HTTPException(403, "Only the dispatch Runtime owner can report progress")
    from app.services.project_chat.group_message_authority import (
        prepare_group_message_authority,
    )

    prepare_group_message_authority(
        db,
        group_id=str(container_id),
        thread_id=item_id,
        actor_user_id=execution.assigner_user_id,
    )
    item = lock_scoped_thread(db, str(container_id), item_id)
    execution = resource_query(
        db.query(LoopItemExecution).filter_by(id=execution.id), current=True
    ).one()
    if (
        execution.executor_owner_user_id != caller_user_id
        or execution.cloud_project_id != str(container_id)
        or execution.loop_item_id != item_id
        or execution.runtime_origin_context.get("dispatch_id") != dispatch_id
    ):
        raise HTTPException(403, "Dispatch Runtime ownership changed")
    from app.services.collaboration_revocation import execution_authorized

    if not execution_authorized(db, execution):
        raise HTTPException(403, "Collaboration execution authority was revoked")
    snapshot = collaboration_group_snapshot_for_dispatch(item=item, execution=execution)
    manager_id = str(execution.runtime_origin_context.get("manager_agent_id") or "")
    manager = runtime_member_agent(db, item, execution, manager_id)
    if (
        manager_agent_id is not None and manager_agent_id != manager.id
    ) or not collaboration_group_agent_matches(snapshot.get("leader"), manager):
        raise HTTPException(
            422, "Dispatch manager does not match its current assignment"
        )
    return GroupRuntimeContext(group, item, execution, manager)


def runtime_member_agent(
    db: Session, item: LoopItem, dispatch: LoopItemExecution, member_id: str
) -> ProjectChatAgent:
    """Resolve the existing Crew binding without inventing another Agent identity."""
    source_id = execution_resource_owner(db, dispatch)
    agents = resource_query(
        db.query(ProjectChatAgent).filter_by(
            cloud_project_id=source_id, status="active"
        ),
        current=True,
    ).all()
    agent = resolve_collaboration_group_agent(agents, member_id)
    if agent is None:
        raise HTTPException(422, "Collaboration Agent is unavailable")
    return require_assignment_agent(
        db,
        container_id=str(item.cloud_project_id),
        agent_id=agent.id,
        user_id=dispatch.assigner_user_id,
        item=item,
        execute=True,
    )


def trusted_group_binding_item(
    db: Session,
    *,
    execution: LoopItemExecution,
    item_id: str,
    task_owner_user_id: int,
) -> LoopItem | None:
    """Allow only a persisted authorized dispatch to bind its own runtime session."""
    if not isinstance(
        get_collaboration_container(db, execution.cloud_project_id),
        CollaborationChatGroup,
    ):
        return None
    context = require_group_runtime_context(
        db,
        container_id=execution.cloud_project_id,
        item_id=item_id,
        dispatch_id=str(execution.runtime_origin_context.get("dispatch_id") or ""),
        caller_user_id=task_owner_user_id,
    )
    if context is None or context.dispatch.id != execution.id:
        raise HTTPException(403, "Binding does not belong to the authorized dispatch")
    return context.item
