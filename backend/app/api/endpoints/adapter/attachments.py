# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Attachment API endpoints for file upload and management.

Uses the unified context service for managing attachments as subtask contexts.
"""

import logging
from typing import List, Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import RedirectResponse, Response
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.subtask import Subtask
from app.models.subtask_context import ContextType
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.subtask_context import (
    AttachmentDetailResponse,
    AttachmentPreviewResponse,
    AttachmentResponse,
    TruncationInfo,
)
from app.services.attachment.parser import DocumentParseError, DocumentParser
from app.services.context import context_service
from app.services.context.context_service import NotFoundException
from app.services.shared_task import shared_task_service

logger = logging.getLogger(__name__)

router = APIRouter()

ATTACHMENT_PREVIEW_TEXT_LIMIT = 4000


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


def _ensure_attachment_access(db: Session, context, current_user: User) -> None:
    """Ensure current user has access to the attachment context."""
    # Check access permission:
    # 1. User is the uploader
    # 2. User is the task owner
    # 3. User is a member of the task that contains this attachment
    has_access = context.user_id == current_user.id

    if not has_access and context.subtask_id > 0:
        # Check if user is a task owner or member
        from app.models.resource_member import MemberStatus, ResourceMember
        from app.models.share_link import ResourceType
        from app.models.subtask import Subtask
        from app.models.task import TaskResource

        subtask = db.query(Subtask).filter(Subtask.id == context.subtask_id).first()
        if subtask:
            # Check if user is the task owner
            task = (
                db.query(TaskResource)
                .filter(
                    TaskResource.id == subtask.task_id,
                    TaskResource.kind == "Task",
                    TaskResource.user_id == current_user.id,
                )
                .first()
            )
            if task:
                has_access = True
            else:
                # Check if user is a task member using ResourceMember
                # Exclude share records (copied_resource_id > 0), only consider actual group chat members
                task_member = (
                    db.query(ResourceMember)
                    .filter(
                        ResourceMember.resource_type == ResourceType.TASK,
                        ResourceMember.resource_id == subtask.task_id,
                        ResourceMember.user_id == current_user.id,
                        ResourceMember.status == MemberStatus.APPROVED.value,
                        ResourceMember.copied_resource_id == 0,
                    )
                    .first()
                )
                has_access = task_member is not None

    if not has_access:
        raise HTTPException(status_code=404, detail="Attachment not found")


def _get_attachment_context(db: Session, attachment_id: int, current_user: User):
    context = context_service.get_context_optional(
        db=db,
        context_id=attachment_id,
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
    context = context_service.get_context_optional(
        db=db,
        context_id=attachment_id,
    )
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

    subtask = db.query(Subtask).filter(Subtask.id == context.subtask_id).first()
    if not subtask:
        return False

    # Verify the subtask belongs to the task in the token
    if subtask.task_id != share_info.task_id:
        return False

    # Verify the task owner matches the user_id in the token
    task = (
        db.query(TaskResource)
        .filter(
            TaskResource.id == share_info.task_id,
            TaskResource.user_id == share_info.user_id,
            TaskResource.kind == "Task",
            TaskResource.is_active == TaskResource.STATE_ACTIVE,
        )
        .first()
    )
    if not task:
        return False

    return True


@router.post("/upload", response_model=AttachmentResponse)
async def upload_attachment(
    file: UploadFile = File(...),
    overwrite_attachment_id: Optional[int] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user_jwt_apikey_tasktoken),
):
    """
    Upload a document file for chat attachment.

    Supported file types:
    - PDF (.pdf)
    - Word (.doc, .docx)
    - PowerPoint (.ppt, .pptx)
    - Excel (.xls, .xlsx, .csv)
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
    logger.info(
        f"[attachments.py] upload_attachment: user_id={current_user.id}, filename={file.filename}"
    )

    if not file.filename:
        raise HTTPException(status_code=400, detail="Filename is required")

    # Read file content
    try:
        binary_data = await file.read()
    except Exception as e:
        logger.error(f"Error reading uploaded file: {e}")
        raise HTTPException(
            status_code=400, detail="Failed to read uploaded file"
        ) from e

    # Validate file size before processing
    if not DocumentParser.validate_file_size(len(binary_data)):
        max_size_mb = DocumentParser.get_max_file_size() / (1024 * 1024)
        raise HTTPException(
            status_code=400,
            detail=f"File size exceeds maximum limit ({max_size_mb} MB)",
        )

    try:
        if overwrite_attachment_id is not None:
            if overwrite_attachment_id <= 0:
                raise HTTPException(
                    status_code=400, detail="overwrite_attachment_id must be positive"
                )
            context, truncation_info = context_service.overwrite_attachment(
                db=db,
                context_id=overwrite_attachment_id,
                user_id=current_user.id,
                filename=file.filename,
                binary_data=binary_data,
            )
        else:
            context, truncation_info = context_service.upload_attachment(
                db=db,
                user_id=current_user.id,
                filename=file.filename,
                binary_data=binary_data,
            )

        return _build_attachment_response(context, truncation_info)

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


