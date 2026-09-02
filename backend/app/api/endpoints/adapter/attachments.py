# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Attachment API endpoints for file upload and management.

Uses the unified context service for managing attachments as subtask contexts.
"""

import asyncio
import copy
import json
import logging
import threading
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from functools import partial
from typing import Any, BinaryIO, List, Optional
from urllib.parse import quote

from fastapi import (
    APIRouter,
    Depends,
    File,
    Header,
    HTTPException,
    Query,
    Request,
    UploadFile,
)
from fastapi.responses import RedirectResponse, Response, StreamingResponse
from jose import JWTError, jwt
from pydantic import BaseModel
from sqlalchemy.orm import Query as SQLAlchemyQuery
from sqlalchemy.orm import Session, defer
from starlette.background import BackgroundTask

from app.core import security
from app.core.bounded_executor import BoundedExecutor, BoundedExecutorOverloaded
from app.core.config import settings
from app.core.payload_codec import run_payload_codec
from app.db import session as db_session
from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.subtask_context import (
    AttachmentDetailResponse,
    AttachmentPreviewResponse,
    AttachmentResponse,
    TruncationInfo,
)
from app.services.attachment.external_storage import (
    ExternalAttachmentPlayback,
    resolve_external_attachment_playback,
)
from app.services.attachment.parser import DocumentParseError, DocumentParser
from app.services.attachment.public_link import (
    InvalidPublicAttachmentToken,
    generate_public_attachment_token,
    verify_public_attachment_token,
)
from app.services.auth.task_token import extract_token_from_header, verify_task_token
from app.services.context import context_service
from app.services.context.context_service import NotFoundException
from app.services.shared_task import shared_task_service
from app.services.web_scraper.security import (
    WebScraperSecurityError,
    WebScraperUrlGuard,
)
from app.stores.tasks import subtask_store, task_store

logger = logging.getLogger(__name__)


def _extract_subtask_id_from_task_token(authorization: str) -> int:
    """Extract subtask_id from task token in Authorization header.

    Returns subtask_id if the token is a valid task token, 0 otherwise.
    """
    if not authorization:
        return 0
    token = extract_token_from_header(authorization)
    if not token:
        return 0
    token_info = verify_task_token(token)
    if token_info and token_info.subtask_id > 0:
        return token_info.subtask_id
    return 0


router = APIRouter()

ATTACHMENT_PREVIEW_TEXT_LIMIT = 4000
REMOTE_MEDIA_TIMEOUT = 120.0
REMOTE_MEDIA_CHUNK_SIZE = 1024 * 1024
ATTACHMENT_STREAM_CHUNK_SIZE = 1024 * 1024
ATTACHMENT_UPLOAD_CHUNK_SIZE = 1024 * 1024
BYTES_PER_MIB = 1024 * 1024
DOWNLOAD_TOKEN_EXPIRE_SECONDS = 300
DOWNLOAD_TOKEN_SCOPE = "attachment_download"
_ATTACHMENT_BLOCKING_EXECUTOR = BoundedExecutor(
    max_workers=4,
    max_in_flight=8,
    thread_name_prefix="wegent-attachment-io",
    max_waiters=16,
)
_ATTACHMENT_UPLOAD_EXECUTOR = BoundedExecutor(
    max_workers=2,
    max_in_flight=2,
    thread_name_prefix="wegent-attachment-upload",
    max_waiters=4,
)


class _StoredDownloadLease:
    """Idempotent lease held while a response retains attachment bytes."""

    def __init__(self, admission: "_StoredDownloadAdmission") -> None:
        self._admission = admission
        self._released = False
        self._lock = threading.Lock()

    def release(self) -> None:
        with self._lock:
            if self._released:
                return
            self._released = True
        self._admission.release()


class _StoredDownloadAdmission:
    """Hard-bound full attachment buffers retained by slow clients."""

    def __init__(self, max_active: int) -> None:
        if max_active <= 0:
            raise ValueError("max_active must be positive")
        self._slots = threading.BoundedSemaphore(max_active)

    def acquire(self) -> _StoredDownloadLease:
        if not self._slots.acquire(blocking=False):
            raise BoundedExecutorOverloaded(
                "Attachment download buffer capacity is exhausted"
            )
        return _StoredDownloadLease(self)

    def release(self) -> None:
        self._slots.release()


_STORED_DOWNLOAD_ADMISSION = _StoredDownloadAdmission(max_active=2)


@dataclass(frozen=True)
class _UserIdentity:
    """Loaded request-user fields safe to pass across thread boundaries."""

    id: int
    user_name: str


@dataclass(frozen=True)
class _AttachmentSnapshot:
    """Detached attachment fields consumed by the async forwarding layer."""

    id: int
    subtask_id: int
    user_id: int
    context_type: str
    name: str
    status: str
    error_message: str
    text_length: int
    type_data: dict[str, Any]
    created_at: datetime | None
    original_filename: str
    file_extension: str
    file_size: int
    mime_type: str
    storage_backend: str
    storage_key: str
    extracted_text: str = ""


def _user_identity(user: User) -> _UserIdentity:
    """Copy loaded scalar identity fields before leaving the request task."""
    return _UserIdentity(id=user.id, user_name=user.user_name)


def _snapshot_context(
    context: Any,
    *,
    include_extracted_text: bool = False,
) -> _AttachmentSnapshot:
    """Detach all fields before the worker-owned SQLAlchemy session closes."""
    return _AttachmentSnapshot(
        id=context.id,
        subtask_id=context.subtask_id,
        user_id=context.user_id,
        context_type=context.context_type,
        name=context.name,
        status=context.status,
        error_message=context.error_message,
        text_length=context.text_length,
        type_data=copy.deepcopy(context.type_data or {}),
        created_at=context.created_at,
        original_filename=context.original_filename,
        file_extension=context.file_extension,
        file_size=context.file_size,
        mime_type=context.mime_type,
        storage_backend=context.storage_backend,
        storage_key=context.storage_key,
        extracted_text=context.extracted_text if include_extracted_text else "",
    )


def _attachment_metadata_query(
    db: Session,
    *,
    include_extracted_text: bool = False,
) -> SQLAlchemyQuery:
    """Build an attachment query that never fetches unused large payload columns."""
    deferred_columns = [
        defer(SubtaskContext.binary_data),
        defer(SubtaskContext.image_base64),
    ]
    if not include_extracted_text:
        deferred_columns.append(defer(SubtaskContext.extracted_text))
    return db.query(SubtaskContext).options(*deferred_columns)


def _get_attachment_optional(
    db: Session,
    attachment_id: int,
    *,
    user_id: int | None = None,
    include_extracted_text: bool = False,
):
    query = _attachment_metadata_query(
        db,
        include_extracted_text=include_extracted_text,
    ).filter(SubtaskContext.id == attachment_id)
    if user_id is not None:
        query = query.filter(SubtaskContext.user_id == user_id)
    return query.first()


def _model_response(model: BaseModel, *, status_code: int = 200) -> Response:
    """Serialize Pydantic output in the blocking worker, not on Uvicorn's loop."""
    return Response(
        content=model.model_dump_json(),
        status_code=status_code,
        media_type="application/json",
    )


