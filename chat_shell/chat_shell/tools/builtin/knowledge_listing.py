# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Knowledge base exploration tools for listing and reading documents.

These tools provide Unix-like commands (kb_ls, kb_head) for AI to explore
knowledge base contents when RAG search doesn't find relevant results.
"""

import json
import logging
from typing import Any, Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


def _format_file_size(size_bytes: int) -> str:
    """Format file size in human-readable format."""
    if size_bytes < 1024:
        return f"{size_bytes}B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f}KB"
    else:
        return f"{size_bytes / (1024 * 1024):.1f}MB"


def _get_backend_url() -> str:
    """Get backend API URL from settings."""
    from chat_shell.core.config import settings

    remote_url = getattr(settings, "REMOTE_STORAGE_URL", "")
    if remote_url:
        return remote_url.replace("/api/internal", "")
    return getattr(settings, "BACKEND_API_URL", "http://localhost:8000")


# ============== kb_ls Tool ==============


class KbLsInput(BaseModel):
    """Input schema for kb_ls tool."""

    knowledge_base_id: int = Field(
        description="Knowledge base ID to list documents from"
    )


class KbLsTool(BaseTool):
    """List documents in a knowledge base with metadata and summaries.

    Similar to 'ls -l' command. Use when RAG search doesn't find relevant
    content and you need to explore what documents are available.
    """

    name: str = "kb_ls"
    display_name: str = "列出文档"
    description: str = (
        "List documents in a knowledge base with summaries. Similar to 'ls -l'. "
        "Use when RAG search doesn't find relevant content to explore available documents."
    )
    args_schema: type[BaseModel] = KbLsInput

    # Knowledge base IDs this tool can access (set when creating the tool)
    knowledge_base_ids: list[int] = Field(default_factory=list)

    # Database session (optional, used in package mode)
    db_session: Optional[Any] = None

    def _run(
        self,
        knowledge_base_id: int,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Synchronous run - not implemented, use async version."""
        raise NotImplementedError("KbLsTool only supports async execution")

    async def _arun(
        self,
        knowledge_base_id: int,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """List documents in the specified knowledge base.

        Args:
            knowledge_base_id: Knowledge base ID to list documents from
            run_manager: Callback manager

        Returns:
            JSON string with document list
        """
        try:
            # Validate knowledge base ID is in allowed list
            if (
                self.knowledge_base_ids
                and knowledge_base_id not in self.knowledge_base_ids
            ):
                return json.dumps(
                    {
                        "error": f"Knowledge base {knowledge_base_id} is not accessible. "
                        f"Available KBs: {self.knowledge_base_ids}"
                    },
                    ensure_ascii=False,
                )

            logger.info(f"[KbLsTool] Listing documents in KB {knowledge_base_id}")

            # Try package mode first (direct DB access)
            try:
                return await self._list_docs_package_mode(knowledge_base_id)
            except ImportError:
                # Fall back to HTTP mode
                return await self._list_docs_http_mode(knowledge_base_id)

        except Exception as e:
            logger.error(f"[KbLsTool] Failed to list documents: {e}", exc_info=True)
            return json.dumps(
                {"error": f"Failed to list documents: {str(e)}"}, ensure_ascii=False
            )

    async def _list_docs_package_mode(self, knowledge_base_id: int) -> str:
        """List documents using direct database access."""
        import asyncio

        from app.models.knowledge import KnowledgeDocument

        def _query_docs():
            documents = (
                self.db_session.query(KnowledgeDocument)
                .filter(KnowledgeDocument.kind_id == knowledge_base_id)
                .order_by(KnowledgeDocument.created_at.desc())
                .all()
            )
            return documents

        documents = await asyncio.to_thread(_query_docs)

        doc_items = []
        for doc in documents:
            short_summary = None
            if doc.summary and isinstance(doc.summary, dict):
                short_summary = doc.summary.get("short_summary")

            doc_items.append(
                {
                    "id": doc.id,
                    "name": doc.name,
                    "type": doc.file_extension or "",
                    "size": _format_file_size(doc.file_size or 0),
                    "summary": short_summary,
                    "is_active": doc.is_active,
                }
            )

        logger.info(
            f"[KbLsTool] Listed {len(doc_items)} documents from KB {knowledge_base_id} (package mode)"
        )

        return json.dumps(
            {
                "knowledge_base_id": knowledge_base_id,
                "documents": doc_items,
                "total": len(doc_items),
            },
            ensure_ascii=False,
        )

    async def _list_docs_http_mode(self, knowledge_base_id: int) -> str:
        """List documents via HTTP API."""
        import httpx

        backend_url = _get_backend_url()

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{backend_url}/api/internal/rag/list-docs",
                    json={"knowledge_base_id": knowledge_base_id},
                )

                if response.status_code != 200:
                    logger.warning(
                        f"[KbLsTool] HTTP list-docs returned {response.status_code}"
                    )
                    return json.dumps(
                        {
                            "error": f"Failed to list documents: HTTP {response.status_code}"
                        },
                        ensure_ascii=False,
                    )

                data = response.json()
                documents = data.get("documents", [])

                # Format response for AI consumption
                doc_items = []
                for doc in documents:
                    doc_items.append(
                        {
                            "id": doc.get("id"),
                            "name": doc.get("name"),
                            "type": doc.get("file_extension", ""),
                            "size": _format_file_size(doc.get("file_size", 0)),
                            "summary": doc.get("short_summary"),
                            "is_active": doc.get("is_active", False),
                        }
                    )

                logger.info(
                    f"[KbLsTool] Listed {len(doc_items)} documents from KB {knowledge_base_id} (HTTP mode)"
                )

                return json.dumps(
                    {
                        "knowledge_base_id": knowledge_base_id,
                        "documents": doc_items,
                        "total": len(doc_items),
                    },
                    ensure_ascii=False,
                )

        except Exception as e:
            logger.error(f"[KbLsTool] HTTP list-docs failed: {e}")
            return json.dumps(
                {"error": f"Failed to list documents: {str(e)}"}, ensure_ascii=False
            )


