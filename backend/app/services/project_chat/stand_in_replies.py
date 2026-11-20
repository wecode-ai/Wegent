"""Project public stand-in messages onto Issue comments without redispatching them."""

import hashlib
import uuid
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.base_role import BaseRole
from app.schemas.issue_activity_comment import StandInPublicReply
from app.schemas.project_chat import ProjectChatMessageView
from app.services.collaboration_human_assignments import human_task_bindings
from app.services.device.identity import resolve_owned_device_alias
from app.services.loop_item_status_history import (
    automatic_project_status,
    write_status_change,
)
from app.services.loop_items.task_bindings import active_task_binding_query
from app.services.project_chat.public_replies import (
    existing_public_reply,
    public_reply_key,
    public_reply_view,
    save_public_reply,
)
from app.services.project_chat.service import project_chat_service
from shared.telemetry.decorators import trace_sync


def stand_in_reply_recipient(db: Session, message_id: str) -> dict | None:
    row = (
        db.query(ProjectChatMessage)
        .filter_by(message_id=message_id, sender_type="agent")
        .first()
    )
    identity = (row.metadata_json or {}).get("stand_in") if row else None
    if not isinstance(identity, dict) or not isinstance(identity.get("user_id"), int):
        return None
    return {
        "user_id": identity["user_id"],
        "role_id": identity["role_id"],
        "name": row.sender_name,
    }


def _dispatch_endpoint_belongs_to(
    metadata: dict, *, user_id: int, role_id: str
) -> bool:
    endpoint = metadata.get("assistant_endpoint_ref")
    if not isinstance(endpoint, str):
        return False
    parts = endpoint.split(":")
    if len(parts) < 3 or parts[-1] != role_id:
        return False
    owner = metadata.get("assistant_owner_user_id")
    if owner is not None and owner != user_id:
        return False
    try:
        endpoint_owner = int(parts[1])
    except ValueError:
        return False
    return endpoint_owner == user_id


@trace_sync("stand_in.public_issue_reply", tracer_name="backend.project_chat")
def publish_stand_in_reply(
    db: Session,
    *,
    user_id: int,
    project_id: str,
    item_id: str,
    body: str,
    identity: StandInPublicReply,
) -> ProjectChatMessageView:
    project = project_chat_service._require_scope(
        db,
        user_id=user_id,
        project_id=project_id,
        task_id=item_id,
        required_role=BaseRole.Developer,
    )
    # Serialize with reassignment and other public replies on the owning Issue.
    if (
        resolve_owned_device_alias(db, user_id=user_id, device_id=identity.device_id)
        is None
    ):
        raise HTTPException(409, "The stand-in device is no longer active")
    item = (
        db.query(LoopItem)
        .filter_by(id=item_id)
        .populate_existing()
        .with_for_update()
        .one()
    )
    bindings = active_task_binding_query(
        db,
        user_id=user_id,
        project_id=project_id,
        item_id=item_id,
        device_id=identity.device_id,
        task_id=identity.task_id,
        lock=True,
    ).all()
    if not bindings:
        raise HTTPException(409, "The stand-in has no owned Issue session binding")
    sender = (
        f"stand-in:{user_id}:{hashlib.sha256(identity.role_id.encode()).hexdigest()}"
    )
    client = public_reply_key(
        project_id, item_id, identity.device_id, identity.task_id, identity.message_id
    )
    existing = existing_public_reply(db, sender_id=sender, key=client, body=body)
    if existing is not None:
        return public_reply_view(db, existing)
    message_id = str(uuid.uuid4())
    metadata = dict(item.metadata_json or {})
    policy = metadata.get("assistant_autonomy_policy")
    owner_matches = _dispatch_endpoint_belongs_to(
        metadata, user_id=user_id, role_id=identity.role_id
    )
    current_assignment = human_task_bindings(
        db, [item], user_id, projects=[project]
    ).get(item.id, {})
    assignment_id = current_assignment.get("humanAssignmentId")
    current_dispatch = bool(
        assignment_id
        and identity.human_assignment_id == assignment_id
        and any(
            (binding.metadata_json or {}).get("human_assignment_id") == assignment_id
            for binding in bindings
        )
    )
    completion_status = automatic_project_status(
        project, current_status=item.status, candidate_status="completed"
    )
    review_status = automatic_project_status(
        project, current_status=item.status, candidate_status="in_review"
    )
    auto_publish = (
        metadata.get("assistant_dispatch_role") == "member"
        and owner_matches
        and current_dispatch
        and metadata.get("awaiting_public_summary") is True
        and metadata.get("publish_policy") == "summary_only"
        and metadata.get("risk_level") == "low"
        and identity.publish_policy == "summary_only"
        and identity.status == "completed"
        and bool(body.strip())
        and isinstance(policy, dict)
        and policy.get("automatic") is True
        and policy.get("ask_before_act") is False
        and policy.get("risk_ceiling") == "low"
    )
    dispatch_review = (
        metadata.get("assistant_dispatch_role") == "member"
        and owner_matches
        and current_dispatch
        and metadata.get("awaiting_public_summary") is True
        and metadata.get("publish_policy") == "summary_only"
        and identity.status == "completed"
        and not auto_publish
        and review_status != item.status
    )
    message_metadata = {
        "execution_dispatch": "comment_only",
        "member_assistant_result": {
            "status": identity.status,
            "summary": body,
            "evidence_refs": identity.evidence_refs,
            "publish_policy": identity.publish_policy,
            "next_action": identity.next_action,
        },
        "stand_in": {
            "user_id": user_id,
            "role_id": identity.role_id,
            "message_id": identity.message_id,
            "human_assignment_id": identity.human_assignment_id,
            "binding_id": bindings[0].id,
            "device_id": bindings[0].device_id,
            "task_id": bindings[0].task_id,
        },
    }
    if auto_publish:
        message_metadata["assistant_publication"] = {
            "verified": True,
            "published_by": "ai",
            "policy": "automatic_low_risk",
        }
        metadata["awaiting_public_summary"] = False
        metadata["assistant_publication_message_id"] = message_id
        metadata["assistant_result_message_id"] = message_id
        if completion_status != item.status and item.status != "in_review":
            write_status_change(
                metadata,
                project=project,
                from_status=item.status,
                to_status=completion_status,
                trigger="assistant_publication",
                by_user_id=user_id,
                completion_owner_user_id=user_id,
            )
            item.status = completion_status
            item.completed_at = datetime.now(UTC).replace(tzinfo=None)
    elif dispatch_review:
        metadata["awaiting_public_summary"] = False
        metadata["assistant_result_message_id"] = message_id
        write_status_change(
            metadata,
            project=project,
            from_status=item.status,
            to_status=review_status,
            trigger="assistant_result",
            by_user_id=user_id,
        )
        item.status = review_status
    row = ProjectChatMessage(
        message_id=message_id,
        client_message_id=client,
        project_id=project_id,
        task_id=item_id,
        sender_type="agent",
        sender_id=sender,
        sender_name=identity.role_name,
        message_type="text",
        content=body,
        metadata_json=message_metadata,
        status="completed",
        thread_root_message_id=message_id,
    )
    return save_public_reply(db, item=item, row=row, item_metadata=metadata)