def _json_response(payload: Any, *, status_code: int = 200) -> Response:
    """Serialize plain JSON output in the blocking worker."""
    return Response(
        content=json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        status_code=status_code,
        media_type="application/json",
    )


def _build_content_disposition(filename: str) -> str:
    """
    Build Content-Disposition header value with proper filename encoding.

    For ASCII filenames, use: filename="name.ext"
    For non-ASCII filenames, use: filename*=UTF-8''encoded_name

    This ensures compatibility with both old and new browsers.
    """
    try:
        filename.encode("latin-1")
    except UnicodeEncodeError:
        # Non-ASCII filename: use RFC 5987 encoding
        encoded = quote(filename)
        return f"attachment; filename*=UTF-8''{encoded}"

    # ASCII filename: use simple quoted string
    escaped = filename.replace("\\", "\\\\").replace('"', '\\"')
    return f'attachment; filename="{escaped}"'


async def _stream_remote_media(
    url: str,
    filename: str,
    default_media_type: str,
    range_header: Optional[str] = None,
) -> StreamingResponse:
    """Proxy remote media without buffering the complete file in memory."""
    import httpx

    try:
        await _ATTACHMENT_BLOCKING_EXECUTOR.run(
            WebScraperUrlGuard().validate_initial_url,
            url,
        )
    except WebScraperSecurityError as exc:
        raise HTTPException(status_code=502, detail="Invalid remote media URL") from exc

    client = httpx.AsyncClient(timeout=REMOTE_MEDIA_TIMEOUT)
    request_headers = {"Range": range_header} if range_header else {}
    stream_context = client.stream("GET", url, headers=request_headers)
    try:
        response = await stream_context.__aenter__()
        response.raise_for_status()
    except Exception as exc:
        with suppress(Exception):
            await stream_context.__aexit__(type(exc), exc, exc.__traceback__)
        await client.aclose()
        raise

    async def iter_bytes():
        try:
            async for chunk in response.aiter_bytes(chunk_size=REMOTE_MEDIA_CHUNK_SIZE):
                if chunk:
                    yield chunk
        finally:
            await stream_context.__aexit__(None, None, None)
            await client.aclose()

    headers = {
        "Content-Disposition": _build_content_disposition(filename),
        "Referrer-Policy": "no-referrer",
        "X-Accel-Buffering": "no",
    }
    for source_header, target_header in (
        ("content-length", "Content-Length"),
        ("content-range", "Content-Range"),
        ("accept-ranges", "Accept-Ranges"),
    ):
        value = response.headers.get(source_header)
        if value:
            headers[target_header] = value
    headers.setdefault("Accept-Ranges", "bytes")

    return StreamingResponse(
        iter_bytes(),
        media_type=response.headers.get("content-type", default_media_type),
        headers=headers,
        status_code=response.status_code,
    )


async def _stream_external_attachment(
    context,
    *,
    range_header: Optional[str] = None,
) -> Optional[StreamingResponse]:
    """Resolve and stream externally stored media when an adapter handles it."""
    playback = await _resolve_attachment_playback(context)
    if playback is None:
        return None
    return await _stream_remote_media(
        playback.url,
        context.original_filename,
        default_media_type=playback.media_type,
        range_header=range_header,
    )


def _load_stored_attachment_binary_data(attachment_id: int) -> Optional[bytes]:
    """Load attachment bytes with a session owned by the current worker thread."""
    with db_session.SessionLocal() as db:
        context = _get_attachment_optional(db, attachment_id)
        if context is None:
            return None
        return context_service.get_attachment_binary_data(db=db, context=context)


