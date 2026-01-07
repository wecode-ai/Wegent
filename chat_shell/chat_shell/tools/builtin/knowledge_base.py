# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Knowledge base retrieval tool for RAG functionality.

NOTE: This tool requires the RAG service which is currently in backend.
For now, this is a placeholder implementation. In production, either:
1. Call backend RAG API via HTTP
2. Migrate RAG service to shared or chat-shell
"""

import json
import logging
from typing import Any, Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

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
    # Accepts both sync Session (backend) and AsyncSession (chat_shell HTTP mode)
    # In HTTP mode, db_session is not used - retrieval goes through HTTP API
    db_session: Optional[Any] = None

    # User subtask ID for persisting RAG results to context database
    # This is the subtask_id of the user message that triggered the AI response
    user_subtask_id: Optional[int] = None

    class Config:
        arbitrary_types_allowed = True

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

            # Import RAG service - try backend first, then fallback
            all_results = []
            source_references = []
            source_index = 1
            seen_sources: dict[tuple[int, str], int] = {}

            try:
                # Try to use the RAG service via HTTP or direct import
                all_results, source_references = await self._retrieve_from_rag(
                    query, max_results, seen_sources
                )
            except ImportError as e:
                logger.warning(
                    f"[KnowledgeBaseTool] RAG service not available: {e}. "
                    "Knowledge base search requires backend RAG service."
                )
                return json.dumps(
                    {
                        "error": "RAG service not available. Please ensure backend is running.",
                        "query": query,
                    }
                )

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
                    "sources": source_references,
                },
                ensure_ascii=False,
            )

        except Exception as e:
            logger.error(f"[KnowledgeBaseTool] Search failed: {e}", exc_info=True)
            return json.dumps({"error": f"Knowledge base search failed: {str(e)}"})

    async def _retrieve_from_rag(
        self,
        query: str,
        max_results: int,
        seen_sources: dict[tuple[int, str], int],
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Retrieve from RAG service.

        This method attempts to use the backend RAG service.
        In production, this could be replaced with HTTP API calls.

        Args:
            query: Search query
            max_results: Max results per KB
            seen_sources: Dict to track unique sources

        Returns:
            Tuple of (results, source_references)
        """
        # Try to import from backend if available (when running inside backend process)
        try:
            from app.services.rag.retrieval_service import RetrievalService

            retrieval_service = RetrievalService()
            all_results = []
            source_references = []
            source_index = 1

            for kb_id in self.knowledge_base_ids:
                try:
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

                    for record in records:
                        source_file = record.get("title", "Unknown")
                        source_key = (kb_id, source_file)
                        content = record.get("content", "")
                        score = record.get("score", 0.0)

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

                        all_results.append(
                            {
                                "content": content,
                                "source": source_file,
                                "source_index": seen_sources[source_key],
                                "score": score,
                                "knowledge_base_id": kb_id,
                            }
                        )

                except Exception as e:
                    logger.error(
                        f"[KnowledgeBaseTool] Error retrieving from KB {kb_id}: {e}"
                    )
                    continue

            return all_results, source_references

        except ImportError:
            # Backend RAG service not available, try HTTP fallback
            return await self._retrieve_via_http(query, max_results, seen_sources)

    async def _retrieve_via_http(
        self,
        query: str,
        max_results: int,
        seen_sources: dict[tuple[int, str], int],
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Retrieve from RAG service via HTTP API.

        This is a fallback when direct import is not available.
        Uses the internal RAG API endpoint at /api/internal/rag/retrieve.

        Args:
            query: Search query
            max_results: Max results per KB
            seen_sources: Dict to track unique sources

        Returns:
            Tuple of (results, source_references)
        """
        import httpx

        from chat_shell.core.config import settings

        all_results = []
        source_references = []
        source_index = 1

        # Get backend API URL from settings (use REMOTE_STORAGE_URL as base)
        # REMOTE_STORAGE_URL is like "http://localhost:9000/api/internal"
        # We need "http://localhost:9000" for the backend base URL
        remote_url = getattr(settings, "REMOTE_STORAGE_URL", "")
        if remote_url:
            # Remove /api/internal suffix to get backend base
            backend_url = remote_url.replace("/api/internal", "")
        else:
            backend_url = getattr(settings, "BACKEND_API_URL", "http://localhost:8000")

        async with httpx.AsyncClient(timeout=30.0) as client:
            for kb_id in self.knowledge_base_ids:
                try:
                    # Call internal RAG API (simplified endpoint for chat_shell)
                    response = await client.post(
                        f"{backend_url}/api/internal/rag/retrieve",
                        json={
                            "query": query,
                            "knowledge_base_id": kb_id,
                            "max_results": max_results,
                        },
                    )

                    if response.status_code != 200:
                        logger.warning(
                            f"[KnowledgeBaseTool] Internal RAG API returned {response.status_code}: {response.text}"
                        )
                        continue

                    data = response.json()
                    records = data.get("records", [])

                    logger.info(
                        f"[KnowledgeBaseTool] HTTP retrieved {len(records)} chunks from KB {kb_id}"
                    )

                    for record in records:
                        source_file = record.get("title", "Unknown")
                        source_key = (kb_id, source_file)
                        content = record.get("content", "")
                        score = record.get("score", 0.0)

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

                        all_results.append(
                            {
                                "content": content,
                                "source": source_file,
                                "source_index": seen_sources[source_key],
                                "score": score,
                                "knowledge_base_id": kb_id,
                            }
                        )

                except Exception as e:
                    logger.error(
                        f"[KnowledgeBaseTool] HTTP RAG call failed for KB {kb_id}: {e}"
                    )
                    continue

        return all_results, source_references
