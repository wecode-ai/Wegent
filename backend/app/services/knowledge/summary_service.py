# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Summary service for knowledge base and document summarization.

This module provides services for:
- Triggering document summary generation
- Triggering knowledge base summary generation
- Handling summary callbacks from executor
- Managing summary status and updates
"""

import json
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.core.config import settings
from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.schemas.knowledge import (
    DocumentSummary,
    DocumentSummaryCallbackRequest,
    KnowledgeBaseSummary,
    KnowledgeBaseSummaryCallbackRequest,
)
from app.services.group_permission import get_effective_role_in_group
from app.services.knowledge.knowledge_service import KnowledgeService

logger = logging.getLogger(__name__)


class SummaryService:
    """Service for managing document and knowledge base summarization."""

    # ===== Document Summary Methods =====

    @staticmethod
    def get_document_summary(
        db: Session,
        document_id: int,
        user_id: int,
    ) -> Optional[DocumentSummary]:
        """
        Get the summary for a document.

        Args:
            db: Database session
            document_id: Document ID
            user_id: Requesting user ID

        Returns:
            DocumentSummary if available, None otherwise
        """
        doc = KnowledgeService.get_document(db, document_id, user_id)
        if not doc:
            return None

        if doc.summary:
            return DocumentSummary(**doc.summary)
        return None

    @staticmethod
    def trigger_document_summary(
        db: Session,
        document_id: int,
        user_id: int,
        force: bool = False,
    ) -> Dict[str, Any]:
        """
        Trigger document summary generation.

        Args:
            db: Database session
            document_id: Document ID
            user_id: Requesting user ID
            force: Force regeneration even if summary exists

        Returns:
            Dict with status and message

        Raises:
            ValueError: If document not found or not accessible
        """
        if not settings.SUMMARY_ENABLED:
            return {"status": "disabled", "message": "Summary feature is disabled"}

        doc = KnowledgeService.get_document(db, document_id, user_id)
        if not doc:
            raise ValueError("Document not found or access denied")

        # Check if document is indexed (is_active=True)
        if not doc.is_active:
            raise ValueError(
                "Document is not indexed yet. Please wait for indexing to complete."
            )

        # Check if summary already exists and not forcing regeneration
        if doc.summary and not force:
            current_status = doc.summary.get("status", "pending")
            if current_status == "completed":
                return {
                    "status": "exists",
                    "message": "Summary already exists. Use force=true to regenerate.",
                }
            elif current_status == "generating":
                return {
                    "status": "generating",
                    "message": "Summary generation is already in progress.",
                }

        # Update summary status to generating
        summary_data = doc.summary or {}
        summary_data["status"] = "generating"
        summary_data["updated_at"] = datetime.utcnow().isoformat()
        summary_data["error"] = None
        doc.summary = summary_data
        flag_modified(doc, "summary")
        db.commit()

        # TODO: In a full implementation, this would create a Chat Task
        # with summaryContext to trigger the actual summarization via executor.
        # For now, we just mark it as generating and return.
        # The actual implementation would:
        # 1. Get document content from attachment
        # 2. Create a Chat Task with summary Ghost/Bot/Team
        # 3. Task executor calls the callback URL on completion

        logger.info(f"Triggered document summary generation for document {document_id}")

        return {
            "status": "triggered",
            "message": "Summary generation has been triggered.",
            "document_id": document_id,
        }

    @staticmethod
    def update_document_summary(
        db: Session,
        document_id: int,
        data: DocumentSummaryCallbackRequest,
    ) -> bool:
        """
        Update document summary from callback.

        Args:
            db: Database session
            document_id: Document ID
            data: Summary callback data

        Returns:
            True if updated successfully
        """
        doc = (
            db.query(KnowledgeDocument)
            .filter(KnowledgeDocument.id == document_id)
            .first()
        )
        if not doc:
            logger.warning(f"Document {document_id} not found for summary update")
            return False

        # Build summary data
        summary_data = {
            "status": data.status,
            "updated_at": datetime.utcnow().isoformat(),
        }

        if data.status == "completed":
            summary_data["short_summary"] = data.short_summary
            summary_data["long_summary"] = data.long_summary
            summary_data["topics"] = data.topics
            if data.meta_info:
                summary_data["meta_info"] = data.meta_info.model_dump()
        else:
            summary_data["error"] = data.error

        doc.summary = summary_data
        flag_modified(doc, "summary")
        db.commit()

        logger.info(
            f"Updated document {document_id} summary with status: {data.status}"
        )

        # Check if we should trigger knowledge base summary update
        if data.status == "completed":
            SummaryService._check_and_trigger_kb_summary(db, doc.kind_id)

        return True

    # ===== Knowledge Base Summary Methods =====

    @staticmethod
    def get_kb_summary(
        db: Session,
        kb_id: int,
        user_id: int,
    ) -> Optional[KnowledgeBaseSummary]:
        """
        Get the summary for a knowledge base.

        Args:
            db: Database session
            kb_id: Knowledge base ID
            user_id: Requesting user ID

        Returns:
            KnowledgeBaseSummary if available, None otherwise
        """
        kb = KnowledgeService.get_knowledge_base(db, kb_id, user_id)
        if not kb:
            return None

        spec = kb.json.get("spec", {})
        summary_data = spec.get("summary")
        if summary_data:
            return KnowledgeBaseSummary(**summary_data)
        return None

    @staticmethod
    def trigger_kb_summary(
        db: Session,
        kb_id: int,
        user_id: int,
        force: bool = False,
    ) -> Dict[str, Any]:
        """
        Trigger knowledge base summary generation.

        Args:
            db: Database session
            kb_id: Knowledge base ID
            user_id: Requesting user ID
            force: Force regeneration even if threshold not reached

        Returns:
            Dict with status and message

        Raises:
            ValueError: If knowledge base not found or not accessible
        """
        if not settings.SUMMARY_ENABLED:
            return {"status": "disabled", "message": "Summary feature is disabled"}

        kb = KnowledgeService.get_knowledge_base(db, kb_id, user_id)
        if not kb:
            raise ValueError("Knowledge base not found or access denied")

        spec = kb.json.get("spec", {})
        current_summary = spec.get("summary", {})

        # Check current status
        current_status = current_summary.get("status", "pending")
        if current_status == "generating":
            return {
                "status": "generating",
                "message": "Summary generation is already in progress.",
            }

        # Check change threshold if not forcing
        if not force:
            should_trigger, reason = SummaryService._should_trigger_kb_summary(
                db, kb_id, current_summary
            )
            if not should_trigger:
                return {
                    "status": "skipped",
                    "message": reason,
                }

        # Check if all documents have completed summaries
        if not SummaryService._all_documents_summary_completed(db, kb_id):
            return {
                "status": "waiting",
                "message": "Waiting for all document summaries to complete.",
            }

        # Get current document count
        doc_count = KnowledgeService.get_active_document_count(db, kb_id)

        # Update summary status to generating
        current_summary["status"] = "generating"
        current_summary["updated_at"] = datetime.utcnow().isoformat()
        current_summary["error"] = None
        spec["summary"] = current_summary
        kb.json["spec"] = spec
        flag_modified(kb, "json")
        db.commit()

        # TODO: In a full implementation, this would:
        # 1. Aggregate all document summaries
        # 2. Create a Chat Task with summary Ghost/Bot/Team
        # 3. Task executor calls the callback URL on completion

        logger.info(f"Triggered knowledge base summary generation for KB {kb_id}")

        return {
            "status": "triggered",
            "message": "Summary generation has been triggered.",
            "knowledge_base_id": kb_id,
            "document_count": doc_count,
        }

    @staticmethod
    def update_kb_summary(
        db: Session,
        kb_id: int,
        data: KnowledgeBaseSummaryCallbackRequest,
    ) -> bool:
        """
        Update knowledge base summary from callback.

        Args:
            db: Database session
            kb_id: Knowledge base ID
            data: Summary callback data

        Returns:
            True if updated successfully
        """
        kb = (
            db.query(Kind)
            .filter(
                Kind.id == kb_id,
                Kind.kind == "KnowledgeBase",
                Kind.is_active == True,
            )
            .first()
        )
        if not kb:
            logger.warning(f"Knowledge base {kb_id} not found for summary update")
            return False

        # Get current document count
        doc_count = KnowledgeService.get_active_document_count(db, kb_id)

        # Build summary data
        summary_data = {
            "status": data.status,
            "updated_at": datetime.utcnow().isoformat(),
            "last_summary_doc_count": doc_count,
            "meta_info": {
                "document_count": doc_count,
                "last_updated": datetime.utcnow().isoformat(),
            },
        }

        if data.status == "completed":
            summary_data["short_summary"] = data.short_summary
            summary_data["long_summary"] = data.long_summary
            summary_data["topics"] = data.topics
        else:
            summary_data["error"] = data.error

        # Update spec
        spec = kb.json.get("spec", {})
        spec["summary"] = summary_data
        kb.json["spec"] = spec
        flag_modified(kb, "json")
        db.commit()

        logger.info(
            f"Updated knowledge base {kb_id} summary with status: {data.status}"
        )

        return True

    # ===== Helper Methods =====

    @staticmethod
    def _should_trigger_kb_summary(
        db: Session,
        kb_id: int,
        current_summary: Dict[str, Any],
    ) -> tuple[bool, str]:
        """
        Check if knowledge base summary should be triggered based on change threshold.

        Args:
            db: Database session
            kb_id: Knowledge base ID
            current_summary: Current summary data

        Returns:
            Tuple of (should_trigger, reason)
        """
        current_doc_count = KnowledgeService.get_active_document_count(db, kb_id)
        last_doc_count = current_summary.get("last_summary_doc_count")

        # If no previous summary, trigger it
        if last_doc_count is None:
            return True, "No previous summary exists"

        # If no documents, skip
        if current_doc_count == 0:
            return False, "No documents in knowledge base"

        # Calculate change ratio
        if last_doc_count == 0:
            change_ratio = 1.0  # From 0 to something is 100% change
        else:
            change_ratio = abs(current_doc_count - last_doc_count) / last_doc_count

        threshold = settings.SUMMARY_KB_CHANGE_THRESHOLD

        if change_ratio >= threshold:
            return (
                True,
                f"Change ratio {change_ratio:.2%} exceeds threshold {threshold:.0%}",
            )

        return (
            False,
            f"Change ratio {change_ratio:.2%} below threshold {threshold:.0%}. "
            f"Use force=true to regenerate.",
        )

    @staticmethod
    def _all_documents_summary_completed(db: Session, kb_id: int) -> bool:
        """
        Check if all active documents in a knowledge base have completed summaries.

        Args:
            db: Database session
            kb_id: Knowledge base ID

        Returns:
            True if all documents have completed summaries
        """
        from sqlalchemy import func

        # Count active documents
        total_active = (
            db.query(func.count(KnowledgeDocument.id))
            .filter(
                KnowledgeDocument.kind_id == kb_id,
                KnowledgeDocument.is_active == True,
            )
            .scalar()
            or 0
        )

        if total_active == 0:
            return False

        # Count documents with completed summaries
        # We need to filter by JSON field summary->status = 'completed'
        # For MySQL with JSON support:
        completed_count = 0
        docs = (
            db.query(KnowledgeDocument)
            .filter(
                KnowledgeDocument.kind_id == kb_id,
                KnowledgeDocument.is_active == True,
            )
            .all()
        )

        for doc in docs:
            if doc.summary and doc.summary.get("status") == "completed":
                completed_count += 1

        return completed_count == total_active

    @staticmethod
    def _check_and_trigger_kb_summary(db: Session, kb_id: int) -> None:
        """
        Check if knowledge base summary should be triggered after document summary completion.

        This is called after a document summary is completed to check if we should
        automatically trigger KB summary update.

        Args:
            db: Database session
            kb_id: Knowledge base ID
        """
        if not settings.SUMMARY_ENABLED:
            return

        kb = (
            db.query(Kind)
            .filter(
                Kind.id == kb_id,
                Kind.kind == "KnowledgeBase",
                Kind.is_active == True,
            )
            .first()
        )
        if not kb:
            return

        spec = kb.json.get("spec", {})
        current_summary = spec.get("summary", {})

        # Don't trigger if already generating
        if current_summary.get("status") == "generating":
            return

        # Check if threshold is met
        should_trigger, reason = SummaryService._should_trigger_kb_summary(
            db, kb_id, current_summary
        )

        if should_trigger and SummaryService._all_documents_summary_completed(
            db, kb_id
        ):
            logger.info(f"Auto-triggering KB summary for {kb_id}: {reason}")
            # Update status to generating
            current_summary["status"] = "generating"
            current_summary["updated_at"] = datetime.utcnow().isoformat()
            spec["summary"] = current_summary
            kb.json["spec"] = spec
            flag_modified(kb, "json")
            db.commit()

            # TODO: Create actual summary task here

    @staticmethod
    def aggregate_document_summaries(db: Session, kb_id: int) -> str:
        """
        Aggregate all document summaries for a knowledge base.

        This creates a combined text of all document short summaries and topics
        that can be used as input for generating the KB-level summary.

        Args:
            db: Database session
            kb_id: Knowledge base ID

        Returns:
            Aggregated summary text
        """
        docs = (
            db.query(KnowledgeDocument)
            .filter(
                KnowledgeDocument.kind_id == kb_id,
                KnowledgeDocument.is_active == True,
            )
            .all()
        )

        summaries = []
        all_topics = set()

        for doc in docs:
            if doc.summary and doc.summary.get("status") == "completed":
                short_summary = doc.summary.get("short_summary", "")
                topics = doc.summary.get("topics", [])

                if short_summary:
                    summaries.append(f"- {doc.name}: {short_summary}")

                for topic in topics:
                    all_topics.add(topic)

        result_parts = []
        if summaries:
            result_parts.append("Document Summaries:\n" + "\n".join(summaries))
        if all_topics:
            result_parts.append("Topics: " + ", ".join(sorted(all_topics)))

        return "\n\n".join(result_parts)


# Singleton instance
summary_service = SummaryService()
