# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Subtask attachment model for storing uploaded document files.

Stores file binary data and extracted text content for chat attachments.
"""
from datetime import datetime
from enum import Enum as PyEnum

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy import Enum as SQLEnum
from sqlalchemy.dialects.mysql import LONGBLOB, LONGTEXT
from sqlalchemy.sql import func

from app.db.base import Base


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
    
    # Foreign key to subtasks table (nullable - can be set after message is sent)
    subtask_id = Column(
        Integer, 
        ForeignKey("subtasks.id", ondelete="CASCADE"), 
        nullable=True,
        index=True
    )
    
    # Foreign key to users table
    user_id = Column(Integer, nullable=False, index=True)
    
    # File metadata
    original_filename = Column(String(255), nullable=False)
    file_extension = Column(String(20), nullable=False)
    file_size = Column(Integer, nullable=False)  # File size in bytes
    mime_type = Column(String(100), nullable=False)
    
    # Binary data storage (LONGBLOB for MySQL - supports up to 4GB)
    binary_data = Column(LONGBLOB, nullable=False)

    # Image base64 encoding (for vision models, LONGTEXT for large images)
    image_base64 = Column(LONGTEXT, nullable=True)

    # Extracted text content (LONGTEXT for MySQL - supports up to 4GB)
    extracted_text = Column(LONGTEXT, nullable=True)
    text_length = Column(Integer, nullable=True)  # Character count of extracted text
    
    # Processing status
    status = Column(
        SQLEnum(AttachmentStatus, values_callable=lambda obj: [e.value for e in obj]),
        nullable=False,
        default=AttachmentStatus.UPLOADING
    )
    error_message = Column(String(500), nullable=True)
    
    # Timestamps
    created_at = Column(DateTime, default=func.now())

    __table_args__ = (
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )