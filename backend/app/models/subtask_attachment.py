# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Subtask attachment model for storing uploaded document files.

Stores file binary data and extracted text content for chat attachments.
"""
from datetime import datetime
from enum import Enum as PyEnum

from sqlalchemy import Column, DateTime
from sqlalchemy import Enum as SQLEnum
from sqlalchemy import ForeignKey, Integer, LargeBinary, String, Text
from sqlalchemy.dialects.mysql import LONGBLOB, LONGTEXT
from sqlalchemy.sql import func

from app.db.base import Base

# Type adapter for binary data - uses LONGBLOB for MySQL, LargeBinary for others
BinaryDataType = LargeBinary().with_variant(LONGBLOB, "mysql")

# Type adapter for long text - uses LONGTEXT for MySQL, Text for others
LongTextType = Text().with_variant(LONGTEXT, "mysql")


class AttachmentStatus(str, PyEnum):
    """Attachment processing status."""

    UPLOADING = "uploading"
    PARSING = "parsing"
    READY = "ready"
    FAILED = "failed"


class SubtaskAttachment(Base):
    """
    Subtask attachment storage for uploaded document files.

    Stores the original file binary data and extracted text content.
    Supports PDF, Word, PowerPoint, Excel, TXT, and Markdown files.
    """

    __tablename__ = "subtask_attachments"

    id = Column(Integer, primary_key=True, index=True)

    # Reference to subtasks table (no foreign key constraint for flexibility)
    # 0 means unlinked, > 0 means linked to a subtask
    subtask_id = Column(Integer, nullable=False, default=0, index=True)

    # Foreign key to users table
    user_id = Column(Integer, nullable=False, index=True)

    # File metadata
    original_filename = Column(String(255), nullable=False)
    file_extension = Column(String(20), nullable=False)
    file_size = Column(Integer, nullable=False)  # File size in bytes
    mime_type = Column(String(100), nullable=False)

    # Binary data storage (LONGBLOB for MySQL, LargeBinary for SQLite - supports up to 4GB)
    # When using external storage backends, this column stores empty bytes (b'') as a marker
    binary_data = Column(BinaryDataType, nullable=False, default=b"")

    # External storage backend configuration
    # storage_key: Reference key for external storage (format: attachments/{attachment_id})
    # Empty string means data is stored in MySQL binary_data column
    storage_key = Column(String(500), nullable=False, default="")
    # storage_backend: Type of storage backend used (e.g., "mysql", "s3", "minio")
    # Default is 'mysql' for backward compatibility
    storage_backend = Column(String(50), nullable=False, default="mysql")

    # Image base64 encoding (for vision models, LONGTEXT for MySQL, Text for SQLite)
    # Note: MySQL doesn't allow default values for TEXT/BLOB columns, so nullable=True
    # Empty string or None means no image data
    image_base64 = Column(LongTextType, nullable=True, default="")

    # Extracted text content (LONGTEXT for MySQL, Text for SQLite - supports up to 4GB)
    # Note: MySQL doesn't allow default values for TEXT/BLOB columns, so nullable=True
    # Empty string or None means no extracted text
    extracted_text = Column(LongTextType, nullable=True, default="")
    text_length = Column(
        Integer, nullable=False, default=0
    )  # Character count of extracted text

    # Processing status
    status = Column(
        SQLEnum(AttachmentStatus, values_callable=lambda obj: [e.value for e in obj]),
        nullable=False,
        default=AttachmentStatus.UPLOADING,
    )
    error_message = Column(String(500), nullable=False, default="")

    # Timestamps
    created_at = Column(DateTime, nullable=False, default=func.now())

    __table_args__ = (
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
