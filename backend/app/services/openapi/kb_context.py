# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge base context creation for OpenAPI v1/responses endpoint.

This module provides functionality to create SubtaskContext records
for knowledge bases specified in API requests.
"""

import logging
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.services.knowledge.task_knowledge_base_service import (
    task_knowledge_base_service,
)
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
        task=None,
        user_name: Optional[str] = None,
    ) -> List[SubtaskContext]:
        """
        Create SubtaskContext records for knowledge bases.

        This method resolves knowledge base names to IDs and creates
        corresponding SubtaskContext records that will be processed
        by the existing RAG pipeline.

        Args:
            subtask_id: ID of the subtask to attach contexts to
            kb_names: List of dicts with 'namespace' and 'name' keys
            task: Optional task to sync selected KBs into task-level refs
            user_name: Optional user name used as boundBy during task-level sync

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

            if task is not None and user_name:
                self._sync_resolved_refs_to_task(
                    task=task,
                    resolved_refs=resolution_result.resolved,
                    user_name=user_name,
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
            "scope_restricted": kb.scope_restricted,
        }
        if kb.scope_restricted:
            type_data.update(
                {
                    "document_ids": kb.resolved_document_ids,
                    "folder_ids": kb.folder_ids,
                    "explicit_document_ids": kb.explicit_document_ids,
                    "include_subfolders": kb.include_subfolders,
                }
            )

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

    def _sync_resolved_refs_to_task(
        self,
        task,
        resolved_refs: List[ResolvedKnowledgeBase],
        user_name: str,
    ) -> None:
        """Sync API-selected KB refs to task-level scope metadata."""
        self._replace_task_scope_refs(task, resolved_refs, user_name)

        for ref in resolved_refs:
            if ref.scope_restricted:
                continue
            synced = task_knowledge_base_service.sync_subtask_kb_to_task(
                db=self.db,
                task=task,
                knowledge_id=ref.kb_id,
                user_id=self.user_id,
                user_name=user_name,
            )
            if synced:
                logger.info(
                    "[KBContextCreator] Synced KB %s to task %s from subtask-level selection",
                    ref.kb_id,
                    task.id,
                )

    def _replace_task_scope_refs(
        self,
        task,
        resolved_refs: List[ResolvedKnowledgeBase],
        user_name: str,
    ) -> None:
        """Replace task-level API scope refs with the current request selection."""
        task_json = task.json if isinstance(task.json, dict) else {}
        spec = task_json.setdefault("spec", {})
        bound_at = datetime.now(timezone.utc).isoformat()

        spec["knowledgeBaseScopes"] = [
            {
                "id": ref.kb_id,
                "namespace": ref.namespace,
                "name": ref.name,
                "scopeRestricted": ref.scope_restricted,
                "folderIds": ref.folder_ids,
                "explicitDocumentIds": ref.explicit_document_ids,
                "includeSubfolders": ref.include_subfolders,
                "boundBy": user_name,
                "boundAt": bound_at,
            }
            for ref in resolved_refs
        ]

        task_json["spec"] = spec
        task.json = task_json
        flag_modified(task, "json")
        self.db.commit()
        logger.info(
            "[KBContextCreator] Replaced task %s knowledgeBaseScopes with %d refs",
            task.id,
            len(resolved_refs),
        )


def get_task_knowledge_base_scope_refs(task) -> list[dict]:
    """Return normalized task-level API KB scope refs for follow-up requests."""
    task_json = task.json if isinstance(task.json, dict) else {}
    spec = task_json.get("spec", {})
    raw_scope_refs = spec.get("knowledgeBaseScopes") or []
    if not raw_scope_refs:
        return []

    refs: list[dict] = []
    for raw_ref in raw_scope_refs:
        if not isinstance(raw_ref, dict):
            continue
        name = raw_ref.get("name")
        ref_id = raw_ref.get("id")
        if not name and ref_id is None:
            continue
        scope_restricted = bool(raw_ref.get("scopeRestricted", False))
        refs.append(
            {
                "id": ref_id,
                "namespace": raw_ref.get("namespace", "default"),
                "name": name or "",
                "folder_ids": raw_ref.get("folderIds"),
                "document_ids": raw_ref.get("explicitDocumentIds"),
                "include_subfolders": raw_ref.get("includeSubfolders", True),
                "scope_specified": scope_restricted,
            }
        )
    return refs
