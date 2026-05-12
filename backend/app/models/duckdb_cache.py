# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DuckDB cache model for tracking Excel/CSV data analysis state."""

from __future__ import annotations

from sqlalchemy import JSON, Column, DateTime, Integer, String, func

from app.db.base import Base


class DuckDBCache(Base):
    """Tracks DuckDB generation status and metadata for Excel/CSV attachments.

    Each row corresponds to one source attachment (Excel/CSV file).
    The generated .duckdb file is stored as a separate attachment via
    SubtaskContext, referenced by duckdb_attachment_id.

    No foreign key constraints are used, consistent with the existing
    knowledge_documents.attachment_id pattern. Referential integrity
    is managed at the application layer.
    """

    __tablename__ = "duckdb_cache"

    id = Column(Integer, primary_key=True, autoincrement=True)
    attachment_id = Column(
        Integer,
        nullable=False,
        unique=True,
        index=True,
        comment="Source attachment ID (references subtask_contexts.id)",
    )
    duckdb_attachment_id = Column(
        Integer,
        nullable=True,
        comment="Generated .duckdb file attachment ID (references subtask_contexts.id)",
    )
    summary = Column(
        JSON,
        nullable=True,
        comment="SUMMARIZE output + sample data in JSON format",
    )
    tables_count = Column(
        Integer,
        nullable=False,
        default=0,
        comment="Number of tables in the DuckDB database",
    )
    file_size = Column(
        Integer,
        nullable=False,
        default=0,
        comment="Size of the .duckdb file in bytes",
    )
    source_file_hash = Column(
        String(64),
        nullable=True,
        comment="SHA256 hash of the original source file for change detection",
    )
    status = Column(
        String(20),
        nullable=False,
        default="pending",
        index=True,
        comment="Generation status: pending, generating, ready, failed",
    )
    created_at = Column(
        DateTime,
        nullable=False,
        default=func.now(),
    )
    updated_at = Column(
        DateTime,
        nullable=False,
        default=func.now(),
        onupdate=func.now(),
    )
