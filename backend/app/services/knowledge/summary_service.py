# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
SummaryService - Document and knowledge base summary service.

Responsible for:
- Triggering document summary generation
- Triggering knowledge base summary generation
- Managing summary status
- Checking knowledge base summary trigger conditions
"""

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.core.config import settings
from app.models.kind import Kind
from app.models.knowledge import DocumentSourceType, KnowledgeDocument
from app.schemas.summary import DocumentSummary, KnowledgeBaseSummary
from app.services.background_chat_executor import (
    BackgroundChatExecutor,
    BackgroundTaskConfig,
    BackgroundTaskResult,
)

logger = logging.getLogger(__name__)

# Maximum character length for document content before truncation
MAX_DOCUMENT_CONTENT_LENGTH = 50000

# System prompt for document summary generation
DOCUMENT_SUMMARY_PROMPT = """You are a professional document summary assistant. Your task is:
1. Read and understand the provided document content
2. Generate a concise and accurate short summary (50-100 characters)
3. Generate a detailed long summary (up to 500 characters)
4. Extract 3-5 key topic tags
5. Extract document meta information (if available)

## Language Rules

- Summary language should match the source document
- If the source document is in Chinese, output Chinese summary
- If the source document is in English, output English summary

## Output Format

Please output strictly in the following JSON format (do not include markdown code block markers):
{
  "short_summary": "One sentence summarizing the core content of the document (50-100 characters)",
  "long_summary": "Detailed summary including main points, key information and conclusions (up to 500 characters)",
  "topics": ["topic1", "topic2", "topic3"],
  "meta_info": {
    "author": "Author (if available, otherwise null)",
    "source": "Source (if available, otherwise null)",
    "type": "Document type (e.g.: technical documentation, report, tutorial, etc.)"
  }
}

## Notes

- Summaries should be objective and accurate, without subjective evaluation
- Topic tags should be representative and facilitate search
- If document content is too short, simplify output but maintain JSON format
- Output JSON directly without any other text
"""

# System prompt for knowledge base summary generation
KB_SUMMARY_PROMPT = """You are a professional knowledge base summary assistant. Your task is to generate a comprehensive summary of the entire knowledge base based on the provided document summaries.

## Input Description

You will receive a collection of short summaries and topic tags from all documents in this knowledge base.

## Output Format

Please output strictly in the following JSON format (do not include markdown code block markers):
{
  "short_summary": "One sentence summarizing the overall content and purpose of the knowledge base (50-100 characters)",
  "long_summary": "Detailed description of the main areas covered by the knowledge base, core content, and applicable scenarios (up to 500 characters)",
  "topics": ["core_topic1", "core_topic2", "core_topic3", "core_topic4", "core_topic5"]
}

## Notes