async def _stream_stored_attachment(context) -> StreamingResponse:
    """Read blocking storage off the event loop and stream bounded chunks."""
    attachment_id = context.id
    filename = context.original_filename
    media_type = context.mime_type or "application/octet-stream"
    storage_backend = context.storage_backend
    storage_key = context.storage_key
    lease = _STORED_DOWNLOAD_ADMISSION.acquire()
    load_task = asyncio.create_task(
        _ATTACHMENT_BLOCKING_EXECUTOR.run(
            _load_stored_attachment_binary_data,
            attachment_id,
        )
    )

    try:
        binary_data = await asyncio.shield(load_task)
    except asyncio.CancelledError:
        load_task.add_done_callback(lambda _: lease.release())
        raise
    except BoundedExecutorOverloaded:
        lease.release()
        raise
    except Exception as exc:
        lease.release()
        logger.error(
            "Failed to retrieve binary data for attachment %s",
            attachment_id,
            exc_info=True,
        )
        raise HTTPException(
            status_code=500,
            detail="Failed to retrieve attachment data",
        ) from exc

    if binary_data is None:
        lease.release()
        logger.error(
            "Failed to retrieve binary data for attachment %s, "
            "storage_backend=%s, storage_key=%s",
            attachment_id,
            storage_backend,
            storage_key,
        )
        raise HTTPException(
            status_code=500,
            detail="Failed to retrieve attachment data",
        )

    async def iter_bytes():
        binary_view = memoryview(binary_data)
        try:
            for offset in range(0, len(binary_data), ATTACHMENT_STREAM_CHUNK_SIZE):
                yield binary_view[offset : offset + ATTACHMENT_STREAM_CHUNK_SIZE]
                await asyncio.sleep(0)
        finally:
            binary_view.release()
            lease.release()

    try:
        return StreamingResponse(
            iter_bytes(),
            media_type=media_type,
            headers={
                "Content-Disposition": _build_content_disposition(filename),
                "Content-Length": str(len(binary_data)),
                "X-Accel-Buffering": "no",
            },
            background=BackgroundTask(lease.release),
        )
    except BaseException:
        lease.release()
        raise


async def _resolve_attachment_playback(
    context,
) -> Optional[ExternalAttachmentPlayback]:
    """Resolve fresh playback metadata through a registered storage adapter."""
    type_data = context.type_data if isinstance(context.type_data, dict) else {}
    try:
        return await _ATTACHMENT_BLOCKING_EXECUTOR.run(
            partial(
                resolve_external_attachment_playback,
                type_data=type_data,
                user_id=context.user_id,
            )
        )
    except BoundedExecutorOverloaded:
        raise
    except Exception as exc:
        logger.error(
            "Failed to resolve external attachment playback: attachment_id=%s",
            context.id,
            exc_info=True,
        )
        raise HTTPException(
            status_code=502,
            detail="External media playback URL is unavailable",
        ) from exc


def _create_download_token(
    attachment_id: int,
    user: User | _UserIdentity,
) -> str:
    expires_at = datetime.now(timezone.utc) + timedelta(
        seconds=DOWNLOAD_TOKEN_EXPIRE_SECONDS
    )
    return jwt.encode(
        {
            "scope": DOWNLOAD_TOKEN_SCOPE,
            "attachment_id": attachment_id,
            "user_id": user.id,
            "sub": user.user_name,
            "exp": expires_at,
        },
        settings.SECRET_KEY,
        algorithm=settings.ALGORITHM,
    )


def _resolve_user_from_download_token(
    db: Session,
    attachment_id: int,
    download_token: str,
) -> User:
    try:
        payload = jwt.decode(
            download_token,
            settings.SECRET_KEY,
            algorithms=[settings.ALGORITHM],
        )
    except JWTError as exc:
        logger.warning(
            "Invalid attachment download token: attachment_id=%s reason=%s",
            attachment_id,
            exc.__class__.__name__,
        )
        raise HTTPException(status_code=401, detail="Invalid download token")

    if (
        payload.get("scope") != DOWNLOAD_TOKEN_SCOPE
        or payload.get("attachment_id") != attachment_id
    ):
        raise HTTPException(status_code=401, detail="Invalid download token")

    user = (
        db.query(User)
        .filter(
            User.id == payload.get("user_id"),
            User.user_name == payload.get("sub"),
            User.is_active == True,
        )
        .first()
    )
    if user is None:
        raise HTTPException(status_code=401, detail="Invalid download token")
    return user


def _check_knowledge_base_access(
    db: Session, attachment_id: int, user_id: int
) -> bool | None:
    """Check if a user has access to a knowledge base that contains this attachment.

    This is used for attachments that are part of knowledge base documents
    (subtask_id=0) rather than task attachments.

    Args:
        db: Database session
        attachment_id: The attachment ID to check
        user_id: User ID to check access for

    Returns:
        - True: if kb_doc exists and user has access to the knowledge base
        - False: if kb_doc exists but user is denied access (hard deny)
        - None: if no kb_doc found (not a KB attachment, should try other checks)
    """
    from app.models.knowledge import KnowledgeDocument
    from app.services.knowledge import KnowledgeService

    # Find knowledge base documents that reference this attachment
    kb_doc = (
        db.query(KnowledgeDocument)
        .filter(
            KnowledgeDocument.attachment_id == attachment_id,
        )
        .first()
    )

    if kb_doc:
        # Check if user has access to this knowledge base
        _, has_access = KnowledgeService.get_knowledge_base(
            db=db,
            knowledge_base_id=kb_doc.kind_id,
            user_id=user_id,
        )
        return has_access

    return None


def _ensure_attachment_access(db: Session, context, current_user: User) -> None:
    """Ensure current user has access to the attachment context."""
    # Check access permission:
    # 1. User is the uploader
    # 2. User is the task owner (via subtask linkage)
    # 3. User is a member of the task that contains this attachment
    # 4. User has access to the knowledge base containing this attachment
    has_access = context.user_id == current_user.id

    if not has_access:
        task_id = None

        if context.subtask_id > 0:
            # Linked attachment: find task via subtask
            subtask = subtask_store.get_by_id(db, subtask_id=context.subtask_id)
            if subtask:
                task_id = subtask.task_id
        else:
            # Unlinked attachment (subtask_id=0): check if it's part of a knowledge base
            # This handles knowledge base document attachments
            kb_access = _check_knowledge_base_access(db, context.id, current_user.id)

            if kb_access is True:
                # Attachment is in a knowledge base and user has access
                has_access = True
            elif kb_access is False:
                # Attachment is in a knowledge base but user is DENIED access
                # This is a hard deny - do NOT fall back to task checks
                has_access = False
            else:
                # kb_access is None: not a KB attachment, try task-based fallback
                # This handles executor-uploaded files that weren't linked
                # to a subtask at upload time (legacy data).
                subtasks = subtask_store.list_by_user(
                    db,
                    user_id=context.user_id,
                    limit=1,
                )
                subtask = subtasks[0] if subtasks else None
                if subtask:
                    task_id = subtask.task_id

        if task_id:
            has_access = _check_task_access(db, task_id, current_user.id)

    if not has_access:
        raise HTTPException(status_code=404, detail="Attachment not found")


