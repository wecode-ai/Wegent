# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
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
from app.schemas.turn_file_changes import (
    TurnFileChangesDiffResponse,
    TurnFileChangesRevertResponse,
)
from app.services.chat.storage import session_manager
from app.services.chat.storage.db import run_sync_in_executor
from app.services.execution.web_stream_client import web_stream_worker_client
from app.services.execution.web_stream_protocol import SUBTASK_SUBSCRIPTION_STREAM
from app.services.subtask import subtask_service
from app.services.turn_file_changes import turn_file_changes_service
from app.stores.tasks import subtask_store, task_access_store

router = APIRouter()


@dataclass(frozen=True)
class _SubtaskUser:
    id: int


def _get_subtask_user(
    current_user: User = Depends(security.get_current_user),
) -> _SubtaskUser:
    return _SubtaskUser(id=current_user.id)


def _is_task_member_sync(task_id: int, user_id: int) -> bool:
    from app.db.session import SessionLocal
    from app.services.task_member_service import task_member_service

    with SessionLocal() as db:
        return task_member_service.is_member(db, task_id, user_id)


def _poll_new_messages_sync(
    task_id: int,
    user_id: int,
    last_subtask_id: int | None,
    since: str | None,
) -> list[dict[str, Any]]:
    from app.db.session import SessionLocal

    with SessionLocal() as db:
        return subtask_service.get_new_messages_since(
            db=db,
            task_id=task_id,
            user_id=user_id,
            last_subtask_id=last_subtask_id,
            since=since,
        )


def _can_subscribe_stream_sync(
    task_id: int,
    subtask_id: int,
    user_id: int,
) -> bool:
    from app.db.session import SessionLocal

    with SessionLocal() as db:
        if not task_access_store.is_member(
            db,
            task_id=task_id,
            user_id=user_id,
        ):
            return False
        subtask = subtask_store.get_accessible_by_id(
            db,
            subtask_id=subtask_id,
            user_id=user_id,
            access_store=task_access_store,
        )
        return subtask is not None and subtask.task_id == task_id


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

    total = subtask_store.count_by_task_for_user(
        db,
        task_id=task_id,
        user_id=current_user.id,
        access_store=task_access_store,
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


@router.get(
    "/{subtask_id}/file-changes/diff",
    response_model=TurnFileChangesDiffResponse,
)
async def get_turn_file_changes_diff(
    subtask_id: int,
    current_user: _SubtaskUser = Depends(_get_subtask_user),
) -> TurnFileChangesDiffResponse:
    """Load one assistant turn's validated diff from its execution device."""
    return await turn_file_changes_service.get_diff(
        user_id=current_user.id,
        subtask_id=subtask_id,
    )


@router.post(
    "/{subtask_id}/file-changes/revert",
    response_model=TurnFileChangesRevertResponse,
)
async def revert_turn_file_changes(
    subtask_id: int,
    current_user: _SubtaskUser = Depends(_get_subtask_user),
) -> TurnFileChangesRevertResponse:
    """Reverse one assistant turn without overwriting later workspace changes."""
    return await turn_file_changes_service.revert(
        user_id=current_user.id,
        subtask_id=subtask_id,
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
):
    """
    Poll for new messages in a group chat task.
    Returns new messages since the given subtask ID or timestamp.
    """
    user_id = current_user.id
    del current_user
    messages = await run_sync_in_executor(
        _poll_new_messages_sync,
        task_id,
        user_id,
        last_subtask_id,
        since,
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
):
    """
    Get current streaming status for a task.
    Returns information about any active stream.
    """
    user_id = current_user.id
    del current_user
    is_member = await run_sync_in_executor(
        _is_task_member_sync,
        task_id,
        user_id,
    )
    if not is_member:
        from fastapi import HTTPException

        raise HTTPException(status_code=403, detail="Not authorized")

    # Get streaming status from Redis
    streaming_status = await session_manager.get_task_streaming_status(task_id)

    if not streaming_status:
        return StreamingStatus(is_streaming=False)

    subtask_id = streaming_status.get("subtask_id")

    return StreamingStatus(
        is_streaming=True,
        subtask_id=subtask_id,
        started_by_user_id=streaming_status.get("user_id"),
        started_by_username=streaming_status.get("username"),
        started_at=(
            datetime.fromisoformat(streaming_status.get("started_at"))
            if streaming_status.get("started_at")
            else None
        ),
        last_activity_at=(
            datetime.fromisoformat(streaming_status.get("last_activity_at"))
            if streaming_status.get("last_activity_at")
            else None
        ),
    )


@router.get("/tasks/{task_id}/stream/subscribe")
async def subscribe_group_stream(
    task_id: int,
    subtask_id: int = Query(..., description="Subtask ID to subscribe to"),
    offset: Optional[int] = Query(0, description="Character offset for resuming"),
    current_user: User = Depends(security.get_current_user),
):
    """
    Subscribe to a group chat stream via SSE.
    Allows group members to receive streaming updates from any member's AI interaction.
    """
    user_id = current_user.id
    del current_user
    authorized = await run_sync_in_executor(
        _can_subscribe_stream_sync,
        task_id,
        subtask_id,
        user_id,
    )
    if not authorized:
        raise HTTPException(status_code=403, detail="Not authorized")

    return StreamingResponse(
        web_stream_worker_client.stream(
            SUBTASK_SUBSCRIPTION_STREAM,
            {"subtask_id": subtask_id, "offset": offset or 0},
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
