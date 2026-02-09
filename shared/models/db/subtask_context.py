# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Subtask context model for storing various context types.

Supports multiple context types including attachments, knowledge bases, etc.
"""

from typing import List, Optional

from sqlalchemy import Column, DateTime, Integer, LargeBinary, String, Text
from sqlalchemy.dialects.mysql import JSON, LONGBLOB, LONGTEXT
from sqlalchemy.sql import func

from .base import Base
from .enums import ContextStatus

# Type adapters for cross-database compatibility (MySQL/SQLite)
# Uses LONGBLOB for MySQL, LargeBinary for others (e.g., SQLite in tests)
BinaryDataType = LargeBinary().with_variant(LONGBLOB, "mysql")

# Uses LONGTEXT for MySQL, Text for others (e.g., SQLite in tests)
LongTextType = Text().with_variant(LONGTEXT, "mysql")


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

    # Binary data storage (LONGBLOB for MySQL, LargeBinary for SQLite)
    binary_data = Column(BinaryDataType, nullable=False, default=b"")

    # Image base64 encoding (for vision models)
    image_base64 = Column(LongTextType, nullable=False, default="")

    # Extracted text content
    extracted_text = Column(LongTextType, nullable=False, default="")

    # Character count of extracted text
    text_length = Column(Integer, nullable=False, default=0)

    # Type-specific metadata (JSON)
    # For attachment type, includes:
    # - original_filename: Original file name
    # - file_extension: File extension
    # - file_size: File size in bytes
    # - mime_type: MIME type
    # - storage_backend: Storage backend type (e.g., "mysql", "s3")
    # - storage_key: Storage key for retrieving binary data
    # - is_encrypted: Whether binary_data is encrypted (bool, default: False)
    # - encryption_version: Encryption version for future key rotation (int, 0 = unencrypted, 1 = AES-256-CBC)
    #
    # For knowledge_base type, includes:
    # - knowledge_id: Knowledge base ID
    # - document_count: Number of documents in knowledge base
    # - sources: List of source references [{index, title, kb_id, score?}]
    # - injection_mode: "direct_injection" or "rag_retrieval" (RAG observability)
    # - query: Original search query (RAG observability)
    # - chunks_count: Number of chunks retrieved/injected (RAG observability)
    # - retrieval_count: Number of times retrieval was executed (for duration calculation)
    # - kb_head_count: Number of times kb_head tool was used (kb_head observability)
    # - kb_head_total_chars: Total characters read via kb_head (kb_head observability)
    # - kb_head_document_ids: List of document IDs accessed via kb_head (kb_head observability)
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

    @property
    def is_encrypted(self) -> bool:
        """Get encryption status from type_data (attachment type)."""
        if self.type_data and isinstance(self.type_data, dict):
            return self.type_data.get("is_encrypted", False)
        return False

    @property
    def encryption_version(self) -> int:
        """Get encryption version from type_data (attachment type)."""
        if self.type_data and isinstance(self.type_data, dict):
            return self.type_data.get("encryption_version", 0)
        return 0

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

    @property
    def injection_mode(self) -> Optional[str]:
        """Get injection mode from type_data (knowledge_base type).

        Returns:
            "direct_injection" or "rag_retrieval", or None if not set.
        """
        if self.type_data and isinstance(self.type_data, dict):
            # Try new rag_result structure first, then fall back to legacy flat field
            rag_result = self.type_data.get("rag_result", {})
            if rag_result:
                return rag_result.get("injection_mode")
            return self.type_data.get("injection_mode")
        return None

    @property
    def query(self) -> Optional[str]:
        """Get query from type_data (knowledge_base type).

        Returns:
            Original search query used for RAG retrieval.
        """
        if self.type_data and isinstance(self.type_data, dict):
            # Try new rag_result structure first, then fall back to legacy flat field
            rag_result = self.type_data.get("rag_result", {})
            if rag_result:
                return rag_result.get("query")
            return self.type_data.get("query")
        return None

    @property
    def chunks_count(self) -> int:
        """Get chunks count from type_data (knowledge_base type).

        Returns:
            Number of chunks retrieved/injected.
        """
        if self.type_data and isinstance(self.type_data, dict):
            # Try new rag_result structure first, then fall back to legacy flat field
            rag_result = self.type_data.get("rag_result", {})
            if rag_result:
                return rag_result.get("chunks_count", 0)
            return self.type_data.get("chunks_count", 0)
        return 0

    @property
    def retrieval_count(self) -> int:
        """Get retrieval count from type_data (knowledge_base type).

        Tracks how many times the RAG tool was called for this context.
        Used for duration calculation when updated_at timestamp is overwritten
        by multiple tool calls.

        Returns:
            Number of times retrieval was executed (1 = first call, >1 = multiple calls).
        """
        if self.type_data and isinstance(self.type_data, dict):
            # Try new rag_result structure first, then fall back to legacy flat field
            rag_result = self.type_data.get("rag_result", {})
            if rag_result:
                return rag_result.get("retrieval_count", 0)
            return self.type_data.get("retrieval_count", 0)
        return 0

    @property
    def kb_head_count(self) -> int:
        """Get kb_head usage count from type_data (knowledge_base type).

        Tracks how many times the kb_head tool was called for this context.
        Used for observability and cross-turn content injection.

        Returns:
            Number of times kb_head was executed.
        """
        if self.type_data and isinstance(self.type_data, dict):
            # Try new structure first, then fall back to legacy flat field
            kb_head_result = self.type_data.get("kb_head_result", {})
            if kb_head_result:
                return kb_head_result.get("usage_count", 0)
            return self.type_data.get("kb_head_count", 0)
        return 0

    @property
    def kb_head_document_ids(self) -> List[int]:
        """Get document IDs accessed via kb_head from type_data (knowledge_base type).

        Returns the list of document IDs that were read using kb_head tool.
        Used for cross-turn content injection.

        Returns:
            List of document IDs accessed via kb_head.
        """
        if self.type_data and isinstance(self.type_data, dict):
            # Try new structure first, then fall back to legacy flat field
            kb_head_result = self.type_data.get("kb_head_result", {})
            if kb_head_result:
                return kb_head_result.get("document_ids", [])
            return self.type_data.get("kb_head_document_ids", [])
        return []

    @property
    def rag_result(self) -> dict:
        """Get RAG result sub-object from type_data (knowledge_base type).

        Returns:
            Dict with sources, injection_mode, query, chunks_count, retrieval_count.
        """
        if self.type_data and isinstance(self.type_data, dict):
            return self.type_data.get("rag_result", {})
        return {}

    @property
    def kb_head_result(self) -> dict:
        """Get kb_head result sub-object from type_data (knowledge_base type).

        Returns:
            Dict with usage_count, document_ids, offset, limit.
        """
        if self.type_data and isinstance(self.type_data, dict):
            return self.type_data.get("kb_head_result", {})
        return {}

    # === Common helper properties ===

    @property
    def text_preview(self) -> str:
        """Get a preview of extracted_text (first 50 chars)."""
        if not self.extracted_text:
            return ""
        text = " ".join(self.extracted_text.split())
        if len(text) > 50:
            return text[:50] + "..."
        return text
