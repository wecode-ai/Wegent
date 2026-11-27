# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Project robot queue execution endpoints.

The queue is a derived view over `loop_item_executions`; these endpoints power
the queue page and runtime write-back. Backend persists queue and runtime state
for observation and recovery; Executors pull work through the device channel
and own capacity and execution.
"""

import hashlib
import json
import logging
import uuid
from typing import Optional

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Query,
    Request,
    Response,
    status,
)
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import (
    get_current_user,
    get_current_user_jwt_apikey_tasktoken,
    oauth2_scheme_optional,
)
from app.models.delivery import CloudProject, LoopItem, ProjectChatAgent
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.schemas.base_role import BaseRole, has_permission
from app.schemas.project_chat import (
    LoopItemExecutionAssignmentStatus,
    LoopItemExecutionBatchCreate,
    LoopItemExecutionCancel,
    LoopItemExecutionDispatchFailed,
    LoopItemExecutionDispatchIntent,
    LoopItemExecutionDispatchUnknown,
    LoopItemExecutionHeartbeat,
    LoopItemExecutionListResponse,
    LoopItemExecutionManagerDecision,
    LoopItemExecutionManagerStatus,
    LoopItemExecutionRuntimeStart,
    LoopItemExecutionView,
)
from app.schemas.runtime_profile import ExecutionRuntimeSelect
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.collaboration_group_execution import (
    collaboration_group_agent_matches,
    collaboration_group_snapshot_for_dispatch,
    resolve_collaboration_group_agent,
)
from app.services.collaboration_human_assignments import (
    collaboration_human_assignment_id,
    notify_collaboration_human_assignment,
)
from app.services.collaboration_manager_decisions import (
    _require_manager_dispatch,
    apply_collaboration_manager_decision,
)
from app.services.collaboration_member_activity import (
    project_collaboration_member_activity,
)
from app.services.issue_assignments import issue_assignment_service
from app.services.loop_item_executions.service import (
    WeworkRuntimeConfigurationError,
    _optional_datetime,
    _optional_text,
    _optional_user_id,
    execution_display_state,
    loop_item_execution_service,
)
from app.services.loop_items.access import visible_item_filter
from app.services.loop_items.service import loop_item_service
from app.services.project_chat.push import push_project_chat_message
from app.services.project_chat.service import project_chat_service
from app.services.runtime_profiles import runtime_profile_service
from app.services.workspaces.storage import workspace_id_for_project

logger = logging.getLogger(__name__)

router = APIRouter()


def _require_project_agent(
    db: Session, *, project_id: int, agent_id: str
) -> ProjectChatAgent:
    """Resolve a group member by project-agent id or its bound Wegent Team id."""

    agents = (
        db.query(ProjectChatAgent)
        .filter(
            ProjectChatAgent.cloud_project_id == str(project_id),
            ProjectChatAgent.status == "active",
        )
        .all()
    )
    agent = resolve_collaboration_group_agent(agents, agent_id)
    if agent is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Robot not found")
    return agent


def _require_run_owner(
    db: Session, *, project_id: int, execution_id: int, user_id: int
) -> LoopItemExecution:
    """The Run owner's App/worker is the only runtime write-back caller."""

    row = db.get(LoopItemExecution, execution_id)
    if row is None or row.cloud_project_id != str(project_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Execution not found")
    if row.executor_owner_user_id != user_id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Only the execution owner can report this run",
        )
    return row


