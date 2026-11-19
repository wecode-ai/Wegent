"""Deliver a second public Issue reply to an already running collaboration session."""

from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.project_chat_message import ProjectChatMessage
from app.services.device.runtime_rpc_service import RuntimeRpcError, runtime_rpc_service


async def guide_collaboration_comment(
    db: Session,
    *,
    trigger: ProjectChatMessage,
    runtime_task_id: str,
    runtime_device_id: str,
    owner_user_id: int,
    attachments: list[dict[str, Any]],
) -> dict[str, Any] | None:
    if not runtime_task_id or not runtime_device_id:
        return None
    active = (
        db.query(ProjectChatMessage.id)
        .filter_by(
            project_id=trigger.project_id,
            task_id=trigger.task_id,
            runtime_task_id=runtime_task_id,
            sender_type="agent",
            status="streaming",
        )
        .first()
    )
    if active is None:
        return None
    try:
        result = await runtime_rpc_service.call(
            user_id=owner_user_id,
            device_id=runtime_device_id,
            method="runtime.tasks.guidance",
            payload={
                "taskId": runtime_task_id,
                "clientGuidanceId": trigger.message_id,
                "issueCommentId": trigger.message_id,
                "message": (
                    f"New comment on this Issue (comment ID {trigger.message_id}). "
                    "Keep its reply separate from other comments and use "
                    "add_board_item_comment with this reply_to_comment_id.\n\n"
                    f"{trigger.content}"
                ),
                "attachments": attachments,
            },
            timeout_seconds=15,
            allow_app_device_task_messaging=True,
        )
    except RuntimeRpcError as error:
        raise HTTPException(
            502, "Delivery of the Issue reply could not be confirmed"
        ) from error
    if result.get("accepted") is True:
        return result
    if result.get("code") in {
        "no_active_turn",
        "conversation_context_mismatch",
        "user_input_pending",
    }:
        return None
    raise HTTPException(
        502, str(result.get("error") or "Runtime rejected the Issue reply")
    )