@router.get("/{attachment_id}", response_model=AttachmentDetailResponse)
async def get_attachment(
    attachment_id: int,
    share_token: Optional[str] = Query(
        None, description="Share token for public access"
    ),
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(security.get_current_user_optional),
):
    """
    Get attachment details by ID.

    Supports two authentication methods:
    1. JWT token (for logged-in users)
    2. Share token (for public shared task viewers)

    Returns:
        Attachment details including status and metadata
    """

    context = None

    # Method 1: Share token authentication (no login required)
    if share_token:
        has_access = _validate_share_token_access(db, attachment_id, share_token)
        if has_access:
            # Get context for share token access
            context = context_service.get_context_optional(
                db=db,
                context_id=attachment_id,
            )
            if context is None:
                raise HTTPException(status_code=404, detail="Attachment not found")
        else:
            raise HTTPException(status_code=403, detail="Share token access denied")
    # Method 2: JWT token authentication (existing logic)
    elif current_user:
        context = _get_attachment_context(db, attachment_id, current_user)
    else:
        # No authentication provided
        raise HTTPException(status_code=401, detail="Authentication required")

    return AttachmentDetailResponse.from_context(context)


@router.get("/{attachment_id}/preview", response_model=AttachmentPreviewResponse)
async def get_attachment_preview(
    attachment_id: int,
    share_token: Optional[str] = Query(
        None, description="Share token for public access"
    ),
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(security.get_current_user_optional),
):
    """
    Get attachment preview content.

    Supports two authentication methods:
    1. JWT token (for logged-in users)
    2. Share token (for public shared task viewers)

    Returns:
        Attachment metadata and preview snippet (if available).
    """
    has_access = False

    # Method 1: Share token authentication (no login required)
    if share_token:
        has_access = _validate_share_token_access(db, attachment_id, share_token)
        if has_access:
            # Get context for share token access
            context = context_service.get_context_optional(
                db=db,
                context_id=attachment_id,
            )
            if context is None:
                raise HTTPException(status_code=404, detail="Attachment not found")
        else:
            raise HTTPException(status_code=403, detail="Share token access denied")
    # Method 2: JWT token authentication (existing logic)
    elif current_user:
        context = _get_attachment_context(db, attachment_id, current_user)
        has_access = True
    else:
        # No authentication provided
        raise HTTPException(status_code=401, detail="Authentication required")

    preview_type = "none"
    preview_text = None

    if context_service.is_image_context(context):
        preview_type = "image"
    elif context.extracted_text:
        preview_type = "text"
        # Check if it's an HTML file - return full content for HTML to enable proper preview
        type_data = context.type_data or {}
        mime_type = type_data.get("mime_type", "")
        file_extension = type_data.get("file_extension", "").lower().lstrip(".")
        is_html = mime_type == "text/html" or file_extension in ["html", "htm"]

        if is_html:
            # Return full HTML content without truncation
            preview_text = context.extracted_text
        else:
            # Truncate non-HTML content for preview
            preview_text = context.extracted_text[:ATTACHMENT_PREVIEW_TEXT_LIMIT]

    download_url = context_service.build_attachment_url(attachment_id)

    return AttachmentPreviewResponse.from_context(
        context=context,
        preview_type=preview_type,
        preview_text=preview_text,
        download_url=download_url,
    )