def _require_project_execution(
    db: Session, *, project_id: int, execution_id: int
) -> LoopItemExecution:
    """Resolve an execution only inside the project named by the route."""

    row = db.get(LoopItemExecution, execution_id)
    if row is None or row.cloud_project_id != str(project_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Execution not found")
    return row


def _collaboration_group_leader(
    group: dict[str, object],
) -> tuple[str, str] | None:
    leader = group.get("leader")
    if not isinstance(leader, dict):
        return None
    kind = str(leader.get("kind") or "")
    member_id = str(leader.get("id") or "")
    if kind not in {"agent", "human"} or not member_id:
        return None
    return kind, member_id


def _collaboration_group_execution_members(
    group: dict[str, object],
) -> set[tuple[str, str]]:
    values: set[tuple[str, str]] = set()
    leader_identity = _collaboration_group_leader(group)
    members = group.get("members")
    if isinstance(members, list):
        values.update(
            (str(member.get("kind") or ""), str(member.get("id") or ""))
            for member in members
            if isinstance(member, dict)
        )
    return {
        (kind, member_id)
        for kind, member_id in values
        if kind in {"agent", "human"}
        and member_id
        and (kind, member_id) != leader_identity
    }


def _collaboration_group_execution_agent_members(
    group: dict[str, object],
) -> list[object]:
    """Return configured executor references, excluding the coordinator."""

    members = group.get("members")
    if not isinstance(members, list):
        return []
    leader_identity = _collaboration_group_leader(group)
    return [
        member
        for member in members
        if not (
            isinstance(member, dict)
            and (str(member.get("kind") or ""), str(member.get("id") or ""))
            == leader_identity
        )
    ]


def _collaboration_group_contains_execution_agent(
    group: dict[str, object],
    agent: ProjectChatAgent,
) -> bool:
    return any(
        collaboration_group_agent_matches(member, agent)
        for member in _collaboration_group_execution_agent_members(group)
    )


def _execution_view(
    db: Session,
    row: object,
    *,
    viewer_user_id: int | None = None,
    include_runtime_payload: bool = False,
) -> LoopItemExecutionView:
    item = db.get(LoopItem, row.loop_item_id)
    origin_context = row.runtime_origin_context
    workflow_task_title = str(origin_context.get("workflow_task_title") or "").strip()
    agent = db.get(ProjectChatAgent, row.agent_id) if row.agent_id else None
    if agent is not None:
        from app.services.project_chat.service import bot_max_concurrent_executions

        agent_max_concurrent_executions = bot_max_concurrent_executions(agent)
    else:
        agent_max_concurrent_executions = 1
    runtime_payload = (
        loop_item_execution_service.build_runtime_payload(
            db,
            execution=row,
        )
        if include_runtime_payload
        else None
    )
    return LoopItemExecutionView.model_validate(
        {
            "id": row.id,
            "loop_item_id": row.loop_item_id,
            "cloud_project_id": row.cloud_project_id,
            "workspace_id": workspace_id_for_project(db, row.cloud_project_id),
            "task_title": workflow_task_title
            or ((item.title or item.name or "") if item else ""),
            "task_status": item.status if item else None,
            "task_priority": item.priority if item else None,
            "executor_type": row.executor_type,
            "agent_id": _optional_text(row.agent_id),
            "team_id": row.optional_team_id,
            "backend_task_id": row.optional_backend_task_id,
            "automation_run_id": row.automation_run_id,
            "executor_owner_user_id": _optional_user_id(row.executor_owner_user_id),
            "assigner_user_id": row.assigner_user_id,
            "execution_environment": row.execution_environment,
            "execution_device_id": _optional_text(row.execution_device_id),
            "runtime_instance_id": _optional_text(row.runtime_instance_id),
            "status": row.status,
            "display_state": execution_display_state(row),
            "observed_state": row.observed_state,
            "sync_state": row.sync_state,
            "priority_weight": row.priority_weight,
            "queued_at": _optional_datetime(row.queued_at),
            "started_at": _optional_datetime(row.started_at),
            "completed_at": _optional_datetime(row.completed_at),
            "lease_expires_at": _optional_datetime(row.lease_expires_at),
            "heartbeat_at": _optional_datetime(row.heartbeat_at),
            "claimed_at": _optional_datetime(row.claimed_at),
            "start_requested_at": _optional_datetime(row.start_requested_at),
            "observed_at": _optional_datetime(row.observed_at),
            "cancel_requested_at": _optional_datetime(row.cancel_requested_at),
            "attempt_no": row.attempt_no,
            "previous_execution_id": row.previous_execution_id or None,
            "execution_scope": row.execution_scope,
            "last_event_seq": row.last_event_seq,
            "termination_reason": row.termination_reason,
            "retry_attempt": row.retry_attempt,
            "error_message": row.error_message,
            "execution_note": row.execution_note,
            "approval_status": _optional_text(row.approval_status),
            "approved_by_user_id": _optional_user_id(row.approved_by_user_id),
            "rejected_reason": _optional_text(row.rejected_reason),
            "runtime_device_id": _optional_text(row.runtime_device_id),
            "runtime_task_id": _optional_text(row.runtime_task_id),
            "agent_max_concurrent_executions": agent_max_concurrent_executions,
            "runtime_profile_id": row.runtime_selection.get("runtime_profile_id"),
            "runtime_source": row.runtime_selection.get("runtime_source"),
            "can_select_runtime": (
                viewer_user_id is not None
                and row.executor_owner_user_id == viewer_user_id
                and not row.uses_runner_routing
                and row.status in {"waiting_runtime", "queued"}
            ),
            "waiting_runtime_reason": (
                row.execution_note if row.status == "waiting_runtime" else None
            ),
            "runtime_payload": runtime_payload,
            "version": row.version,
            "created_at": row.created_at,
            "updated_at": row.updated_at,
        }
    )


@router.put(
    "/{project_id}/executions/{execution_id}/runtime",
    response_model=LoopItemExecutionView,
)
def select_execution_runtime(
    project_id: int,
    execution_id: int,
    values: ExecutionRuntimeSelect,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LoopItemExecutionView:
    require_cloud_project_role(db, project_id, current_user.id, BaseRole.Viewer)
    row = _require_project_execution(
        db, project_id=project_id, execution_id=execution_id
    )
    if row.executor_owner_user_id != current_user.id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Only the Runtime owner can configure this execution",
        )
    selected = runtime_profile_service.select_execution(
        db,
        execution_id=execution_id,
        user_id=current_user.id,
        profile_id=values.runtime_profile_id,
        version=values.version,
    )
    return _execution_view(db, selected, viewer_user_id=current_user.id)


@router.get(
    "/{project_id}/executions",
    response_model=LoopItemExecutionListResponse,
)
async def list_executions(
    project_id: int,
    agent_id: Optional[str] = Query(default=None),
    assigner_user_id: Optional[int] = Query(default=None),
    status: Optional[str] = Query(default=None),
    include_terminal: bool = Query(default=False),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LoopItemExecutionListResponse:
    access = require_cloud_project_role(
        db, project_id, current_user.id, BaseRole.Viewer
    )
    project = access.project
    rows = loop_item_execution_service.list_queue(
        db,
        project_id=str(project_id),
        viewer_user_id=current_user.id,
        agent_id=agent_id,
        assigner_user_id=assigner_user_id,
        status_filter=status,
        include_terminal=include_terminal,
    )
    if project.task_provider in {"github", "gitlab"}:
        from app.services.loop_items.external_provider import (
            external_loop_item_provider,
        )

        issues = external_loop_item_provider.list(db, project_id, current_user.id)
        by_id = {str(issue["id"]): issue for issue in issues}
        if not has_permission(access.role, BaseRole.Maintainer):
            rows = [row for row in rows if str(row["loop_item_id"]) in by_id]
        for row in rows:
            issue = by_id.get(str(row["loop_item_id"]))
            row["task_title"] = str(issue.get("title") or "") if issue else ""
            row["task_status"] = issue.get("status") if issue else None
            row["task_priority"] = issue.get("priority") if issue else None
    else:
        item_ids = [row["loop_item_id"] for row in rows]
        item_query = db.query(LoopItem).filter(LoopItem.id.in_(item_ids))
        if not has_permission(access.role, BaseRole.Maintainer):
            item_query = item_query.filter(
                visible_item_filter(current_user.id, access.project)
            )
        items = item_query.all() if item_ids else []
        by_id = {item.id: item for item in items}
        if not has_permission(access.role, BaseRole.Maintainer):
            rows = [row for row in rows if str(row["loop_item_id"]) in by_id]
        for row in rows:
            item = by_id.get(str(row["loop_item_id"]))
            row["task_title"] = (item.title or item.name or "") if item else ""
            row["task_status"] = item.status if item else None
            row["task_priority"] = item.priority if item else None
    from app.services.runner_catalog import annotate_queue

    await annotate_queue(db, rows)
    return LoopItemExecutionListResponse(
        items=[LoopItemExecutionView.model_validate(row) for row in rows],
        total=len(rows),
    )


@router.post("/{project_id}/executions/batch")
def enqueue_execution_batch(
    project_id: int,
    values: LoopItemExecutionBatchCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
    request: Request = None,
) -> dict[str, object]:
    """Admit a manager round using the protocol bound to its dispatch."""

    return admit_collaboration_batch(
        db,
        project_id,
        values,
        current_user,
        device_manager_execution_id=(
            getattr(request.state, "device_manager_execution_id", None)
            if request
            else None
        ),
        signed_in=request is not None
        and getattr(request.state, "user_session_id", None) == current_user.id,
        task_id=getattr(request.state, "execution_task_id", None) if request else None,
        subtask_id=(
            getattr(request.state, "execution_subtask_id", None) if request else None
        ),
    )


def admit_collaboration_batch(
    db: Session,
    project_id: int,
    values: LoopItemExecutionBatchCreate,
    current_user: User,
    *,
    signed_in: bool,
    device_manager_execution_id: int | None = None,
    task_id: int | None,
    subtask_id: int | None = None,
) -> dict[str, object]:
    if not values.manager_agent_id and not signed_in:
        raise HTTPException(
            403, "Human coordination requires the leader's signed-in session"
        )
    require_cloud_project_role(
        db,
        project_id,
        current_user.id,
        BaseRole.Developer,
    )
    item = (
        db.query(LoopItem)
        .filter(
            LoopItem.id == values.loop_item_id,
            LoopItem.cloud_project_id == project_id,
        )
        .with_for_update()
        .first()
    )
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Issue not found")
    from app.services.issue_coordination import (
        coordination_activity,
        human_authority,
        require_finished_batch,
        require_open_round,
    )

    project = db.get(CloudProject, project_id)
    if project is None:
        raise HTTPException(404, "Project not found")
    root = None
    turn_scope = None
    manager = manager_execution = None
    if values.manager_agent_id:
        manager = _require_project_agent(
            db, project_id=project_id, agent_id=values.manager_agent_id
        )
        manager, manager_execution = _require_manager_dispatch(
            db,
            project_id=project_id,
            item=item,
            dispatch_id=values.dispatch_id,
            manager_agent_id=manager.id,
        )
        group = collaboration_group_snapshot_for_dispatch(
            item=item, execution=manager_execution
        )
        if task_id is not None or manager_execution.execution_environment == "wegent":
            from app.services.issue_coordination import require_machine_task_scope

            require_machine_task_scope(
                task_id, manager_execution, device_manager_execution_id
            )
        if manager_execution.execution_environment == "wegent":
            from app.services.issue_coordination import managed_turn_scope

            turn_scope = managed_turn_scope(db, manager_execution, task_id, subtask_id)
            values.manager_runtime_task_id = str(subtask_id)
        sender_id, sender_name = manager.id, manager.title or manager.name
        server_dispatch = (
            manager_execution.runtime_origin_context.get("dispatch_protocol_version")
            == 2
        )
        if (
            server_dispatch
            and manager_execution.executor_owner_user_id != current_user.id
        ):
            raise HTTPException(
                403, "Collaboration manager execution is owned by another user"
            )
    else:
        root, group = human_authority(db, item, current_user.id, values.dispatch_id)
        sender_id, sender_name = str(current_user.id), current_user.user_name
        server_dispatch = True
    round_key = [str(project_id), item.id, values.dispatch_id, values.round_id]
    message_id = hashlib.sha256(
        b"manager_assignment\0" + json.dumps(round_key, separators=(",", ":")).encode()
    ).hexdigest()
    request_digest = hashlib.sha256(
        json.dumps(
            [
                current_user.id,
                sender_id,
                [c.model_dump(mode="json") for c in values.items],
            ],
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    previous = (
        db.query(ProjectChatMessage).filter_by(message_id=message_id).one_or_none()
    )
    if turn_scope is not None:
        from app.services.issue_coordination import require_manager_turn

        require_manager_turn(
            turn_scope[0], subtask_id, previous.metadata_json if previous else None
        )
    if previous is not None:
        metadata = previous.metadata_json
        if metadata["request_digest"] != request_digest:
            raise HTTPException(
                409, "Round already submitted with different assignments"
            )
        return metadata["submission_result"]
    if len({c.assignment_id for c in values.items}) != len(values.items):
        raise HTTPException(422, "Duplicate assignment ID in collaboration round")
    if server_dispatch and manager:
        root = coordination_activity(db, item, values.dispatch_id, group)
        if not values.manager_runtime_task_id:
            raise HTTPException(422, "Manager run identity is required")
        if (
            root.status != "active"
            or (
                turn_scope
                and root.metadata_json.get("last_manager_turn") == turn_scope[1]
            )
            or (
                (turn_scope or not values.manager_turn_id)
                and root.metadata_json.get("last_manager_run")
                == values.manager_runtime_task_id
            )
        ):
            raise HTTPException(409, "Manager turn is closed")
        require_finished_batch(
            db, root, item, None if turn_scope else values.manager_turn_id
        )
    elif root is not None:
        require_open_round(db, root, item, values.round_id)
    if not server_dispatch:
        # Historical v1 rounds used random message IDs. Preserve their original receipts.
        old_round = (
            db.query(ProjectChatMessage)
            .filter(
                ProjectChatMessage.project_id == str(project_id),
                ProjectChatMessage.task_id == item.id,
                ProjectChatMessage.sender_id == manager.id,
                ProjectChatMessage.metadata_json["activity_type"].as_string()
                == "manager_assignment",
                ProjectChatMessage.metadata_json["dispatch_id"].as_string()
                == values.dispatch_id,
                ProjectChatMessage.metadata_json["coordination_round_id"].as_string()
                == values.round_id,
            )
            .first()
        )
        if old_round:
            return {
                "dispatch_id": values.dispatch_id,
                "round_id": values.round_id,
                "human_assignments": [
                    entry
                    for entry in old_round.metadata_json["dispatch_assignments"]
                    if entry.get("assignee_type") == "human"
                ],
            }
    stages = {stage["id"]: stage for stage in group.get("stages", [])}
    agent_assignments: list[dict[str, object]] = []
    leader_identity = _collaboration_group_leader(group)
    allowed_members = _collaboration_group_execution_members(group)
    human_assignments: list[dict[str, object]] = []
    assignment_activity: list[dict[str, object]] = []
    assignees: list[ProjectChatAgent | User] = []
    for command in values.items:
        member_key = (command.assignee_type, command.assignee_id)
        stage = stages.get(command.workflow_stage_id)
        if server_dispatch and command.workflow_stage_id and stage is None:
            raise HTTPException(422, "Unknown collaboration stage")
        stage_assignee = (stage or {}).get("assignee") if server_dispatch else None
        if command.assignee_type == "human" and member_key == leader_identity:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Collaboration group leader cannot execute an assignment",
            )
        if command.assignee_type == "human" and member_key not in allowed_members:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Assignment target is not part of the collaboration group",
            )
        if command.assignee_type == "agent":
            agent = _require_project_agent(
                db,
                project_id=project_id,
                agent_id=command.assignee_id,
            )
            if collaboration_group_agent_matches(group.get("leader"), agent):
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Collaboration group leader cannot execute an assignment",
                )
            if not _collaboration_group_contains_execution_agent(group, agent):
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Assignment target is not part of the collaboration group",
                )
            if stage_assignee and not collaboration_group_agent_matches(
                stage_assignee, agent
            ):
                raise HTTPException(422, "Stage assignee does not match assignment")
            assignees.append(agent)
        else:
            if (
                stage_assignee
                and (stage_assignee.get("kind"), stage_assignee.get("id")) != member_key
            ):
                raise HTTPException(422, "Stage assignee does not match assignment")
            canonical_type, canonical_id = (
                issue_assignment_service.require_canonical_member(
                    db,
                    project=project,
                    member_type="human",
                    member_id=command.assignee_id,
                )
            )
            if canonical_type != "user":
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Human assignee is invalid",
                )
            human = db.get(User, int(canonical_id))
            if human is None or not human.is_active:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Human assignee is not active",
                )
            assignees.append(human)
    for command, assignee in zip(values.items, assignees, strict=True):
        if isinstance(assignee, ProjectChatAgent):
            agent = assignee
            activity = {
                "assignee_type": "agent",
                "assignment_id": command.assignment_id,
                "task_title": command.title,
                "instructions": command.instructions,
                "assignee_id": command.assignee_id,
                "agent_id": agent.id,
                "agent_name": agent.title or agent.name or "AI",
                "workflow_stage_id": command.workflow_stage_id,
            }
            if server_dispatch:
                execution = loop_item_execution_service.create_for_assignment(
                    db,
                    loop_item_id=item.id,
                    cloud_project_id=str(project_id),
                    agent=agent,
                    assigner_user_id=current_user.id,
                    environment="local",
                    execution_device_id=None,
                    priority=item.priority,
                    instruction=f"任务标题：{command.title}\n\n执行要求：{command.instructions}",
                    automation_context={
                        "dispatch_kind": "collaboration_group",
                        **(
                            {
                                "collaboration_dispatch_execution_id": manager_execution.id
                            }
                            if manager_execution
                            else {}
                        ),
                        "dispatch_role": "member",
                        "dispatch_task_id": item.id,
                        "manager_agent_id": manager.id if manager else None,
                        "dispatch_protocol_version": 2,
                        "assignment_key": item.metadata_json[
                            "collaboration_group_assignment_key"
                        ],
                        "collaboration_group_id": group["id"],
                        "dispatch_id": values.dispatch_id,
                        "coordination_round_id": values.round_id,
                        "assignment_id": command.assignment_id,
                        "run_id": hashlib.sha256(
                            f"{message_id}:{command.assignment_id}".encode()
                        ).hexdigest(),
                        "workflow_stage_id": command.workflow_stage_id,
                        "workflow_task_title": command.title,
                        "model": command.model_id,
                    },
                )
                activity["execution_id"] = execution.id
                agent_assignments.append(dict(activity))
        else:
            human = assignee
            human_assignment_id = (
                str(uuid.uuid4())
                if server_dispatch
                else collaboration_human_assignment_id(
                    dispatch_id=values.dispatch_id,
                    round_id=values.round_id,
                    assignment_id=command.assignment_id,
                )
            )
            notify_collaboration_human_assignment(
                db,
                project=project,
                issue=item,
                human=human,
                actor_user_id=current_user.id,
                actor_name=sender_name,
                human_assignment_id=human_assignment_id,
                dispatch_id=values.dispatch_id,
                round_id=values.round_id,
                assignment_id=command.assignment_id,
                task_title=command.title,
                instructions=command.instructions,
                workflow_stage_id=command.workflow_stage_id,
            )
            human_assignment = {
                "assignee_type": "human",
                "work_id": f"human_assignment:{human_assignment_id}",
                "human_assignment_id": human_assignment_id,
                "status": "queued",
                "assignment_id": command.assignment_id,
                "task_title": command.title,
                "instructions": command.instructions,
                "human_user_id": human.id,
                "human_user_name": human.user_name,
                "workflow_stage_id": command.workflow_stage_id,
            }
            human_assignments.append(human_assignment)
            activity = dict(human_assignment)
        assignment_activity.append(activity)

    # Runtime updates may replace the manager card while member status is reported.
    # Keep the round assignment on its own durable activity record.
    response = {
        "dispatch_id": values.dispatch_id,
        "round_id": values.round_id,
        "human_assignments": human_assignments,
    }
    if server_dispatch:
        response["agent_assignments"] = agent_assignments
    from app.services.collaboration_round_assignment import assign_round_owner

    assign_round_owner(
        db,
        item=item,
        assignments=assignment_activity,
        user_id=current_user.id,
        manager=manager,
    )
    assignment_message = ProjectChatMessage(
        message_id=message_id,
        client_message_id=message_id,
        project_id=str(project_id),
        task_id=item.id,
        sender_type="agent" if manager else "user",
        sender_id=sender_id,
        sender_name=sender_name,
        message_type="text",
        content="",
        metadata_json={
            "request_digest": request_digest,
            "submission_result": response,
            "dispatch_role": "manager",
            "activity_type": "manager_assignment",
            "dispatch_id": values.dispatch_id,
            "manager_runtime_task_id": values.manager_runtime_task_id,
            "coordination_round_id": values.round_id,
            "dispatch_assignments": assignment_activity,
        },
        agent_id=manager.id if manager else "",
        runtime_device_id=(
            manager_execution.runtime_device_id if manager_execution else ""
        ),
        runtime_task_id=values.manager_runtime_task_id or "",
        status="completed",
    )
    if manager_execution and manager_execution.optional_backend_task_id:
        from app.core.config import settings

        backend_task_id = manager_execution.optional_backend_task_id
        assignment_message.metadata_json = {
            **assignment_message.metadata_json,
            "backend_task_id": backend_task_id,
            "execution_url": f"{settings.FRONTEND_URL.rstrip('/')}/chat?taskId={backend_task_id}",
        }
    db.add(assignment_message)
    db.flush()
    from app.services.project_chat.runtime_binding import (
        bind_collaboration_manager_activity,
    )

    if manager_execution and manager_execution.execution_environment != "wegent":
        bind_collaboration_manager_activity(
            db, dispatch=manager_execution, activity=assignment_message, item=item
        )
    if root is not None:
        root.metadata_json = {
            **root.metadata_json,
            "round": root.metadata_json["round"] + 1,
            "last_batch": message_id,
            "last_manager_run": values.manager_runtime_task_id,
            **({"last_manager_turn": turn_scope[1]} if turn_scope else {}),
        }
    db.commit()
    db.refresh(assignment_message)
    push_project_chat_message(
        project_chat_service.to_view(assignment_message, db=db).model_dump(
            by_alias=True
        )
    )
    return response


