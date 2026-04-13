# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Work Queue API endpoints."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.exceptions import ConflictException, ForbiddenException, NotFoundException
from app.models.user import User
from app.schemas.work_queue import (
    BatchMessageIds,
    BatchOperationResult,
    BatchStatusUpdate,
    ForwardMessageRequest,
    ForwardMessageResponse,
    PublicQueueResponse,
    QueueMessageListResponse,
    QueueMessagePriority,
    QueueMessagePriorityUpdate,
    QueueMessageResponse,
    QueueMessageStatus,
    QueueMessageStatusUpdate,
    RecentContactsListResponse,
    UnreadCountResponse,
    UserPublicQueuesResponse,
    WorkQueueCreate,
    WorkQueueListResponse,
    WorkQueueResponse,
    WorkQueueUpdate,
)
from app.services.message_forwarding_service import message_forwarding_service
from app.services.work_queue_service import (
    contact_service,
    queue_message_service,
    work_queue_service,
)

router = APIRouter()


# ==================== Work Queue Management ====================


@router.post("", response_model=WorkQueueResponse, status_code=status.HTTP_201_CREATED)
async def create_work_queue(
    data: WorkQueueCreate,
    current_user: User = Depends(security.get_current_user),
):
    """Create a new work queue."""
    try:
        return work_queue_service.create_queue(current_user.id, data)
    except ConflictException as e:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e))


@router.get("", response_model=WorkQueueListResponse)
async def list_work_queues(
    current_user: User = Depends(security.get_current_user),
):
    """List all work queues for the current user."""
    queues = work_queue_service.list_queues(current_user.id)
    return WorkQueueListResponse(items=queues, total=len(queues))


@router.get("/messages/unread-count", response_model=UnreadCountResponse)
async def get_unread_message_count(
    current_user: User = Depends(security.get_current_user),
):
    """Get unread message count across all queues."""
    total, by_queue = queue_message_service.get_unread_counts(current_user.id)
    return UnreadCountResponse(total=total, byQueue=by_queue)


@router.get("/{queue_id}", response_model=WorkQueueResponse)
async def get_work_queue(
    queue_id: int,
    current_user: User = Depends(security.get_current_user),
):
    """Get a specific work queue."""
    queue = work_queue_service.get_queue(current_user.id, queue_id)
    if not queue:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Work queue not found"
        )
    return queue


@router.put("/{queue_id}", response_model=WorkQueueResponse)
async def update_work_queue(
    queue_id: int,
    data: WorkQueueUpdate,
    current_user: User = Depends(security.get_current_user),
):
    """Update a work queue."""
    try:
        return work_queue_service.update_queue(current_user.id, queue_id, data)
    except NotFoundException as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


@router.delete("/{queue_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_work_queue(
    queue_id: int,
    current_user: User = Depends(security.get_current_user),
):
    """Delete a work queue."""
    try:
        work_queue_service.delete_queue(current_user.id, queue_id)
    except NotFoundException as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


@router.post("/{queue_id}/set-default", response_model=WorkQueueResponse)
async def set_default_queue(
    queue_id: int,
    current_user: User = Depends(security.get_current_user),
):
    """Set a queue as the default queue."""
    try:
        return work_queue_service.set_default_queue(current_user.id, queue_id)
    except NotFoundException as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


@router.post("/{queue_id}/regenerate-invite", response_model=WorkQueueResponse)
async def regenerate_invite_code(
    queue_id: int,
    current_user: User = Depends(security.get_current_user),
):
    """Regenerate the invite code for a queue."""
    try:
        return work_queue_service.regenerate_invite_code(current_user.id, queue_id)
    except NotFoundException as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
    except ConflictException as e:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e))


# ==================== Queue Messages ====================


@router.get("/{queue_id}/messages", response_model=QueueMessageListResponse)
async def list_queue_messages(
    queue_id: int,
    message_status: Optional[QueueMessageStatus] = Query(None, alias="status"),
    priority: Optional[QueueMessagePriority] = Query(None),
    sender_user_id: Optional[int] = Query(None),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    sort_by: str = Query("created_at"),
    sort_order: str = Query("desc"),
    current_user: User = Depends(security.get_current_user),
):
    """List messages in a queue with filtering and pagination."""
    # Verify queue ownership
    queue = work_queue_service.get_queue(current_user.id, queue_id)
    if not queue:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Work queue not found"
        )

    items, total, unread = queue_message_service.list_messages(
        user_id=current_user.id,
        queue_id=queue_id,
        status=message_status,
        priority=priority,
        sender_user_id=sender_user_id,
        skip=skip,
        limit=limit,
        sort_by=sort_by,
        sort_order=sort_order,
    )

    return QueueMessageListResponse(items=items, total=total, unreadCount=unread)