def _check_task_access(db: Session, task_id: int, user_id: int) -> bool:
    """Check if a user has access to a task (as owner or member)."""
    from app.models.resource_member import MemberStatus, ResourceMember
    from app.models.share_link import ResourceType

    # Check if user is the task owner
    task = task_store.get_by_id(db, task_id=task_id)
    if task and task.kind == "Task" and task.user_id == user_id:
        return True

    # Check if user is a task member
    task_member = (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == ResourceType.TASK,
            ResourceMember.resource_id == task_id,
            ResourceMember.entity_type == "user",
            ResourceMember.entity_id == str(user_id),
            ResourceMember.status == MemberStatus.APPROVED,
        )
        .first()
    )
    return task_member is not None


def _get_attachment_context(
    db: Session,
    attachment_id: int,
    current_user: User | _UserIdentity,
    *,
    include_extracted_text: bool = False,
):
    context = _get_attachment_optional(
        db,
        attachment_id,
        include_extracted_text=include_extracted_text,
    )

    if context is None:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Verify it's an attachment type
    if context.context_type != ContextType.ATTACHMENT.value:
        raise HTTPException(status_code=404, detail="Attachment not found")

    _ensure_attachment_access(db, context, current_user)
    return context


def _build_attachment_response(
    context,
    truncation_info: Optional[TruncationInfo],
) -> AttachmentResponse:
    response_truncation_info = None
    if truncation_info and truncation_info.is_truncated:
        response_truncation_info = TruncationInfo(
            is_truncated=True,
            original_length=truncation_info.original_length,
            truncated_length=truncation_info.truncated_length,
            truncation_message_key="content_truncated",
        )

    return AttachmentResponse.from_context(context, response_truncation_info)


def _validate_share_token_access(
    db: Session, attachment_id: int, share_token: str
) -> bool:
    """
    Validate that a share_token has access to a specific attachment.

    This validates that:
    1. The share_token is valid and decrypts to user_id#task_id
    2. The attachment belongs to a subtask of the task in the token
    3. The task owner matches the user_id in the token

    Args:
        db: Database session
        attachment_id: The attachment ID to check access for
        share_token: The encrypted share token

    Returns:
        True if access is granted, False otherwise
    """
    # Decode share token to get task info
    share_info = shared_task_service.decode_share_token(share_token, db)
    if not share_info:
        return False

    # Get the context (attachment)
    context = _get_attachment_optional(db, attachment_id)
    if context is None:
        return False

    # Verify it's an attachment type
    if context.context_type != ContextType.ATTACHMENT.value:
        return False

    # Get the subtask that this attachment belongs to
    if context.subtask_id <= 0:
        # Attachment not linked to a subtask
        # For unlinked attachments, verify the attachment owner matches the task owner
        if context.user_id == share_info.user_id:
            return True
        else:
            logger.warning(
                f"[_validate_share_token_access] Ownership mismatch: context.user_id={context.user_id}, "
                f"share_info.user_id={share_info.user_id}"
            )
            return False

    subtask = subtask_store.get_by_id(db, subtask_id=context.subtask_id)
    if not subtask:
        return False

    # Verify the subtask belongs to the task in the token
    if subtask.task_id != share_info.task_id:
        return False

    # Verify the task owner matches the user_id in the token
    task = task_store.get_owned_task_by_state(
        db,
        task_id=share_info.task_id,
        user_id=share_info.user_id,
        state=TaskResource.STATE_ACTIVE,
    )
    if not task:
        return False

    return True


def _read_upload_limited(file_object: BinaryIO) -> bytes:
    """Read one spooled multipart file without ever crossing its hard limit."""
    max_file_size = DocumentParser.get_max_file_size()
    binary_data = bytearray()
    file_object.seek(0)

    while True:
        remaining = max_file_size - len(binary_data)
        chunk = file_object.read(min(ATTACHMENT_UPLOAD_CHUNK_SIZE, remaining + 1))
        if not chunk:
            return bytes(binary_data)
        if len(chunk) > remaining:
            max_size_mb = max_file_size / BYTES_PER_MIB
            raise HTTPException(
                status_code=400,
                detail=f"File size exceeds maximum limit ({max_size_mb} MB)",
            )
        binary_data.extend(chunk)


def _upload_attachment_sync(
    file_object: BinaryIO,
    *,
    user_id: int,
    filename: str,
    overwrite_attachment_id: int | None,
    subtask_id: int,
    storage_purpose: str,
) -> Response:
    """Read, parse, store, persist, and serialize one multipart upload."""
    try:
        binary_data = _read_upload_limited(file_object)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Error reading uploaded file", exc_info=True)
        raise HTTPException(
            status_code=400,
            detail="Failed to read uploaded file",
        ) from exc

    with db_session.SessionLocal() as db:
        if overwrite_attachment_id is not None:
            context, truncation_info = context_service.overwrite_attachment(
                db=db,
                context_id=overwrite_attachment_id,
                user_id=user_id,
                filename=filename,
                binary_data=binary_data,
            )
        else:
            context, truncation_info = context_service.upload_attachment(
                db=db,
                user_id=user_id,
                filename=filename,
                binary_data=binary_data,
                subtask_id=subtask_id,
                storage_purpose=storage_purpose,
            )
        return _model_response(_build_attachment_response(context, truncation_info))


