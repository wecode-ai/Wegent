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

from shared.utils.crypto import decrypt_attachment, encrypt_attachment
from sqlalchemy.orm import Session

from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
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

    # ==================== Attachment Operations ====================

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
        # Get file extension
        _, extension = os.path.splitext(filename)
        extension = extension.lower()

        # Validate file extension
        if not self.parser.is_supported_extension(extension):
            raise ValueError(
                f"Unsupported file type: {extension}. "
                f"Supported types: {', '.join(self.parser.SUPPORTED_EXTENSIONS.keys())}"
            )

        # Validate file size
        file_size = len(binary_data)
        if not self.parser.validate_file_size(file_size):
            max_size_mb = DocumentParser.get_max_file_size() / (1024 * 1024)
            raise ValueError(f"File size exceeds maximum limit ({max_size_mb} MB)")

        # Get MIME type
        mime_type = self.parser.get_mime_type(extension)

        # Use placeholder subtask_id if not provided (0 means unlinked)
        effective_subtask_id = (
            subtask_id if subtask_id > 0 else self.UNLINKED_SUBTASK_ID
        )

        # Get the storage backend
        storage_backend = get_storage_backend(db)

        # Create context record with UPLOADING status
        # binary_data is NOT stored here - it will be saved via storage_backend.save()
        # which handles storage based on the configured backend type (MySQL, S3, MinIO, etc.)
        context = SubtaskContext(
            subtask_id=effective_subtask_id,
            user_id=user_id,
            context_type=ContextType.ATTACHMENT.value,
            name=filename,
            status=ContextStatus.UPLOADING.value,
            binary_data=b"",  # Empty bytes - actual data stored via storage_backend.save()
            image_base64="",  # Empty string for NOT NULL constraint
            extracted_text="",  # Empty string for NOT NULL constraint
            text_length=0,
            error_message="",  # Empty string for NOT NULL constraint
            type_data={
                "original_filename": filename,
                "file_extension": extension,
                "file_size": file_size,
                "mime_type": mime_type,
                "storage_backend": storage_backend.backend_type,
                "storage_key": "",
            },
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
            # Encrypt binary data if encryption is enabled (handled at service layer)
            is_encrypted = _should_encrypt()
            data_to_store = binary_data
            if is_encrypted:
                data_to_store = encrypt_attachment(binary_data)
                logger.info(f"Encrypted attachment data for context {context.id}")

            # Save binary data to storage backend
            metadata = {
                "filename": filename,
                "mime_type": mime_type,
                "file_size": file_size,
                "user_id": user_id,
                "is_encrypted": is_encrypted,
            }
            storage_backend.save(storage_key, data_to_store, metadata)

            # Update encryption metadata in type_data
            context.type_data = {
                **context.type_data,
                "is_encrypted": is_encrypted,
                "encryption_version": 1 if is_encrypted else 0,
            }
        except StorageError as e:
            logger.exception(f"Failed to save context {context.id} to storage: {e}")
            db.rollback()
            raise

        # Update status to PARSING
        context.status = ContextStatus.PARSING.value
        db.flush()

        # Parse document
        truncation_info = None
        try:
            parse_result: ParseResult = self.parser.parse(binary_data, extension)

            # Update context with parsed content (use empty string instead of None for NOT NULL fields)
            context.extracted_text = parse_result.text if parse_result.text else ""
            context.text_length = (
                parse_result.text_length if parse_result.text_length else 0
            )
            context.image_base64 = (
                parse_result.image_base64 if parse_result.image_base64 else ""
            )
            context.status = ContextStatus.READY.value

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
    ) -> Optional[str]:
        """
        Build a text prefix containing document content for prepending to messages.

        Args:
            context: SubtaskContext record with extracted_text

        Returns:
            Formatted text prefix, or None if no extracted text
        """
        if not context.extracted_text:
            return None

        # Check if text was truncated by comparing text_length with max limit
        max_text_length = DocumentParser.get_max_text_length()
        is_truncated = context.text_length >= max_text_length

        # Build the prefix with optional truncation notice
        prefix = f"[File Content - {context.original_filename}]:\n"

        if is_truncated:
            prefix += (
                f"(Note: The file content is too long and has been truncated to "
                f"{max_text_length} characters. The following is only partial content.)\n"
            )

        prefix += f"{context.extracted_text}\n\n"

        return prefix

    def build_message_with_attachment(
        self,
        message: str,
        context: SubtaskContext,
    ) -> Union[str, Dict[str, Any]]:
        """
        Build a message with attachment content.

        For image attachments, returns a vision-compatible message structure.
        For text documents, returns combined text message.

        Args:
            message: User's original message
            context: SubtaskContext with extracted text or image data

        Returns:
            For images: Dict with vision content structure
            For documents: String with combined text
        """
        if self.is_image_context(context) and context.image_base64:
            return {
                "type": "vision",
                "text": message,
                "image_base64": context.image_base64,
                "mime_type": context.mime_type,
                "filename": context.original_filename,
            }

        doc_prefix = self.build_document_text_prefix(context)
        if doc_prefix:
            return f"{doc_prefix}[User Question]:\n{message}"

        return message

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

    def update_knowledge_base_retrieval_result(
        self,
        db: Session,
        context_id: int,
        extracted_text: str,
        sources: List[Dict[str, Any]],
    ) -> Optional[SubtaskContext]:
        """
        Update knowledge base context with RAG retrieval results.

        Args:
            db: Database session
            context_id: Context ID to update
            extracted_text: Concatenated retrieval text from RAG
            sources: List of source info dicts with document_name, chunk_id, score

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

        # Update extracted_text and text_length
        context.extracted_text = extracted_text
        context.text_length = len(extracted_text) if extracted_text else 0

        # Update type_data with sources info
        current_type_data = context.type_data or {}
        context.type_data = {
            **current_type_data,
            "sources": sources,
        }

        db.commit()
        db.refresh(context)

        logger.info(
            f"Knowledge base context {context_id} updated with RAG results: "
            f"text_length={context.text_length}, sources_count={len(sources)}"
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

    def build_knowledge_base_text_prefix(
        self,
        context: SubtaskContext,
    ) -> Optional[str]:
        """
        Build a text prefix containing knowledge base retrieval content.

        Args:
            context: SubtaskContext record with extracted_text from RAG

        Returns:
            Formatted text prefix, or None if no extracted text
        """
        if not context.extracted_text:
            return None

        if context.context_type != ContextType.KNOWLEDGE_BASE.value:
            return None

        # Get knowledge base name and sources info
        kb_name = context.name or "Knowledge Base"
        sources = []
        if context.type_data and isinstance(context.type_data, dict):
            sources = context.type_data.get("sources", [])

        # Build source names list (up to 5 for brevity)
        source_names = [s.get("document_name", "Unknown") for s in sources[:5]]
        if len(sources) > 5:
            source_names.append(f"... and {len(sources) - 5} more")
        sources_str = ", ".join(source_names) if source_names else "N/A"

        # Build the prefix
        prefix = f"[Knowledge Base - {kb_name}]:\n"
        prefix += f"(Sources: {sources_str})\n"
        prefix += f"{context.extracted_text}\n\n"

        return prefix

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
        contexts = (
            db.query(SubtaskContext)
            .filter(
                SubtaskContext.subtask_id == subtask_id,
                SubtaskContext.context_type == ContextType.KNOWLEDGE_BASE.value,
            )
            .all()
        )

        # Filter by knowledge_id in type_data
        for ctx in contexts:
            if ctx.type_data and ctx.type_data.get("knowledge_id") == knowledge_id:
                return ctx

        return None

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
        from app.models.subtask import Subtask

        # Get all subtask IDs for the task
        subtask_ids = db.query(Subtask.id).filter(Subtask.task_id == task_id).all()
        subtask_ids = [s[0] for s in subtask_ids]

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
