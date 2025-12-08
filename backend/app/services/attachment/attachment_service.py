# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Attachment service for managing file uploads and document parsing.

This service handles the attachment lifecycle including:
- File upload and validation
- Document parsing and text extraction
- Storage backend abstraction for pluggable storage
- Attachment retrieval and deletion
"""

import logging
import os
from typing import Any, Dict, Optional, Union

from sqlalchemy.orm import Session

from app.models.subtask_attachment import AttachmentStatus, SubtaskAttachment
from app.services.attachment.parser import DocumentParseError, DocumentParser
from app.services.attachment.storage_factory import (
    get_storage_backend,
    get_storage_backend_name,
)

logger = logging.getLogger(__name__)


class AttachmentService:
    """
    Service for managing file attachments.

    Handles file upload, document parsing, storage backend integration,
    and attachment lifecycle management.
    """

    def __init__(self):
        self.parser = DocumentParser()

    # Placeholder subtask_id for attachments not yet linked to a subtask
    # Using 0 as a sentinel value since database requires non-null
    UNLINKED_SUBTASK_ID = 0

    def _generate_storage_key(self, attachment_id: int) -> str:
        """
        Generate a storage key for an attachment.

        Args:
            attachment_id: The attachment ID

        Returns:
            Storage key in format 'attachments/{id}'
        """
        return f"attachments/{attachment_id}"

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

        # Get storage backend name
        backend_name = get_storage_backend_name()

        # Create attachment record with UPLOADING status
        # For MySQL backend, binary_data is stored directly
        # For external backends, binary_data will be NULL and data stored externally
        attachment = SubtaskAttachment(
            subtask_id=effective_subtask_id,
            user_id=user_id,
            original_filename=filename,
            file_extension=extension,
            file_size=file_size,
            mime_type=mime_type,
            binary_data=binary_data if backend_name == "mysql" else None,
            image_base64="",  # Empty string as placeholder, will be updated after parsing
            extracted_text="",  # Empty string as placeholder, will be updated after parsing
            text_length=0,  # Will be updated after parsing
            status=AttachmentStatus.UPLOADING,
            error_message="",  # Empty string as placeholder
            storage_backend=backend_name,
            storage_key=None,  # Will be set after flush to get the ID
        )
        db.add(attachment)
        db.flush()  # Get the ID

        # Generate and set storage key
        storage_key = self._generate_storage_key(attachment.id)
        attachment.storage_key = storage_key

        # For non-MySQL backends, save to external storage
        if backend_name != "mysql":
            try:
                storage_backend = get_storage_backend()
                metadata = {
                    "db": db,
                    "filename": filename,
                    "mime_type": mime_type,
                    "file_size": file_size,
                    "user_id": user_id,
                }
                storage_backend.save(storage_key, binary_data, metadata)
                logger.debug(
                    f"Binary data saved to {backend_name} storage for attachment {attachment.id}"
                )
            except Exception as e:
                logger.error(f"Failed to save to external storage: {e}")
                db.rollback()
                raise ValueError(f"Failed to save file to storage: {e}")

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
            f"storage_backend={backend_name}"
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
        Get binary data for an attachment.

        This method handles retrieving binary data from either MySQL storage
        or external storage backends based on the attachment's storage_backend field.

        Args:
            db: Database session
            attachment: SubtaskAttachment record

        Returns:
            Binary data or None if not found
        """
        # Check storage backend type
        backend_name = attachment.storage_backend or "mysql"

        if backend_name == "mysql":
            # Data is stored in the database
            return attachment.binary_data
        else:
            # Data is stored externally
            if not attachment.storage_key:
                logger.error(
                    f"Attachment {attachment.id} has external storage but no storage_key"
                )
                return None

            try:
                storage_backend = get_storage_backend()
                return storage_backend.get(attachment.storage_key, db=db)
            except Exception as e:
                logger.error(
                    f"Failed to get data from external storage for attachment {attachment.id}: {e}"
                )
                return None

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
        Also deletes data from external storage if applicable.

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

        # Delete from external storage if applicable
        backend_name = attachment.storage_backend or "mysql"
        if backend_name != "mysql" and attachment.storage_key:
            try:
                storage_backend = get_storage_backend()
                storage_backend.delete(attachment.storage_key, db=db)
                logger.debug(
                    f"Deleted attachment {attachment_id} from {backend_name} storage"
                )
            except Exception as e:
                logger.warning(
                    f"Failed to delete from external storage for attachment {attachment_id}: {e}"
                )
                # Continue with database deletion even if external deletion fails

        db.delete(attachment)
        db.commit()

        logger.info(f"Attachment {attachment_id} deleted")

        return True

    def get_download_url(
        self,
        db: Session,
        attachment: SubtaskAttachment,
        expires: int = 3600,
    ) -> Optional[str]:
        """
        Get a direct download URL for an attachment.

        This method returns a direct download URL if the storage backend supports it
        (e.g., S3 presigned URLs). For backends that don't support direct URLs
        (like MySQL), this returns None.

        Args:
            db: Database session
            attachment: SubtaskAttachment record
            expires: URL expiration time in seconds (default: 1 hour)

        Returns:
            Direct download URL if supported, None otherwise
        """
        backend_name = attachment.storage_backend or "mysql"

        # MySQL backend doesn't support direct URLs
        if backend_name == "mysql":
            return None

        if not attachment.storage_key:
            logger.warning(
                f"Attachment {attachment.id} has no storage_key for URL generation"
            )
            return None

        try:
            storage_backend = get_storage_backend()
            return storage_backend.get_url(attachment.storage_key, expires)
        except Exception as e:
            logger.error(
                f"Failed to get download URL for attachment {attachment.id}: {e}"
            )
            return None

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
                f"[File Content - {attachment.original_filename}]:\n"
                f"{attachment.extracted_text}\n\n"
                f"[User Question]:\n"
                f"{message}"
            )
            return combined
        else:
            return message


# Global service instance
attachment_service = AttachmentService()