def _get_context_for_share_token(
    db: Session,
    attachment_id: int,
    share_token: str,
    *,
    denied_status: int,
    include_extracted_text: bool = False,
):
    if not _validate_share_token_access(db, attachment_id, share_token):
        detail = (
            "Share token access denied"
            if denied_status == 403
            else "Attachment not found"
        )
        raise HTTPException(status_code=denied_status, detail=detail)
    context = _get_attachment_optional(
        db,
        attachment_id,
        include_extracted_text=include_extracted_text,
    )
    if context is None:
        raise HTTPException(status_code=404, detail="Attachment not found")
    return context


def _get_context_for_request(
    db: Session,
    attachment_id: int,
    *,
    current_user: _UserIdentity | None,
    share_token: str | None,
    download_token: str | None = None,
    share_denied_status: int = 403,
    include_extracted_text: bool = False,
):
    if download_token:
        token_user = _resolve_user_from_download_token(
            db,
            attachment_id,
            download_token,
        )
        return _get_attachment_context(
            db,
            attachment_id,
            token_user,
            include_extracted_text=include_extracted_text,
        )
    if share_token:
        return _get_context_for_share_token(
            db,
            attachment_id,
            share_token,
            denied_status=share_denied_status,
            include_extracted_text=include_extracted_text,
        )
    if current_user is not None:
        return _get_attachment_context(
            db,
            attachment_id,
            current_user,
            include_extracted_text=include_extracted_text,
        )
    raise HTTPException(status_code=401, detail="Authentication required")


def _attachment_detail_response_sync(
    attachment_id: int,
    current_user: _UserIdentity | None,
    share_token: str | None,
) -> Response:
    with db_session.SessionLocal() as db:
        context = _get_context_for_request(
            db,
            attachment_id,
            current_user=current_user,
            share_token=share_token,
        )
        return _model_response(AttachmentDetailResponse.from_context(context))


def _attachment_preview_response_sync(
    attachment_id: int,
    current_user: _UserIdentity | None,
    share_token: str | None,
) -> Response:
    with db_session.SessionLocal() as db:
        context = _get_context_for_request(
            db,
            attachment_id,
            current_user=current_user,
            share_token=share_token,
            include_extracted_text=True,
        )
        preview_type = "none"
        preview_text = None
        if context_service.is_image_context(context):
            preview_type = "image"
        elif context.extracted_text:
            preview_type = "text"
            extension = context.file_extension.lower().lstrip(".")
            is_html = context.mime_type == "text/html" or extension in {
                "html",
                "htm",
            }
            preview_text = (
                context.extracted_text
                if is_html
                else context.extracted_text[:ATTACHMENT_PREVIEW_TEXT_LIMIT]
            )
        model = AttachmentPreviewResponse.from_context(
            context=context,
            preview_type=preview_type,
            preview_text=preview_text,
            download_url=context_service.build_attachment_url(attachment_id),
        )
        return _model_response(model)


def _attachment_playback_response_sync(
    attachment_id: int,
    current_user: _UserIdentity | None,
    share_token: str | None,
) -> Response:
    with db_session.SessionLocal() as db:
        context = _get_context_for_request(
            db,
            attachment_id,
            current_user=current_user,
            share_token=share_token,
        )
        snapshot = _snapshot_context(context)

    external_playback = resolve_external_attachment_playback(
        type_data=snapshot.type_data,
        user_id=snapshot.user_id,
    )
    if external_playback and external_playback.delivery_mode == "direct":
        return _model_response(
            AttachmentPlaybackResponse(
                playback_url=external_playback.url,
                cover_url=(
                    external_playback.cover_url or _attachment_cover_url(snapshot)
                ),
            )
        )

    proxy_url = context_service.build_attachment_url(attachment_id)
    if share_token:
        proxy_url = f"{proxy_url}?share_token={quote(share_token, safe='')}"
    elif current_user is not None:
        token = _create_download_token(attachment_id, current_user)
        proxy_url = f"{proxy_url}?download_token={quote(token, safe='')}"
    return _model_response(
        AttachmentPlaybackResponse(
            playback_url=proxy_url,
            cover_url=(
                external_playback.cover_url
                if external_playback and external_playback.cover_url
                else _attachment_cover_url(snapshot)
            ),
        )
    )


def _attachment_stream_snapshot_sync(
    attachment_id: int,
    current_user: _UserIdentity | None,
    share_token: str | None,
    download_token: str | None,
) -> _AttachmentSnapshot:
    with db_session.SessionLocal() as db:
        context = _get_context_for_request(
            db,
            attachment_id,
            current_user=current_user,
            share_token=share_token,
            download_token=download_token,
            share_denied_status=404,
        )
        return _snapshot_context(context)


def _executor_attachment_snapshot_sync(
    attachment_id: int,
    user_id: int,
) -> _AttachmentSnapshot:
    with db_session.SessionLocal() as db:
        context = _get_attachment_optional(
            db,
            attachment_id,
            user_id=user_id,
        )
        if context is None or context.context_type != ContextType.ATTACHMENT.value:
            raise HTTPException(status_code=404, detail="Attachment not found")
        return _snapshot_context(context)


def _create_download_token_response_sync(
    attachment_id: int,
    current_user: _UserIdentity,
) -> Response:
    with db_session.SessionLocal() as db:
        _get_attachment_context(db, attachment_id, current_user)
    return _json_response(
        {
            "download_token": _create_download_token(attachment_id, current_user),
            "expires_in": DOWNLOAD_TOKEN_EXPIRE_SECONDS,
        }
    )


def _delete_attachment_response_sync(
    attachment_id: int,
    user_id: int,
) -> Response:
    with db_session.SessionLocal() as db:
        context = _get_attachment_optional(
            db,
            attachment_id,
            user_id=user_id,
        )
        if context is None or context.context_type != ContextType.ATTACHMENT.value:
            raise HTTPException(status_code=404, detail="Attachment not found")
        if context.subtask_id > 0:
            raise HTTPException(
                status_code=400,
                detail="Cannot delete attachment that is linked to a message",
            )
        if not context_service.delete_context(
            db=db,
            context_id=attachment_id,
            user_id=user_id,
        ):
            raise HTTPException(status_code=500, detail="Failed to delete attachment")
    return _json_response({"message": "Attachment deleted successfully"})