@router.post("/{project_id}/executions/assignment-status")
def report_collaboration_assignment_status(
    project_id: int,
    values: LoopItemExecutionManagerStatus | LoopItemExecutionAssignmentStatus,
    response: Response,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
    session_token: str | None = Depends(oauth2_scheme_optional),
) -> dict[str, object]:
    """Bind collaboration sessions and record progress; Executor owns the round."""

    require_cloud_project_role(db, project_id, current_user.id, BaseRole.Developer)
    runtime_profiles = None
    try:
        if isinstance(values, LoopItemExecutionManagerStatus):
            from app.services.collaboration_manager_activity import (
                project_collaboration_manager_activity,
            )

            if values.refresh_runtime_profiles and (
                not session_token
                or get_current_user(token=session_token, db=db).id != current_user.id
            ):
                raise HTTPException(403, "Runtime profiles require the owner's session")
            message, changed, runtime_profiles = project_collaboration_manager_activity(
                db, project_id=project_id, user_id=current_user.id, values=values
            )
        else:
            message, changed = project_collaboration_member_activity(
                db, project_id=project_id, values=values
            )
    except HTTPException as exc:
        logger.warning(
            "Collaboration activity rejected project=%s issue=%s dispatch=%s "
            "round=%s runtime_task=%s http_status=%s reason=%s",
            project_id,
            values.loop_item_id,
            values.dispatch_id,
            values.round_id,
            values.runtime_task_id,
            exc.status_code,
            exc.detail,
        )
        raise
    view = project_chat_service.to_view(message, db=db).model_dump(by_alias=True)
    if changed:
        logger.info(
            "Collaboration activity recorded project=%s issue=%s dispatch=%s "
            "round=%s runtime_task=%s activity_type=%s activity_status=%s",
            project_id,
            values.loop_item_id,
            values.dispatch_id,
            values.round_id,
            values.runtime_task_id,
            (message.metadata_json or {}).get("activity_type"),
            message.status,
        )
        push_project_chat_message(view)
    result: dict[str, object] = {"message": view, "changed": changed}
    if runtime_profiles is not None:
        response.headers["Cache-Control"] = "no-store"
        result["runtime_profiles"] = runtime_profiles
    return result


