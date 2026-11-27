"""Project-scoped dispatch authority for a single Issue assignment."""

import hashlib
import json

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.subtask import SubtaskRole, SubtaskStatus
from app.services.collaboration_permissions import collaboration_permission_service


def current_dispatch_id(item: LoopItem) -> str | None:
    metadata = item.metadata_json or {}
    group_id = (metadata.get("collaboration_group") or {}).get("id")
    key = metadata.get("collaboration_group_assignment_key")
    return f"collaboration-group:{group_id}:{key}" if group_id and key else None


def require_machine_task_scope(
    task_id: int | None, dispatch, device_manager_execution_id: int | None = None
) -> None:
    if (
        task_id == 0
        and dispatch.execution_environment != "wegent"
        and device_manager_execution_id is not None
        and device_manager_execution_id == dispatch.id
    ):
        return
    if task_id is None or task_id != dispatch.optional_backend_task_id:
        raise HTTPException(403, "Task does not own this collaboration manager turn")


def managed_turn_scope(
    db: Session,
    dispatch: LoopItemExecution,
    task_id: int | None,
    subtask_id: int | None,
) -> tuple[bool, str]:
    """Read the exact manager assistant while the Issue and dispatch are locked."""
    from app.stores.tasks import subtask_store, task_store

    require_machine_task_scope(task_id, dispatch)
    owner = dispatch.executor_owner_user_id
    task = task_store.get_by_id_for_update(db, task_id=task_id, owner_user_id=owner)
    assistant = (
        subtask_store.get_by_id_and_role(
            db, subtask_id=subtask_id, role=SubtaskRole.ASSISTANT, owner_user_id=owner
        )
        if subtask_id is not None
        else None
    )
    labels = (
        ((task.json or {}).get("metadata") or {}).get("labels") or {} if task else {}
    )
    if (
        assistant is None
        or assistant.task_id != task_id
        or str(labels.get("projectRobotExecutionId")) != str(dispatch.id)
    ):
        raise HTTPException(403, "Assistant does not belong to this manager Task")
    first = str(labels.get("projectAutomationSubtaskId") or "")
    current = str(labels.get("projectAutomationManagerSubtaskId") or first)
    return (
        current == str(subtask_id)
        and assistant.status in {SubtaskStatus.PENDING, SubtaskStatus.RUNNING}
        and dispatch.status in {"claimed", "running"},
        first,
    )


def require_manager_turn(
    current: bool, subtask_id: int | None, receipt: dict | None = None
) -> None:
    """A closed assistant can only read its own existing receipt."""
    if not current and (
        not receipt or receipt.get("manager_runtime_task_id") != str(subtask_id)
    ):
        raise HTTPException(403, "Assistant does not own the current manager turn")


def coordination_activity(
    db: Session, item: LoopItem, dispatch_id: str, group: dict | None = None
) -> ProjectChatMessage | None:
    identity = json.dumps(
        [str(item.cloud_project_id), item.id, dispatch_id], separators=(",", ":")
    )
    message_id = hashlib.sha256(b"issue_coordination\0" + identity.encode()).hexdigest()
    activity = (
        db.query(ProjectChatMessage).filter_by(message_id=message_id).one_or_none()
    )
    if activity is None and group is not None:
        # Coordination metadata is outside the public project timeline. The stable
        # key includes the project, Issue and assignment; all writers lock the Issue.
        activity = ProjectChatMessage(
            message_id=message_id,
            message_type="coordination",
            status="active",
            metadata_json={
                "group": jsonable_encoder(group),
                "round": 1,
                "protocol": 2,
                "issue_id": item.id,
                "project_id": str(item.cloud_project_id),
                "assignment_key": item.metadata_json[
                    "collaboration_group_assignment_key"
                ],
            },
        )
        db.add(activity)
        db.flush()
    return activity


