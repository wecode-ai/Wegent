# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Knowledge base exploration tools for listing and reading documents.

These tools provide Unix-like commands (kb_ls, kb_head) for AI to explore
knowledge base contents when RAG search doesn't find relevant results.

These tools share the same call limit (max_calls_per_conversation) with
knowledge_base_search tool to prevent excessive knowledge base access.
"""

import json
import logging
from typing import Any, Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field, PrivateAttr

from shared.telemetry.decorators import add_span_event, set_span_attribute, trace_async

logger = logging.getLogger(__name__)

# Default configuration values
DEFAULT_MAX_CALLS_PER_CONVERSATION = 10

# File size constants for human-readable formatting
KB = 1024
MB = KB * KB


class KBToolCallCounter:
    """Shared call counter for KB exploration tools (kb_ls, kb_head).

    This counter is shared across kb_ls and kb_head tools to enforce
    the max_calls_per_conversation limit. The counter is separate from
    knowledge_base_search's counter since exploration tools are secondary.

    Note: While knowledge_base_search has its own internal counter with
    token-based warnings, kb_ls and kb_head share this simpler counter
    that only enforces the hard max limit.
    """

    def __init__(self, max_calls: int = DEFAULT_MAX_CALLS_PER_CONVERSATION):
        self.max_calls = max_calls
        self.call_count = 0

    def check_and_increment(self) -> tuple[bool, Optional[str]]:
        """Check if call is allowed and increment counter.

        Returns:
            Tuple of (allowed, error_message)
            - allowed: True if call should proceed
            - error_message: JSON string with rejection info if not allowed
        """
        if self.call_count >= self.max_calls:
            logger.warning(
                "[KBToolCallCounter] Call REJECTED | Reason: max_calls_exceeded | "
                "Call count: %d/%d",
                self.call_count + 1,
                self.max_calls,
            )
            return False, json.dumps(
                {
                    "status": "rejected",
                    "reason": "max_calls_exceeded",
                    "message": f"🚫 Call Rejected: Maximum knowledge base tool call limit ({self.max_calls}) "
                    f"reached for this conversation. You have made {self.call_count} calls. "
                    f"Please use the information you've already gathered to answer the user's question.",
                    "call_count": self.call_count,
                    "max_calls": self.max_calls,
                },
                ensure_ascii=False,
            )

        self.call_count += 1
        logger.info(
            "[KBToolCallCounter] Call %d/%d allowed",
            self.call_count,
            self.max_calls,
        )
        return True, None


def _format_file_size(size_bytes: int) -> str:
    """Format file size in human-readable format."""
    if size_bytes < KB:
        return f"{size_bytes}B"
    elif size_bytes < MB:
        return f"{size_bytes / KB:.1f}KB"
    else:
        return f"{size_bytes / MB:.1f}MB"


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

    This tool shares call limits with kb_head via a shared counter.
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

    # Shared call counter (set when creating the tool, shared with kb_head)
    _call_counter: Optional[KBToolCallCounter] = PrivateAttr(default=None)

    def _run(
        self,
        knowledge_base_id: int,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Synchronous run - not implemented, use async version."""
        raise NotImplementedError("KbLsTool only supports async execution")

    @trace_async(span_name="kb_ls_arun", tracer_name="chat_shell.tools.kb_ls")
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
            add_span_event("listing_documents")
            set_span_attribute("knowledge_base_id", knowledge_base_id)

            # Check call limit if counter is set
            if self._call_counter:
                allowed, error_msg = self._call_counter.check_and_increment()
                if not allowed:
                    return error_msg

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

    @trace_async(
        span_name="kb_ls_list_docs_package_mode",
        tracer_name="chat_shell.tools.kb_ls",
    )
    async def _list_docs_package_mode(self, knowledge_base_id: int) -> str:
        """List documents using direct database access."""
        import asyncio

        from app.models.knowledge import KnowledgeDocument

        add_span_event("listing_documents")
        set_span_attribute("knowledge_base_id", knowledge_base_id)
        set_span_attribute("mode", "package")

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

        set_span_attribute("document_count", len(doc_items))

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

    @trace_async(
        span_name="kb_ls_list_docs_http_mode", tracer_name="chat_shell.tools.kb_ls"
    )
    async def _list_docs_http_mode(self, knowledge_base_id: int) -> str:
        """List documents via HTTP API."""
        import httpx

        add_span_event("listing_documents")
        set_span_attribute("knowledge_base_id", knowledge_base_id)
        set_span_attribute("mode", "http")

        backend_url = _get_backend_url()

        try:
            add_span_event("http_request_started")
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

                set_span_attribute("document_count", len(doc_items))

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

    This tool shares call limits with kb_ls via a shared counter.
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

    # Shared call counter (set when creating the tool, shared with kb_ls)
    _call_counter: Optional[KBToolCallCounter] = PrivateAttr(default=None)

    def _run(
        self,
        document_ids: list[int],
        offset: int = 0,
        limit: int = 50000,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Synchronous run - not implemented, use async version."""
        raise NotImplementedError("KbHeadTool only supports async execution")

    @trace_async(span_name="kb_head_arun", tracer_name="chat_shell.tools.kb_head")
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
            add_span_event("reading_documents")
            set_span_attribute("document_ids", str(document_ids))
            set_span_attribute("offset", offset)
            set_span_attribute("limit", limit)

            # Check call limit if counter is set
            if self._call_counter:
                allowed, error_msg = self._call_counter.check_and_increment()
                if not allowed:
                    return error_msg

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

    @trace_async(
        span_name="kb_head_read_docs_package_mode",
        tracer_name="chat_shell.tools.kb_head",
    )
    async def _read_docs_package_mode(
        self, document_ids: list[int], offset: int, limit: int
    ) -> str:
        """Read documents using direct database access."""
        import asyncio

        from app.models.knowledge import KnowledgeDocument
        from app.services.context import context_service

        add_span_event("reading_documents")
        set_span_attribute("document_ids", str(document_ids))
        set_span_attribute("offset", offset)
        set_span_attribute("limit", limit)
        set_span_attribute("mode", "package")

        # Get allowed knowledge base IDs
        allowed_kb_ids = (
            set(self.knowledge_base_ids) if self.knowledge_base_ids else None
        )

        def _read_single_doc(doc_id: int) -> dict:
            document = (
                self.db_session.query(KnowledgeDocument)
                .filter(KnowledgeDocument.id == doc_id)
                .first()
            )

            if not document:
                return {"id": doc_id, "error": "Document not found"}

            # Security check: verify document belongs to allowed knowledge base
            if allowed_kb_ids and document.kind_id not in allowed_kb_ids:
                logger.warning(
                    f"[KbHeadTool] Access denied: doc {doc_id} belongs to KB {document.kind_id}, "
                    f"allowed KBs: {allowed_kb_ids}"
                )
                return {
                    "id": doc_id,
                    "error": "Access denied: document not in allowed knowledge bases",
                }

            content = ""
            total_length = 0
            start = 0  # Track the actual start position used for slicing

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
            # Use clamped start (not offset) for consistent pagination
            has_more = (start + returned_length) < total_length

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

        set_span_attribute("document_count", len(results))

        logger.info(f"[KbHeadTool] Read {len(results)} documents (package mode)")

        return json.dumps({"documents": results}, ensure_ascii=False)

    @trace_async(
        span_name="kb_head_read_docs_http_mode", tracer_name="chat_shell.tools.kb_head"
    )
    async def _read_docs_http_mode(
        self, document_ids: list[int], offset: int, limit: int
    ) -> str:
        """Read documents via HTTP API."""
        import httpx

        add_span_event("reading_documents")
        set_span_attribute("document_ids", str(document_ids))
        set_span_attribute("offset", offset)
        set_span_attribute("limit", limit)
        set_span_attribute("mode", "http")

        backend_url = _get_backend_url()
        results = []

        add_span_event("http_request_started")
        async with httpx.AsyncClient(timeout=60.0) as client:
            for doc_id in document_ids:
                try:
                    # Include knowledge_base_ids for server-side security validation
                    request_data = {
                        "document_id": doc_id,
                        "offset": offset,
                        "limit": limit,
                    }
                    if self.knowledge_base_ids:
                        request_data["knowledge_base_ids"] = self.knowledge_base_ids

                    response = await client.post(
                        f"{backend_url}/api/internal/rag/read-doc",
                        json=request_data,
                    )

                    if response.status_code == 404:
                        results.append({"id": doc_id, "error": "Document not found"})
                        continue

                    if response.status_code == 403:
                        results.append(
                            {
                                "id": doc_id,
                                "error": "Access denied: document not in allowed knowledge bases",
                            }
                        )
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

        set_span_attribute("document_count", len(results))

        logger.info(f"[KbHeadTool] Read {len(results)} documents (HTTP mode)")

        return json.dumps({"documents": results}, ensure_ascii=False)
