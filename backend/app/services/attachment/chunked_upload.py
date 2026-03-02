# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Chunked upload service for handling large file uploads.

This service provides a way to upload large files in smaller chunks,
avoiding gateway timeouts and improving upload reliability.

The chunked upload flow is:
1. Client calls init_chunked_upload() to start an upload session
2. Client uploads chunks via upload_chunk() in sequence
3. Client calls complete_chunked_upload() to finalize and process the file
4. Optionally, client can call abort_chunked_upload() to cancel

Temporary chunks are stored in Redis with an expiration time.
"""

import hashlib
import json
import logging
import time
import uuid
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.schemas.subtask_context import TruncationInfo
from app.services.attachment.parser import DocumentParseError, DocumentParser
from app.services.attachment.storage_backend import StorageError, generate_storage_key
from app.services.attachment.storage_factory import get_storage_backend
from shared.utils.crypto import encrypt_attachment

logger = logging.getLogger(__name__)


# Constants for chunked upload
CHUNK_SIZE = 5 * 1024 * 1024  # 5 MB per chunk
MAX_CHUNKS = 200  # Max 200 chunks = 1GB max file size
UPLOAD_EXPIRATION = 24 * 60 * 60  # 24 hours expiration for incomplete uploads
MAX_CONCURRENT_UPLOADS = 10  # Max concurrent uploads per user


@dataclass
class ChunkedUploadSession:
    """Represents an active chunked upload session."""

    upload_id: str
    user_id: int
    filename: str
    file_size: int
    total_chunks: int
    received_chunks: List[int]
    chunk_checksums: Dict[int, str]  # chunk_index -> md5 checksum
    created_at: float
    last_updated: float
    mime_type: str
    file_extension: str

    def to_dict(self) -> Dict:
        """Convert session to dictionary for storage."""
        return {
            "upload_id": self.upload_id,
            "user_id": self.user_id,
            "filename": self.filename,
            "file_size": self.file_size,
            "total_chunks": self.total_chunks,
            "received_chunks": self.received_chunks,
            "chunk_checksums": self.chunk_checksums,
            "created_at": self.created_at,
            "last_updated": self.last_updated,
            "mime_type": self.mime_type,
            "file_extension": self.file_extension,
        }

    @classmethod
    def from_dict(cls, data: Dict) -> "ChunkedUploadSession":
        """Create session from dictionary."""
        return cls(
            upload_id=data["upload_id"],
            user_id=data["user_id"],
            filename=data["filename"],
            file_size=data["file_size"],
            total_chunks=data["total_chunks"],
            received_chunks=data["received_chunks"],
            chunk_checksums=data["chunk_checksums"],
            created_at=data["created_at"],
            last_updated=data["last_updated"],
            mime_type=data["mime_type"],
            file_extension=data["file_extension"],
        )


class ChunkedUploadError(Exception):
    """Exception for chunked upload errors."""

    def __init__(self, message: str, error_code: str = "chunked_upload_error"):
        self.message = message
        self.error_code = error_code
        super().__init__(self.message)


class ChunkedUploadService:
    """
    Service for managing chunked file uploads.

    Uses Redis for temporary storage of upload sessions and chunks.
    """

    def __init__(self):
        self.parser = DocumentParser()
        self._redis_client = None

    def _get_redis_client(self):
        """Get Redis client lazily."""
        if self._redis_client is None:
            import os

            import redis

            redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
            self._redis_client = redis.from_url(redis_url)
        return self._redis_client

    def _session_key(self, upload_id: str) -> str:
        """Get Redis key for upload session."""
        return f"chunked_upload:session:{upload_id}"

    def _chunk_key(self, upload_id: str, chunk_index: int) -> str:
        """Get Redis key for chunk data."""
        return f"chunked_upload:chunk:{upload_id}:{chunk_index}"

    def _user_uploads_key(self, user_id: int) -> str:
        """Get Redis key for user's active uploads."""
        return f"chunked_upload:user:{user_id}:uploads"

    def init_chunked_upload(
        self,
        user_id: int,
        filename: str,
        file_size: int,
        chunk_size: int = CHUNK_SIZE,
    ) -> Tuple[str, int, int]:
        """
        Initialize a chunked upload session.

        Args:
            user_id: User ID
            filename: Original filename
            file_size: Total file size in bytes
            chunk_size: Size of each chunk (default: 5MB)

        Returns:
            Tuple of (upload_id, total_chunks, chunk_size)

        Raises:
            ChunkedUploadError: If validation fails or too many concurrent uploads
        """
        # Validate file size
        max_file_size = DocumentParser.get_max_file_size()
        if file_size > max_file_size:
            raise ChunkedUploadError(
                f"File size exceeds maximum limit ({max_file_size / (1024 * 1024)} MB)",
                error_code="file_too_large",
            )

        # Validate file extension
        import os

        _, extension = os.path.splitext(filename)
        extension = extension.lower()

        if not self.parser.is_supported_extension(extension):
            raise ChunkedUploadError(
                f"Unsupported file type: {extension}",
                error_code="unsupported_type",
            )

        # Calculate total chunks
        total_chunks = (file_size + chunk_size - 1) // chunk_size
        if total_chunks > MAX_CHUNKS:
            raise ChunkedUploadError(
                f"File too large: requires {total_chunks} chunks (max: {MAX_CHUNKS})",
                error_code="too_many_chunks",
            )

        # Check concurrent upload limit
        redis_client = self._get_redis_client()
        user_uploads_key = self._user_uploads_key(user_id)
        current_uploads = redis_client.scard(user_uploads_key)

        if current_uploads >= MAX_CONCURRENT_UPLOADS:
            raise ChunkedUploadError(
                f"Too many concurrent uploads (max: {MAX_CONCURRENT_UPLOADS})",
                error_code="too_many_uploads",
            )

        # Create upload session
        upload_id = str(uuid.uuid4())
        mime_type = self.parser.get_mime_type(extension)
        now = time.time()

        session = ChunkedUploadSession(
            upload_id=upload_id,
            user_id=user_id,
            filename=filename,
            file_size=file_size,
            total_chunks=total_chunks,
            received_chunks=[],
            chunk_checksums={},
            created_at=now,
            last_updated=now,
            mime_type=mime_type,
            file_extension=extension,
        )

        # Store session in Redis
        session_key = self._session_key(upload_id)
        redis_client.setex(
            session_key,
            UPLOAD_EXPIRATION,
            json.dumps(session.to_dict()),
        )

        # Track user's active uploads
        redis_client.sadd(user_uploads_key, upload_id)
        redis_client.expire(user_uploads_key, UPLOAD_EXPIRATION)

        logger.info(
            f"Initialized chunked upload: upload_id={upload_id}, "
            f"user_id={user_id}, filename={filename}, "
            f"file_size={file_size}, total_chunks={total_chunks}"
        )

        return upload_id, total_chunks, chunk_size

    def upload_chunk(
        self,
        upload_id: str,
        user_id: int,
        chunk_index: int,
        chunk_data: bytes,
        checksum: Optional[str] = None,
    ) -> Tuple[int, int]:
        """
        Upload a single chunk.

        Args:
            upload_id: Upload session ID
            user_id: User ID for authorization
            chunk_index: Index of this chunk (0-based)
            chunk_data: Binary chunk data
            checksum: Optional MD5 checksum for verification

        Returns:
            Tuple of (received_chunks_count, total_chunks)

        Raises:
            ChunkedUploadError: If validation fails
        """
        redis_client = self._get_redis_client()

        # Get session
        session_key = self._session_key(upload_id)
        session_data = redis_client.get(session_key)

        if not session_data:
            raise ChunkedUploadError(
                f"Upload session not found or expired: {upload_id}",
                error_code="session_not_found",
            )

        session = ChunkedUploadSession.from_dict(json.loads(session_data))

        # Verify user ownership
        if session.user_id != user_id:
            raise ChunkedUploadError(
                "Unauthorized access to upload session",
                error_code="unauthorized",
            )

        # Validate chunk index
        if chunk_index < 0 or chunk_index >= session.total_chunks:
            raise ChunkedUploadError(
                f"Invalid chunk index: {chunk_index} (valid: 0-{session.total_chunks - 1})",
                error_code="invalid_chunk_index",
            )

        # Verify checksum if provided
        if checksum:
            actual_checksum = hashlib.md5(chunk_data).hexdigest()
            if actual_checksum != checksum:
                raise ChunkedUploadError(
                    f"Chunk checksum mismatch for chunk {chunk_index}",
                    error_code="checksum_mismatch",
                )

        # Store chunk
        chunk_key = self._chunk_key(upload_id, chunk_index)
        redis_client.setex(chunk_key, UPLOAD_EXPIRATION, chunk_data)

        # Update session atomically using Redis WATCH/MULTI
        # This prevents race conditions when multiple chunks are uploaded concurrently
        chunk_checksum = hashlib.md5(chunk_data).hexdigest()  # noqa: S324
        max_retries = 5
        for retry in range(max_retries):
            try:
                # Watch the session key for changes
                redis_client.watch(session_key)

                # Re-read session data
                session_data = redis_client.get(session_key)
                if not session_data:
                    redis_client.unwatch()
                    raise ChunkedUploadError(
                        f"Upload session expired during chunk upload: {upload_id}",
                        error_code="session_not_found",
                    )

                session = ChunkedUploadSession.from_dict(json.loads(session_data))

                # Update session
                if chunk_index not in session.received_chunks:
                    session.received_chunks.append(chunk_index)
                    session.received_chunks.sort()

                session.chunk_checksums[chunk_index] = chunk_checksum
                session.last_updated = time.time()

                # Execute atomic update
                pipe = redis_client.pipeline()
                pipe.setex(
                    session_key,
                    UPLOAD_EXPIRATION,
                    json.dumps(session.to_dict()),
                )
                pipe.execute()
                break  # Success
            except Exception as e:
                # Check if it's a WatchError (concurrent modification)
                if "WATCH" in str(type(e).__name__) or "WatchError" in str(e):
                    if retry < max_retries - 1:
                        logger.debug(
                            f"Retrying session update due to concurrent modification: "
                            f"upload_id={upload_id}, chunk_index={chunk_index}, retry={retry + 1}"
                        )
                        continue
                    else:
                        logger.warning(
                            f"Max retries reached for session update: "
                            f"upload_id={upload_id}, chunk_index={chunk_index}"
                        )
                raise

        logger.debug(
            f"Uploaded chunk: upload_id={upload_id}, chunk_index={chunk_index}, "
            f"received={len(session.received_chunks)}/{session.total_chunks}"
        )

        return len(session.received_chunks), session.total_chunks

    def complete_chunked_upload(
        self,
        db: Session,
        upload_id: str,
        user_id: int,
    ) -> Tuple[SubtaskContext, Optional[TruncationInfo]]:
        """
        Complete the chunked upload by assembling chunks and processing the file.

        Args:
            db: Database session
            upload_id: Upload session ID
            user_id: User ID for authorization

        Returns:
            Tuple of (Created SubtaskContext, TruncationInfo if truncated)

        Raises:
            ChunkedUploadError: If validation fails or chunks are missing
        """
        redis_client = self._get_redis_client()

        # Get session
        session_key = self._session_key(upload_id)
        session_data = redis_client.get(session_key)

        if not session_data:
            raise ChunkedUploadError(
                f"Upload session not found or expired: {upload_id}",
                error_code="session_not_found",
            )

        session = ChunkedUploadSession.from_dict(json.loads(session_data))

        # Verify user ownership
        if session.user_id != user_id:
            raise ChunkedUploadError(
                "Unauthorized access to upload session",
                error_code="unauthorized",
            )

        # Check all chunks are received
        if len(session.received_chunks) != session.total_chunks:
            missing = set(range(session.total_chunks)) - set(session.received_chunks)
            raise ChunkedUploadError(
                f"Missing chunks: {sorted(missing)[:10]}{'...' if len(missing) > 10 else ''}",
                error_code="missing_chunks",
            )

        # Assemble all chunks
        logger.info(f"Assembling {session.total_chunks} chunks for upload {upload_id}")
        binary_data_parts = []

        for i in range(session.total_chunks):
            chunk_key = self._chunk_key(upload_id, i)
            chunk_data = redis_client.get(chunk_key)

            if chunk_data is None:
                raise ChunkedUploadError(
                    f"Chunk {i} data not found",
                    error_code="chunk_data_missing",
                )

            binary_data_parts.append(chunk_data)

        binary_data = b"".join(binary_data_parts)

        # Verify total size
        if len(binary_data) != session.file_size:
            raise ChunkedUploadError(
                f"Assembled file size mismatch: expected {session.file_size}, got {len(binary_data)}",
                error_code="size_mismatch",
            )

        logger.info(f"Assembled file: upload_id={upload_id}, size={len(binary_data)}")

        # Create attachment context using the same logic as regular upload
        try:
            context, truncation_info = self._create_attachment_from_binary(
                db=db,
                user_id=user_id,
                filename=session.filename,
                binary_data=binary_data,
                extension=session.file_extension,
                mime_type=session.mime_type,
            )
        except Exception as e:
            logger.exception(f"Failed to create attachment from chunked upload: {e}")
            raise

        # Cleanup Redis data
        self._cleanup_upload_session(upload_id, user_id, session.total_chunks)

        logger.info(
            f"Completed chunked upload: upload_id={upload_id}, "
            f"attachment_id={context.id}, filename={session.filename}"
        )

        return context, truncation_info

    def _create_attachment_from_binary(
        self,
        db: Session,
        user_id: int,
        filename: str,
        binary_data: bytes,
        extension: str,
        mime_type: str,
    ) -> Tuple[SubtaskContext, Optional[TruncationInfo]]:
        """
        Create attachment context from assembled binary data.

        This is similar to context_service.upload_attachment but accepts
        pre-validated binary data.
        """
        import os as _os

        from app.services.context import context_service

        # Reuse the context service's upload_attachment method
        # This ensures consistent behavior with regular uploads
        return context_service.upload_attachment(
            db=db,
            user_id=user_id,
            filename=filename,
            binary_data=binary_data,
        )

    def abort_chunked_upload(
        self,
        upload_id: str,
        user_id: int,
    ) -> bool:
        """
        Abort a chunked upload and cleanup resources.

        Args:
            upload_id: Upload session ID
            user_id: User ID for authorization

        Returns:
            True if aborted successfully

        Raises:
            ChunkedUploadError: If session not found or unauthorized
        """
        redis_client = self._get_redis_client()

        # Get session
        session_key = self._session_key(upload_id)
        session_data = redis_client.get(session_key)

        if not session_data:
            raise ChunkedUploadError(
                f"Upload session not found or expired: {upload_id}",
                error_code="session_not_found",
            )

        session = ChunkedUploadSession.from_dict(json.loads(session_data))

        # Verify user ownership
        if session.user_id != user_id:
            raise ChunkedUploadError(
                "Unauthorized access to upload session",
                error_code="unauthorized",
            )

        # Cleanup
        self._cleanup_upload_session(upload_id, user_id, session.total_chunks)

        logger.info(f"Aborted chunked upload: upload_id={upload_id}")

        return True

    def _cleanup_upload_session(
        self,
        upload_id: str,
        user_id: int,
        total_chunks: int,
    ) -> None:
        """Cleanup all Redis data for an upload session."""
        redis_client = self._get_redis_client()

        # Delete session
        session_key = self._session_key(upload_id)
        redis_client.delete(session_key)

        # Delete all chunks
        for i in range(total_chunks):
            chunk_key = self._chunk_key(upload_id, i)
            redis_client.delete(chunk_key)

        # Remove from user's active uploads
        user_uploads_key = self._user_uploads_key(user_id)
        redis_client.srem(user_uploads_key, upload_id)

    def get_upload_status(
        self,
        upload_id: str,
        user_id: int,
    ) -> Dict:
        """
        Get status of a chunked upload.

        Args:
            upload_id: Upload session ID
            user_id: User ID for authorization

        Returns:
            Status dictionary with progress information

        Raises:
            ChunkedUploadError: If session not found or unauthorized
        """
        redis_client = self._get_redis_client()

        # Get session
        session_key = self._session_key(upload_id)
        session_data = redis_client.get(session_key)

        if not session_data:
            raise ChunkedUploadError(
                f"Upload session not found or expired: {upload_id}",
                error_code="session_not_found",
            )

        session = ChunkedUploadSession.from_dict(json.loads(session_data))

        # Verify user ownership
        if session.user_id != user_id:
            raise ChunkedUploadError(
                "Unauthorized access to upload session",
                error_code="unauthorized",
            )

        return {
            "upload_id": session.upload_id,
            "filename": session.filename,
            "file_size": session.file_size,
            "total_chunks": session.total_chunks,
            "received_chunks": len(session.received_chunks),
            "missing_chunks": sorted(
                set(range(session.total_chunks)) - set(session.received_chunks)
            ),
            "progress_percent": round(
                len(session.received_chunks) / session.total_chunks * 100, 1
            ),
            "created_at": session.created_at,
            "last_updated": session.last_updated,
        }


# Singleton instance
chunked_upload_service = ChunkedUploadService()