def human_authority(
    db: Session, item: LoopItem, user_id: int, dispatch_id: str
) -> tuple[ProjectChatMessage, dict]:
    if current_dispatch_id(item) != dispatch_id:
        raise HTTPException(409, "Issue assignment has changed")
    group_id = str(item.metadata_json["collaboration_group"]["id"])
    current = collaboration_permission_service.require_project_group(
        db, item.cloud_project_id, group_id
    )
    live = (current.json or {}).get("spec") or {}
    root = coordination_activity(db, item, dispatch_id, {**live, "id": group_id})
    group = root.metadata_json["group"]
    for snapshot in (live, group):
        leader = snapshot.get("leader") or {}
        if leader.get("kind") != "human" or str(leader.get("id")) != str(user_id):
            raise HTTPException(
                403, "Only the assigned human leader can coordinate this Issue"
            )
    from app.services.loop_items.access import can_view_item, require_item_access

    access = require_item_access(db, item, user_id)
    if not can_view_item(db, access, item, user_id):
        raise HTTPException(404, "Issue not found")
    return root, group


def coordination_view(
    db: Session, item: LoopItem, user_id: int, can_execute: bool
) -> dict | None:
    dispatch_id = current_dispatch_id(item)
    if dispatch_id is None:
        return None
    root = coordination_activity(db, item, dispatch_id)
    if root is None:
        return None
    group = root.metadata_json["group"]
    leader = group["leader"]
    assignments = []
    waiting = False
    last_batch = root.metadata_json.get("last_batch")
    if last_batch:
        from app.services.collaboration_manager_activity import (
            assignment_state,
            terminal_assignment,
        )

        activity = db.query(ProjectChatMessage).filter_by(message_id=last_batch).one()
        for entry in activity.metadata_json["dispatch_assignments"]:
            state = assignment_state(db, item.cloud_project_id, item.id, entry)
            assignments.append(
                {
                    "assignmentId": entry["assignment_id"],
                    "assigneeType": entry["assignee_type"],
                    "assigneeId": str(
                        entry.get("assignee_id") or entry.get("human_user_id") or ""
                    ),
                    **(
                        {"executionId": entry["execution_id"]}
                        if entry.get("execution_id")
                        else {}
                    ),
                    **(
                        {"humanAssignmentId": entry["human_assignment_id"]}
                        if entry.get("human_assignment_id")
                        else {}
                    ),
                    "status": state,
                }
            )
            waiting |= not terminal_assignment(state)
    return {
        "waitingForMembers": waiting,
        "assignments": assignments,
        "dispatchId": dispatch_id,
        "roundId": str(root.metadata_json["round"]),
        "leader": leader,
        "members": group.get("members", []),
        "stages": group.get("stages", []),
        "canCoordinate": can_execute
        and not waiting
        and root.status == "active"
        and leader.get("kind") == "human"
        and str(leader.get("id")) == str(user_id),
    }


def require_open_round(
    db: Session, root: ProjectChatMessage, item: LoopItem, round_id: str | None
) -> None:
    if root.status != "active" or str(root.metadata_json["round"]) != round_id:
        raise HTTPException(409, "Collaboration round is no longer open")
    require_finished_batch(db, root, item)


def require_finished_batch(
    db: Session,
    root: ProjectChatMessage,
    item: LoopItem,
    device_turn: str | None = None,
) -> None:
    last_batch = root.metadata_json.get("last_batch")
    if last_batch:
        from app.services.collaboration_manager_activity import _round_finished

        activity = db.query(ProjectChatMessage).filter_by(message_id=last_batch).one()
        if device_turn:
            # The Executor resumes the same session with a turn keyed by the finished round.
            metadata = activity.metadata_json
            identity = json.dumps(
                [metadata["dispatch_id"], metadata["coordination_round_id"]],
                ensure_ascii=False,
                separators=(",", ":"),
            )
            if hashlib.sha256(identity.encode()).hexdigest() != device_turn:
                raise HTTPException(
                    409, "Manager turn does not follow the current round"
                )
        if not _round_finished(
            db,
            item.cloud_project_id,
            item.id,
            activity.metadata_json["dispatch_assignments"],
        ):
            raise HTTPException(409, "Assigned work is still pending")