@router.post("/{project_id}/executions/manager-decision")
def decide_collaboration_issue_status(
    project_id: int,
    values: LoopItemExecutionManagerDecision,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
    request: Request = None,
) -> dict[str, object]:
    """Persist one manager-owned Issue decision without owning the loop."""

    if not values.manager_agent_id and (
        request is None
        or getattr(request.state, "user_session_id", None) != current_user.id
    ):
        raise HTTPException(
            403, "Human coordination requires the leader's signed-in session"
        )
    require_cloud_project_role(
        db,
        project_id,
        current_user.id,
        BaseRole.Developer,
    )
    decision = apply_collaboration_manager_decision(
        db,
        project_id=project_id,
        item_id=values.loop_item_id,
        user_id=current_user.id,
        dispatch_id=values.dispatch_id,
        manager_agent_id=values.manager_agent_id,
        idempotency_key=values.idempotency_key,
        round_id=values.round_id,
        target_status=values.target_status,
        reason=values.reason,
        comment=values.comment,
        request=request,
        manager_runtime_task_id=values.manager_runtime_task_id,
        manager_turn_id=values.manager_turn_id,
    )
    return decision.response


def _claimed_execution_view(
    db: Session,
    row: LoopItemExecution,
) -> LoopItemExecutionView:
    """Materialize a claimed run or durably fail an unavailable model."""

    try:
        return _execution_view(db, row, include_runtime_payload=True)
    except WeworkRuntimeConfigurationError as exc:
        logger.warning(
            "[LoopItemExecution] Runtime configuration unavailable "
            "execution=%s model_error=%s",
            row.id,
            str(exc),
        )
        loop_item_execution_service.fail_runtime_preflight(
            db,
            execution_id=row.id,
            error=str(exc),
            note="runtime_configuration_unavailable",
        )
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc


