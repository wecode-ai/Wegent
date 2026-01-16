# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse

from app.api.dependencies import get_db
from app.core import security
from app.models.subtask import Subtask
from app.models.user import User
from app.schemas.subtask import (
    MessageEditRequest,
    MessageEditResponse,
    PollMessagesResponse,
    StreamingStatus,
    SubtaskInDB,
    SubtaskListResponse,
    SubtaskUpdate,
)
from app.services.chat.storage import session_manager
from app.services.subtask import subtask_service

router = APIRouter()


@router.get("", response_model=SubtaskListResponse)
def list_subtasks(
    task_id: int = Query(..., description="Task ID"),
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(10, ge=1, le=100, description="Items per page"),
    from_latest: bool = Query(
        True, description="If True, return latest N messages (default for group chat)"
    ),
    before_message_id: Optional[int] = Query(
        None, description="Return messages before this message_id (for loading older)"
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Get subtasks for a specific task (paginated)

    By default (from_latest=True), returns the latest N messages.
    Use before_message_id to load older messages when scrolling up.
    """
    import logging

    from app.services.task_member_service import task_member_service

    logger = logging.getLogger(__name__)

    skip = (page - 1) * limit
    items = subtask_service.get_by_task(
        db=db,
        task_id=task_id,
        user_id=current_user.id,
        skip=skip,
        limit=limit,
        from_latest=from_latest,
        before_message_id=before_message_id,
    )

    # DEBUG: Log contexts for table types
    for item in items:
        if hasattr(item, "contexts") and item.contexts:
            for ctx in item.contexts:
                if ctx.context_type == "table":
                    logger.info(
                        f"[list_subtasks] Table context in response: subtask_id={item.id}, "
                        f"ctx_id={ctx.id}, name={ctx.name}, source_config={ctx.source_config}"
                    )

    # Calculate total based on whether user is a group chat member
    is_member = task_member_service.is_member(db, task_id, current_user.id)
    if is_member:
        # For group chat members, count all subtasks in the task
        total = db.query(Subtask).filter(Subtask.task_id == task_id).count()
    else:
        # For non-members, count only user's own subtasks
        total = (
            db.query(Subtask)
            .filter(Subtask.task_id == task_id, Subtask.user_id == current_user.id)
            .count()
        )

    return {"total": total, "items": items}


@router.get("/{subtask_id}", response_model=SubtaskInDB)
def get_subtask(
    subtask_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get specified subtask details"""
    return subtask_service.get_subtask_by_id(
        db=db, subtask_id=subtask_id, user_id=current_user.id
    )


@router.put("/{subtask_id}", response_model=SubtaskInDB)
def update_subtask(
    subtask_id: int,
    subtask_update: SubtaskUpdate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Update subtask information"""
    return subtask_service.update_subtask(
        db=db, subtask_id=subtask_id, obj_in=subtask_update, user_id=current_user.id
    )


@router.delete("/{subtask_id}")
def delete_subtask(
    subtask_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Delete subtask"""
    subtask_service.delete_subtask(
        db=db, subtask_id=subtask_id, user_id=current_user.id
    )
    return {"message": "Subtask deleted successfully"}


@router.post("/{subtask_id}/edit", response_model=MessageEditResponse)
def edit_user_message(
    subtask_id: int,
    request: MessageEditRequest,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Edit a user message by deleting it and all subsequent messages.

    This implements ChatGPT-style message editing. The edited message and all
    messages after it are deleted. The frontend should then send a new message
    with the edited content to trigger a fresh AI response.

    Constraints:
    - Only USER role messages can be edited
    - Not available in group chat
    - Cannot edit while AI is generating a response
    """
    returned_subtask_id, message_id, deleted_count = subtask_service.edit_user_message(
        db=db,
        subtask_id=subtask_id,
        new_content=request.new_content,
        user_id=current_user.id,
    )

    return MessageEditResponse(
        success=True,
        subtask_id=returned_subtask_id,
        message_id=message_id,
        deleted_count=deleted_count,
        new_content=request.new_content,
    )


@router.get("/tasks/{task_id}/messages/poll", response_model=PollMessagesResponse)
async def poll_new_messages(
    task_id: int,
    last_subtask_id: Optional[int] = Query(
        None, description="Last subtask ID received"
    ),
    since: Optional[str] = Query(None, description="ISO timestamp to filter messages"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Poll for new messages in a group chat task.
    Returns new messages since the given subtask ID or timestamp.
    """
    # Get new messages
    messages = subtask_service.get_new_messages_since(
        db=db,
        task_id=task_id,
        user_id=current_user.id,
        last_subtask_id=last_subtask_id,
        since=since,
    )

    # Check if there's an active stream
    streaming_status = await session_manager.get_task_streaming_status(task_id)
    has_streaming = streaming_status is not None
    streaming_subtask_id = (
        streaming_status.get("subtask_id") if streaming_status else None
    )

    return PollMessagesResponse(
        messages=messages,
        has_streaming=has_streaming,
        streaming_subtask_id=streaming_subtask_id,
    )


@router.get("/tasks/{task_id}/streaming-status", response_model=StreamingStatus)
async def get_streaming_status(
    task_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get current streaming status for a task.
    Returns information about any active stream.
    """
    from app.services.task_member_service import task_member_service

    # Check if user is authorized to access this task
    is_member = task_member_service.is_member(db, task_id, current_user.id)
    if not is_member:
        from fastapi import HTTPException

        raise HTTPException(status_code=403, detail="Not authorized")

    # Get streaming status from Redis
    streaming_status = await session_manager.get_task_streaming_status(task_id)

    if not streaming_status:
        return StreamingStatus(is_streaming=False)

    # Get current streaming content
    subtask_id = streaming_status.get("subtask_id")
    current_content = None
    if subtask_id:
        current_content = await session_manager.get_streaming_content(subtask_id)

    return StreamingStatus(
        is_streaming=True,
        subtask_id=subtask_id,
        started_by_user_id=streaming_status.get("user_id"),
        started_by_username=streaming_status.get("username"),
        current_content=current_content,
        started_at=(
            datetime.fromisoformat(streaming_status.get("started_at"))
            if streaming_status.get("started_at")
            else None
        ),
    )


@router.get("/tasks/{task_id}/stream/subscribe")
async def subscribe_group_stream(
    task_id: int,
    subtask_id: int = Query(..., description="Subtask ID to subscribe to"),
    offset: Optional[int] = Query(0, description="Character offset for resuming"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Subscribe to a group chat stream via SSE.
    Allows group members to receive streaming updates from any member's AI interaction.
    """
    from app.services.task_member_service import task_member_service

    # Check if user is authorized
    is_member = task_member_service.is_member(db, task_id, current_user.id)
    if not is_member:
        from fastapi import HTTPException

        raise HTTPException(status_code=403, detail="Not authorized")

    async def event_generator():
        """Generate SSE events for the subscribed stream."""
        # Get current cached content
        current_content = await session_manager.get_streaming_content(subtask_id)

        # If offset is provided and we have cached content, send the portion after offset
        if offset > 0 and current_content:
            remaining_content = current_content[offset:]
            if remaining_content:
                yield {
                    "event": "message",
                    "data": json.dumps(
                        {
                            "content": remaining_content,
                            "done": False,
                            "subtask_id": subtask_id,
                        }
                    ),
                }

        # Subscribe to Redis Pub/Sub for real-time updates
        redis_client, pubsub = await session_manager.subscribe_streaming_channel(
            subtask_id
        )

        if not redis_client or not pubsub:
            # Failed to subscribe, send error and close
            yield {
                "event": "error",
                "data": json.dumps({"error": "Failed to subscribe to stream"}),
            }
            return

        try:
            # Listen for messages from Redis Pub/Sub
            while True:
                message = await pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=30.0
                )

                if message and message["type"] == "message":
                    chunk_data = message["data"]

                    # Check if it's a done signal (JSON encoded)
                    if isinstance(chunk_data, bytes):
                        chunk_data = chunk_data.decode("utf-8")

                    try:
                        # Try to parse as JSON (done signal)
                        parsed = json.loads(chunk_data)
                        if parsed.get("__type__") == "STREAM_DONE":
                            # Send done event
                            yield {
                                "event": "message",
                                "data": json.dumps(
                                    {
                                        "content": "",
                                        "done": True,
                                        "result": parsed.get("result"),
                                        "subtask_id": subtask_id,
                                    }
                                ),
                            }
                            break
                    except json.JSONDecodeError:
                        # Regular text chunk
                        yield {
                            "event": "message",
                            "data": json.dumps(
                                {
                                    "content": chunk_data,
                                    "done": False,
                                    "subtask_id": subtask_id,
                                }
                            ),
                        }

        finally:
            # Clean up Redis connections
            await pubsub.unsubscribe()
            await redis_client.aclose()

    return EventSourceResponse(event_generator())