def _attachment_by_subtask_response_sync(
    subtask_id: int,
    user_id: int,
) -> Response:
    with db_session.SessionLocal() as db:
        context = (
            _attachment_metadata_query(db)
            .filter(
                SubtaskContext.subtask_id == subtask_id,
                SubtaskContext.context_type == ContextType.ATTACHMENT.value,
            )
            .order_by(SubtaskContext.created_at)
            .first()
        )
        if context is None:
            return _json_response(None)
        has_access = context.user_id == user_id
        if not has_access:
            subtask = subtask_store.get_by_id(db, subtask_id=subtask_id)
            if subtask:
                has_access = _check_task_access(db, subtask.task_id, user_id)
        if not has_access:
            raise HTTPException(status_code=403, detail="Access denied")
        return _model_response(AttachmentDetailResponse.from_context(context))


def _task_attachments_response_sync(task_id: int, user_id: int) -> Response:
    from app.models.resource_member import MemberStatus, ResourceMember
    from app.models.share_link import ResourceType

    with db_session.SessionLocal() as db:
        task = task_store.get_by_id(db, task_id=task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="Task not found")
        is_owner = task.user_id == user_id
        is_member = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.TASK,
                ResourceMember.resource_id == task_id,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status == MemberStatus.APPROVED,
            )
            .first()
            is not None
        )
        if not is_owner and not is_member:
            raise HTTPException(status_code=403, detail="Access denied")
        subtask_ids = [
            subtask.id
            for subtask in subtask_store.list_by_task_unfiltered(db, task_id=task_id)
        ]
        attachments = []
        if subtask_ids:
            attachments = (
                _attachment_metadata_query(db)
                .filter(
                    SubtaskContext.subtask_id.in_(subtask_ids),
                    SubtaskContext.context_type == ContextType.ATTACHMENT.value,
                    SubtaskContext.status == ContextStatus.READY.value,
                )
                .order_by(SubtaskContext.created_at)
                .all()
            )
        models = [
            AttachmentDetailResponse.from_context(attachment)
            for attachment in attachments
        ]
        return _json_response([model.model_dump(mode="json") for model in models])


def _public_share_response_sync(
    attachment_id: int,
    expires_in_days: int,
    current_user: _UserIdentity,
) -> Response:
    with db_session.SessionLocal() as db:
        context = _get_attachment_optional(db, attachment_id)
        if context is None or context.context_type != ContextType.ATTACHMENT.value:
            raise HTTPException(status_code=404, detail="Attachment not found")
        if context.user_id != current_user.id:
            raise HTTPException(
                status_code=403,
                detail="Only the attachment owner can create share links",
            )

    token = _generate_public_share_token(attachment_id, expires_in_days)
    expires_at = datetime.now(timezone.utc) + timedelta(days=expires_in_days)
    share_url = f"{settings.FRONTEND_URL.rstrip('/')}/download/shared?token={token}"
    logger.info(
        "[PublicShare] User %s created public share link for attachment %s, "
        "expires at %s",
        current_user.id,
        attachment_id,
        expires_at,
    )
    return _model_response(
        PublicShareLinkResponse(
            share_url=share_url,
            expires_at=expires_at.isoformat(),
        )
    )


def _public_attachment_snapshot_sync(token: str) -> _AttachmentSnapshot:
    try:
        attachment_id = _verify_public_share_token(token)["attachment_id"]
    except HTTPException as exc:
        raise HTTPException(
            status_code=403,
            detail="Invalid or expired share link",
        ) from exc

    with db_session.SessionLocal() as db:
        context = _get_attachment_optional(db, attachment_id)
        if context is None or context.context_type != ContextType.ATTACHMENT.value:
            raise HTTPException(status_code=404, detail="Attachment not found")
        return _snapshot_context(context)


@router.post("/upload", response_model=AttachmentResponse)
async def upload_attachment(
    file: UploadFile = File(...),
    overwrite_attachment_id: Optional[int] = None,
    storage_purpose: str = "default",
    current_user: User = Depends(security.get_current_user_jwt_apikey_tasktoken),
    authorization: str = Header(default=""),
) -> Response:
    """
    Upload a document file for chat attachment.

    Supported file types:
    - PDF (.pdf)
    - Word (.doc, .docx)
    - PowerPoint (.ppt, .pptx)
    - Excel (.xls, .xlsx, .csv)
    - XMind (.xmind)
    - Plain text (.txt)
    - Markdown (.md)
    - Images (.jpg, .jpeg, .png, .gif, .bmp, .webp)

    Limits:
    - Maximum file size: 100 MB
    - Maximum extracted text: 1,500,000 characters (auto-truncated if exceeded)

    Returns:
        Attachment details including ID, processing status, and truncation info

    Optional:
        overwrite_attachment_id: Existing attachment ID to overwrite in-place
    """
    if storage_purpose not in {"default", "video_reference"}:
        raise HTTPException(status_code=400, detail="Invalid storage_purpose")

    if not file.filename:
        raise HTTPException(status_code=400, detail="Filename is required")
    max_file_size = DocumentParser.get_max_file_size()
    if file.size is not None and file.size > max_file_size:
        max_size_mb = max_file_size / BYTES_PER_MIB
        raise HTTPException(
            status_code=400,
            detail=f"File size exceeds maximum limit ({max_size_mb} MB)",
        )
    if overwrite_attachment_id is not None and overwrite_attachment_id <= 0:
        raise HTTPException(
            status_code=400,
            detail="overwrite_attachment_id must be positive",
        )

    user_id = current_user.id
    filename = file.filename
    subtask_id = await run_payload_codec(
        _extract_subtask_id_from_task_token,
        authorization,
        payload_hint=authorization,
        force_offload=True,
    )
    logger.info(
        "[attachments.py] upload_attachment: user_id=%s, filename=<redacted>, "
        "subtask_id=%s, storage_purpose=%s",
        user_id,
        subtask_id,
        storage_purpose,
    )

    try:
        return await _ATTACHMENT_UPLOAD_EXECUTOR.run(
            partial(
                _upload_attachment_sync,
                file.file,
                user_id=user_id,
                filename=filename,
                overwrite_attachment_id=overwrite_attachment_id,
                subtask_id=subtask_id,
                storage_purpose=storage_purpose,
            )
        )
    except BoundedExecutorOverloaded:
        raise
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except NotFoundException as e:
        raise HTTPException(status_code=404, detail="Attachment not found") from e
    except DocumentParseError as e:
        # Return error with error_code for i18n mapping
        error_code = getattr(e, "error_code", None)
        raise HTTPException(
            status_code=400,
            detail={
                "message": str(e),
                "error_code": error_code,
            },
        ) from e
    except Exception as e:
        logger.error(f"Error uploading attachment: {e}", exc_info=True)
        raise HTTPException(
            status_code=500, detail="Failed to upload attachment"
        ) from e


