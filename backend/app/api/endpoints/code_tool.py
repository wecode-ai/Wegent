# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Code Tool API endpoints for executing code tasks in isolated Docker containers."""

import logging

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import Response, StreamingResponse

from app.core.config import settings
from app.core.security import get_current_user
from app.models.user import User
from app.schemas.code_tool import (
    ChunkUploadResponse,
    CodeToolExecuteRequest,
    SessionStatus,
)
from app.services.code_tool import CodeToolService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/code-tool", tags=["code-tool"])

# Initialize service
code_tool_service = CodeToolService()


def _check_code_tool_enabled():
    """Check if Code Tool is enabled."""
    if not getattr(settings, "CODE_TOOL_ENABLED", False):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Code Tool is not enabled",
        )


@router.post("/upload")
async def upload_file(
    file: UploadFile = File(...),
    session_id: str = Form(...),
    current_user: User = Depends(get_current_user),
):
    """
    Upload a file for Code Tool execution.

    The file will be available in the container at /workspace/input/{filename}.
    Maximum file size is configured via CODE_TOOL_MAX_FILE_SIZE.

    Args:
        file: The file to upload
        session_id: Chat session ID
        current_user: Authenticated user

    Returns:
        FileAttachment with file_id, filename, size, and target_path
    """
    _check_code_tool_enabled()

    try:
        # Read file content
        content = await file.read()

        # Check file size
        max_size = getattr(settings, "CODE_TOOL_MAX_FILE_SIZE", 100 * 1024 * 1024)
        if len(content) > max_size:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"File size exceeds maximum allowed size of {max_size} bytes",
            )

        # Store file
        file_info = await code_tool_service.upload_file(
            session_id=session_id,
            filename=file.filename or "uploaded_file",
            content=content,
        )

        # Add target path
        file_info["target_path"] = f"/workspace/input/{file_info['filename']}"

        logger.info(
            f"File uploaded: {file_info['filename']} for session {session_id}"
        )

        return file_info

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Error uploading file: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to upload file: {str(e)}",
        )


@router.post("/upload/chunk")
async def upload_chunk(
    chunk: UploadFile = File(...),
    upload_id: str = Form(...),
    chunk_index: int = Form(...),
    total_chunks: int = Form(...),
    session_id: str = Form(...),
    current_user: User = Depends(get_current_user),
) -> ChunkUploadResponse:
    """
    Upload a file chunk for large file uploads.

    Use this endpoint for files larger than 10MB. Upload chunks sequentially
    and call /upload/complete when all chunks are uploaded.

    Args:
        chunk: File chunk content
        upload_id: Unique upload session ID (generate on client)
        chunk_index: Index of this chunk (0-based)
        total_chunks: Total number of chunks
        session_id: Chat session ID
        current_user: Authenticated user

    Returns:
        ChunkUploadResponse with upload progress
    """
    _check_code_tool_enabled()

    # TODO: Implement chunked upload
    # For now, return a placeholder response
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="Chunked upload not yet implemented. Use single file upload for now.",
    )


@router.post("/upload/complete")
async def complete_upload(
    upload_id: str = Form(...),
    session_id: str = Form(...),
    current_user: User = Depends(get_current_user),
):
    """
    Complete a chunked upload and assemble the file.

    Call this after all chunks have been uploaded via /upload/chunk.

    Args:
        upload_id: Upload session ID used for chunks
        session_id: Chat session ID
        current_user: Authenticated user

    Returns:
        FileAttachment with assembled file info
    """
    _check_code_tool_enabled()

    # TODO: Implement chunked upload completion
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="Chunked upload not yet implemented. Use single file upload for now.",
    )


@router.post("/execute")
async def execute_code_tool(
    request: CodeToolExecuteRequest,
    current_user: User = Depends(get_current_user),
):
    """
    Execute Code Tool in an isolated Docker environment.

    This endpoint starts a Claude Code Agent in a Docker container and returns
    a streaming response (SSE) with execution progress and results.

    The agent has access to:
    - Full development environment (Python, Node.js, common tools)
    - File system operations
    - Network access for package installation
    - Persistent state within the same chat session

    Args:
        request: Execution request with prompt, files, and configuration
        current_user: Authenticated user

    Returns:
        StreamingResponse with SSE events
    """
    _check_code_tool_enabled()

    async def event_stream():
        async for event in code_tool_service.execute_stream(
            request=request,
            user_id=current_user.id,
        ):
            yield f"data: {event.model_dump_json()}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/download/{session_id}/{file_id}")
async def download_file(
    session_id: str,
    file_id: str,
    current_user: User = Depends(get_current_user),
):
    """
    Download an output file from Code Tool execution.

    Args:
        session_id: Session identifier
        file_id: File identifier
        current_user: Authenticated user

    Returns:
        File content with appropriate content-type
    """
    _check_code_tool_enabled()

    result = await code_tool_service.download_file(session_id, file_id)

    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found",
        )

    content, filename = result

    # Determine content type
    content_type = "application/octet-stream"
    if filename.endswith((".txt", ".md", ".py", ".js", ".ts", ".json", ".yaml", ".yml")):
        content_type = "text/plain; charset=utf-8"
    elif filename.endswith((".html", ".htm")):
        content_type = "text/html; charset=utf-8"
    elif filename.endswith(".css"):
        content_type = "text/css; charset=utf-8"
    elif filename.endswith(".csv"):
        content_type = "text/csv; charset=utf-8"
    elif filename.endswith(".pdf"):
        content_type = "application/pdf"
    elif filename.endswith((".png", ".jpg", ".jpeg", ".gif", ".webp")):
        ext = filename.rsplit(".", 1)[-1].lower()
        content_type = f"image/{ext}"
    elif filename.endswith(".svg"):
        content_type = "image/svg+xml"
    elif filename.endswith(".zip"):
        content_type = "application/zip"

    return Response(
        content=content,
        media_type=content_type,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(len(content)),
        },
    )


@router.get("/session/{session_id}/status", response_model=SessionStatus)
async def get_session_status(
    session_id: str,
    current_user: User = Depends(get_current_user),
) -> SessionStatus:
    """
    Get Code Tool session status.

    Returns information about the session including:
    - Container status (running, stopped, etc.)
    - Resource usage
    - Creation and last activity times

    Args:
        session_id: Session identifier
        current_user: Authenticated user

    Returns:
        SessionStatus with session information
    """
    _check_code_tool_enabled()

    status_info = await code_tool_service.get_session_status(session_id)

    return SessionStatus(
        session_id=session_id,
        container_id=status_info.get("container_id"),
        status=status_info.get("status", "idle"),
        created_at=status_info.get("created_at"),
        last_active=status_info.get("last_active"),
        resource_usage=status_info.get("resource_usage"),
    )


@router.delete("/session/{session_id}")
async def cleanup_session(
    session_id: str,
    current_user: User = Depends(get_current_user),
):
    """
    Clean up Code Tool session.

    This will:
    - Destroy the Docker container
    - Delete temporary files
    - Release resources

    Args:
        session_id: Session identifier
        current_user: Authenticated user

    Returns:
        Success message
    """
    _check_code_tool_enabled()

    success = await code_tool_service.cleanup_session(session_id)

    if success:
        return {"message": f"Session {session_id} cleaned up successfully"}
    else:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to fully cleanup session",
        )
