# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Context service for managing subtask contexts.

Unified service for handling attachments, knowledge bases, and other
context types that can be associated with subtasks.
"""

import logging
import os
from typing import Any, Dict, List, Optional, Tuple, Union

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.subtask_context import (
    ContextStatus,
    ContextType,
    InjectionMode,
    SubtaskContext,
)
from app.schemas.subtask_context import (
    KnowledgeBaseContextCreate,
    SubtaskContextBrief,
    TruncationInfo,
)
from app.services.attachment.parser import (
    DocumentParseError,
    DocumentParser,
    ParseResult,
)
from app.services.attachment.storage_backend import StorageError, generate_storage_key
from app.services.attachment.storage_factory import get_storage_backend
from app.stores.tasks import subtask_store
from shared.telemetry.decorators import trace_sync
from shared.utils.attachment_block import (
    build_attachment_download_url,
    build_attachment_header,
    build_sandbox_path,
    build_truncation_note,
    format_file_size,
    truncate_for_injection,
)
from shared.utils.crypto import decrypt_attachment, encrypt_attachment
from shared.utils.multimodal_ext import is_multimodal_extension

logger = logging.getLogger(__name__)


def _should_encrypt() -> bool:
    """Check if attachment encryption is enabled."""
    return os.environ.get("ATTACHMENT_ENCRYPTION_ENABLED", "false").lower() == "true"


class NotFoundException(Exception):
    """Exception raised when a context is not found."""

    pass


class ContextService:
    """
    Unified context service for attachments and knowledge bases.

    Replaces the original AttachmentService with a more flexible design
    that supports multiple context types.
    """

    def __init__(self):
        self.parser = DocumentParser()

    # Placeholder subtask_id for contexts not yet linked to a subtask
    UNLINKED_SUBTASK_ID = 0

    # Image file extensions supported for vision models
    IMAGE_EXTENSIONS = frozenset([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"])

    # ==================== Helper Methods ====================

    # File-size / URL / sandbox-path formatting is shared with chat_shell's
    # history loader (single source of truth in shared.utils.attachment_block)
    # so the attachment block format stays consistent across first-send and
    # history replay. These thin wrappers preserve the existing public API.
    @staticmethod
    def format_file_size(size_bytes: int) -> str:
        """Format file size in bytes to human-readable format."""
        return format_file_size(size_bytes)

    @staticmethod
    def build_attachment_url(attachment_id: int) -> str:
        """Build the download URL for an attachment."""
        return build_attachment_download_url(attachment_id)

    @staticmethod
    def build_sandbox_path(
        task_id: Optional[int],
        subtask_id: Optional[int],
        filename: str,
    ) -> Optional[str]:
        """Build the sandbox file path where the Executor downloads an attachment."""
        return build_sandbox_path(task_id, subtask_id, filename)

    # ==================== Attachment Operations ====================

    def _validate_attachment_input(
        self,
        filename: str,
        binary_data: bytes,
    ) -> Tuple[str, int, str]:
        """
        Validate attachment input and return basic metadata.

        Returns:
            Tuple of (extension, file_size, mime_type)
        """
        _, extension = os.path.splitext(filename)
        extension = extension.lower()

        if not self.parser.is_supported_extension(extension):
            raise ValueError(
                f"Unsupported file type: {extension}. "
                f"Supported types: {', '.join(self.parser.SUPPORTED_EXTENSIONS.keys())}"
            )

        file_size = len(binary_data)
        if not self.parser.validate_file_size(file_size):
            max_size_mb = DocumentParser.get_max_file_size() / (1024 * 1024)
            raise ValueError(f"File size exceeds maximum limit ({max_size_mb} MB)")

        mime_type = self.parser.get_mime_type(extension)
        return extension, file_size, mime_type

    @staticmethod
    def _build_attachment_type_data(
        filename: str,
        extension: str,
        file_size: int,
        mime_type: str,
        storage_backend: str,
        storage_key: str,
    ) -> Dict[str, Any]:
        """Build type_data payload for attachment contexts."""
        return {
            "original_filename": filename,
            "file_extension": extension,
            "file_size": file_size,
            "mime_type": mime_type,
            "storage_backend": storage_backend,
            "storage_key": storage_key,
        }

    def _create_attachment_context(
        self,
        user_id: int,
        filename: str,
        extension: str,
        file_size: int,
        mime_type: str,
        subtask_id: int,
        storage_backend: str,
    ) -> SubtaskContext:
        """Create a new attachment context with uploading status."""
        effective_subtask_id = (
            subtask_id if subtask_id > 0 else self.UNLINKED_SUBTASK_ID
        )

        return SubtaskContext(
            subtask_id=effective_subtask_id,
            user_id=user_id,
            context_type=ContextType.ATTACHMENT.value,
            name=filename,
            status=ContextStatus.UPLOADING.value,
            binary_data=b"",
            image_base64="",
            extracted_text="",
            text_length=0,
            error_message="",
            type_data=self._build_attachment_type_data(
                filename=filename,
                extension=extension,
                file_size=file_size,
                mime_type=mime_type,
                storage_backend=storage_backend,
                storage_key="",
            ),
        )

    def _reset_attachment_context(
        self,
        context: SubtaskContext,
        filename: str,
        extension: str,
        file_size: int,
        mime_type: str,
        storage_backend: str,
        storage_key: str,
    ) -> None:
        """Reset an existing attachment context for overwrite."""
        context.name = filename
        context.status = ContextStatus.UPLOADING.value
        context.error_message = ""
        context.binary_data = b""
        context.image_base64 = ""
        context.extracted_text = ""
        context.text_length = 0

        base_type_data = context.type_data or {}
        updated_type_data = self._build_attachment_type_data(
            filename=filename,
            extension=extension,
            file_size=file_size,
            mime_type=mime_type,
            storage_backend=storage_backend,
            storage_key=storage_key,
        )
        context.type_data = {**base_type_data, **updated_type_data}

    def _store_attachment_binary(
        self,
        storage_backend,
        context: SubtaskContext,
        filename: str,
        mime_type: str,
        file_size: int,
        binary_data: bytes,
    ) -> None:
        """Save attachment binary data with encryption metadata."""
        is_encrypted = _should_encrypt()
        data_to_store = encrypt_attachment(binary_data) if is_encrypted else binary_data

        if is_encrypted:
            logger.info(f"Encrypted attachment data for context {context.id}")

        metadata = {
            "filename": filename,
            "mime_type": mime_type,
            "file_size": file_size,
            "user_id": context.user_id,
            "is_encrypted": is_encrypted,
        }
        storage_backend.save(context.storage_key, data_to_store, metadata)

        base_type_data = context.type_data or {}
        context.type_data = {
            **base_type_data,
            "is_encrypted": is_encrypted,
            "encryption_version": 1 if is_encrypted else 0,
        }

    def _parse_and_update_context(
        self,
        context: SubtaskContext,
        binary_data: bytes,
        extension: str,
    ) -> Optional[TruncationInfo]:
        """Parse attachment data and update context fields."""
        # Multimodal files (video/image) are not text-parseable. They are
        # analyzed by the Gemini multimodal pipeline (convert_multimodal task)
        # which produces Markdown. Skip text extraction here — the file is
        # stored as binary and the converter fetches it via the download endpoint.
        if is_multimodal_extension(extension):
            context.extracted_text = ""
            context.text_length = 0
            context.image_base64 = ""
            context.status = ContextStatus.READY.value
            context.type_data = {
                **(context.type_data or {}),
                "is_truncated": False,
            }
            logger.info(
                "Skipping text parse for multimodal file: context=%s ext=%s",
                context.id,
                extension,
            )
            return None

        truncation_info = None
        try:
            parse_result: ParseResult = self.parser.parse(binary_data, extension)

            context.extracted_text = parse_result.text if parse_result.text else ""
            context.text_length = (
                parse_result.text_length if parse_result.text_length else 0
            )
            context.image_base64 = (
                parse_result.image_base64 if parse_result.image_base64 else ""
            )
            # Sync mime_type when image was converted to a different format during parsing
            if (
                parse_result.image_mime_type
                and parse_result.image_mime_type != context.mime_type
            ):
                context.type_data = {
                    **context.type_data,
                    "mime_type": parse_result.image_mime_type,
                }
            context.status = ContextStatus.READY.value

            # Persist the parse-time truncation flag so the injected attachment
            # block can render a partial-content notice for modes without the
            # chat_shell preview (executor / device). Always write it (even when
            # False) so overwriting a previously-truncated attachment with a
            # smaller, non-truncated file clears the stale True.
            context.type_data = {
                **context.type_data,
                "is_truncated": bool(
                    parse_result.truncation_info
                    and parse_result.truncation_info.is_truncated
                ),
            }
            if parse_result.truncation_info:
                truncation_info = TruncationInfo(
                    is_truncated=parse_result.truncation_info.is_truncated,
                    original_length=parse_result.truncation_info.original_length,
                    truncated_length=parse_result.truncation_info.truncated_length,
                )
        except DocumentParseError as e:
            logger.exception(f"Document parsing failed for context {context.id}: {e}")
            context.status = ContextStatus.FAILED.value
            context.error_message = str(e)
            raise

        return truncation_info

    def upload_attachment(
        self,
        db: Session,
        user_id: int,
        filename: str,
        binary_data: bytes,
        subtask_id: int = 0,
    ) -> Tuple[SubtaskContext, Optional[TruncationInfo]]:
        """
        Upload and process a file attachment.

        Args:
            db: Database session
            user_id: User ID
            filename: Original filename
            binary_data: File binary data
            subtask_id: Subtask ID to link to (0 means unlinked)

        Returns:
            Tuple of (Created SubtaskContext record, TruncationInfo if truncated)

        Raises:
            ValueError: If file validation fails
            DocumentParseError: If document parsing fails
            StorageError: If storage operation fails
        """
        extension, file_size, mime_type = self._validate_attachment_input(
            filename, binary_data
        )

        # Get the storage backend
        storage_backend = get_storage_backend(db)

        context = self._create_attachment_context(
            user_id=user_id,
            filename=filename,
            extension=extension,
            file_size=file_size,
            mime_type=mime_type,
            subtask_id=subtask_id,
            storage_backend=storage_backend.backend_type,
        )
        db.add(context)
        db.flush()  # Get the ID

        # Generate storage key and save to storage backend
        storage_key = generate_storage_key(context.id, user_id)
        context.type_data = {
            **context.type_data,
            "storage_key": storage_key,
        }

        try:
            self._store_attachment_binary(
                storage_backend=storage_backend,
                context=context,
                filename=filename,
                mime_type=mime_type,
                file_size=file_size,
                binary_data=binary_data,
            )
        except StorageError as e:
            logger.exception(f"Failed to save context {context.id} to storage: {e}")
            db.rollback()
            raise

        # Update status to PARSING
        context.status = ContextStatus.PARSING.value
        db.flush()

        # Parse document
        try:
            truncation_info = self._parse_and_update_context(
                context=context,
                binary_data=binary_data,
                extension=extension,
            )
        except DocumentParseError as e:
            db.commit()
            raise

        db.commit()
        db.refresh(context)

        logger.info(
            f"Attachment uploaded successfully: id={context.id}, "
            f"filename={filename}, text_length={context.text_length}, "
            f"storage_backend={storage_backend.backend_type}, "
            f"truncated={truncation_info.is_truncated if truncation_info else False}"
        )

        return context, truncation_info

    def overwrite_attachment(
        self,
        db: Session,
        context_id: int,
        user_id: int,
        filename: str,
        binary_data: bytes,
    ) -> Tuple[SubtaskContext, Optional[TruncationInfo]]:
        """
        Overwrite an existing attachment with owner validation.

        Args:
            db: Database session
            context_id: Attachment context ID to overwrite
            user_id: User ID for ownership validation (required)
            filename: New filename
            binary_data: New file binary data

        Returns:
            Tuple of (Updated SubtaskContext record, TruncationInfo if truncated)

        Raises:
            NotFoundException: If context not found or user is not the owner
        """
        context = self.get_context(db, context_id, user_id)
        if context.context_type != ContextType.ATTACHMENT.value:
            raise NotFoundException(f"Context {context_id} not found")

        return self._overwrite_attachment_impl(db, context, filename, binary_data)

    def overwrite_attachment_internal(
        self,
        db: Session,
        context_id: int,
        filename: str,
        reason: str,
        binary_data: bytes,
    ) -> Tuple[SubtaskContext, Optional[TruncationInfo]]:
        """
        Overwrite an existing attachment without owner validation.

        Trusted internal path — caller must enforce business-level authorization
        before calling. Used by knowledge management and conversion callbacks
        where the caller has already verified permissions at a higher level.

        Args:
            db: Database session
            context_id: Attachment context ID to overwrite
            filename: New filename
            reason: Audit reason (e.g. "knowledge_manage", "conversion_callback")
            binary_data: New file binary data

        Returns:
            Tuple of (Updated SubtaskContext record, TruncationInfo if truncated)

        Raises:
            NotFoundException: If context not found
        """
        context = self.get_context(db, context_id)
        if context.context_type != ContextType.ATTACHMENT.value:
            raise NotFoundException(f"Context {context_id} not found")

        logger.info(
            f"Internal attachment overwrite: context_id={context_id}, "
            f"reason={reason}, owner_user_id={context.user_id}"
        )

        return self._overwrite_attachment_impl(db, context, filename, binary_data)

    def _overwrite_attachment_impl(
        self,
        db: Session,
        context: SubtaskContext,
        filename: str,
        binary_data: bytes,
    ) -> Tuple[SubtaskContext, Optional[TruncationInfo]]:
        """Shared implementation for attachment overwrite."""
        extension, file_size, mime_type = self._validate_attachment_input(
            filename, binary_data
        )

        storage_backend = get_storage_backend(db)
        storage_key = context.storage_key or generate_storage_key(
            context.id, context.user_id
        )

        self._reset_attachment_context(
            context=context,
            filename=filename,
            extension=extension,
            file_size=file_size,
            mime_type=mime_type,
            storage_backend=storage_backend.backend_type,
            storage_key=storage_key,
        )
        db.flush()

        try:
            self._store_attachment_binary(
                storage_backend=storage_backend,
                context=context,
                filename=filename,
                mime_type=mime_type,
                file_size=file_size,
                binary_data=binary_data,
            )
        except StorageError as e:
            logger.exception(
                f"Failed to overwrite context {context.id} in storage: {e}"
            )
            db.rollback()
            raise

        context.status = ContextStatus.PARSING.value
        db.flush()

        try:
            truncation_info = self._parse_and_update_context(
                context=context,
                binary_data=binary_data,
                extension=extension,
            )
        except DocumentParseError:
            db.commit()
            raise

        db.commit()
        db.refresh(context)

        logger.info(
            f"Attachment overwritten successfully: id={context.id}, "
            f"filename={filename}, text_length={context.text_length}, "
            f"storage_backend={storage_backend.backend_type}, "
            f"truncated={truncation_info.is_truncated if truncation_info else False}"
        )

        return context, truncation_info

    def get_attachment_binary_data(
        self,
        db: Session,
        context: SubtaskContext,
    ) -> Optional[bytes]:
        """
        Get binary data for an attachment from the appropriate storage backend.

        Decryption is handled at this service layer, so storage backends
        don't need to implement encryption/decryption logic.

        Args:
            db: Database session
            context: SubtaskContext record

        Returns:
            Binary data (decrypted if necessary) or None if not found
        """
        if context.context_type != ContextType.ATTACHMENT.value:
            return None

        storage_key = context.storage_key
        if not storage_key:
            logger.warning(
                f"Context {context.id} has no storage_key for storage backend"
            )
            return None

        # Retrieve raw data from storage backend
        storage_backend = get_storage_backend(db)
        binary_data = storage_backend.get(storage_key)

        if binary_data is None:
            return None

        # Decrypt at service layer if data is encrypted
        is_encrypted = False
        if context.type_data and isinstance(context.type_data, dict):
            is_encrypted = context.type_data.get("is_encrypted", False)

        if is_encrypted:
            logger.debug(f"Decrypting attachment data for context {context.id}")
            binary_data = decrypt_attachment(binary_data)

        return binary_data

    def copy_attachment_for_user(
        self,
        db: Session,
        source_context: SubtaskContext,
        target_user_id: int,
        source_metadata: Optional[Dict[str, Any]] = None,
    ) -> SubtaskContext:
        """Copy a trusted source attachment into a target user's unlinked context.

        This is used for system-owned templates such as quick launch preset
        attachments. Callers must verify the source context is allowed by their
        business rules before invoking this method.
        """
        if source_context.context_type != ContextType.ATTACHMENT.value:
            raise ValueError("source_context must be an attachment")
        if source_context.status != ContextStatus.READY.value:
            raise ValueError("source attachment must be ready")
        if target_user_id <= 0:
            raise ValueError("target_user_id must be positive")

        binary_data = self.get_attachment_binary_data(db, source_context)
        if binary_data is None:
            raise StorageError(
                f"Failed to read source attachment {source_context.id} binary data"
            )

        storage_backend = get_storage_backend(db)
        copied_context = self._create_attachment_context(
            user_id=target_user_id,
            filename=source_context.original_filename,
            extension=source_context.file_extension,
            file_size=source_context.file_size,
            mime_type=source_context.mime_type,
            subtask_id=self.UNLINKED_SUBTASK_ID,
            storage_backend=storage_backend.backend_type,
        )
        db.add(copied_context)
        db.flush()

        storage_key = generate_storage_key(copied_context.id, target_user_id)
        copied_context.type_data = {
            **copied_context.type_data,
            "storage_key": storage_key,
            "source_attachment_id": source_context.id,
            **(source_metadata or {}),
        }

        try:
            self._store_attachment_binary(
                storage_backend=storage_backend,
                context=copied_context,
                filename=copied_context.original_filename,
                mime_type=copied_context.mime_type,
                file_size=copied_context.file_size,
                binary_data=binary_data,
            )
        except StorageError as e:
            logger.exception(
                f"Failed to copy source attachment {source_context.id}: {e}"
            )
            db.rollback()
            raise

        copied_context.extracted_text = source_context.extracted_text or ""
        copied_context.text_length = source_context.text_length or 0
        copied_context.image_base64 = source_context.image_base64 or ""
        copied_context.status = ContextStatus.READY.value
        copied_context.error_message = ""

        db.commit()
        db.refresh(copied_context)

        logger.info(
            f"Copied attachment {source_context.id} for user {target_user_id}: "
            f"new_context_id={copied_context.id}"
        )
        return copied_context

    def get_attachment_url(
        self,
        db: Session,
        context: SubtaskContext,
        expires: int = 3600,
    ) -> Optional[str]:
        """
        Get a URL for accessing the attachment file.

        Only supported for storage backends that provide URL access (S3, MinIO).
        Returns None for MySQL backend.

        Args:
            db: Database session
            context: SubtaskContext record
            expires: URL expiration time in seconds (default: 3600)

        Returns:
            URL string if supported, None otherwise
        """
        if context.context_type != ContextType.ATTACHMENT.value:
            return None

        storage_key = context.storage_key
        if not storage_key or context.storage_backend == "mysql":
            return None

        storage_backend = get_storage_backend(db)
        return storage_backend.get_url(storage_key, expires)

    def is_image_context(self, context: SubtaskContext) -> bool:
        """
        Check if context is an image attachment.

        Args:
            context: SubtaskContext record

        Returns:
            True if the context is an image attachment
        """
        if context.context_type != ContextType.ATTACHMENT.value:
            return False
        return context.file_extension.lower() in self.IMAGE_EXTENSIONS

    def build_vision_content_block(
        self,
        context: SubtaskContext,
    ) -> Optional[Dict[str, Any]]:
        """
        Build an OpenAI-compatible vision content block for an image attachment.

        Args:
            context: SubtaskContext record with image_base64 data

        Returns:
            Vision content block dict, or None if not an image or no image data
        """
        if not self.is_image_context(context) or not context.image_base64:
            return None

        return {
            "type": "image_url",
            "image_url": {
                "url": f"data:{context.mime_type};base64,{context.image_base64}"
            },
        }

    def build_document_text_prefix(
        self,
        context: SubtaskContext,
        task_id: Optional[int] = None,
        subtask_id: Optional[int] = None,
    ) -> Optional[str]:
        """
        Build a text prefix containing document content for prepending to messages.

        Includes attachment metadata (id, filename, mime_type, file_size, url, sandbox_path).

        Args:
            context: SubtaskContext record with extracted_text
            task_id: Optional task ID for building sandbox path
            subtask_id: Optional subtask ID for building sandbox path
        Returns:
            Formatted text prefix without XML tags, or None if no extracted text
        """
        if not context.extracted_text:
            return None

        # Build attachment metadata header (shared with chat_shell loader).
        # When the parser truncated the file, prepend a length-free partial-content
        # notice so modes without the chat_shell preview (executor / device) still
        # know the text is incomplete and the full file should be read.
        filename = context.original_filename
        sandbox_path = build_sandbox_path(task_id, subtask_id, filename)
        header = build_attachment_header(
            attachment_id=context.id,
            filename=filename,
            mime_type=context.mime_type or "unknown",
            file_size=context.file_size or 0,
            sandbox_path=sandbox_path,
        )
        # Bound the inline copy: the injected text is only a preview (the full
        # file stays reachable via the downloaded file / sandbox, or read_attachment
        # in chat_shell), so cap it well below the stored length. This is the only
        # length guard for modes without the chat_shell token preview (executor /
        # device).
        inject_text, inj_truncated = truncate_for_injection(
            context.extracted_text, settings.ATTACHMENT_INJECT_MAX_CHARS
        )
        # Single partial-content signal: when the injection was capped, its inline
        # marker already flags partiality and points to the file. Fall back to a
        # prefix note only when parsing truncated the stored text but the inject
        # cap did not re-truncate (rare; e.g. an unusually small cap).
        note = build_truncation_note(context.is_truncated and not inj_truncated)
        return f"{header}\n{note}{inject_text}\n\n"

    # ==================== Knowledge Base Operations ====================

    def create_knowledge_base_context(
        self,
        db: Session,
        user_id: int,
        data: KnowledgeBaseContextCreate,
        subtask_id: int = 0,
    ) -> SubtaskContext:
        """
        Create knowledge base context reference.

        Args:
            db: Database session
            user_id: User ID
            data: Knowledge base context data
            subtask_id: Subtask ID to link to (0 means unlinked)

        Returns:
            Created SubtaskContext record
        """
        context = SubtaskContext(
            subtask_id=subtask_id,
            user_id=user_id,
            context_type=ContextType.KNOWLEDGE_BASE.value,
            name=data.name,
            status=ContextStatus.READY.value,
            binary_data=b"",  # Empty bytes for NOT NULL constraint
            image_base64="",  # Empty string for NOT NULL constraint
            extracted_text="",  # Empty string for NOT NULL constraint (will be filled by RAG)
            error_message="",  # Empty string for NOT NULL constraint
            type_data={
                "knowledge_id": data.knowledge_id,
                "document_count": data.document_count,
            },
        )
        db.add(context)
        db.commit()
        db.refresh(context)

        logger.info(
            f"Knowledge base context created: id={context.id}, "
            f"knowledge_id={data.knowledge_id}, name={data.name}"
        )

        return context

    @trace_sync(
        span_name="update_knowledge_base_retrieval_result",
        tracer_name="context_service",
    )
    def update_knowledge_base_retrieval_result(
        self,
        db: Session,
        context_id: int,
        extracted_text: str,
        sources: List[Dict[str, Any]],
        injection_mode: str,
        query: str,
        chunks_count: int,
        restricted_mode: bool = False,
    ) -> Optional[SubtaskContext]:
        """
        Update knowledge base context with RAG retrieval results.

        For direct_injection mode, extracted_text is not stored (empty string)
        since the full content is injected into context and doesn't need to be
        persisted for observability.

        Args:
            db: Database session
            context_id: Context ID to update
            extracted_text: Concatenated retrieval text from RAG (ignored for direct injection)
            sources: List of source info dicts with document_name, chunk_id, score
            injection_mode: "direct_injection" or "rag_retrieval"
            query: Original search query
            chunks_count: Number of chunks retrieved/injected
            restricted_mode: Whether this result came from Restricted Analyst mode

        Returns:
            Updated SubtaskContext or None if not found
        """
        context = self.get_context_optional(db, context_id)
        if context is None:
            logger.warning(f"Context {context_id} not found for RAG result update")
            return None

        if context.context_type != ContextType.KNOWLEDGE_BASE.value:
            logger.warning(
                f"Context {context_id} is not a knowledge_base type, skipping RAG update"
            )
            return None

        # For direct_injection mode, don't store extracted_text (save storage space)
        # For rag_retrieval mode, store the extracted text normally
        if injection_mode == InjectionMode.DIRECT_INJECTION.value:
            context.extracted_text = ""
            context.text_length = 0
        else:
            context.extracted_text = extracted_text
            context.text_length = len(extracted_text) if extracted_text else 0

        # Set status based on chunks_count
        if chunks_count > 0:
            context.status = ContextStatus.READY.value
        else:
            context.status = ContextStatus.EMPTY.value

        # Update type_data with rag_result sub-object for better structure
        current_type_data = context.type_data or {}
        existing_rag_result = current_type_data.get("rag_result", {})

        # Increment retrieval_count to track multiple tool calls
        retrieval_count = existing_rag_result.get("retrieval_count", 0) + 1

        # Build rag_result sub-object
        rag_result = {
            "sources": sources,
            "injection_mode": injection_mode,
            "query": query,
            "chunks_count": chunks_count,
            "retrieval_count": retrieval_count,
            "restricted_mode": restricted_mode,
        }

        # Preserve existing fields (like kb_head_result) and update rag_result
        # Note: Flat fields removed to avoid duplication - use rag_result sub-object
        context.type_data = {
            **current_type_data,
            "rag_result": rag_result,
        }

        db.commit()
        db.refresh(context)

        logger.info(
            f"Knowledge base context {context_id} updated with RAG results: "
            f"injection_mode={injection_mode}, chunks_count={chunks_count}, "
            f"status={context.status}, sources_count={len(sources)}, "
            f"retrieval_count={retrieval_count}"
        )

        return context

    def mark_knowledge_base_context_failed(
        self,
        db: Session,
        context_id: int,
        error_message: str,
    ) -> Optional[SubtaskContext]:
        """
        Mark knowledge base context as failed when RAG retrieval fails.

        Args:
            db: Database session
            context_id: Context ID to mark as failed
            error_message: Error message describing the failure

        Returns:
            Updated SubtaskContext or None if not found
        """
        context = self.get_context_optional(db, context_id)
        if context is None:
            logger.warning(f"Context {context_id} not found for failure marking")
            return None

        context.status = ContextStatus.FAILED.value
        context.error_message = error_message
        db.commit()
        db.refresh(context)

        logger.warning(
            f"Knowledge base context {context_id} marked as failed: {error_message}"
        )

        return context

    @trace_sync(
        span_name="update_knowledge_base_kb_head_result",
        tracer_name="context_service",
    )
    def update_knowledge_base_kb_head_result(
        self,
        db: Session,
        context_id: int,
        document_ids: List[int],
        offset: int = 0,
        limit: int = 50000,
    ) -> Optional[SubtaskContext]:
        """
        Update knowledge base context with kb_head usage tracking.

        This method tracks kb_head tool usage for cross-turn persistence.
        It stores the KbHeadInput parameters (document_ids, offset, limit)
        so the content can be re-fetched when loading history.

        IMPORTANT: This method uses APPEND mode - it preserves existing data
        (like RAG retrieval results) and only updates kb_head-specific fields.

        Args:
            db: Database session
            context_id: Context ID to update
            document_ids: List of document IDs that were read
            offset: Start position in characters (from KbHeadInput)
            limit: Max characters to return (from KbHeadInput)

        Returns:
            Updated SubtaskContext or None if not found
        """
        context = self.get_context_optional(db, context_id)
        if context is None:
            logger.warning(f"Context {context_id} not found for kb_head update")
            return None

        if context.context_type != ContextType.KNOWLEDGE_BASE.value:
            logger.warning(
                f"Context {context_id} is not a knowledge_base type, skipping kb_head update"
            )
            return None

        # APPEND mode: preserve existing type_data and only update kb_head fields
        current_type_data = context.type_data or {}
        existing_kb_head_result = current_type_data.get("kb_head_result", {})

        # Increment usage_count
        usage_count = existing_kb_head_result.get("usage_count", 0) + 1

        # Merge document_ids (deduplicate with existing)
        existing_doc_ids = set(existing_kb_head_result.get("document_ids", []))
        existing_doc_ids.update(document_ids)

        # Build kb_head_result sub-object with KbHeadInput params
        kb_head_result = {
            "usage_count": usage_count,
            "document_ids": list(existing_doc_ids),
            "offset": offset,
            "limit": limit,
        }

        # Update type_data (preserve all existing fields like rag_result)
        context.type_data = {
            **current_type_data,
            "kb_head_result": kb_head_result,
        }

        # Update status to READY if it's PENDING or EMPTY
        # EMPTY can occur when RAG retrieval returned 0 chunks
        if context.status in (ContextStatus.PENDING.value, ContextStatus.EMPTY.value):
            context.status = ContextStatus.READY.value

        db.commit()
        db.refresh(context)

        logger.info(
            f"Knowledge base context {context_id} updated with kb_head results: "
            f"usage_count={usage_count}, document_ids={list(existing_doc_ids)}"
        )

        return context

    @trace_sync(
        span_name="create_knowledge_base_context_with_result",
        tracer_name="context_service",
    )
    def create_knowledge_base_context_with_result(
        self,
        db: Session,
        subtask_id: int,
        knowledge_id: int,
        user_id: int,
        tool_type: str,
        result_data: Dict[str, Any],
        kb_name: Optional[str] = None,
    ) -> SubtaskContext:
        """
        Create new KB context with result data in one operation.

        This is used when a task-level KB is used in a subtask that
        didn't explicitly select it. Creates context and writes result
        in a single transaction, avoiding the need for separate create
        and update calls.

        Args:
            db: Database session
            subtask_id: Current user subtask ID
            knowledge_id: Knowledge base ID
            user_id: User ID for ownership
            tool_type: "rag" or "kb_head"
            result_data: Tool-specific result data:
                - For RAG: {"extracted_text", "sources", "injection_mode", "query", "chunks_count"}
                - For kb_head: {"document_ids", "offset", "limit"}
            kb_name: Optional KB name (will be fetched from Kind table if not provided)

        Returns:
            Newly created SubtaskContext record with result data

        Raises:
            ValueError: If tool_type is not "rag" or "kb_head"
        """
        # If kb_name not provided, fetch from Kind table
        if not kb_name:
            from app.models.kind import Kind

            kind = db.query(Kind).filter(Kind.id == knowledge_id).first()
            kb_name = kind.name if kind else f"Knowledge Base {knowledge_id}"

        # Build type_data based on tool_type
        type_data: Dict[str, Any] = {
            "knowledge_id": knowledge_id,
            "auto_created": True,  # Mark as auto-created for observability
        }

        # Determine status and extracted_text based on tool_type and result
        if tool_type == "rag":
            # RAG result structure
            rag_result = {
                "sources": result_data.get("sources", []),
                "injection_mode": result_data.get("injection_mode", "rag_retrieval"),
                "query": result_data.get("query", ""),
                "chunks_count": result_data.get("chunks_count", 0),
                "retrieval_count": 1,
                "restricted_mode": result_data.get("restricted_mode", False),
            }
            type_data["rag_result"] = rag_result
            # Note: Flat fields removed to avoid duplication - use rag_result sub-object
            extracted_text = result_data.get("extracted_text", "")
            status = (
                ContextStatus.READY.value
                if rag_result["chunks_count"] > 0
                else ContextStatus.EMPTY.value
            )

        elif tool_type == "kb_head":
            # kb_head result structure
            kb_head_result = {
                "usage_count": 1,
                "document_ids": result_data.get("document_ids", []),
                "offset": result_data.get("offset", 0),
                "limit": result_data.get("limit", 50000),
            }
            type_data["kb_head_result"] = kb_head_result
            extracted_text = ""
            status = ContextStatus.READY.value
        else:
            raise ValueError(f"Unknown tool_type: {tool_type}")

        # Create new context record
        new_context = SubtaskContext(
            subtask_id=subtask_id,
            user_id=user_id,
            context_type=ContextType.KNOWLEDGE_BASE.value,
            name=kb_name,
            status=status,
            type_data=type_data,
            extracted_text=extracted_text,
            text_length=len(extracted_text) if extracted_text else 0,
        )

        db.add(new_context)
        db.commit()
        db.refresh(new_context)

        logger.info(
            f"[context_service] Created KB context with {tool_type} result: "
            f"id={new_context.id}, subtask_id={subtask_id}, kb_id={knowledge_id}, "
            f"auto_created=True, status={status}"
        )

        return new_context

    def build_knowledge_base_text_prefix(
        self,
        context: SubtaskContext,
    ) -> Optional[str]:
        """
        Build a text prefix containing knowledge base retrieval content.

        Note: This method returns raw content without XML tags. The caller is responsible
        for wrapping multiple KB contents in a single <knowledge_base> XML tag.

        Args:
            context: SubtaskContext record with extracted_text from RAG

        Returns:
            Formatted text prefix without XML tags, or None if no extracted text
        """
        if not context.extracted_text:
            return None

        if context.context_type != ContextType.KNOWLEDGE_BASE.value:
            return None

        # Get knowledge base name and sources info
        kb_name = context.name or "Knowledge Base"
        # Use property which handles rag_result sub-object with legacy fallback
        sources = context.sources

        # Build source names list (up to 5 for brevity)
        source_names = [s.get("document_name", "Unknown") for s in sources[:5]]
        if len(sources) > 5:
            source_names.append(f"... and {len(sources) - 5} more")
        sources_str = ", ".join(source_names) if source_names else "N/A"

        # Build the content parts (without XML tags)
        parts = [
            f"[Knowledge Base - {kb_name}]:",
            f"(Sources: {sources_str})",
            context.extracted_text,
        ]

        return "\n".join(parts)

    def get_knowledge_base_contexts_by_subtask(
        self,
        db: Session,
        subtask_id: int,
    ) -> List[SubtaskContext]:
        """
        Get only knowledge base contexts for a subtask.

        Args:
            db: Database session
            subtask_id: Subtask ID

        Returns:
            List of knowledge_base SubtaskContext records
        """
        return (
            db.query(SubtaskContext)
            .filter(
                SubtaskContext.subtask_id == subtask_id,
                SubtaskContext.context_type == ContextType.KNOWLEDGE_BASE.value,
                SubtaskContext.status == ContextStatus.READY.value,
            )
            .order_by(SubtaskContext.created_at)
            .all()
        )

    def get_knowledge_base_context_by_subtask_and_kb_id(
        self,
        db: Session,
        subtask_id: int,
        knowledge_id: int,
    ) -> Optional[SubtaskContext]:
        """
        Get knowledge base context by subtask_id and knowledge_id.

        This is used to find the specific context record for updating
        RAG retrieval results.

        Args:
            db: Database session
            subtask_id: Subtask ID
            knowledge_id: Knowledge base ID

        Returns:
            SubtaskContext record or None if not found
        """
        contexts_by_kb_id = self.get_knowledge_base_context_map_by_subtask(
            db=db,
            subtask_id=subtask_id,
            knowledge_ids=[knowledge_id],
        )
        return contexts_by_kb_id.get(knowledge_id)

    def get_knowledge_base_context_map_by_subtask(
        self,
        db: Session,
        subtask_id: int,
        knowledge_ids: Optional[List[int]] = None,
    ) -> Dict[int, SubtaskContext]:
        """
        Get knowledge base contexts for a subtask indexed by knowledge_id.

        This avoids repeated subtask-wide scans when multiple KB contexts
        need to be updated in a single operation.

        Args:
            db: Database session
            subtask_id: Subtask ID
            knowledge_ids: Optional knowledge base IDs to keep in the result

        Returns:
            Mapping of knowledge_id -> SubtaskContext
        """
        contexts = (
            db.query(SubtaskContext)
            .filter(
                SubtaskContext.subtask_id == subtask_id,
                SubtaskContext.context_type == ContextType.KNOWLEDGE_BASE.value,
            )
            .order_by(SubtaskContext.created_at)
            .all()
        )

        requested_ids = set(knowledge_ids or [])
        contexts_by_kb_id: Dict[int, SubtaskContext] = {}
        for ctx in contexts:
            kb_id = (ctx.type_data or {}).get("knowledge_id")
            if kb_id is None:
                continue
            if requested_ids and kb_id not in requested_ids:
                continue
            contexts_by_kb_id.setdefault(kb_id, ctx)

        return contexts_by_kb_id

    def get_knowledge_base_meta_for_task(
        self,
        db: Session,
        task_id: int,
    ) -> List[Dict[str, Any]]:
        """
        Get knowledge base meta information for all messages in a task.

        Collects unique knowledge bases from all subtasks in the task.

        Args:
            db: Database session
            task_id: Task ID

        Returns:
            List of dicts with kb_name and kb_id
        """
        # Get all subtask IDs for the task
        subtask_ids = [
            subtask.id
            for subtask in subtask_store.list_by_task_unfiltered(db, task_id=task_id)
        ]

        if not subtask_ids:
            return []

        # Get unique knowledge base contexts
        kb_contexts = (
            db.query(SubtaskContext)
            .filter(
                SubtaskContext.subtask_id.in_(subtask_ids),
                SubtaskContext.context_type == ContextType.KNOWLEDGE_BASE.value,
            )
            .all()
        )

        # Deduplicate by knowledge_id
        seen_kb_ids = set()
        kb_meta_list = []
        for ctx in kb_contexts:
            kb_id = ctx.knowledge_id
            if kb_id and kb_id not in seen_kb_ids:
                seen_kb_ids.add(kb_id)
                kb_meta_list.append(
                    {
                        "kb_name": ctx.name,
                        "kb_id": kb_id,
                    }
                )

        return kb_meta_list

    # ==================== Common Operations ====================

    def get_context(
        self,
        db: Session,
        context_id: int,
        user_id: Optional[int] = None,
    ) -> SubtaskContext:
        """
        Get context by ID with optional user ownership check.

        Args:
            db: Database session
            context_id: Context ID
            user_id: Optional user ID for ownership check

        Returns:
            SubtaskContext record

        Raises:
            NotFoundException: If context not found
        """
        query = db.query(SubtaskContext).filter(SubtaskContext.id == context_id)

        if user_id is not None:
            query = query.filter(SubtaskContext.user_id == user_id)

        context = query.first()
        if not context:
            raise NotFoundException(f"Context {context_id} not found")

        return context

    def get_context_optional(
        self,
        db: Session,
        context_id: int,
        user_id: Optional[int] = None,
    ) -> Optional[SubtaskContext]:
        """
        Get context by ID, returning None if not found.

        Args:
            db: Database session
            context_id: Context ID
            user_id: Optional user ID for ownership check

        Returns:
            SubtaskContext record or None
        """
        try:
            return self.get_context(db, context_id, user_id)
        except NotFoundException:
            return None

    def link_to_subtask(
        self,
        db: Session,
        context_id: int,
        subtask_id: int,
        user_id: Optional[int] = None,
    ) -> Optional[SubtaskContext]:
        """
        Link a context to a subtask.

        Args:
            db: Database session
            context_id: Context ID
            subtask_id: Subtask ID to link to
            user_id: Optional user ID for ownership check

        Returns:
            Updated SubtaskContext or None if not found
        """
        context = self.get_context_optional(db, context_id, user_id)

        if context is None:
            return None

        context.subtask_id = subtask_id
        db.commit()
        db.refresh(context)

        logger.info(f"Context {context_id} linked to subtask {subtask_id}")

        return context

    def link_many_to_subtask(
        self,
        db: Session,
        context_ids: List[int],
        subtask_id: int,
    ) -> None:
        """
        Link multiple contexts to a subtask.

        Args:
            db: Database session
            context_ids: List of context IDs
            subtask_id: Subtask ID to link to
        """
        if not context_ids:
            return

        db.query(SubtaskContext).filter(SubtaskContext.id.in_(context_ids)).update(
            {"subtask_id": subtask_id},
            synchronize_session=False,
        )
        db.commit()

        logger.info(f"Linked {len(context_ids)} contexts to subtask {subtask_id}")

    def get_by_subtask(
        self,
        db: Session,
        subtask_id: int,
    ) -> List[SubtaskContext]:
        """
        Get all contexts for a subtask.

        Args:
            db: Database session
            subtask_id: Subtask ID

        Returns:
            List of SubtaskContext records
        """
        return (
            db.query(SubtaskContext)
            .filter(SubtaskContext.subtask_id == subtask_id)
            .order_by(SubtaskContext.created_at)
            .all()
        )

    def get_briefs_by_subtask(
        self,
        db: Session,
        subtask_id: int,
    ) -> List[SubtaskContextBrief]:
        """
        Get brief context info for message display.

        Args:
            db: Database session
            subtask_id: Subtask ID

        Returns:
            List of SubtaskContextBrief objects
        """
        contexts = self.get_by_subtask(db, subtask_id)
        return [SubtaskContextBrief.from_model(c) for c in contexts]

    def get_attachments_by_subtask(
        self,
        db: Session,
        subtask_id: int,
    ) -> List[SubtaskContext]:
        """
        Get only attachment contexts for a subtask.

        Args:
            db: Database session
            subtask_id: Subtask ID

        Returns:
            List of attachment SubtaskContext records
        """
        return (
            db.query(SubtaskContext)
            .filter(
                SubtaskContext.subtask_id == subtask_id,
                SubtaskContext.context_type == ContextType.ATTACHMENT.value,
            )
            .order_by(SubtaskContext.created_at)
            .all()
        )

    def get_attachment_by_subtask(
        self,
        db: Session,
        subtask_id: int,
    ) -> Optional[SubtaskContext]:
        """
        Get the first attachment for a subtask (for backward compatibility).

        Args:
            db: Database session
            subtask_id: Subtask ID

        Returns:
            First attachment SubtaskContext or None
        """
        return (
            db.query(SubtaskContext)
            .filter(
                SubtaskContext.subtask_id == subtask_id,
                SubtaskContext.context_type == ContextType.ATTACHMENT.value,
            )
            .order_by(SubtaskContext.created_at)
            .first()
        )

    def get_attachments_by_task(
        self,
        db: Session,
        task_id: int,
    ) -> List[SubtaskContext]:
        """
        Get all attachment contexts for a task (across all subtasks).

        This method is used by the executor to pre-download all attachments
        for a task at sandbox startup.

        Args:
            db: Database session
            task_id: Task ID

        Returns:
            List of attachment SubtaskContext records for all subtasks of the task
        """
        # Get all subtask IDs for this task
        subtask_ids = [
            subtask.id
            for subtask in subtask_store.list_by_task_unfiltered(db, task_id=task_id)
        ]

        if not subtask_ids:
            return []

        # Get all attachments for these subtasks
        return (
            db.query(SubtaskContext)
            .filter(
                SubtaskContext.subtask_id.in_(subtask_ids),
                SubtaskContext.context_type == ContextType.ATTACHMENT.value,
                SubtaskContext.status == ContextStatus.READY.value,
            )
            .order_by(SubtaskContext.created_at)
            .all()
        )

    def delete_context(
        self,
        db: Session,
        context_id: int,
        user_id: int,
    ) -> bool:
        """
        Delete a context.

        Only allows deletion of contexts that are not linked to a subtask.
        Also deletes the binary data from the storage backend for attachments.

        Args:
            db: Database session
            context_id: Context ID
            user_id: User ID for ownership check

        Returns:
            True if deleted, False if not found or cannot be deleted
        """
        context = self.get_context_optional(db, context_id, user_id)

        if context is None:
            return False

        # Only allow deletion of unlinked contexts (subtask_id == 0)
        if context.subtask_id > 0:
            logger.warning(
                f"Cannot delete context {context_id}: linked to subtask {context.subtask_id}"
            )
            return False

        # Delete from storage backend if attachment with storage_key
        if context.context_type == ContextType.ATTACHMENT.value and context.storage_key:
            try:
                storage_backend = get_storage_backend(db)
                storage_backend.delete(context.storage_key)
            except StorageError as e:
                logger.warning(
                    f"Failed to delete context {context_id} from storage: {e}"
                )
                # Continue with database deletion even if storage deletion fails

        db.delete(context)
        db.commit()

        logger.info(f"Context {context_id} deleted")

        return True

    def get_unlinked_contexts(
        self,
        db: Session,
        user_id: int,
    ) -> List[SubtaskContext]:
        """
        Get unlinked contexts for a user.

        Args:
            db: Database session
            user_id: User ID

        Returns:
            List of unlinked SubtaskContext records
        """
        return (
            db.query(SubtaskContext)
            .filter(
                SubtaskContext.user_id == user_id,
                SubtaskContext.subtask_id == self.UNLINKED_SUBTASK_ID,
            )
            .order_by(SubtaskContext.created_at.desc())
            .all()
        )


# Global service instance
context_service = ContextService()
