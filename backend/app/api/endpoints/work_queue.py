# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Work Queue API endpoints."""

import logging
from functools import partial
from typing import BinaryIO, List, Optional, Sequence

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Path,
    Query,
    UploadFile,
    status,
)
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.bounded_executor import BoundedExecutor
from app.core.exceptions import ConflictException, ForbiddenException, NotFoundException
from app.db import session as db_session
from app.models.user import User
from app.schemas.work_queue import (
    BatchMessageIds,
    BatchOperationResult,
    BatchStatusUpdate,
    ExternalSender,
    ForwardMessageRequest,
    ForwardMessageResponse,
    IngestMessageRequest,
    IngestSource,
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
from app.services.attachment.parser import DocumentParser
from app.services.context import context_service
from app.services.message_forwarding_service import message_forwarding_service
from app.services.work_queue_service import (
    contact_service,
    queue_message_service,
    work_queue_service,
)

logger = logging.getLogger(__name__)

# get_current_user_flexible_for_executor supports both JWT and API Key (wg- prefix)
_ingest_auth = security.get_current_user_flexible_for_executor

router = APIRouter()

WORK_QUEUE_UPLOAD_CHUNK_SIZE = 1024 * 1024
WORK_QUEUE_UPLOAD_MAX_FILES = 20
WORK_QUEUE_UPLOAD_FILENAME_MAX_LENGTH = 255
_WORK_QUEUE_UPLOAD_EXECUTOR = BoundedExecutor(
    max_workers=2,
    max_in_flight=2,
    max_waiters=4,
    thread_name_prefix="wegent-work-queue-upload",
)


# ==================== Work Queue Management ====================


@router.post("", response_model=WorkQueueResponse, status_code=status.HTTP_201_CREATED)
def create_work_queue(
    data: WorkQueueCreate,
    current_user: User = Depends(security.get_current_user),
):
    """Create a new work queue."""
    try:
        return work_queue_service.create_queue(current_user.id, data)
    except ConflictException as e:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e))


@router.get("", response_model=WorkQueueListResponse)
def list_work_queues(
    current_user: User = Depends(_ingest_auth),
):
    """List all work queues for the current user."""
    queues = work_queue_service.list_queues(current_user.id)
    return WorkQueueListResponse(items=queues, total=len(queues))


@router.get("/messages/unread-count", response_model=UnreadCountResponse)
def get_unread_message_count(
    current_user: User = Depends(security.get_current_user),
):
    """Get unread message count across all queues."""
    total, by_queue = queue_message_service.get_unread_counts(current_user.id)
    return UnreadCountResponse(total=total, byQueue=by_queue)