@router.get("/{attachment_id}/download")
async def download_attachment(
    attachment_id: int,
    request: Request,
    share_token: Optional[str] = Query(
        None, description="Share token for public access"
    ),
    db: Session = Depends(get_db),
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
    has_access = False
    context = None

    # Method 1: Share token authentication (no login required)
    if share_token:
        has_access = _validate_share_token_access(db, attachment_id, share_token)
        if has_access:
            # Get context for share token access
            context = context_service.get_context_optional(
                db=db,
                context_id=attachment_id,
            )
            if context is None:
                raise HTTPException(status_code=404, detail="Attachment not found")

    # Method 2: JWT token authentication (existing logic)
    elif current_user:
        context = _get_attachment_context(db, attachment_id, current_user)
        has_access = True

    # Method 3: No authentication - redirect to login for browser access
    else:
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

    if not has_access:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Check if attachment has an external URL (e.g., generated video)
    # For such attachments, redirect to the external URL instead of serving binary data
    if context.type_data and isinstance(context.type_data, dict):
        video_metadata = context.type_data.get("video_metadata")
        if video_metadata and isinstance(video_metadata, dict):
            video_url = video_metadata.get("video_url")
            if video_url:
                logger.info(
                    f"Redirecting attachment {attachment_id} to external video URL"
                )
                return RedirectResponse(url=video_url, status_code=302)

    # Get binary data from the appropriate storage backend
    binary_data = context_service.get_attachment_binary_data(
        db=db,
        context=context,
    )

    if binary_data is None:
        logger.error(
            f"Failed to retrieve binary data for attachment {attachment_id}, "
            f"storage_backend={context.storage_backend}, "
            f"storage_key={context.storage_key}"
        )
        raise HTTPException(
            status_code=500, detail="Failed to retrieve attachment data"
        )

    return Response(
        content=binary_data,
        media_type=context.mime_type,
        headers={
            "Content-Disposition": _build_content_disposition(context.original_filename)
        },
    )


@router.get("/{attachment_id}/executor-download")
async def executor_download_attachment(
    attachment_id: int,
    db: Session = Depends(get_db),
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
    # Get context and verify ownership
    context = context_service.get_context_optional(
        db=db,
        context_id=attachment_id,
        user_id=current_user.id,
    )

    if context is None:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Verify it's an attachment type
    if context.context_type != ContextType.ATTACHMENT.value:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Get binary data from the appropriate storage backend
    binary_data = context_service.get_attachment_binary_data(
        db=db,
        context=context,
    )

    if binary_data is None:
        logger.error(
            f"Failed to retrieve binary data for attachment {attachment_id}, "
            f"storage_backend={context.storage_backend}, "
            f"storage_key={context.storage_key}"
        )
        raise HTTPException(
            status_code=500, detail="Failed to retrieve attachment data"
        )

    return Response(
        content=binary_data,
        media_type=context.mime_type,
        headers={
            "Content-Disposition": _build_content_disposition(context.original_filename)
        },
    )


@router.delete("/{attachment_id}")
async def delete_attachment(
    attachment_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Delete an attachment.

    Only attachments that are not linked to a subtask can be deleted.

    Returns:
        Success message
    """
    context = context_service.get_context_optional(
        db=db,
        context_id=attachment_id,
        user_id=current_user.id,
    )

    if context is None:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Verify it's an attachment type
    if context.context_type != ContextType.ATTACHMENT.value:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # subtask_id == 0 means unlinked, > 0 means linked to a subtask
    if context.subtask_id > 0:
        raise HTTPException(
            status_code=400,
            detail="Cannot delete attachment that is linked to a message",
        )

    success = context_service.delete_context(
        db=db,
        context_id=attachment_id,
        user_id=current_user.id,
    )

    if not success:
        raise HTTPException(status_code=500, detail="Failed to delete attachment")

    return {"message": "Attachment deleted successfully"}


@router.get("/subtask/{subtask_id}", response_model=Optional[AttachmentDetailResponse])
async def get_attachment_by_subtask(
    subtask_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get attachment by subtask ID.

    Returns:
        Attachment details or null if no attachment exists
    """
    context = context_service.get_attachment_by_subtask(
        db=db,
        subtask_id=subtask_id,
    )

    if context is None:
        return None

    # Verify ownership
    if context.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Access denied")

    return AttachmentDetailResponse.from_context(context)


@router.get("/task/{task_id}/all", response_model=List[AttachmentDetailResponse])
async def get_all_task_attachments(
    task_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user_jwt_apikey_tasktoken),
):
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
    # Verify task exists and user has access
    task = db.query(TaskResource).filter(TaskResource.id == task_id).first()
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")

    # Check if user is the task owner or a member
    from app.models.resource_member import MemberStatus, ResourceMember
    from app.models.share_link import ResourceType

    is_owner = task.user_id == current_user.id
    # Exclude share records (copied_resource_id > 0), only consider actual group chat members
    is_member = (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == ResourceType.TASK,
            ResourceMember.resource_id == task_id,
            ResourceMember.user_id == current_user.id,
            ResourceMember.status == MemberStatus.APPROVED.value,
            ResourceMember.copied_resource_id == 0,
        )
        .first()
        is not None
    )

    if not is_owner and not is_member:
        raise HTTPException(status_code=403, detail="Access denied")

    # Get all attachments for the task
    attachments = context_service.get_attachments_by_task(db=db, task_id=task_id)

    return [AttachmentDetailResponse.from_context(att) for att in attachments]


# =============================================================================
# Public Share Link Endpoints
# =============================================================================

import secrets
from datetime import datetime, timedelta, timezone

from jose import JWTError, jwt
from pydantic import BaseModel


class PublicShareLinkResponse(BaseModel):
    """Response for public share link generation."""

    share_url: str
    expires_at: str


def _generate_public_share_token(attachment_id: int, expires_in_days: int = 7) -> str:
    """
    Generate a JWT token for public attachment download.

    The token contains:
    - aid: attachment_id
    - nonce: random string to prevent enumeration attacks
    - exp: expiration timestamp
    - type: "public_dl" (token type)

    Args:
        attachment_id: ID of the attachment to share
        expires_in_days: Token expiration time in days (default: 7)

    Returns:
        Signed JWT token
    """
    from app.core.config import settings

    expire = datetime.now(timezone.utc) + timedelta(days=expires_in_days)

    # Generate random nonce to prevent enumeration attacks
    # Even if someone knows attachment_id, they can't construct valid token
    nonce = secrets.token_urlsafe(8)

    to_encode = {
        "aid": attachment_id,
        "nonce": nonce,
        "exp": expire,
        "type": "public_dl",
    }

    token = jwt.encode(to_encode, settings.SECRET_KEY, algorithm="HS256")
    return token


def _verify_public_share_token(token: str) -> dict:
    """
    Verify and decode a public share token.

    Returns:
        Decoded token payload with attachment_id

    Raises:
        HTTPException: If token is invalid or expired
    """
    from app.core.config import settings

    credentials_exception = HTTPException(
        status_code=403,
        detail="Invalid or expired share link",
    )

    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=["HS256"])

        # Verify token type
        if payload.get("type") != "public_dl":
            raise credentials_exception

        # Verify required fields
        attachment_id = payload.get("aid")
        nonce = payload.get("nonce")

        if attachment_id is None or nonce is None:
            raise credentials_exception

        return {"attachment_id": int(attachment_id), "nonce": nonce}

    except JWTError:
        raise credentials_exception