# ============== kb_head Tool ==============


class KbHeadInput(BaseModel):
    """Input schema for kb_head tool."""

    document_ids: list[int] = Field(description="Document IDs to read content from")
    offset: int = Field(default=0, ge=0, description="Start position in characters")
    limit: int = Field(
        default=50000,
        ge=1,
        le=500000,
        description="Max characters to return (default 50KB)",
    )


class KbHeadTool(BaseTool):
    """Read document content with offset/limit pagination.

    Similar to 'head -c' command. Returns partial content starting from
    the specified offset. Use has_more flag to check if more content exists.
    """

    name: str = "kb_head"
    display_name: str = "读取文档"
    description: str = (
        "Read document content with offset/limit. Similar to 'head -c'. "
        "Returns partial content, use offset to continue reading large files."
    )
    args_schema: type[BaseModel] = KbHeadInput

    # Knowledge base IDs this tool can access (set when creating the tool)
    knowledge_base_ids: list[int] = Field(default_factory=list)

    # Database session (optional, used in package mode)
    db_session: Optional[Any] = None

    def _run(
        self,
        document_ids: list[int],
        offset: int = 0,
        limit: int = 50000,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Synchronous run - not implemented, use async version."""
        raise NotImplementedError("KbHeadTool only supports async execution")

    async def _arun(
        self,
        document_ids: list[int],
        offset: int = 0,
        limit: int = 50000,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Read content from specified documents.

        Args:
            document_ids: List of document IDs to read
            offset: Start position in characters
            limit: Maximum characters to return
            run_manager: Callback manager

        Returns:
            JSON string with document contents
        """
        try:
            if not document_ids:
                return json.dumps(
                    {"error": "No document IDs provided"}, ensure_ascii=False
                )

            logger.info(
                f"[KbHeadTool] Reading {len(document_ids)} documents, offset={offset}, limit={limit}"
            )

            # Try package mode first (direct DB access)
            try:
                return await self._read_docs_package_mode(document_ids, offset, limit)
            except ImportError:
                # Fall back to HTTP mode
                return await self._read_docs_http_mode(document_ids, offset, limit)

        except Exception as e:
            logger.error(f"[KbHeadTool] Failed to read documents: {e}", exc_info=True)
            return json.dumps(
                {"error": f"Failed to read documents: {str(e)}"}, ensure_ascii=False
            )

    async def _read_docs_package_mode(
        self, document_ids: list[int], offset: int, limit: int
    ) -> str:
        """Read documents using direct database access."""
        import asyncio

        from app.models.knowledge import KnowledgeDocument
        from app.services.context import context_service

        def _read_single_doc(doc_id: int) -> dict:
            document = (
                self.db_session.query(KnowledgeDocument)
                .filter(KnowledgeDocument.id == doc_id)
                .first()
            )

            if not document:
                return {"id": doc_id, "error": "Document not found"}

            content = ""
            total_length = 0

            if document.attachment_id:
                attachment = context_service.get_context_by_id(
                    db=self.db_session,
                    context_id=document.attachment_id,
                )
                if attachment and attachment.extracted_text:
                    full_content = attachment.extracted_text
                    total_length = len(full_content)
                    start = min(offset, total_length)
                    end = min(start + limit, total_length)
                    content = full_content[start:end]

            returned_length = len(content)
            has_more = (offset + returned_length) < total_length

            return {
                "id": document.id,
                "name": document.name,
                "content": content,
                "total_length": total_length,
                "returned_length": returned_length,
                "has_more": has_more,
            }

        results = []
        for doc_id in document_ids:
            result = await asyncio.to_thread(_read_single_doc, doc_id)
            results.append(result)

        logger.info(f"[KbHeadTool] Read {len(results)} documents (package mode)")

        return json.dumps({"documents": results}, ensure_ascii=False)

    async def _read_docs_http_mode(
        self, document_ids: list[int], offset: int, limit: int
    ) -> str:
        """Read documents via HTTP API."""
        import httpx

        backend_url = _get_backend_url()
        results = []

        async with httpx.AsyncClient(timeout=60.0) as client:
            for doc_id in document_ids:
                try:
                    response = await client.post(
                        f"{backend_url}/api/internal/rag/read-doc",
                        json={
                            "document_id": doc_id,
                            "offset": offset,
                            "limit": limit,
                        },
                    )

                    if response.status_code == 404:
                        results.append({"id": doc_id, "error": "Document not found"})
                        continue

                    if response.status_code != 200:
                        results.append(
                            {"id": doc_id, "error": f"HTTP {response.status_code}"}
                        )
                        continue

                    data = response.json()
                    results.append(
                        {
                            "id": data.get("document_id"),
                            "name": data.get("name"),
                            "content": data.get("content", ""),
                            "total_length": data.get("total_length", 0),
                            "returned_length": data.get("returned_length", 0),
                            "has_more": data.get("has_more", False),
                        }
                    )

                except Exception as e:
                    logger.error(
                        f"[KbHeadTool] HTTP read-doc failed for doc {doc_id}: {e}"
                    )
                    results.append({"id": doc_id, "error": str(e)})

        logger.info(f"[KbHeadTool] Read {len(results)} documents (HTTP mode)")

        return json.dumps({"documents": results}, ensure_ascii=False)
