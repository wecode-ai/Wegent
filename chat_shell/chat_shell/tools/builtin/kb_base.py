# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Base class for knowledge base tools with unified persistence.

This module provides a base class for KB-related tools (KnowledgeBaseTool, KbHeadTool)
that enforces consistent RAG observability tracking through shared persistence methods.
"""

import logging
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional

from langchain_core.tools import BaseTool
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from shared.telemetry.decorators import add_span_event, set_span_attribute, trace_async

logger = logging.getLogger(__name__)


# Default limit for kb_head tool (50KB)
DEFAULT_KB_HEAD_LIMIT = 50000


def _get_backend_url() -> str:
    """Get backend URL from settings."""
    from chat_shell.core.config import settings

    return settings.BACKEND_URL


class KnowledgeBaseToolMixin(ABC):
    """Mixin providing unified persistence methods for KB tools.

    This mixin enforces consistent RAG observability tracking across all KB-related tools.
    Tools using this mixin MUST implement the abstract property `tool_type` to identify
    the type of tool for persistence routing.

    Attributes:
        user_subtask_id: Optional subtask ID for persistence
        knowledge_base_ids: List of allowed KB IDs
        db_session: Database session (sync or async)

    Usage:
        class MyKBTool(BaseTool, KnowledgeBaseToolMixin):
            @property
            def tool_type(self) -> str:
                return "my_tool"

            async def _arun(self, ...):
                # ... tool logic ...
                await self.persist_kb_result(kb_id, ...)
    """

    # These attributes should be set by the implementing class
    user_subtask_id: Optional[int]
    knowledge_base_ids: Optional[List[int]]
    db_session: Optional[Session]

    @property
    @abstractmethod
    def tool_type(self) -> str:
        """Return the tool type identifier for persistence routing.

        Returns:
            One of: 'rag', 'kb_head'
        """
        pass

    @trace_async(
        span_name="kb_tool_persist_result",
        tracer_name="chat_shell.tools.kb_base",
    )
    async def persist_kb_result(
        self,
        kb_id: int,
        *,
        # RAG-specific params
        extracted_text: Optional[str] = None,
        sources: Optional[List[Dict[str, Any]]] = None,
        injection_mode: Optional[str] = None,
        query: Optional[str] = None,
        chunks_count: Optional[int] = None,
        # kb_head-specific params
        document_ids: Optional[List[int]] = None,
        offset: int = 0,
        limit: int = DEFAULT_KB_HEAD_LIMIT,
    ) -> None:
        """Unified persistence method for KB tool results.

        This method routes persistence to the appropriate handler based on tool_type.
        Subclasses should call this method after completing their main logic.

        Args:
            kb_id: Knowledge base ID
            extracted_text: Concatenated retrieval text (RAG only)
            sources: Source references (RAG only)
            injection_mode: 'direct_injection' or 'rag_retrieval' (RAG only)
            query: Original search query (RAG only)
            chunks_count: Number of chunks (RAG only)
            document_ids: Document IDs that were read (kb_head only)
            offset: Start position in characters (kb_head only)
            limit: Max characters returned (kb_head only)
        """
        if not self.user_subtask_id:
            return

        if kb_id not in (self.knowledge_base_ids or []):
            logger.debug(
                f"[KnowledgeBaseToolMixin] Skipping persistence for kb_id={kb_id}, "
                f"not in allowed list: {self.knowledge_base_ids}"
            )
            return

        set_span_attribute("tool_type", self.tool_type)
        set_span_attribute("kb_id", kb_id)
        set_span_attribute("user_subtask_id", self.user_subtask_id)

        # Try package mode first (direct DB access)
        try:
            await self._persist_package_mode(
                kb_id,
                extracted_text=extracted_text,
                sources=sources,
                injection_mode=injection_mode,
                query=query,
                chunks_count=chunks_count,
                document_ids=document_ids,
                offset=offset,
                limit=limit,
            )
            add_span_event("persisted_package_mode")
        except ImportError:
            # HTTP mode: use HTTP API
            await self._persist_http_mode(
                kb_id,
                extracted_text=extracted_text,
                sources=sources,
                injection_mode=injection_mode,
                query=query,
                chunks_count=chunks_count,
                document_ids=document_ids,
                offset=offset,
                limit=limit,
            )
            add_span_event("persisted_http_mode")

    @trace_async(
        span_name="kb_tool_persist_package_mode",
        tracer_name="chat_shell.tools.kb_base",
    )
    async def _persist_package_mode(
        self,
        kb_id: int,
        *,
        extracted_text: Optional[str] = None,
        sources: Optional[List[Dict[str, Any]]] = None,
        injection_mode: Optional[str] = None,
        query: Optional[str] = None,
        chunks_count: Optional[int] = None,
        document_ids: Optional[List[int]] = None,
        offset: int = 0,
        limit: int = DEFAULT_KB_HEAD_LIMIT,
    ) -> None:
        """Persist result using direct database access (package mode)."""
        import asyncio

        from app.services.context.context_service import context_service

        def _persist():
            # Find context record for this subtask and KB
            context = context_service.get_knowledge_base_context_by_subtask_and_kb_id(
                db=self.db_session,
                subtask_id=self.user_subtask_id,
                knowledge_id=kb_id,
            )

            if context is None:
                logger.warning(
                    f"[{self.__class__.__name__}] No context found for "
                    f"subtask_id={self.user_subtask_id}, kb_id={kb_id}"
                )
                return

            if self.tool_type == "rag":
                context_service.update_knowledge_base_retrieval_result(
                    db=self.db_session,
                    context_id=context.id,
                    extracted_text=extracted_text or "",
                    sources=sources or [],
                    injection_mode=injection_mode or "rag_retrieval",
                    query=query or "",
                    chunks_count=chunks_count or 0,
                )
                logger.info(
                    f"[{self.__class__.__name__}] Persisted RAG result: "
                    f"context_id={context.id}, kb_id={kb_id}, "
                    f"injection_mode={injection_mode}, chunks_count={chunks_count}"
                )
            elif self.tool_type == "kb_head":
                context_service.update_knowledge_base_kb_head_result(
                    db=self.db_session,
                    context_id=context.id,
                    document_ids=document_ids or [],
                    offset=offset,
                    limit=limit,
                )
                logger.info(
                    f"[{self.__class__.__name__}] Persisted kb_head result: "
                    f"context_id={context.id}, kb_id={kb_id}, "
                    f"docs={len(document_ids or [])}, offset={offset}, limit={limit}"
                )

        # Run synchronous database operation in thread pool
        await asyncio.to_thread(_persist)

    @trace_async(
        span_name="kb_tool_persist_http_mode",
        tracer_name="chat_shell.tools.kb_base",
    )
    async def _persist_http_mode(
        self,
        kb_id: int,
        *,
        extracted_text: Optional[str] = None,
        sources: Optional[List[Dict[str, Any]]] = None,
        injection_mode: Optional[str] = None,
        query: Optional[str] = None,
        chunks_count: Optional[int] = None,
        document_ids: Optional[List[int]] = None,
        offset: int = 0,
        limit: int = DEFAULT_KB_HEAD_LIMIT,
    ) -> None:
        """Persist result via HTTP API (HTTP mode)."""
        import httpx

        backend_url = _get_backend_url()

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                # Build request based on tool type
                if self.tool_type == "rag":
                    request_body = {
                        "user_subtask_id": self.user_subtask_id,
                        "knowledge_base_id": kb_id,
                        "tool_type": "rag",
                        "extracted_text": extracted_text or "",
                        "sources": sources or [],
                        "injection_mode": injection_mode or "rag_retrieval",
                        "query": query or "",
                        "chunks_count": chunks_count or 0,
                    }
                elif self.tool_type == "kb_head":
                    request_body = {
                        "user_subtask_id": self.user_subtask_id,
                        "knowledge_base_id": kb_id,
                        "tool_type": "kb_head",
                        "document_ids": document_ids or [],
                        "offset": offset,
                        "limit": limit,
                    }
                else:
                    logger.error(f"Unknown tool_type: {self.tool_type}")
                    return

                response = await client.post(
                    f"{backend_url}/api/internal/rag/save-tool-result",
                    json=request_body,
                )

                if response.status_code == 200:
                    data = response.json()
                    if data.get("success"):
                        logger.info(
                            f"[{self.__class__.__name__}] Persisted {self.tool_type} result via HTTP: "
                            f"context_id={data.get('context_id')}, kb_id={kb_id}"
                        )
                    else:
                        logger.warning(
                            f"[{self.__class__.__name__}] Failed to persist: {data.get('message')}"
                        )
                else:
                    logger.warning(
                        f"[{self.__class__.__name__}] HTTP persist failed: "
                        f"status={response.status_code}, body={response.text[:200]}"
                    )

        except Exception as e:
            logger.warning(
                f"[{self.__class__.__name__}] HTTP persist error for kb_id={kb_id}: {e}"
            )
