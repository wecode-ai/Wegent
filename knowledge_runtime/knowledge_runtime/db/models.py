# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Read-only database models for knowledge_runtime.

Kind and User models are reused from shared.models.db.
KnowledgeDocumentReadOnly is a lightweight mapping with only the fields KR needs.
"""

from sqlalchemy import JSON, Column, Integer
from sqlalchemy.orm import declarative_base

from shared.models.db import Kind, User

Kind = Kind  # Re-export for convenience
User = User  # Re-export for convenience

# Use a separate Base for KR-specific models to avoid metadata conflicts
# with shared's Base (which may have table_args KR doesn't need)
_KRBase = declarative_base()


class KnowledgeDocumentReadOnly(_KRBase):
    """Lightweight read-only mapping for knowledge_documents table.

    Only maps fields that KR needs (splitter_config for indexing).
    All other fields (status, index_status, summary, etc.) are Backend business logic.
    """

    __tablename__ = "knowledge_documents"

    id = Column(Integer, primary_key=True)
    kind_id = Column(Integer)
    splitter_config = Column(JSON)
