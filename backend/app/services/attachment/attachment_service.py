# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Attachment service for managing file uploads and document parsing.
"""

import logging
import os
from typing import Optional, Union, Dict, Any

from sqlalchemy.orm import Session

from app.models.subtask_attachment import AttachmentStatus, SubtaskAttachment
from app.services.attachment.parser import DocumentParser, DocumentParseError
from app.services.storage.minio_client import minio_client

logger = logging.getLogger(__name__)


class AttachmentService:
    """
    Service for managing file attachments.
    
    Handles file upload, document parsing, and attachment lifecycle.
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
        effective_subtask_id = subtask_id if subtask_id > 0 else self.UNLINKED_SUBTASK_ID

        # Create attachment record with UPLOADING status
        # Note: binary_data is set to empty bytes - actual data stored in MinIO
        # All fields must have non-null values as required by database
        attachment = SubtaskAttachment(
            subtask_id=effective_subtask_id,
            user_id=user_id,
            original_filename=filename,
            file_extension=extension,
            file_size=file_size,
            mime_type=mime_type,
            binary_data=b"",  # Empty bytes - new data stored in MinIO
            minio_object_key=None,  # Will be set after upload to MinIO
            image_base64="",  # Empty string as placeholder, will be updated after parsing
            extracted_text="",  # Empty string as placeholder, will be updated after parsing
            text_length=0,  # Will be updated after parsing
            status=AttachmentStatus.UPLOADING,
            error_message="",  # Empty string as placeholder
        )
        db.add(attachment)
        db.flush()  # Get the ID

        # Upload file to MinIO
        try:
            object_key = minio_client.generate_object_key(
                user_id=user_id,
                attachment_id=attachment.id,
                original_filename=filename,
            )
            minio_client.upload_file(
                object_key=object_key,
                data=binary_data,
                content_type=mime_type,
            )
            attachment.minio_object_key = object_key
            logger.info(f"Uploaded attachment {attachment.id} to MinIO: {object_key}")
        except Exception as e:
            logger.error(f"Failed to upload attachment to MinIO: {e}")
            attachment.status = AttachmentStatus.FAILED
            attachment.error_message = f"Failed to upload to storage: {str(e)}"
            db.commit()
            raise ValueError(f"Failed to upload file to storage: {str(e)}")

        # Update status to PARSING
        attachment.status = AttachmentStatus.PARSING
        db.flush()
        
        # Parse document
        try:
            extracted_text, text_length, image_base64 = self.parser.parse(binary_data, extension)

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
            f"filename={filename}, text_length={attachment.text_length}"
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
        return db.query(SubtaskAttachment).filter(
            SubtaskAttachment.subtask_id == subtask_id
        ).first()
    
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
        Also deletes the file from MinIO if stored there.

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

        # Delete from MinIO if stored there
        if attachment.minio_object_key:
            try:
                minio_client.delete_file(attachment.minio_object_key)
                logger.info(f"Deleted attachment {attachment_id} from MinIO: {attachment.minio_object_key}")
            except Exception as e:
                logger.error(f"Failed to delete attachment from MinIO: {e}")
                # Continue with database deletion even if MinIO deletion fails

        db.delete(attachment)
        db.commit()

        logger.info(f"Attachment {attachment_id} deleted")

        return True

    def get_attachment_binary(
        self,
        attachment: SubtaskAttachment,
    ) -> bytes:
        """
        Get binary data for an attachment.

        For new attachments, retrieves data from MinIO.
        For legacy attachments, returns data from MySQL binary_data column.

        Args:
            attachment: SubtaskAttachment record

        Returns:
            File binary data

        Raises:
            ValueError: If binary data cannot be retrieved
        """
        # Check if data is stored in MinIO (new data)
        if attachment.minio_object_key:
            try:
                data = minio_client.download_file(attachment.minio_object_key)
                logger.debug(
                    f"Retrieved attachment {attachment.id} from MinIO: "
                    f"{attachment.minio_object_key} ({len(data)} bytes)"
                )
                return data
            except Exception as e:
                logger.error(f"Failed to retrieve attachment from MinIO: {e}")
                raise ValueError(f"Failed to retrieve file from storage: {str(e)}")

        # Legacy data stored in MySQL
        if attachment.binary_data:
            logger.debug(
                f"Retrieved attachment {attachment.id} from MySQL: "
                f"{len(attachment.binary_data)} bytes"
            )
            return attachment.binary_data

        # No data available
        raise ValueError(f"No binary data available for attachment {attachment.id}")
    
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
            ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"
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