# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Attachment service for managing file uploads and document parsing.
"""

import logging
import os
from typing import Any, Dict, Optional, Union

from sqlalchemy.orm import Session

from app.models.subtask_attachment import AttachmentStatus, SubtaskAttachment
from app.services.attachment.parser import DocumentParseError, DocumentParser
from app.services.attachment.storage_backend import StorageError, generate_storage_key
from app.services.attachment.storage_factory import get_storage_backend

logger = logging.getLogger(__name__)


class AttachmentService:
    """
    Service for managing file attachments.

    Handles file upload, document parsing, and attachment lifecycle.
    Supports pluggable storage backends (MySQL, S3, MinIO, etc.).
    """

    def __init__(self):
        self.parser = DocumentParser()

    # Placeholder subtask_id for attachments not yet linked to a subtask
    # Using 0 as a sentinel value since database requires non-null
    UNLINKED_SUBTASK_ID = 0

    def upload_attachment(
        self,
        db: Session,
        user_id: int,
        filename: str,
        binary_data: bytes,
        subtask_id: int = 0,
    ) -> SubtaskAttachment:
        """
        Upload and process a file attachment.

        Args:
            db: Database session
            user_id: User ID
            filename: Original filename
            binary_data: File binary data
            subtask_id: Subtask ID to link to (0 means unlinked)

        Returns:
            Created SubtaskAttachment record

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
            max_size_mb = self.parser.MAX_FILE_SIZE / (1024 * 1024)
            raise ValueError(f"File size exceeds maximum limit ({max_size_mb} MB)")

        # Get MIME type
        mime_type = self.parser.get_mime_type(extension)

        # Use placeholder subtask_id if not provided (0 means unlinked)
        effective_subtask_id = (
            subtask_id if subtask_id > 0 else self.UNLINKED_SUBTASK_ID
        )

        # Get the storage backend
        storage_backend = get_storage_backend(db)

        # Create attachment record with UPLOADING status
        # For MySQL backend, store binary_data directly
        # For external backends, binary_data will be set to empty bytes (b'') after storage
        attachment = SubtaskAttachment(
            subtask_id=effective_subtask_id,
            user_id=user_id,
            original_filename=filename,
            file_extension=extension,
            file_size=file_size,
            mime_type=mime_type,
            binary_data=binary_data,  # Temporarily store here, will be cleared for external storage
            image_base64="",  # Empty string as placeholder, will be updated after parsing
            extracted_text="",  # Empty string as placeholder, will be updated after parsing
            text_length=0,  # Will be updated after parsing
            status=AttachmentStatus.UPLOADING,
            error_message="",  # Empty string as placeholder
            storage_backend=storage_backend.backend_type,
            storage_key="",  # Will be set after getting ID
        )
        db.add(attachment)
        db.flush()  # Get the ID

        # Generate storage key and save to storage backend
        storage_key = generate_storage_key(attachment.id, user_id)
        attachment.storage_key = storage_key

        try:
            # Save binary data to storage backend
            metadata = {
                "filename": filename,
                "mime_type": mime_type,
                "file_size": file_size,
                "user_id": user_id,
            }
            storage_backend.save(storage_key, binary_data, metadata)
        except StorageError as e:
            logger.error(f"Failed to save attachment {attachment.id} to storage: {e}")
            db.rollback()
            raise

        # Update status to PARSING
        attachment.status = AttachmentStatus.PARSING
        db.flush()

        # Parse document
        try:
            extracted_text, text_length, image_base64 = self.parser.parse(
                binary_data, extension
            )

            # Update attachment with parsed content
            attachment.extracted_text = extracted_text if extracted_text else ""
            attachment.text_length = text_length if text_length else 0
            attachment.image_base64 = image_base64 if image_base64 else ""
            attachment.status = AttachmentStatus.READY

        except DocumentParseError as e:
            logger.error(f"Document parsing failed for attachment {attachment.id}: {e}")
            attachment.status = AttachmentStatus.FAILED
            attachment.error_message = str(e)
            db.commit()
            raise

        db.commit()
        db.refresh(attachment)

        logger.info(
            f"Attachment uploaded successfully: id={attachment.id}, "
            f"filename={filename}, text_length={attachment.text_length}, "
            f"storage_backend={storage_backend.backend_type}"
        )

        return attachment

    def get_attachment(
        self,
        db: Session,
        attachment_id: int,
        user_id: Optional[int] = None,
    ) -> Optional[SubtaskAttachment]:
        """
        Get attachment by ID.

        Args:
            db: Database session
            attachment_id: Attachment ID
            user_id: Optional user ID for ownership check

        Returns:
            SubtaskAttachment or None if not found
        """
        query = db.query(SubtaskAttachment).filter(
            SubtaskAttachment.id == attachment_id
        )

        if user_id is not None:
            query = query.filter(SubtaskAttachment.user_id == user_id)

        return query.first()

    def get_attachment_binary_data(
        self,
        db: Session,
        attachment: SubtaskAttachment,
    ) -> Optional[bytes]:
        """
        Get binary data for an attachment from the appropriate storage backend.

        This method abstracts the storage backend and retrieves binary data
        regardless of where it's stored (MySQL or external storage).

        Args:
            db: Database session
            attachment: SubtaskAttachment record

        Returns:
            Binary data or None if not found
        """
        # Check if data is stored in MySQL (storage_backend == 'mysql')
        if attachment.storage_backend == "mysql":
            # For MySQL storage, binary_data contains the actual data
            return attachment.binary_data if attachment.binary_data else None

        # For external storage, retrieve from storage backend using storage_key
        if not attachment.storage_key or attachment.storage_key == "":
            logger.warning(
                f"Attachment {attachment.id} has no storage_key for external storage"
            )
            return None

        storage_backend = get_storage_backend(db)
        return storage_backend.get(attachment.storage_key)

    def get_attachment_url(
        self,
        db: Session,
        attachment: SubtaskAttachment,
        expires: int = 3600,
    ) -> Optional[str]:
        """
        Get a URL for accessing the attachment file.

        Only supported for storage backends that provide URL access (S3, MinIO).
        Returns None for MySQL backend.

        Args:
            db: Database session
            attachment: SubtaskAttachment record
            expires: URL expiration time in seconds (default: 3600)

        Returns:
            URL string if supported, None otherwise
        """
        # Only external storage backends support URL access
        if (
            not attachment.storage_key
            or attachment.storage_key == ""
            or attachment.storage_backend == "mysql"
        ):
            return None

        storage_backend = get_storage_backend(db)
        return storage_backend.get_url(attachment.storage_key, expires)

    def get_attachment_by_subtask(
        self,
        db: Session,
        subtask_id: int,
    ) -> Optional[SubtaskAttachment]:
        """
        Get attachment by subtask ID.

        Args:
            db: Database session
            subtask_id: Subtask ID

        Returns:
            SubtaskAttachment or None if not found
        """
        return (
            db.query(SubtaskAttachment)
            .filter(SubtaskAttachment.subtask_id == subtask_id)
            .first()
        )

    def link_attachment_to_subtask(
        self,
        db: Session,
        attachment_id: int,
        subtask_id: int,
        user_id: int,
    ) -> Optional[SubtaskAttachment]:
        """
        Link an attachment to a subtask.

        Args:
            db: Database session
            attachment_id: Attachment ID
            subtask_id: Subtask ID to link to
            user_id: User ID for ownership check

        Returns:
            Updated SubtaskAttachment or None if not found
        """
        attachment = self.get_attachment(db, attachment_id, user_id)

        if attachment is None:
            return None

        attachment.subtask_id = subtask_id
        db.commit()
        db.refresh(attachment)

        logger.info(f"Attachment {attachment_id} linked to subtask {subtask_id}")

        return attachment

    def delete_attachment(
        self,
        db: Session,
        attachment_id: int,
        user_id: int,
    ) -> bool:
        """
        Delete an attachment.

        Only allows deletion of attachments that are not linked to a subtask.
        Also deletes the binary data from the storage backend.

        Args:
            db: Database session
            attachment_id: Attachment ID
            user_id: User ID for ownership check

        Returns:
            True if deleted, False if not found or cannot be deleted
        """
        attachment = self.get_attachment(db, attachment_id, user_id)

        if attachment is None:
            return False

        # Only allow deletion of unlinked attachments (subtask_id == 0 means unlinked)
        if attachment.subtask_id > 0:
            logger.warning(
                f"Cannot delete attachment {attachment_id}: linked to subtask {attachment.subtask_id}"
            )
            return False

        # Delete from storage backend if storage_key exists
        if attachment.storage_key:
            try:
                storage_backend = get_storage_backend(db)
                storage_backend.delete(attachment.storage_key)
            except StorageError as e:
                logger.warning(
                    f"Failed to delete attachment {attachment_id} from storage: {e}"
                )
                # Continue with database deletion even if storage deletion fails

        db.delete(attachment)
        db.commit()

        logger.info(f"Attachment {attachment_id} deleted")

        return True

    def build_message_with_attachment(
        self,
        message: str,
        attachment: SubtaskAttachment,
    ) -> Union[str, Dict[str, Any]]:
        """
        Build a message with attachment content.

        For image attachments, returns a vision-compatible message structure.
        For text documents, returns combined text message.

        Args:
            message: User's original message
            attachment: Attachment with extracted text or image data

        Returns:
            For images: Dict with vision content structure
            For documents: String with combined text
        """
        # Check if this is an image attachment
        is_image = attachment.file_extension.lower() in [
            ".jpg",
            ".jpeg",
            ".png",
            ".gif",
            ".bmp",
            ".webp",
        ]

        if is_image and attachment.image_base64:
            # Return vision-compatible message structure
            # This will be handled specially by the chat service
            return {
                "type": "vision",
                "text": message,
                "image_base64": attachment.image_base64,
                "mime_type": attachment.mime_type,
                "filename": attachment.original_filename,
            }
        elif attachment.extracted_text:
            # For documents, combine text as before
            combined = (
                f"【文件内容 - {attachment.original_filename}】:\n"
                f"{attachment.extracted_text}\n\n"
                f"【用户问题】:\n"
                f"{message}"
            )
            return combined
        else:
            return message


# Global service instance
attachment_service = AttachmentService()