@router.post(
    "/{project_id}/executions/{execution_id}/heartbeat",
    response_model=Optional[LoopItemExecutionView],
)
def heartbeat_execution(
    project_id: int,
    execution_id: int,
    values: LoopItemExecutionHeartbeat,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Optional[LoopItemExecutionView]:
    _require_run_owner(
        db,
        project_id=project_id,
        execution_id=execution_id,
        user_id=current_user.id,
    )
    row = loop_item_execution_service.heartbeat(
        db,
        execution_id=execution_id,
        runtime_device_id=values.runtime_device_id,
        runtime_task_id=values.runtime_task_id,
        lease_seconds=values.lease_seconds,
    )
    return _execution_view(db, row) if row else None


@router.post(
    "/{project_id}/executions/{execution_id}/start-requested",
    response_model=Optional[LoopItemExecutionView],
)
def request_runtime_start(
    project_id: int,
    execution_id: int,
    values: LoopItemExecutionDispatchIntent,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Optional[LoopItemExecutionView]:
    """Persist delivery intent before the App sends Runtime create."""

    _require_run_owner(
        db,
        project_id=project_id,
        execution_id=execution_id,
        user_id=current_user.id,
    )
    row = loop_item_execution_service.request_runtime_start(
        db,
        execution_id=execution_id,
        runtime_device_id=values.runtime_device_id,
        runtime_task_id=values.runtime_task_id,
    )
    return _execution_view(db, row) if row else None


@router.post(
    "/{project_id}/executions/{execution_id}/dispatch-unknown",
    response_model=Optional[LoopItemExecutionView],
)
def report_runtime_dispatch_unknown(
    project_id: int,
    execution_id: int,
    values: LoopItemExecutionDispatchUnknown,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Optional[LoopItemExecutionView]:
    """Record an ambiguous App-to-Runtime create outcome for reconciliation."""

    _require_run_owner(
        db,
        project_id=project_id,
        execution_id=execution_id,
        user_id=current_user.id,
    )
    row = loop_item_execution_service.report_runtime_dispatch_unknown(
        db,
        execution_id=execution_id,
        runtime_device_id=values.runtime_device_id,
        runtime_task_id=values.runtime_task_id,
        error=values.error,
    )
    return _execution_view(db, row) if row else None


@router.post(
    "/{project_id}/executions/{execution_id}/runtime-start",
    response_model=Optional[LoopItemExecutionView],
)
def runtime_start_execution(
    project_id: int,
    execution_id: int,
    values: LoopItemExecutionRuntimeStart,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Optional[LoopItemExecutionView]:
    """Record Runtime acceptance without claiming that execution has started."""

    _require_run_owner(
        db,
        project_id=project_id,
        execution_id=execution_id,
        user_id=current_user.id,
    )
    accepted = loop_item_execution_service.accept_runtime_and_open_activity(
        db,
        execution_id=execution_id,
        runtime_device_id=values.runtime_device_id,
        runtime_task_id=values.runtime_task_id,
        prompt=values.prompt,
    )
    return _execution_view(db, accepted) if accepted is not None else None


@router.post(
    "/{project_id}/executions/{execution_id}/dispatch-failed",
    response_model=Optional[LoopItemExecutionView],
)
def fail_runtime_preflight(
    project_id: int,
    execution_id: int,
    values: LoopItemExecutionDispatchFailed,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Optional[LoopItemExecutionView]:
    _require_run_owner(
        db,
        project_id=project_id,
        execution_id=execution_id,
        user_id=current_user.id,
    )
    row = loop_item_execution_service.fail_runtime_preflight(
        db,
        execution_id=execution_id,
        error=values.error,
        note=values.note,
    )
    return _execution_view(db, row) if row else None


@router.post(
    "/{project_id}/executions/{execution_id}/cancel",
    response_model=Optional[LoopItemExecutionView],
)
def cancel_execution(
    project_id: int,
    execution_id: int,
    values: LoopItemExecutionCancel,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Optional[LoopItemExecutionView]:
    _require_run_owner(
        db,
        project_id=project_id,
        execution_id=execution_id,
        user_id=current_user.id,
    )
    row = loop_item_execution_service.cancel(
        db, execution_id=execution_id, note=values.note
    )
    if (
        row is not None
        and row.status == "cancel_requested"
        and row.runtime_device_id
        and row.runtime_task_id
    ):
        from app.tasks.robot_queue_tasks import emit_runtime_cancels

        background_tasks.add_task(emit_runtime_cancels, [row])
    return _execution_view(db, row) if row else None


@router.post(
    "/{project_id}/executions/{execution_id}/stop",
    response_model=Optional[LoopItemExecutionView],
)
def stop_execution(
    project_id: int,
    execution_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Optional[LoopItemExecutionView]:
    """Stop a run from the automation page (project member action)."""

    require_cloud_project_role(db, project_id, current_user.id, BaseRole.Developer)
    _require_project_execution(
        db,
        project_id=project_id,
        execution_id=execution_id,
    )
    row = loop_item_execution_service.cancel(
        db,
        execution_id=execution_id,
        note="Stopped from the automation queue",
    )
    if (
        row is not None
        and row.status == "cancel_requested"
        and row.runtime_device_id
        and row.runtime_task_id
    ):
        from app.tasks.robot_queue_tasks import emit_runtime_cancels

        background_tasks.add_task(emit_runtime_cancels, [row])
    return _execution_view(db, row) if row else None