@router.post("/{attachment_id}/public-share", response_model=PublicShareLinkResponse)
async def create_public_share_link(
    attachment_id: int,
    expires_in_days: int = Query(default=7, ge=1, le=3650),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Generate a public share link for an attachment.

    This link can be shared with any logged-in user, regardless of
    whether they have direct access to the attachment.

    The generated token contains a random nonce to prevent enumeration attacks,
    making it impossible to guess other valid tokens even if attachment IDs are known.

    Args:
        attachment_id: ID of the attachment to share
        expires_in_days: Link expiration time in days (1-3650, default: 7)

    Returns:
        Public share URL and expiration time
    """
    # Get the attachment context
    context = context_service.get_context_optional(
        db=db,
        context_id=attachment_id,
    )

    if context is None or context.context_type != ContextType.ATTACHMENT.value:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Only the attachment owner (uploader) can create public share links
    if context.user_id != current_user.id:
        raise HTTPException(
            status_code=403, detail="Only the attachment owner can create share links"
        )

    # Generate public share token
    token = _generate_public_share_token(attachment_id, expires_in_days)

    # Build share URL
    from app.core.config import settings

    base_url = settings.FRONTEND_URL.rstrip("/")
    share_url = f"{base_url}/download/shared?token={token}"

    expires_at = datetime.now(timezone.utc) + timedelta(days=expires_in_days)

    logger.info(
        f"[PublicShare] User {current_user.id} created public share link "
        f"for attachment {attachment_id}, expires at {expires_at}"
    )

    return PublicShareLinkResponse(
        share_url=share_url, expires_at=expires_at.isoformat()
    )


@router.get("/download/shared")
async def public_download_attachment(
    token: str = Query(..., description="Public share token"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Download an attachment using a public share token.

    Any logged-in user can download the attachment using a valid share token,
    regardless of their direct access permissions to the original attachment.

    Args:
        token: Public share token generated by /{id}/public-share endpoint

    Returns:
        File binary data with appropriate content type
    """
    # Verify the share token
    try:
        token_data = _verify_public_share_token(token)
        attachment_id = token_data["attachment_id"]
    except HTTPException:
        raise HTTPException(status_code=403, detail="Invalid or expired share link")

    # Get the attachment (no permission check - token is sufficient)
    context = context_service.get_context_optional(db=db, context_id=attachment_id)

    if context is None or context.context_type != ContextType.ATTACHMENT.value:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Get binary data
    binary_data = context_service.get_attachment_binary_data(db=db, context=context)

    if binary_data is None:
        logger.error(
            f"[PublicDownload] Failed to retrieve binary data for attachment {attachment_id}"
        )
        raise HTTPException(
            status_code=500, detail="Failed to retrieve attachment data"
        )

    logger.info(
        f"[PublicDownload] User {current_user.id} downloaded attachment {attachment_id} "
        f"via public share link"
    )

    return Response(
        content=binary_data,
        media_type=context.mime_type,
        headers={
            "Content-Disposition": _build_content_disposition(context.original_filename)
        },
    )
