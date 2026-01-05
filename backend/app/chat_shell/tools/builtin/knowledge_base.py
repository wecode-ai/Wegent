# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Knowledge base retrieval tool for RAG functionality."""

import json
import logging
from typing import Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.services.rag.retrieval_service import RetrievalService

logger = logging.getLogger(__name__)


class KnowledgeBaseInput(BaseModel):
    """Input schema for knowledge base retrieval tool."""

    query: str = Field(
        description="Search query to find relevant information in the knowledge base"
    )
    max_results: int = Field(
        default=5, description="Maximum number of results to return"
    )


class KnowledgeBaseTool(BaseTool):
    """Knowledge base retrieval tool that integrates with RAG service.

    This tool allows AI to actively retrieve information from specified knowledge bases.
    It's designed for agentic RAG where AI decides when and how to query the knowledge base.
    """

    name: str = "knowledge_base_search"
    display_name: str = "检索知识库"
    description: str = (
        "Search the knowledge base for relevant information. "
        "Use this tool when you need to find specific information from the knowledge base. "
        "Returns relevant document chunks with their sources and relevance scores."
    )
    args_schema: type[BaseModel] = KnowledgeBaseInput

    # Knowledge base IDs to search (set when creating the tool)
    knowledge_base_ids: list[int] = Field(default_factory=list)

    # User ID for access control
    user_id: int = 0

    # Database session (will be set when tool is created)
    db_session: Optional[Session] = None

    # User subtask ID for persisting RAG results to context database
    # This is the subtask_id of the user message that triggered the AI response
    user_subtask_id: Optional[int] = None

    def _run(
        self,
        query: str,
        max_results: int = 5,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Synchronous run - not implemented, use async version."""
        raise NotImplementedError("KnowledgeBaseTool only supports async execution")

    async def _arun(
        self,
        query: str,
        max_results: int = 5,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Execute knowledge base search asynchronously.

        Args:
            query: Search query
            max_results: Maximum number of results per knowledge base
            run_manager: Callback manager

        Returns:
            JSON string with search results
        """
        try:
            if not self.knowledge_base_ids:
                return json.dumps(
                    {"error": "No knowledge bases configured for this conversation."}
                )

            if not self.db_session:
                return json.dumps({"error": "Database session not available."})

            logger.info(
                f"[KnowledgeBaseTool] Searching {len(self.knowledge_base_ids)} knowledge bases with query: {query}"
            )

            # Create retrieval service
            retrieval_service = RetrievalService()
            all_results = []
            source_references = []
            source_index = 1
            seen_sources = {}  # Track unique sources: (kb_id, source_file) -> index

            # Retrieve from each knowledge base
            for kb_id in self.knowledge_base_ids:
                try:
                    # Use internal method to bypass user permission check
                    # Permission is already validated at task/team level
                    result = (
                        await retrieval_service.retrieve_from_knowledge_base_internal(
                            query=query,
                            knowledge_base_id=kb_id,
                            db=self.db_session,
                        )
                    )

                    records = result.get("records", [])
                    logger.info(
                        f"[KnowledgeBaseTool] Retrieved {len(records)} chunks from KB {kb_id}"
                    )

                    # Collect content and sources for this KB (for persistence)
                    kb_content_parts = []
                    kb_sources = []

                    # Format results for AI consumption and collect source references
                    for record in records:
                        source_file = record.get("title", "Unknown")
                        source_key = (kb_id, source_file)
                        content = record.get("content", "")
                        score = record.get("score", 0.0)

                        # Track unique sources for citation
                        if source_key not in seen_sources:
                            seen_sources[source_key] = source_index
                            source_references.append(
                                {
                                    "index": source_index,
                                    "title": source_file,
                                    "kb_id": kb_id,
                                }
                            )
                            source_index += 1

                        # Add source index to result
                        all_results.append(
                            {
                                "content": content,
                                "source": source_file,
                                "source_index": seen_sources[
                                    source_key
                                ],  # Add reference index
                                "score": score,
                                "knowledge_base_id": kb_id,
                            }
                        )

                        # Collect for persistence
                        kb_content_parts.append(
                            f"[Document: {source_file}] (score: {score:.2f})\n{content}"
                        )
                        kb_sources.append(
                            {
                                "document_name": source_file,
                                "score": score,
                            }
                        )

                    # Persist RAG results to context database if user_subtask_id is available
                    if self.user_subtask_id and kb_content_parts:
                        await self._persist_rag_results(
                            kb_id=kb_id,
                            extracted_text="\n\n".join(kb_content_parts),
                            sources=kb_sources,
                        )

                except ValueError as e:
                    logger.warning(
                        f"[KnowledgeBaseTool] Failed to retrieve from KB {kb_id}: {e}"
                    )
                    continue
                except Exception as e:
                    logger.error(
                        f"[KnowledgeBaseTool] Error retrieving from KB {kb_id}: {e}",
                        exc_info=True,
                    )
                    continue

            if not all_results:
                return json.dumps(
                    {
                        "query": query,
                        "results": [],
                        "count": 0,
                        "sources": [],
                        "message": "No relevant information found in the knowledge base for this query.",
                    },
                    ensure_ascii=False,
                )

            # Sort by score (descending)
            all_results.sort(key=lambda x: x.get("score", 0.0), reverse=True)

            # Limit total results
            all_results = all_results[: max_results * len(self.knowledge_base_ids)]

            logger.info(
                f"[KnowledgeBaseTool] ✅ Returning {len(all_results)} results with {len(source_references)} unique sources for query: {query}"
            )

            return json.dumps(
                {
                    "query": query,
                    "results": all_results,
                    "count": len(all_results),
                    "sources": source_references,  # Include source references for citation
                },
                ensure_ascii=False,
            )

        except Exception as e:
            logger.error(f"[KnowledgeBaseTool] Search failed: {e}", exc_info=True)
            return json.dumps({"error": f"Knowledge base search failed: {str(e)}"})

    async def _persist_rag_results(
        self,
        kb_id: int,
        extracted_text: str,
        sources: list[dict],
    ) -> None:
        """
        Persist RAG retrieval results to context database.

        This method finds the knowledge base context record associated with the
        user subtask and updates it with the retrieved content and sources.

        Args:
            kb_id: Knowledge base ID
            extracted_text: Concatenated retrieval text from RAG
            sources: List of source info dicts with document_name, score
        """
        if not self.user_subtask_id or not self.db_session:
            return

        try:
            from app.services.context import context_service

            # Find the context record for this KB and subtask
            context = context_service.get_knowledge_base_context_by_subtask_and_kb_id(
                db=self.db_session,
                subtask_id=self.user_subtask_id,
                knowledge_id=kb_id,
            )

            if context:
                # Update the context with RAG results
                context_service.update_knowledge_base_retrieval_result(
                    db=self.db_session,
                    context_id=context.id,
                    extracted_text=extracted_text,
                    sources=sources,
                )
                logger.info(
                    f"[KnowledgeBaseTool] ✅ Persisted RAG results for KB {kb_id} "
                    f"to context {context.id} (subtask {self.user_subtask_id})"
                )
            else:
                logger.warning(
                    f"[KnowledgeBaseTool] No context found for KB {kb_id} "
                    f"and subtask {self.user_subtask_id}, skipping persistence"
                )

        except Exception as e:
            # Log error but don't fail the retrieval
            logger.error(
                f"[KnowledgeBaseTool] Failed to persist RAG results for KB {kb_id}: {e}",
                exc_info=True,
            )