class AttachmentPlaybackResponse(BaseModel):
    """Fresh browser playback information for a media attachment."""

    playback_url: str
    cover_url: Optional[str] = None


@router.get("/{attachment_id}", response_model=AttachmentDetailResponse)
async def get_attachment(
    attachment_id: int,
    share_token: Optional[str] = Query(
        None, description="Share token for public access"
    ),
    current_user: Optional[User] = Depends(security.get_current_user_optional),
) -> Response:
    """
    Get attachment details by ID.

    Supports two authentication methods:
    1. JWT token (for logged-in users)
    2. Share token (for public shared task viewers)

    Returns:
        Attachment details including status and metadata
    """

    identity = _user_identity(current_user) if current_user else None
    return await _ATTACHMENT_BLOCKING_EXECUTOR.run(
        _attachment_detail_response_sync,
        attachment_id,
        identity,
        share_token,
    )


def _attachment_cover_url(context) -> Optional[str]:
    """Return a persisted cover URL when the attachment already has one."""
    type_data = context.type_data if isinstance(context.type_data, dict) else {}
    video_metadata = type_data.get("video_metadata")
    if isinstance(video_metadata, dict) and video_metadata.get("cover_url"):
        return str(video_metadata["cover_url"])
    cover_url = type_data.get("cover_url")
    return str(cover_url) if cover_url else None


@router.get(
    "/{attachment_id}/playback",
    response_model=AttachmentPlaybackResponse,
)
async def get_attachment_playback(
    attachment_id: int,
    share_token: Optional[str] = Query(
        None, description="Share token for public access"
    ),
    current_user: Optional[User] = Depends(security.get_current_user_optional),
) -> Response:
    """Return a fresh direct or proxied URL for browser media playback."""
    identity = _user_identity(current_user) if current_user else None
    return await _ATTACHMENT_BLOCKING_EXECUTOR.run(
        _attachment_playback_response_sync,
        attachment_id,
        identity,
        share_token,
    )


@router.get("/{attachment_id}/preview", response_model=AttachmentPreviewResponse)
async def get_attachment_preview(
    attachment_id: int,
    share_token: Optional[str] = Query(
        None, description="Share token for public access"
    ),
    current_user: Optional[User] = Depends(security.get_current_user_optional),
) -> Response:
    """
    Get attachment preview content.

    Supports two authentication methods:
    1. JWT token (for logged-in users)
    2. Share token (for public shared task viewers)

    Returns:
        Attachment metadata and preview snippet (if available).
    """
    identity = _user_identity(current_user) if current_user else None
    return await _ATTACHMENT_BLOCKING_EXECUTOR.run(
        _attachment_preview_response_sync,
        attachment_id,
        identity,
        share_token,
    )


@router.get("/{attachment_id}/download")
async def download_attachment(
    attachment_id: int,
    request: Request,
    share_token: Optional[str] = Query(
        None, description="Share token for public access"
    ),
    download_token: Optional[str] = Query(
        None, description="Short-lived token for browser-native download"
    ),
    range_header: Optional[str] = Header(None, alias="Range"),
    current_user: Optional[User] = Depends(security.get_current_user_optional),
):
    """
    Download the original file.

    Supports three authentication methods:
    1. JWT token (for logged-in users)
    2. Share token (for public shared task viewers)
    3. Browser redirect (no auth) -> Login page -> Auto download after login

    Returns:
        File binary data with appropriate content type
    """
    if not download_token and not share_token and current_user is None:
        # Check if it's a browser request (accepts HTML)
        accept_header = request.headers.get("Accept", "")
        is_browser = "text/html" in accept_header

        if is_browser:
            # Browser access - redirect to frontend login page
            from app.core.config import settings

            current_url = str(request.url)
            login_url = f"{settings.FRONTEND_URL}/login?redirect={quote(current_url)}"
            return RedirectResponse(url=login_url, status_code=302)
        else:
            # API/fetch call - return 401
            raise HTTPException(status_code=401, detail="Authentication required")

    identity = _user_identity(current_user) if current_user else None
    context = await _ATTACHMENT_BLOCKING_EXECUTOR.run(
        _attachment_stream_snapshot_sync,
        attachment_id,
        identity,
        share_token,
        download_token,
    )

    external_response = await _stream_external_attachment(
        context,
        range_header=range_header,
    )
    if external_response is not None:
        return external_response

    # Generated videos are streamed through the backend so the browser receives
    # attachment headers without the service buffering the complete file.
    if context.type_data and isinstance(context.type_data, dict):
        video_metadata = context.type_data.get("video_metadata")
        if video_metadata and isinstance(video_metadata, dict):
            video_url = video_metadata.get("video_url")
            if video_url:
                logger.info(
                    "Streaming remote video attachment: attachment_id=%s",
                    attachment_id,
                )
                return await _stream_remote_media(
                    video_url,
                    context.original_filename,
                    default_media_type=context.mime_type or "video/mp4",
                    range_header=range_header,
                )

    return await _stream_stored_attachment(context)


