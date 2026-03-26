# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge base context creation for OpenAPI v1/responses endpoint.

This module provides functionality to create SubtaskContext records
for knowledge bases specified in API requests.
"""

import logging
from typing import List, Optional

from sqlalchemy.orm import Session

from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.services.openapi.kb_resolver import (
    KnowledgeBaseNameResolver,
    ResolvedKnowledgeBase,
)

logger = logging.getLogger(__name__)


class KnowledgeBaseContextCreator:
    """
    Creator for knowledge base SubtaskContext records.

    This class handles the creation of SubtaskContext records for
    knowledge bases specified in OpenAPI requests, enabling RAG
    functionality through the existing context processing pipeline.
    """

    def __init__(self, db: Session, user_id: int):
        """
        Initialize the creator.

        Args:
            db: Database session
            user_id: ID of the user creating the contexts
        """
        self.db = db
        self.user_id = user_id
        self.resolver = KnowledgeBaseNameResolver(db, user_id)

    def create_contexts(
        self,
        subtask_id: int,
        kb_names: List[dict],
    ) -> List[SubtaskContext]:
        """
        Create SubtaskContext records for knowledge bases.

        This method resolves knowledge base names to IDs and creates
        corresponding SubtaskContext records that will be processed
        by the existing RAG pipeline.

        Args:
            subtask_id: ID of the subtask to attach contexts to
            kb_names: List of dicts with 'namespace' and 'name' keys

        Returns:
            List of created SubtaskContext records
        """
        if not kb_names:
            return []

        # Resolve KB names to IDs
        resolution_result = self.resolver.resolve(kb_names, raise_on_error=True)

        if not resolution_result.resolved:
            logger.warning(
                "[KBContextCreator] No knowledge bases resolved for subtask %d",
                subtask_id,
            )
            return []

        # Create SubtaskContext records
        contexts = []
        for kb in resolution_result.resolved:
            context = self._create_kb_context(subtask_id, kb)
            contexts.append(context)

        # Batch insert all contexts
        if contexts:
            self.db.add_all(contexts)
            self.db.commit()

            # Refresh to get IDs
            for ctx in contexts:
                self.db.refresh(ctx)

            logger.info(
                "[KBContextCreator] Created %d KB contexts for subtask %d: %s",
                len(contexts),
                subtask_id,
                [ctx.id for ctx in contexts],
            )

        return contexts

    def _create_kb_context(
        self,
        subtask_id: int,
        kb: ResolvedKnowledgeBase,
    ) -> SubtaskContext:
        """
        Create a single knowledge base SubtaskContext.

        Args:
            subtask_id: ID of the subtask to attach context to
            kb: ResolvedKnowledgeBase with ID and metadata

        Returns:
            SubtaskContext object (not yet committed)
        """
        # Build type_data with knowledge_id for RAG processing
        type_data = {
            "knowledge_id": kb.kb_id,
            "document_count": None,  # Will be populated by RAG service if needed
        }

        context = SubtaskContext(
            subtask_id=subtask_id,
            user_id=self.user_id,
            context_type=ContextType.KNOWLEDGE_BASE.value,
            name=kb.display_name,
            status=ContextStatus.READY.value,
            type_data=type_data,
        )

        logger.debug(
            "[KBContextCreator] Creating KB context: subtask_id=%d, kb_id=%d, name=%s",
            subtask_id,
            kb.kb_id,
            kb.display_name,
        )

        return context
