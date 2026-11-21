# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Immutable answer-time evidence snapshots; business reads are added separately."""

from sqlalchemy import JSON, BigInteger, Column, DateTime, Integer, String, func

from app.db.base import Base


class KnowledgeCitation(Base):
    __tablename__ = "knowledge_citations"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    knowledge_base_id = Column(Integer, nullable=False)
    document_id = Column(Integer, nullable=False)
    title = Column(String(1024), nullable=False)
    content = Column(String(5000), nullable=False)
    user_id = Column(Integer, nullable=False)
    caller_context = Column(JSON, nullable=False)
    source_chunk_id = Column(String(255), nullable=False, server_default="")
    created_at = Column(DateTime, nullable=False, server_default=func.now())

    __table_args__ = {
        "mysql_engine": "InnoDB",
        "mysql_charset": "utf8mb4",
        "mysql_collate": "utf8mb4_unicode_ci",
    }