@router.post("/{attachment_id}/download-token")
async def create_attachment_download_token(
    attachment_id: int,
    current_user: User = Depends(security.get_current_user),
) -> Response:
    """Create a short-lived token for browser-native attachment downloads."""
    return await _ATTACHMENT_BLOCKING_EXECUTOR.run(
        _create_download_token_response_sync,
        attachment_id,
        _user_identity(current_user),
    )


@router.get("/{attachment_id}/executor-download")
async def executor_download_attachment(
    attachment_id: int,
    current_user: User = Depends(security.get_current_user_jwt_apikey_tasktoken),
):
    """
    Download attachment for executor.

    This endpoint is called by the Executor to download attachments
    to the workspace. It supports multiple authentication methods.

    Authentication:
    - JWT Token: Standard Bearer token in Authorization header
    - API Key: Personal API key (wg-xxx) via X-API-Key header or Bearer token
    - Task Token: JWT token issued for task execution

    Returns:
        File binary data with appropriate content type
    """
    context = await _ATTACHMENT_BLOCKING_EXECUTOR.run(
        _executor_attachment_snapshot_sync,
        attachment_id,
        current_user.id,
    )

    external_response = await _stream_external_attachment(context)
    if external_response is not None:
        return external_response

    return await _stream_stored_attachment(context)


@router.delete("/{attachment_id}")
async def delete_attachment(
    attachment_id: int,
    current_user: User = Depends(security.get_current_user),
) -> Response:
    """
    Delete an attachment.

    Only attachments that are not linked to a subtask can be deleted.

    Returns:
        Success message
    """
    return await _ATTACHMENT_BLOCKING_EXECUTOR.run(
        _delete_attachment_response_sync,
        attachment_id,
        current_user.id,
    )


@router.get("/subtask/{subtask_id}", response_model=Optional[AttachmentDetailResponse])
async def get_attachment_by_subtask(
    subtask_id: int,
    current_user: User = Depends(security.get_current_user),
) -> Response:
    """
    Get attachment by subtask ID.

    Returns:
        Attachment details or null if no attachment exists
    """
    return await _ATTACHMENT_BLOCKING_EXECUTOR.run(
        _attachment_by_subtask_response_sync,
        subtask_id,
        current_user.id,
    )


@router.get("/task/{task_id}/all", response_model=List[AttachmentDetailResponse])
async def get_all_task_attachments(
    task_id: int,
    current_user: User = Depends(security.get_current_user_jwt_apikey_tasktoken),
) -> Response:
    """
    Get all attachments for a task (across all subtasks).

    This endpoint is used by the executor to pre-download all attachments
    for a task at sandbox startup.

    Supports multiple authentication methods:
    - JWT Token: Standard Bearer token in Authorization header
    - API Key: Personal API key (wg-xxx) via X-API-Key header or Bearer token
    - Task Token: JWT token issued for task execution

    Args:
        task_id: Task ID

    Returns:
        List of attachment details for all subtasks of the task
    """
    return await _ATTACHMENT_BLOCKING_EXECUTOR.run(
        _task_attachments_response_sync,
        task_id,
        current_user.id,
    )


# =============================================================================
# Public Share Link Endpoints
# =============================================================================


class PublicShareLinkResponse(BaseModel):
    """Response for public share link generation."""

    share_url: str
    expires_at: str


def _generate_public_share_token(attachment_id: int, expires_in_days: int = 7) -> str:
    """Backward-compatible wrapper for public attachment share tokens."""
    return generate_public_attachment_token(
        attachment_id,
        timedelta(days=expires_in_days),
    )


def _verify_public_share_token(token: str) -> dict:
    """Backward-compatible wrapper for public attachment token verification."""
    try:
        return verify_public_attachment_token(token)
    except InvalidPublicAttachmentToken as exc:
        raise HTTPException(
            status_code=403,
            detail="Invalid or expired share link",
        ) from exc


@router.post("/{attachment_id}/public-share", response_model=PublicShareLinkResponse)
async def create_public_share_link(
    attachment_id: int,
    expires_in_days: int = Query(default=7, ge=1, le=3650),
    current_user: User = Depends(security.get_current_user),
) -> Response:
    """
    Generate a public share link for an attachment.

    This link can be shared with anyone who has the signed URL.

    The generated token contains a random nonce to prevent enumeration attacks,
    making it impossible to guess other valid tokens even if attachment IDs are known.

    Args:
        attachment_id: ID of the attachment to share
        expires_in_days: Link expiration time in days (1-3650, default: 7)

    Returns:
        Public share URL and expiration time
    """
    return await _ATTACHMENT_BLOCKING_EXECUTOR.run(
        _public_share_response_sync,
        attachment_id,
        expires_in_days,
        _user_identity(current_user),
    )


@router.get("/download/shared")
async def public_download_attachment(
    token: str = Query(..., description="Public share token"),
    range_header: Optional[str] = Header(None, alias="Range"),
):
    """
    Download an attachment using a public share token.

    Anyone with a valid signed token can download the attachment. The token is
    scoped to one attachment and expires automatically.

    Args:
        token: Public share token generated by /{id}/public-share endpoint

    Returns:
        File binary data with appropriate content type
    """
    context = await _ATTACHMENT_BLOCKING_EXECUTOR.run(
        _public_attachment_snapshot_sync,
        token,
    )

    external_response = await _stream_external_attachment(
        context,
        range_header=range_header,
    )
    if external_response is not None:
        return external_response

    logger.info(
        "[PublicDownload] Streaming attachment %s via signed public link",
        context.id,
    )

    return await _stream_stored_attachment(context)