- Synthesize all document summaries to extract overall characteristics of the knowledge base
- Topic tags should be a summary of all document topics, selecting the 5 most representative ones
- Summary language should be consistent with document summaries
- Output JSON directly without any other text
"""


class SummaryService:
    """Summary service."""

    def __init__(self, db: Session):
        self.db = db

    # ==================== Model Configuration ====================

    def _get_model_config_from_kb(
        self, kb: Kind, user_id: int, user_name: str
    ) -> Optional[Dict[str, Any]]:
        """
        Get model configuration from knowledge base spec.

        This method extracts and processes the model configuration, including:
        - Decrypting API keys
        - Resolving environment variable placeholders
        - Processing DEFAULT_HEADERS

        Args:
            kb: Knowledge base Kind object
            user_id: User ID (for user model lookup)
            user_name: Username for placeholder resolution

        Returns:
            Processed model config dict or None if not configured
        """
        from app.services.chat.config.model_resolver import (
            extract_and_process_model_config,
        )

        kb_json = kb.json or {}
        spec = kb_json.get("spec", {})
        summary_model_ref = spec.get("summaryModelRef")

        if not summary_model_ref:
            logger.info(
                f"[SummaryService] No summaryModelRef configured for KB: {kb.id}"
            )
            return None

        model_name = summary_model_ref.get("name")
        model_namespace = summary_model_ref.get("namespace", "default")
        model_type = summary_model_ref.get("type", "public")

        if not model_name:
            logger.warning(
                f"[SummaryService] Invalid summaryModelRef (missing name) for KB: {kb.id}"
            )
            return None

        logger.info(
            f"[SummaryService] Looking up model: name={model_name}, "
            f"namespace={model_namespace}, type={model_type}"
        )

        # Lookup model based on type
        model_spec = None
        if model_type == "public":
            # Query public model from Kind table (user_id=0)
            public_model = (
                self.db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == "Model",
                    Kind.name == model_name,
                    Kind.namespace == "default",
                    Kind.is_active == True,
                )
                .first()
            )
            if public_model:
                model_json = public_model.json or {}
                model_spec = model_json.get("spec", {})
            else:
                logger.warning(f"[SummaryService] Public model not found: {model_name}")
                return None
        else:
            # Query user or group model from Kind table
            query = self.db.query(Kind).filter(
                Kind.kind == "Model",
                Kind.name == model_name,
                Kind.namespace == model_namespace,
                Kind.is_active == True,
            )

            if model_type == "user":
                query = query.filter(Kind.user_id == user_id)

            model = query.first()
            if model:
                model_json = model.json or {}
                model_spec = model_json.get("spec", {})
            else:
                logger.warning(
                    f"[SummaryService] Model not found: name={model_name}, "
                    f"namespace={model_namespace}, type={model_type}"
                )
                return None

        # Extract and process model config (decrypt API key, resolve placeholders, etc.)
        if model_spec:
            try:
                # Use extract_and_process_model_config to support full placeholder resolution
                # This handles ${user.xxx} placeholders in addition to env var placeholders
                processed_config = extract_and_process_model_config(
                    model_spec=model_spec,
                    user_id=user_id,
                    user_name=user_name,
                )
                logger.info(
                    f"[SummaryService] Model config processed successfully: "
                    f"model_id={processed_config.get('model_id')}, "
                    f"model={processed_config.get('model')}, "
                    f"has_api_key={bool(processed_config.get('api_key'))}"
                )
                return processed_config
            except Exception as e:
                logger.error(
                    f"[SummaryService] Failed to process model config: {e}",
                    exc_info=True,
                )
                return None

        return None

    # ==================== Document Summary ====================

    async def trigger_document_summary(
        self, document_id: int, user_id: int, user_name: str
    ) -> Optional[BackgroundTaskResult]:
        """
        Trigger document summary generation.

        Args:
            document_id: Document ID
            user_id: Triggering user ID
            user_name: Username for placeholder resolution

        Returns:
            BackgroundTaskResult or None (if trigger conditions not met)
        """
        logger.info(
            f"[SummaryService] Triggering document summary: "
            f"document_id={document_id}, user_id={user_id}"
        )

        # 1. Get document
        document = (
            self.db.query(KnowledgeDocument)
            .filter(KnowledgeDocument.id == document_id)
            .first()
        )

        if not document:
            logger.warning(f"[SummaryService] Document not found: {document_id}")
            return None

        # 2. Check document type (only FILE and TEXT supported)
        if document.source_type == DocumentSourceType.TABLE.value:
            logger.info(
                f"[SummaryService] Skipping TABLE type document: "
                f"document_id={document_id}, name={document.name}"
            )
            return None

        # 3. Check if document is active
        if not document.is_active:
            logger.info(
                f"[SummaryService] Document not active yet: "
                f"document_id={document_id}, name={document.name}"
            )
            return None

        # 4. Get knowledge base to retrieve model configuration
        kb = (
            self.db.query(Kind)
            .filter(
                Kind.id == document.kind_id,
                Kind.kind == "KnowledgeBase",
            )
            .first()
        )

        if not kb:
            logger.warning(
                f"[SummaryService] Knowledge base not found for document: {document_id}"
            )
            return None

        # 5. Get model configuration from knowledge base
        model_config = self._get_model_config_from_kb(kb, user_id, user_name)
        if not model_config:
            logger.warning(
                f"[SummaryService] No model configured for summary generation in KB: {kb.id}"
            )
            return None

        logger.info(
            f"[SummaryService] Document validation passed: "
            f"document_id={document_id}, name={document.name}, "
            f"source_type={document.source_type}, kb_id={document.kind_id}"
        )

        try:
            # 6. Update status to generating
            summary_data = document.summary or {}
            summary_data["status"] = "generating"
            summary_data["updated_at"] = datetime.now().isoformat()
            document.summary = summary_data
            flag_modified(document, "summary")
            self.db.commit()

            logger.info(
                f"[SummaryService] Document summary status set to generating: "
                f"document_id={document_id}"
            )

            # 7. Get document content
            content = await self._get_document_content(document)
            if not content:
                raise Exception("Failed to get document content")

            logger.info(
                f"[SummaryService] Document content retrieved: "
                f"document_id={document_id}, content_length={len(content)}"
            )

            # 8. Execute summary generation
            logger.info(
                f"[SummaryService] Starting summary generation: document_id={document_id}"
            )
            executor = BackgroundChatExecutor(self.db, user_id)
            result = await executor.execute(
                system_prompt=DOCUMENT_SUMMARY_PROMPT,
                user_message=f"Please generate a summary for the following document:\n\n{content}",
                config=BackgroundTaskConfig(
                    task_type="summary",
                    summary_type="document",
                    document_id=document_id,
                    knowledge_base_id=document.kind_id,
                    model_config=model_config,
                ),
                parse_json=True,
            )

            # 9. Update document summary
            if result.success and result.parsed_content:
                summary_data = {
                    **result.parsed_content,
                    "status": "completed",
                    "task_id": result.task_id,
                    "updated_at": datetime.now().isoformat(),
                }
                logger.info(
                    f"[SummaryService] Document summary completed: "
                    f"document_id={document_id}, task_id={result.task_id}"
                )
            else:
                summary_data = {
                    "status": "failed",
                    "error": result.error or "Failed to parse summary",
                    "task_id": result.task_id,
                    "updated_at": datetime.now().isoformat(),
                }
                logger.error(
                    f"[SummaryService] Document summary failed: "
                    f"document_id={document_id}, error={result.error}"
                )

            document.summary = summary_data
            flag_modified(document, "summary")
            self.db.commit()

            # 10. Check if knowledge base summary needs to be triggered
            if result.success:
                logger.info(
                    f"[SummaryService] Checking KB summary trigger: kb_id={document.kind_id}"
                )
                await self._check_and_trigger_kb_summary(
                    document.kind_id, user_id, user_name
                )

            return result

        except Exception as e:
            logger.exception(
                f"[SummaryService] Document summary generation failed: "
                f"document_id={document_id}"
            )
            self.db.rollback()
            try:
                summary_data = {
                    "status": "failed",
                    "error": str(e),
                    "updated_at": datetime.now().isoformat(),
                }
                document.summary = summary_data
                flag_modified(document, "summary")
                self.db.commit()
            except Exception as commit_error:
                logger.warning(
                    f"[SummaryService] Failed to save error status: {commit_error}"
                )
                self.db.rollback()
            return None

    async def get_document_summary(self, document_id: int) -> Optional[DocumentSummary]:
        """Get document summary."""
        document = (
            self.db.query(KnowledgeDocument)
            .filter(KnowledgeDocument.id == document_id)
            .first()
        )

        if not document or not document.summary:
            return None

        return DocumentSummary(**document.summary)

    async def refresh_document_summary(
        self, document_id: int, user_id: int, user_name: str
    ) -> Optional[BackgroundTaskResult]:
        """Manually refresh document summary."""
        return await self.trigger_document_summary(document_id, user_id, user_name)

    # ==================== Knowledge Base Summary ====================

    async def trigger_kb_summary(
        self,
        kb_id: int,
        user_id: int,
        user_name: str,
        force: bool = False,
        clear_if_empty: bool = False,
    ) -> Optional[BackgroundTaskResult]:
        """
        Trigger knowledge base summary generation.

        Args:
            kb_id: Knowledge base ID (Kind.id)
            user_id: Triggering user ID
            user_name: Username for placeholder resolution
            force: Whether to force trigger (ignore change threshold)
            clear_if_empty: If True and no active documents exist, clear the summary
                           (used after document deletion)
        """
        logger.info(
            f"[SummaryService] Triggering KB summary: "
            f"kb_id={kb_id}, user_id={user_id}, force={force}, clear_if_empty={clear_if_empty}"
        )

        # 1. Get knowledge base with row lock to prevent TOCTOU race condition
        # This ensures atomic check-and-set for "generating" status
        kb = (
            self.db.query(Kind)
            .filter(
                Kind.id == kb_id,
                Kind.kind == "KnowledgeBase",
            )
            .with_for_update()
            .first()
        )

        if not kb:
            logger.warning(f"[SummaryService] KnowledgeBase not found: {kb_id}")
            return None

        logger.info(f"[SummaryService] KB found: kb_id={kb_id}, name={kb.name}")

        # 2. Check if trigger is needed (unless forced)
        # This check is now atomic with the lock
        if not force and not self._should_trigger_kb_summary(kb):
            logger.info(
                f"[SummaryService] KB summary trigger condition not met: "
                f"kb_id={kb_id} (already generating or no changes)"
            )
            return None

        # 3. Aggregate completed document summaries (single query for both text and count)
        # This is done BEFORE model config check to handle clear_if_empty case
        logger.info(f"[SummaryService] Aggregating document summaries: kb_id={kb_id}")
        aggregation = self._get_document_aggregation(kb_id)
        if not aggregation.aggregated_text:
            # No completed document summaries - handle empty state
            # This works even without model config (for clear_if_empty scenario)
            self._handle_empty_kb_summary(
                kb, kb_id, clear_if_empty, aggregation.completed_count
            )
            return None

        logger.info(
            f"[SummaryService] Document summaries aggregated: "
            f"kb_id={kb_id}, completed_count={aggregation.completed_count}"
        )

        # 4. Get model configuration from knowledge base
        # Only needed if we have documents to summarize
        model_config = self._get_model_config_from_kb(kb, user_id, user_name)
        if not model_config:
            logger.warning(
                f"[SummaryService] No model configured for summary generation in KB: {kb_id}"
            )
            return None

        try:
            # 5. Update status to generating (atomic with the lock)
            kb_json = kb.json or {}
            spec = kb_json.get("spec", {})
            spec["summary"] = {
                **(spec.get("summary") or {}),
                "status": "generating",
                "updated_at": datetime.now().isoformat(),
            }
            kb_json["spec"] = spec
            kb.json = kb_json
            flag_modified(kb, "json")
            self.db.commit()  # Release the lock after setting status

            logger.info(
                f"[SummaryService] KB summary status set to generating: kb_id={kb_id}"
            )

            # 6. Execute summary generation
            logger.info(
                f"[SummaryService] Starting KB summary generation: kb_id={kb_id}"
            )
            executor = BackgroundChatExecutor(self.db, user_id)
            result = await executor.execute(
                system_prompt=KB_SUMMARY_PROMPT,
                user_message=f"Please generate a comprehensive summary for the knowledge base based on the following document summaries:\n\n{aggregation.aggregated_text}",
                config=BackgroundTaskConfig(
                    task_type="summary",
                    summary_type="knowledge_base",
                    knowledge_base_id=kb_id,
                    model_config=model_config,
                ),
                parse_json=True,
            )

            # 7. Update knowledge base summary (reuse completed_count from aggregation)
            if result.success and result.parsed_content:
                summary_data = {
                    **result.parsed_content,
                    "status": "completed",
                    "task_id": result.task_id,
                    "updated_at": datetime.now().isoformat(),
                    "last_summary_doc_count": aggregation.completed_count,
                    "meta_info": {
                        "document_count": aggregation.completed_count,
                        "last_updated": datetime.now().isoformat(),
                    },
                }
                logger.info(
                    f"[SummaryService] KB summary completed: "
                    f"kb_id={kb_id}, task_id={result.task_id}, "
                    f"doc_count={aggregation.completed_count}"
                )
            else:
                summary_data = {
                    "status": "failed",
                    "error": result.error or "Failed to parse summary",
                    "task_id": result.task_id,
                    "updated_at": datetime.now().isoformat(),
                }
                logger.error(
                    f"[SummaryService] KB summary failed: "
                    f"kb_id={kb_id}, error={result.error}"
                )

            spec["summary"] = summary_data
            kb_json["spec"] = spec
            kb.json = kb_json
            flag_modified(kb, "json")
            self.db.commit()

            return result

        except Exception as e:
            logger.exception(
                f"[SummaryService] KB summary generation failed: " f"kb_id={kb_id}"
            )
            self.db.rollback()
            try:
                kb_json = kb.json or {}
                spec = kb_json.get("spec", {})
                spec["summary"] = {
                    "status": "failed",
                    "error": str(e),
                    "updated_at": datetime.now().isoformat(),
                }
                kb_json["spec"] = spec
                kb.json = kb_json
                flag_modified(kb, "json")
                self.db.commit()
            except Exception as commit_error:
                logger.warning(
                    f"[SummaryService] Failed to save KB error status: {commit_error}"
                )
                self.db.rollback()
            return None

    async def get_kb_summary(self, kb_id: int) -> Optional[KnowledgeBaseSummary]:
        """Get knowledge base summary."""
        kb = (
            self.db.query(Kind)
            .filter(
                Kind.id == kb_id,
                Kind.kind == "KnowledgeBase",
            )
            .first()
        )

        if not kb:
            return None

        kb_json = kb.json or {}
        summary_data = kb_json.get("spec", {}).get("summary")

        if not summary_data:
            return None

        return KnowledgeBaseSummary(**summary_data)

    async def refresh_kb_summary(
        self, kb_id: int, user_id: int, user_name: str
    ) -> Optional[BackgroundTaskResult]:
        """Manually refresh knowledge base summary."""
        return await self.trigger_kb_summary(kb_id, user_id, user_name, force=True)

    # ==================== Helper Methods ====================

    def _handle_empty_kb_summary(
        self, kb: Kind, kb_id: int, clear_if_empty: bool, completed_count: int
    ) -> None:
        """
        Handle the case when there are no completed document summaries.

        This method is called when no active documents with completed summaries exist.
        It either clears the KB summary (if called from deletion flow) or just logs the state.

        Args:
            kb: Knowledge base Kind object (already fetched with row lock)
            kb_id: Knowledge base ID for logging
            clear_if_empty: If True, clear the summary (used after document deletion)
            completed_count: Number of completed document summaries (for logging)
        """
        if clear_if_empty:
            # Called from deletion flow - clear the summary if it exists
            logger.info(
                f"[SummaryService] No active documents, clearing KB summary: kb_id={kb_id}"
            )
            kb_json = kb.json or {}
            spec = kb_json.get("spec", {})
            if spec.get("summary") is not None:
                spec["summary"] = None
                kb_json["spec"] = spec
                kb.json = kb_json
                flag_modified(kb, "json")
                self.db.commit()
                logger.info(
                    f"[SummaryService] KB summary cleared (no active documents): kb_id={kb_id}"
                )
            else:
                logger.info(
                    f"[SummaryService] KB summary already cleared: kb_id={kb_id}"
                )
        else:
            logger.info(
                f"[SummaryService] No completed document summaries for KB: "
                f"kb_id={kb_id}, completed_count={completed_count}"
            )

    async def _get_document_content(self, document: KnowledgeDocument) -> Optional[str]:
        """
        Get document content.

        Prioritize reusing RAG chunk content, use Map-Reduce if chunks are too many.
        """
        from app.models.subtask_context import SubtaskContext

        # Try to get extracted text from attachment context
        try:
            if document.attachment_id:
                context = (
                    self.db.query(SubtaskContext)
                    .filter(SubtaskContext.id == document.attachment_id)
                    .first()
                )

                if context and context.extracted_text:
                    content = context.extracted_text

                    # Check content length, truncate if too long
                    if len(content) > MAX_DOCUMENT_CONTENT_LENGTH:
                        logger.warning(
                            f"[SummaryService] Document too long ({len(content)} chars), truncating"
                        )
                        content = (
                            content[:MAX_DOCUMENT_CONTENT_LENGTH]
                            + "\n\n[Content truncated...]"
                        )

                    return content

        except Exception as e:
            logger.warning(f"[SummaryService] Failed to get extracted text: {e}")

        return None

    def _should_trigger_kb_summary(self, kb: Kind) -> bool:
        """Check if knowledge base summary update is needed.

        Triggers when:
        - Never generated summary before
        - Not currently generating (debounce for batch uploads)

        Note: We always regenerate if there are any completed document summaries.
        This ensures the KB summary stays up-to-date whenever documents change.
        """
        kb_json = kb.json or {}
        summary = kb_json.get("spec", {}).get("summary")

        if not summary:
            # Never generated summary, should trigger
            return True

        # Skip if currently generating (debounce for batch uploads)
        if summary.get("status") == "generating":
            logger.info(
                f"[SummaryService] KB summary already generating, skipping: {kb.id}"
            )
            return False

        # Always trigger if not generating - the caller will check if there are
        # any completed document summaries to aggregate
        return True

    async def _check_and_trigger_kb_summary(
        self, kb_id: int, user_id: int, user_name: str
    ):
        """Check if knowledge base summary needs to be triggered after document summary completes.

        This method directly delegates to trigger_kb_summary which handles:
        - KB existence check with row lock
        - Trigger condition check (debounce)
        - Document aggregation and summary generation
        """
        logger.info(
            f"[SummaryService] Checking KB summary trigger after doc summary: kb_id={kb_id}"
        )
        # Directly call trigger_kb_summary - it handles all the logic including
        # KB fetch with lock, trigger condition check, and aggregation
        result = await self.trigger_kb_summary(kb_id, user_id, user_name, force=False)

        if result:
            logger.info(
                f"[SummaryService] KB summary triggered successfully: "
                f"kb_id={kb_id}, task_id={result.task_id}"
            )
        else:
            logger.info(
                f"[SummaryService] KB summary not triggered: "
                f"kb_id={kb_id} (conditions not met or already generating)"
            )

    def _get_document_aggregation(self, kb_id: int) -> "DocumentAggregation":
        """
        Get aggregated document summaries and count in a single query.

        This method replaces separate calls to _aggregate_document_summaries and
        _get_completed_doc_count to avoid redundant database queries.

        Args:
            kb_id: Knowledge base ID

        Returns:
            DocumentAggregation containing formatted text and completed count
        """
        documents = (
            self.db.query(KnowledgeDocument)
            .filter(
                KnowledgeDocument.kind_id == kb_id,
                KnowledgeDocument.is_active.is_(True),
            )
            .all()
        )

        summaries = []
        completed_count = 0

        for doc in documents:
            if doc.summary and doc.summary.get("status") == "completed":
                completed_count += 1
                short = doc.summary.get("short_summary", "")
                topics = doc.summary.get("topics", [])
                if short:
                    summaries.append(
                        {
                            "document_name": doc.name,
                            "short_summary": short,
                            "topics": topics,
                        }
                    )

        # Format as text
        aggregated_text = None
        if summaries:
            lines = []
            for i, s in enumerate(summaries, 1):
                lines.append(f"## Document {i}: {s['document_name']}")
                lines.append(f"Summary: {s['short_summary']}")
                lines.append(f"Topics: {', '.join(s['topics'])}")
                lines.append("")
            aggregated_text = "\n".join(lines)

        return DocumentAggregation(
            aggregated_text=aggregated_text,
            completed_count=completed_count,
        )


@dataclass
class DocumentAggregation:
    """Container for aggregated document summary data."""

    aggregated_text: Optional[str]
    completed_count: int


# Service instance factory
def get_summary_service(db: Session) -> SummaryService:
    """Get summary service instance."""
    return SummaryService(db)
