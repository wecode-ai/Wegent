# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Subtask context model for storing various context types.

Supports multiple context types including attachments, knowledge bases, etc.
Replaces the original subtask_attachments table with a more flexible design.
"""

from datetime import datetime
from enum import Enum as PyEnum

from sqlalchemy import Column, DateTime, Integer, LargeBinary, String, Text
from sqlalchemy.dialects.mysql import JSON, LONGBLOB, LONGTEXT
from sqlalchemy.sql import func

from app.db.base import Base

# Type adapters for cross-database compatibility (MySQL/SQLite)
# Uses LONGBLOB for MySQL, LargeBinary for others (e.g., SQLite in tests)
BinaryDataType = LargeBinary().with_variant(LONGBLOB, "mysql")

# Uses LONGTEXT for MySQL, Text for others (e.g., SQLite in tests)
LongTextType = Text().with_variant(LONGTEXT, "mysql")


class ContextType(str, PyEnum):
    """Context type enumeration."""

    ATTACHMENT = "attachment"
    KNOWLEDGE_BASE = "knowledge_base"


class ContextStatus(str, PyEnum):
    """Context processing status."""

    PENDING = "pending"
    UPLOADING = "uploading"
    PARSING = "parsing"
    READY = "ready"
    FAILED = "failed"


class SubtaskContext(Base):
    """
    Subtask context storage for various context types.

    Supports attachments (PDF, Word, images, etc.) and knowledge base references.
    Uses type_data JSON field for type-specific metadata.
    """

    __tablename__ = "subtask_contexts"

    id = Column(Integer, primary_key=True, index=True)

    # Reference to subtasks table (no foreign key constraint for flexibility)
    # 0 means unlinked, > 0 means linked to a subtask
    subtask_id = Column(Integer, nullable=False, default=0, index=True)

    # User who created this context
    user_id = Column(Integer, nullable=False, index=True)

    # Context type: 'attachment', 'knowledge_base', etc.
    context_type = Column(String(50), nullable=False, index=True)

    # Display name
    name = Column(String(255), nullable=False)

    # Processing status
    status = Column(
        String(20), nullable=False, default=ContextStatus.PENDING.value, index=True
    )
    error_message = Column(Text, nullable=False, default="")

    # Special content fields (used by different types as needed)
    # Note: BLOB/TEXT fields cannot have server_default in MySQL, but application
    # layer provides default values (empty string/bytes) to ensure NOT NULL constraint

    # Binary data storage (LONGBLOB for MySQL, LargeBinary for SQLite - supports up to 4GB)
    # When using external storage backends, this column stores empty bytes (b'') as a marker
    binary_data = Column(BinaryDataType, nullable=False, default=b"")

    # Image base64 encoding (for vision models, LONGTEXT for MySQL, Text for SQLite)
    # Empty string means no image data
    image_base64 = Column(LongTextType, nullable=False, default="")

    # Extracted text content (LONGTEXT for MySQL, Text for SQLite - supports up to 4GB)
    # For attachments: parsed text from documents
    # For knowledge bases: RAG retrieval results
    # Empty string means no extracted text
    extracted_text = Column(LongTextType, nullable=False, default="")

    # Character count of extracted text
    text_length = Column(Integer, nullable=False, default=0)

    # Type-specific metadata (JSON)
    # For attachment: original_filename, file_extension, file_size, mime_type, storage_key, storage_backend
    # For knowledge_base: knowledge_id, document_count, retriever_name, retriever_namespace
    type_data = Column(JSON, nullable=False, default=dict)

    # Timestamps
    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(
        DateTime, nullable=False, default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )

    # === Helper properties for attachment type ===

    @property
    def original_filename(self) -> str:
        """Get original filename from type_data (attachment type)."""
        if self.type_data and isinstance(self.type_data, dict):
            return self.type_data.get("original_filename", self.name)
        return self.name

    @property
    def file_extension(self) -> str:
        """Get file extension from type_data (attachment type)."""
        if self.type_data and isinstance(self.type_data, dict):
            return self.type_data.get("file_extension", "")
        return ""

    @property
    def file_size(self) -> int:
        """Get file size from type_data (attachment type)."""
        if self.type_data and isinstance(self.type_data, dict):
            return self.type_data.get("file_size", 0)
        return 0

    @property
    def mime_type(self) -> str:
        """Get MIME type from type_data (attachment type)."""
        if self.type_data and isinstance(self.type_data, dict):
            return self.type_data.get("mime_type", "")
        return ""

    @property
    def storage_key(self) -> str:
        """Get storage key from type_data (attachment type)."""
        if self.type_data and isinstance(self.type_data, dict):
            return self.type_data.get("storage_key", "")
        return ""

    @property
    def storage_backend(self) -> str:
        """Get storage backend from type_data (attachment type)."""
        if self.type_data and isinstance(self.type_data, dict):
            return self.type_data.get("storage_backend", "mysql")
        return "mysql"

    # === Helper properties for knowledge_base type ===

    @property
    def knowledge_id(self) -> int:
        """Get knowledge ID from type_data (knowledge_base type)."""
        if self.type_data and isinstance(self.type_data, dict):
            return self.type_data.get("knowledge_id", 0)
        return 0

    @property
    def document_count(self) -> int:
        """Get document count from type_data (knowledge_base type)."""
        if self.type_data and isinstance(self.type_data, dict):
            return self.type_data.get("document_count", 0)
        return 0

    # === Common helper properties ===

    @property
    def text_preview(self) -> str:
        """Get a preview of extracted_text (first 50 chars).

        Useful for logging and debugging purposes.
        Replaces newlines with spaces for cleaner log output.
        """
        if not self.extracted_text:
            return ""
        # Replace newlines and multiple spaces with single space
        text = " ".join(self.extracted_text.split())
        if len(text) > 50:
            return text[:50] + "..."
        return text
