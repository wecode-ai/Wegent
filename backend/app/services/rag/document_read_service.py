# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Document reading service for kb_head style access."""

import logging
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.models.knowledge import KnowledgeDocument
from app.models.subtask_context import SubtaskContext

logger = logging.getLogger(__name__)


class DocumentReadService:
    """Read knowledge documents and optionally persist kb_head usage."""

    @staticmethod
    def _load_documents(
        db: Session,
        document_ids: list[int],
    ) -> dict[int, KnowledgeDocument]:
        """Load documents in bulk and index them by ID."""
        if not document_ids:
            return {}

        documents = (
            db.query(KnowledgeDocument)
            .filter(KnowledgeDocument.id.in_(document_ids))
            .all()
        )
        return {document.id: document for document in documents}

    @staticmethod
    def _load_attachment_contexts(
        db: Session,
        attachment_ids: set[int],
    ) -> dict[int, SubtaskContext]:
        """Load attachment contexts in bulk and index them by ID."""
        if not attachment_ids:
            return {}

        contexts = (
            db.query(SubtaskContext).filter(SubtaskContext.id.in_(attachment_ids)).all()
        )
        return {context.id: context for context in contexts}

    @staticmethod
    def _build_document_result(
        *,
        document: KnowledgeDocument,
        attachment: Optional[SubtaskContext],
        offset: int,
        limit: int,
    ) -> Dict[str, Any]:
        """Build the response payload for a readable document."""
        content = ""
        total_length = 0
        actual_start = 0

        if attachment and attachment.extracted_text:
            full_content = attachment.extracted_text
            total_length = len(full_content)
            actual_start = min(offset, total_length)
            end = min(actual_start + limit, total_length)
            content = full_content[actual_start:end]

        returned_length = len(content)
        has_more = (actual_start + returned_length) < total_length

        return {
            "id": document.id,
            "name": document.name,
            "content": content,
            "total_length": total_length,
            "offset": actual_start,
            "returned_length": returned_length,
            "has_more": has_more,
            "kb_id": document.kind_id,
        }

    @staticmethod
    def _persist_kb_head_usage(
        db: Session,
        *,
        user_subtask_id: int,
        user_id: int,
        document_ids_by_kb: dict[int, list[int]],
        offset: int,
        limit: int,
    ) -> None:
        """Persist kb_head usage once per KB for the current tool call."""
        if not document_ids_by_kb:
            return

        from app.services.context.context_service import context_service

        existing_contexts = context_service.get_knowledge_base_context_map_by_subtask(
            db=db,
            subtask_id=user_subtask_id,
            knowledge_ids=list(document_ids_by_kb.keys()),
        )

        for kb_id, document_ids in document_ids_by_kb.items():
            context = existing_contexts.get(kb_id)

            if context is None:
                created_context = (
                    context_service.create_knowledge_base_context_with_result(
                        db=db,
                        subtask_id=user_subtask_id,
                        knowledge_id=kb_id,
                        user_id=user_id,
                        tool_type="kb_head",
                        result_data={
                            "document_ids": document_ids,
                            "offset": offset,
                            "limit": limit,
                        },
                    )
                )
                existing_contexts[kb_id] = created_context
                continue

            context_service.update_knowledge_base_kb_head_result(
                db=db,
                context_id=context.id,
                document_ids=document_ids,
                offset=offset,
                limit=limit,
            )

    def read_documents(
        self,
        db: Session,
        *,
        document_ids: list[int],
        offset: int = 0,
        limit: int = 50_000,
        knowledge_base_ids: Optional[list[int]] = None,
        user_subtask_id: Optional[int] = None,
        user_id: Optional[int] = None,
    ) -> list[Dict[str, Any]]:
        """Read multiple documents while preserving input order."""
        if not document_ids:
            return []

        documents_by_id = self._load_documents(db, document_ids)
        attachments_by_id = self._load_attachment_contexts(
            db,
            {
                document.attachment_id
                for document in documents_by_id.values()
                if document.attachment_id > 0
            },
        )
        allowed_kb_ids = set(knowledge_base_ids or [])
        results: list[Dict[str, Any]] = []
        document_ids_by_kb: dict[int, list[int]] = {}

        for document_id in document_ids:
            document = documents_by_id.get(document_id)
            if document is None:
                results.append({"id": document_id, "error": "Document not found"})
                continue

            if allowed_kb_ids and document.kind_id not in allowed_kb_ids:
                logger.warning(
                    "[document_read] Access denied: doc %d belongs to KB %d, allowed KBs: %s",
                    document_id,
                    document.kind_id,
                    knowledge_base_ids,
                )
                results.append(
                    {
                        "id": document_id,
                        "error": "Access denied: document not in allowed knowledge bases",
                    }
                )
                continue

            attachment = attachments_by_id.get(document.attachment_id)
            results.append(
                self._build_document_result(
                    document=document,
                    attachment=attachment,
                    offset=offset,
                    limit=limit,
                )
            )
            document_ids_by_kb.setdefault(document.kind_id, []).append(document.id)

        if user_subtask_id and user_id is not None and user_id > 0:
            try:
                self._persist_kb_head_usage(
                    db,
                    user_subtask_id=user_subtask_id,
                    user_id=user_id,
                    document_ids_by_kb=document_ids_by_kb,
                    offset=offset,
                    limit=limit,
                )
            except Exception as exc:
                logger.warning(
                    "[document_read] Failed to persist kb_head usage: subtask_id=%s, error=%s",
                    user_subtask_id,
                    exc,
                    exc_info=True,
                )
        elif user_subtask_id:
            logger.warning(
                "[document_read] Skip kb_head persistence because user_id is missing or invalid: "
                "subtask_id=%s, user_id=%s",
                user_subtask_id,
                user_id,
            )

        return results


document_read_service = DocumentReadService()
