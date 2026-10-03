# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Minimal KnowledgeDocument model for knowledge_runtime.

Only the fields needed by KR for config and query metadata are defined here.
The full model lives in the Backend module with additional fields
and enums not required by KR.
"""

from __future__ import annotations

from sqlalchemy import JSON, Boolean, Column, Integer

from shared.models.db.base import Base


class KnowledgeDocument(Base):
    """Document fields needed for indexing config and scoped query metadata."""

    __tablename__ = "knowledge_documents"

    id = Column(Integer, primary_key=True, index=True)
    kind_id = Column(Integer, nullable=False, index=True)
    is_active = Column(Boolean, nullable=False, default=False)
    chunks = Column(JSON, nullable=True)
    attachment_id = Column(Integer, nullable=False, default=0)
    splitter_config = Column(JSON, nullable=False, default={})