@router.get("/{queue_id}", response_model=WorkQueueResponse)
def get_work_queue(
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
def update_work_queue(
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
def delete_work_queue(
    queue_id: int,
    current_user: User = Depends(security.get_current_user),
):
    """Delete a work queue."""
    try:
        work_queue_service.delete_queue(current_user.id, queue_id)
    except NotFoundException as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


@router.post("/{queue_id}/set-default", response_model=WorkQueueResponse)
def set_default_queue(
    queue_id: int,
    current_user: User = Depends(security.get_current_user),
):
    """Set a queue as the default queue."""
    try:
        return work_queue_service.set_default_queue(current_user.id, queue_id)
    except NotFoundException as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


@router.post("/{queue_id}/regenerate-invite", response_model=WorkQueueResponse)
def regenerate_invite_code(
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
def list_queue_messages(
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


def _read_work_queue_uploads_limited(
    uploads: Sequence[tuple[str, BinaryIO]],
) -> list[tuple[str, bytes]]:
    """Read multipart files with per-request and per-file hard limits."""
    if len(uploads) > WORK_QUEUE_UPLOAD_MAX_FILES:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"At most {WORK_QUEUE_UPLOAD_MAX_FILES} files may be uploaded",
        )

    max_bytes = DocumentParser.get_max_file_size()
    total_bytes = 0
    buffered_uploads: list[tuple[str, bytes]] = []

    for filename, file_object in uploads:
        binary_data = bytearray()
        file_object.seek(0)
        while True:
            file_remaining = max_bytes - len(binary_data)
            total_remaining = max_bytes - total_bytes
            read_size = min(
                WORK_QUEUE_UPLOAD_CHUNK_SIZE,
                file_remaining + 1,
                total_remaining + 1,
            )
            chunk = file_object.read(read_size)
            if not chunk:
                break
            if len(chunk) > file_remaining:
                raise HTTPException(
                    status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                    detail=f"File '{filename}' exceeds the upload size limit",
                )
            if len(chunk) > total_remaining:
                raise HTTPException(
                    status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                    detail="Combined attachment size exceeds the upload size limit",
                )
            binary_data.extend(chunk)
            total_bytes += len(chunk)

        if binary_data:
            buffered_uploads.append((filename, bytes(binary_data)))

    return buffered_uploads


def _work_queue_upload_sources(
    files: Sequence[UploadFile],
) -> tuple[tuple[str, BinaryIO], ...]:
    """Validate cheap multipart metadata before bounded worker admission."""
    if len(files) > WORK_QUEUE_UPLOAD_MAX_FILES:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"At most {WORK_QUEUE_UPLOAD_MAX_FILES} files may be uploaded",
        )

    uploads: list[tuple[str, BinaryIO]] = []
    for upload in files:
        filename = upload.filename or ""
        if not filename:
            raise HTTPException(
                status_code=400, detail="Uploaded file name is required"
            )
        if len(filename) > WORK_QUEUE_UPLOAD_FILENAME_MAX_LENGTH:
            raise HTTPException(
                status_code=400, detail="Uploaded file name is too long"
            )
        uploads.append((filename, upload.file))
    return tuple(uploads)


def _build_ingest_request(
    content: Optional[str],
    title: Optional[str],
    note: Optional[str],
    priority: str,
    sender_external_id: Optional[str],
    sender_display_name: Optional[str],
    source_type: Optional[str],
    source_name: Optional[str],
    attachment_context_ids: list[int],
) -> IngestMessageRequest:
    sender = None
    if sender_external_id or sender_display_name:
        sender = ExternalSender(
            externalId=sender_external_id,
            displayName=sender_display_name,
        )

    source = None
    if source_type or source_name:
        source = IngestSource(
            type=source_type or "api",
            name=source_name,
        )

    try:
        priority_enum = QueueMessagePriority(priority)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Priority must be one of: low, normal, high",
        ) from exc

    return IngestMessageRequest(
        content=content or None,
        title=title,
        note=note,
        sender=sender,
        source=source,
        priority=priority_enum,
        attachmentContextIds=attachment_context_ids if attachment_context_ids else None,
    )


def _ingest_message_with_files_sync(
    uploads: Sequence[tuple[str, BinaryIO]],
    *,
    user_id: int,
    queue_name: str,
    content: Optional[str],
    title: Optional[str],
    note: Optional[str],
    priority: str,
    sender_external_id: Optional[str],
    sender_display_name: Optional[str],
    source_type: Optional[str],
    source_name: Optional[str],
) -> QueueMessageResponse:
    """Read, parse, persist, and ingest one bounded multipart request."""
    buffered_uploads = _read_work_queue_uploads_limited(uploads)
    if not content and not buffered_uploads:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Either message content or a non-empty attachment is required",
        )
    try:
        QueueMessagePriority(priority)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Priority must be one of: low, normal, high",
        ) from exc

    attachment_context_ids: list[int] = []

    try:
        if buffered_uploads:
            with db_session.SessionLocal() as db:
                for filename, binary_data in buffered_uploads:
                    context, _ = context_service.upload_attachment(
                        db=db,
                        user_id=user_id,
                        filename=filename,
                        binary_data=binary_data,
                        subtask_id=0,
                    )
                    attachment_context_ids.append(context.id)
                    logger.info(
                        "[ingest] Uploaded file as attachment context %s",
                        context.id,
                    )
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("[ingest] Failed to process uploaded file", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Failed to process uploaded file",
        ) from exc

    request = _build_ingest_request(
        content=content,
        title=title,
        note=note,
        priority=priority,
        sender_external_id=sender_external_id,
        sender_display_name=sender_display_name,
        source_type=source_type,
        source_name=source_name,
        attachment_context_ids=attachment_context_ids,
    )
    return queue_message_service.ingest_message_by_name(
        user_id=user_id,
        queue_name=queue_name,
        request=request,
    )


