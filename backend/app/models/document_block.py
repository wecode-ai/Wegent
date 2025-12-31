# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
DocumentBlock model for storing parsed document blocks.

Blocks are the basic units of parsed documents, used for preview, editing,
and RAG/vectorization support. Each block represents a logical section
of a document (paragraph, heading, image, table, code, etc.)
"""
import uuid
from datetime import datetime

from sqlalchemy import JSON, Boolean, Column, DateTime, Integer, String, Text

from app.db.base import Base


class DocumentBlock(Base):
    """
    DocumentBlock model for storing parsed document blocks.

    Blocks represent structured content from parsed documents:
    - heading: Document headings (h1-h6, metadata.level indicates level)
    - paragraph: Regular text paragraphs
    - list: Bulleted/numbered lists
    - code: Code blocks (metadata.lang for language)
    - table: Tables (content as markdown table or structured JSON)
    - image: Images (metadata.image_url, content = OCR/AI description)
    - ai_summary: AI-generated summaries
    - unsupported: Unsupported content types

    Source types:
    - markdown: Markdown files
    - pdf: PDF documents
    - docx: Word documents
    - image: Image files
    - git: Git repository content
    - ai: AI-generated content
    """

    __tablename__ = "document_blocks"

    id = Column(
        String(36),
        primary_key=True,
        default=lambda: str(uuid.uuid4()),
        comment="Primary key (UUID)",
    )
    document_id = Column(
        String(36),
        nullable=False,
        index=True,
        comment="Reference to uploaded document",
    )
    source_type = Column(
        String(20),
        nullable=False,
        default="markdown",
        comment="Source type: markdown, pdf, docx, image, git, ai",
    )
    block_type = Column(
        String(50),
        nullable=False,
        comment="Block type: paragraph, heading, image, table, code, ai_summary, unsupported, list",
    )
    content = Column(
        Text,
        nullable=True,
        comment="Text content or image description",
    )
    editable = Column(
        Boolean,
        default=False,
        comment="Whether user can edit this block",
    )
    order_index = Column(
        Integer,
        nullable=False,
        comment="Order within document",
    )
    source_ref = Column(
        JSON,
        nullable=True,
        comment="Source reference: {page, line, offset, bbox, etc.}",
    )
    metadata = Column(
        JSON,
        nullable=True,
        comment="Block metadata: {image_url, ocr_text, lang, level, etc.}",
    )
    created_at = Column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        comment="Creation time",
    )
    updated_at = Column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        comment="Update time",
    )

    __table_args__ = (
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )
