"""Serialize exact-question replies without granting access to the source device."""

from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import delete
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.wework_notification import WeworkNotification


def claim_reply(
    db: Session,
    *,
    project_id: str,
    issue_id: str,
    request_id: str,
    user_id: int,
    trigger: ProjectChatMessage,
) -> dict:
    """The Issue row serializes assignment and answer acceptance."""
    item = (
        db.query(LoopItem)
        .filter(LoopItem.id == issue_id, LoopItem.cloud_project_id == project_id)
        .populate_existing()
        .with_for_update()
        .one_or_none()
    )
    if item is None or item.status in {"completed", "cancelled", "archived"}:
        raise HTTPException(409, "Issue is unavailable or has ended")
    metadata = dict(item.metadata_json or {})
    requests = [dict(value) for value in metadata.get("human_requests", [])]
    target = next((value for value in requests if value.get("id") == request_id), None)
    if target is None:
        raise HTTPException(404, "Question not found")
    if target.get("recipient_user_id") != user_id:
        raise HTTPException(403, "Question is assigned to another person")
    if (trigger.thread_root_message_id or trigger.reply_to_message_id) != target.get(
        "root_comment_id"
    ):
        raise HTTPException(409, "Answer belongs to another Issue thread")
    if target.get("answer_message_id") not in {None, "", trigger.message_id}:
        raise HTTPException(409, "Question already has an answer")
    if target.get("status") not in {"pending", "answering", "resolved"}:
        raise HTTPException(409, "Question is no longer pending")
    if target.get("status") == "pending":
        target.pop("delivery_error", None)
        target.update(
            status="answering",
            answer_message_id=trigger.message_id,
            version=target.get("version", 1) + 1,
            updated_at=datetime.now(UTC).isoformat(),
        )
        target["events"] = [
            *target.get("events", []),
            {
                "type": "answered",
                "at": target["updated_at"],
                "user_id": user_id,
                "message_id": trigger.message_id,
            },
        ]
        item.metadata_json = {**metadata, "human_requests": requests}
        item.version += 1
        from app.services.project_chat.service import project_chat_service

        project_chat_service._queue_loop_item_change(db, item)
    return target


def settle_reply(
    db: Session, *, issue_id: str, request_id: str, message_id: str
) -> None:
    """Only delivery acceptance for the matching message completes a handoff."""
    db.flush()
    item = (
        db.query(LoopItem)
        .filter(LoopItem.id == issue_id)
        .populate_existing()
        .with_for_update()
        .one()
    )
    metadata = dict(item.metadata_json or {})
    requests = [dict(value) for value in metadata.get("human_requests", [])]
    target = next((value for value in requests if value.get("id") == request_id), None)
    if not target or target.get("answer_message_id") != message_id:
        raise HTTPException(409, "Question answer identity changed")
    if target.get("status") != "answering":
        return
    target.pop("delivery_error", None)
    target.update(
        status="resolved",
        version=target.get("version", 1) + 1,
        updated_at=datetime.now(UTC).isoformat(),
    )
    target["events"] = [
        *target.get("events", []),
        {"type": "accepted", "at": target["updated_at"], "message_id": message_id},
    ]
    item.metadata_json = {**metadata, "human_requests": requests}
    item.version += 1
    columns = LoopItem.__table__.c
    db.execute(
        delete(LoopItem.__table__).where(
            columns.resource_type == "human_request_index",
            columns.parent_id == issue_id,
            columns.name == request_id,
        )
    )
    db.query(WeworkNotification).filter(
        WeworkNotification.payload["humanRequestId"].as_string() == request_id,
        WeworkNotification.is_read.is_(False),
    ).update(
        {
            "is_read": True,
            "read_status_changed_at": datetime.now(UTC).replace(tzinfo=None),
        },
        synchronize_session=False,
    )
    from app.services.project_chat.service import project_chat_service

    project_chat_service._queue_loop_item_change(db, item)


def settle_execution_reply(db: Session, execution: LoopItemExecution) -> None:
    context = execution.runtime_origin_context
    request_id = context.get("human_request_id")
    message_id = context.get("comment_trigger_message_id")
    if request_id and message_id:
        settle_reply(
            db,
            issue_id=execution.loop_item_id,
            request_id=request_id,
            message_id=message_id,
        )


def record_delivery_failure(
    db: Session, *, issue_id: str, request_id: str, message_id: str, rejected: bool
) -> None:
    """Only a proven rejection permits another answer; uncertain delivery stays pending."""
    item = (
        db.query(LoopItem)
        .filter(LoopItem.id == issue_id)
        .populate_existing()
        .with_for_update()
        .one()
    )
    metadata = dict(item.metadata_json or {})
    requests = [dict(value) for value in metadata.get("human_requests", [])]
    target = next((value for value in requests if value.get("id") == request_id), None)
    if (
        not target
        or target.get("status") != "answering"
        or target.get("answer_message_id") != message_id
    ):
        return
    target["delivery_error"] = "rejected" if rejected else "uncertain"
    target["events"] = [
        *target.get("events", []),
        {
            "type": "delivery_rejected" if rejected else "delivery_uncertain",
            "at": datetime.now(UTC).isoformat(),
            "message_id": message_id,
        },
    ]
    if rejected:
        target.update(status="pending", answer_message_id=None)
    target.update(
        version=target.get("version", 1) + 1, updated_at=datetime.now(UTC).isoformat()
    )
    item.metadata_json = {**metadata, "human_requests": requests}
    item.version += 1
    from app.services.project_chat.service import project_chat_service

    project_chat_service._queue_loop_item_change(db, item)