@router.post(
    "/by-name/{queue_name}/messages/ingest",
    response_model=QueueMessageResponse,
    status_code=status.HTTP_201_CREATED,
)
async def ingest_message_by_name(
    queue_name: str = Path(..., min_length=1, max_length=100),
    current_user: User = Depends(_ingest_auth),
    # Text fields via Form (multipart/form-data)
    content: Optional[str] = Form(
        None, max_length=50000, description="Message text content"
    ),
    title: Optional[str] = Form(None, max_length=200, description="Optional title"),
    note: Optional[str] = Form(None, max_length=1000, description="Optional note"),
    priority: str = Form(
        "normal",
        pattern="^(low|normal|high)$",
        description="Priority: low, normal, high",
    ),
    sender_external_id: Optional[str] = Form(
        None, max_length=255, alias="senderExternalId"
    ),
    sender_display_name: Optional[str] = Form(
        None, max_length=255, alias="senderDisplayName"
    ),
    source_type: Optional[str] = Form(None, max_length=100, alias="sourceType"),
    source_name: Optional[str] = Form(None, max_length=255, alias="sourceName"),
    # File uploads (optional)
    files: List[UploadFile] = File(default=[], description="Files to attach"),
):
    """Ingest a message into a work queue identified by name.

    Convenience endpoint that resolves the queue by name instead of ID.
    Useful for scripting and external integrations where the queue name
    (e.g. "inbox") is known but the numeric ID is not.

    Accepts multipart/form-data with optional file attachments.
    Files are pre-stored as attachments so the LLM can reference them
    by ID without re-outputting content through the model output window.

    Example (text only):
        curl -X POST .../by-name/inbox/messages/ingest -F "content=Hello world"

    Example (with files):
        curl -X POST .../by-name/inbox/messages/ingest \\
            -F "content=See attached" -F "files=@doc.pdf" -F "files=@notes.md"
    """
    uploads = _work_queue_upload_sources(files)
    del files
    user_id = int(current_user.id)
    del current_user

    try:
        return await _WORK_QUEUE_UPLOAD_EXECUTOR.run(
            partial(
                _ingest_message_with_files_sync,
                uploads,
                user_id=user_id,
                queue_name=queue_name,
                content=content,
                title=title,
                note=note,
                priority=priority,
                sender_external_id=sender_external_id,
                sender_display_name=sender_display_name,
                source_type=source_type,
                source_name=source_name,
            )
        )
    except NotFoundException as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
    except ConflictException as e:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e))


# ==================== Message Operations ====================

messages_router = APIRouter()


@messages_router.get("/{message_id}", response_model=QueueMessageResponse)
def get_queue_message(
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
def update_message_status(
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
def update_message_priority(
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
def delete_queue_message(
    message_id: int,
    current_user: User = Depends(security.get_current_user),
):
    """Delete (archive) a queue message."""
    try:
        queue_message_service.delete_message(current_user.id, message_id)
    except NotFoundException as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


@messages_router.post("/{message_id}/retry", response_model=QueueMessageResponse)
def retry_message(
    message_id: int,
    current_user: User = Depends(security.get_current_user),
):
    """Retry processing a failed inbox message.

    Only messages with status 'failed' can be retried.
    Resets the message to 'unread' and re-triggers auto-processing.
    """
    try:
        return queue_message_service.retry_message(
            user_id=current_user.id,
            message_id=message_id,
        )
    except NotFoundException as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
    except ForbiddenException as e:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e))
    except ConflictException as e:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e))


@messages_router.post("/{message_id}/process", response_model=QueueMessageResponse)
async def process_message(
    message_id: int,
    current_user: User = Depends(security.get_current_user),
):
    """Manually trigger processing of an inbox message.

    Dispatches the message through the configured auto-process pipeline
    (subscription mode or direct_agent mode) regardless of the queue's
    triggerMode setting.  Messages that are already processing or processed
    are rejected with 409.
    """
    try:
        return await queue_message_service.process_message(
            user_id=current_user.id,
            message_id=message_id,
        )
    except NotFoundException as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
    except ForbiddenException as e:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e))
    except ConflictException as e:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e))


# ==================== Batch Operations ====================


@messages_router.post("/batch/status", response_model=BatchOperationResult)
def batch_update_message_status(
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
def batch_delete_messages(
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
def forward_messages(
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
def get_user_public_queues(
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
def get_recent_contacts(
    limit: int = Query(20, ge=1, le=100),
    current_user: User = Depends(security.get_current_user),
):
    """Get recent contacts for the current user."""
    contacts = contact_service.get_recent_contacts(current_user.id, limit)
    return RecentContactsListResponse(
        items=contacts,
        total=len(contacts),
    )