# ==================== Message Operations ====================

messages_router = APIRouter()


@messages_router.get("/{message_id}", response_model=QueueMessageResponse)
async def get_queue_message(
    message_id: int,
    current_user: User = Depends(security.get_current_user),
):
    """Get a specific queue message."""
    message = queue_message_service.get_message(current_user.id, message_id)
    if not message:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Queue message not found"
        )
    return message


@messages_router.patch("/{message_id}/status", response_model=QueueMessageResponse)
async def update_message_status(
    message_id: int,
    data: QueueMessageStatusUpdate,
    current_user: User = Depends(security.get_current_user),
):
    """Update message status."""
    try:
        return queue_message_service.update_status(
            current_user.id, message_id, data.status
        )
    except NotFoundException as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


@messages_router.patch("/{message_id}/priority", response_model=QueueMessageResponse)
async def update_message_priority(
    message_id: int,
    data: QueueMessagePriorityUpdate,
    current_user: User = Depends(security.get_current_user),
):
    """Update message priority."""
    try:
        return queue_message_service.update_priority(
            current_user.id, message_id, data.priority
        )
    except NotFoundException as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


@messages_router.delete("/{message_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_queue_message(
    message_id: int,
    current_user: User = Depends(security.get_current_user),
):
    """Delete (archive) a queue message."""
    try:
        queue_message_service.delete_message(current_user.id, message_id)
    except NotFoundException as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


# ==================== Batch Operations ====================


@messages_router.post("/batch/status", response_model=BatchOperationResult)
async def batch_update_message_status(
    data: BatchStatusUpdate,
    current_user: User = Depends(security.get_current_user),
):
    """Batch update message status."""
    success_count, failed_count, failed_ids = queue_message_service.batch_update_status(
        current_user.id, data.messageIds, data.status
    )
    return BatchOperationResult(
        successCount=success_count,
        failedCount=failed_count,
        failedIds=failed_ids,
    )


@messages_router.post("/batch/delete", response_model=BatchOperationResult)
async def batch_delete_messages(
    data: BatchMessageIds,
    current_user: User = Depends(security.get_current_user),
):
    """Batch delete (archive) messages."""
    success_count, failed_count, failed_ids = (
        queue_message_service.batch_delete_messages(current_user.id, data.messageIds)
    )
    return BatchOperationResult(
        successCount=success_count,
        failedCount=failed_count,
        failedIds=failed_ids,
    )


# ==================== Message Forwarding ====================

forward_router = APIRouter()


@forward_router.post("", response_model=ForwardMessageResponse)
async def forward_messages(
    data: ForwardMessageRequest,
    current_user: User = Depends(security.get_current_user),
):
    """Forward messages to one or more recipients."""
    try:
        return message_forwarding_service.forward_messages(current_user.id, data)
    except NotFoundException as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
    except ForbiddenException as e:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e))


# ==================== User Public Queues ====================

users_router = APIRouter()


@users_router.get("/{user_id}/public-queues", response_model=UserPublicQueuesResponse)
async def get_user_public_queues(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Get a user's public queues (for message forwarding)."""
    from app.models.user import User as UserModel

    # Get target user
    target_user = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not target_user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User not found"
        )

    queues = work_queue_service.get_user_public_queues(user_id)
    return UserPublicQueuesResponse(
        userId=user_id,
        userName=target_user.user_name,
        queues=[PublicQueueResponse(**q) for q in queues],
    )


@users_router.get("/recent-contacts", response_model=RecentContactsListResponse)
async def get_recent_contacts(
    limit: int = Query(20, ge=1, le=100),
    current_user: User = Depends(security.get_current_user),
):
    """Get recent contacts for the current user."""
    contacts = contact_service.get_recent_contacts(current_user.id, limit)
    return RecentContactsListResponse(
        items=contacts,
        total=len(contacts),
    )
