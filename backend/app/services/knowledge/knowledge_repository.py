# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge repository module for database queries.

This module contains low-level database query functions for knowledge base operations,
separating query logic from service orchestration.
"""

from typing import Dict

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.knowledge import KnowledgeDocument


def get_document_counts_batch(
    db: Session,
    kb_ids: list[int],
) -> Dict[int, int]:
    """Batch get document counts for multiple knowledge bases.

    This method performs a single database query to get document counts
    for multiple knowledge bases, avoiding the N+1 query problem.

    Args:
        db: Database session
        kb_ids: List of knowledge base IDs

    Returns:
        Dictionary mapping kb_id to document count
    """
    if not kb_ids:
        return {}

    results = (
        db.query(
            KnowledgeDocument.kind_id,
            func.count(KnowledgeDocument.id).label("count"),
        )
        .filter(KnowledgeDocument.kind_id.in_(kb_ids))
        .group_by(KnowledgeDocument.kind_id)
        .all()
    )

    return {kind_id: count for kind_id, count in results}


def get_active_document_counts_batch(
    db: Session,
    kb_ids: list[int],
) -> Dict[int, int]:
    """Batch get active document counts for multiple knowledge bases.

    This method performs a single database query to get active document counts
    for multiple knowledge bases, avoiding the N+1 query problem.

    Args:
        db: Database session
        kb_ids: List of knowledge base IDs

    Returns:
        Dictionary mapping kb_id to active document count
    """
    if not kb_ids:
        return {}

    results = (
        db.query(
            KnowledgeDocument.kind_id,
            func.count(KnowledgeDocument.id).label("count"),
        )
        .filter(
            KnowledgeDocument.kind_id.in_(kb_ids),
            KnowledgeDocument.is_active == True,
        )
        .group_by(KnowledgeDocument.kind_id)
        .all()
    )

    return {kind_id: count for kind_id, count in results}
